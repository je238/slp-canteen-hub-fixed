-- ============================================================
-- WASTAGE IS WEIGHED BY THE MANAGER, AND PHOTOGRAPHED
--
-- Wastage was the chef's own box to fill in. That is the one number in the
-- kitchen the chef should not be the sole author of: food that leaves the
-- pot and never reaches a plate looks exactly like food that was cooked and
-- looks exactly like food that walked out, and the only difference is what
-- somebody types.
--
-- So it moves to the manager, and it comes with a photograph and a weight.
-- Not because anyone is assumed dishonest, but because a number nobody can
-- check is no use to the person it is meant to protect. A picture of a tray
-- on a scale settles in one second what an argument never will.
--
-- The chef keeps "produced" — how much was cooked is theirs to say.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.menu_plan_items
  ADD COLUMN IF NOT EXISTS wastage_photo_url TEXT,
  ADD COLUMN IF NOT EXISTS wastage_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS wastage_at TIMESTAMPTZ;

COMMENT ON COLUMN public.menu_plan_items.wastage_photo_url IS
  'Photograph of the wastage on the scale. Recorded by the manager, not the kitchen.';

-- ---------- The kitchen may no longer write it ----------
CREATE OR REPLACE FUNCTION public.guard_wastage_is_the_managers()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.wastage_qty IS NOT DISTINCT FROM OLD.wastage_qty
     AND NEW.wastage_photo_url IS NOT DISTINCT FROM OLD.wastage_photo_url THEN
    RETURN NEW;                                  -- wastage untouched
  END IF;

  IF NOT public.is_manager_or_above() THEN
    RAISE EXCEPTION
      'Wastage is recorded by the manager, weighed and photographed. The kitchen records what was produced.';
  END IF;

  IF coalesce(NEW.wastage_qty, 0) < 0 THEN
    RAISE EXCEPTION 'Wastage cannot be negative';
  END IF;

  -- A weight with no picture is just a number. The picture is the point.
  IF coalesce(NEW.wastage_qty, 0) > 0
     AND coalesce(btrim(NEW.wastage_photo_url), '') = '' THEN
    RAISE EXCEPTION
      'Take a photo of the wastage on the scale — the weight is only worth recording alongside it.';
  END IF;

  NEW.wastage_by := auth.uid();
  NEW.wastage_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_wastage ON public.menu_plan_items;
CREATE TRIGGER trg_guard_wastage
  BEFORE UPDATE ON public.menu_plan_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_wastage_is_the_managers();

-- ---------- Somewhere to put the photograph ----------
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('wastage', 'wastage', false, 15728640)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 15728640;

DROP POLICY IF EXISTS "the manager files a wastage photo" ON storage.objects;
CREATE POLICY "the manager files a wastage photo"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'wastage'
    AND public.is_manager_or_above()
    AND public.can_access_canteen(((storage.foldername(name))[1])::uuid)
  );

DROP POLICY IF EXISTS "the site's people can see its wastage" ON storage.objects;
CREATE POLICY "the site's people can see its wastage"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'wastage'
    AND public.can_access_canteen(((storage.foldername(name))[1])::uuid)
  );

-- No update and no delete, deliberately — as with the bill photos. A picture
-- that can be swapped for a better one later is not evidence of anything.

-- ---------- What was thrown away, and can it be looked at ----------
CREATE OR REPLACE FUNCTION public.wastage_log(p_canteen_id UUID, p_days INT DEFAULT 30)
RETURNS TABLE (
  menu_date DATE, meal_period TEXT, dish TEXT,
  produced NUMERIC, wasted NUMERIC, unit TEXT,
  share_wasted NUMERIC, photo TEXT, recorded_by TEXT, recorded_at TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT m.menu_date, m.meal_period, i.dish_name,
         i.produced_qty, i.wastage_qty, i.unit,
         CASE WHEN coalesce(i.produced_qty, 0) > 0
              THEN round(i.wastage_qty * 100 / i.produced_qty, 1) END,
         i.wastage_photo_url, coalesce(u.email, '—'), i.wastage_at
  FROM public.menu_plan_items i
  JOIN public.menu_plans m ON m.id = i.menu_plan_id
  LEFT JOIN public.user_directory u ON u.id = i.wastage_by
  WHERE m.canteen_id = p_canteen_id
    AND coalesce(i.wastage_qty, 0) > 0
    AND m.menu_date >= (timezone('Asia/Kolkata', now())::date - p_days)
    AND public.can_access_canteen(p_canteen_id)
  ORDER BY m.menu_date DESC, m.meal_period;
$$;
REVOKE ALL ON FUNCTION public.wastage_log(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wastage_log(UUID, INT) TO authenticated;
