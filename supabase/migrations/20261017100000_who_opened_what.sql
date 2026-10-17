-- ============================================================
-- WHO OPENED WHAT
--
-- action_logs records changes only. The owner asked whether the manager
-- had looked at any report between 1 and 16 October, and the app could not
-- say: opening Reports or Meal Profit changes nothing, so nothing was kept.
--
-- Each screen a signed-in user opens is now one row: who, which screen,
-- which site, when it opened and when it was last seen. The app pings the
-- row once a minute while the screen is visible and once when it is hidden;
-- active_seconds adds up only the visible stretches, so a phone left in a
-- pocket with the app open does not count as reading.
--
-- Rows are written only through the two functions below, always as the
-- caller, and only admin and above can read them. Safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.page_views (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role           text,
  canteen_id     uuid REFERENCES public.canteens(id) ON DELETE SET NULL,
  path           text NOT NULL,
  title          text NOT NULL,
  opened_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  active_seconds integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS page_views_opened_idx ON public.page_views (opened_at DESC);
CREATE INDEX IF NOT EXISTS page_views_user_idx ON public.page_views (user_id, opened_at DESC);

ALTER TABLE public.page_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.page_views FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.page_views TO authenticated;
DROP POLICY IF EXISTS page_views_admin_read ON public.page_views;
CREATE POLICY page_views_admin_read ON public.page_views
  FOR SELECT TO authenticated USING (public.is_admin_editor());

-- Opening a screen. A reload or a re-render of the same screen within two
-- minutes carries on the same row instead of counting a second visit.
CREATE OR REPLACE FUNCTION public.page_view_open(p_path text, p_title text, p_canteen_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id  uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  p_path  := left(coalesce(nullif(trim(p_path), ''), '/'), 200);
  p_title := left(coalesce(nullif(trim(p_title), ''), p_path), 120);

  SELECT id INTO v_id FROM public.page_views
   WHERE user_id = v_uid AND path = p_path AND last_seen_at > now() - interval '2 minutes'
   ORDER BY opened_at DESC LIMIT 1;
  IF v_id IS NOT NULL THEN
    UPDATE public.page_views SET last_seen_at = now() WHERE id = v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.page_views (user_id, role, canteen_id, path, title)
  VALUES (v_uid, (SELECT role::text FROM public.user_roles WHERE user_id = v_uid LIMIT 1),
          CASE WHEN p_canteen_id IS NOT NULL AND public.can_access_canteen(p_canteen_id) THEN p_canteen_id END,
          p_path, p_title)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Still on the screen. p_counts is false when the screen comes back into
-- view after being hidden: that gap was not reading time. One stretch adds
-- at most 90 seconds (the app pings every 60), and only on the caller's own
-- row in its first 12 hours.
DROP FUNCTION IF EXISTS public.page_view_ping(uuid);
CREATE OR REPLACE FUNCTION public.page_view_ping(p_id uuid, p_counts boolean DEFAULT true)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.page_views
     SET active_seconds = active_seconds + CASE WHEN p_counts
           THEN least(90, greatest(0, extract(epoch FROM now() - last_seen_at)))::int ELSE 0 END,
         last_seen_at = now()
   WHERE id = p_id AND user_id = auth.uid() AND opened_at > now() - interval '12 hours';
$$;

REVOKE ALL ON FUNCTION public.page_view_open(text, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.page_view_ping(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.page_view_open(text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.page_view_ping(uuid, boolean) TO authenticated;
