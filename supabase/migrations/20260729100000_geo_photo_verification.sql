-- ============================================================
-- GEO-TAGGED PHOTO / VIDEO VERIFICATION
--
-- Two asks from the field:
--   1. Vendor and store keeper captures carry a GPS location, so a
--      "delivered at the gate" photo can be proved to be at the gate.
--   2. The store keeper photographs every daily issue — what physically
--      left the store, not just the number typed into the register.
--
-- Photos live in a private 'stock-photos' bucket; the row here is the
-- evidence record and is append-only (no UPDATE/DELETE policy at all).
-- Safe to re-run.
-- ============================================================

-- ---------- 1. Geo on vendor bills ----------
ALTER TABLE public.vendor_bills ADD COLUMN IF NOT EXISTS latitude     NUMERIC;
ALTER TABLE public.vendor_bills ADD COLUMN IF NOT EXISTS longitude    NUMERIC;
ALTER TABLE public.vendor_bills ADD COLUMN IF NOT EXISTS geo_accuracy NUMERIC;
ALTER TABLE public.vendor_bills ADD COLUMN IF NOT EXISTS captured_at  TIMESTAMPTZ;

-- ---------- 2. Movement evidence photos ----------
CREATE TABLE IF NOT EXISTS public.stock_photos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canteen_id     UUID NOT NULL REFERENCES public.canteens(id) ON DELETE CASCADE,
  photo_type     TEXT NOT NULL CHECK (photo_type IN
                   ('issue','receipt','requisition','audit','vendor_delivery')),
  reference_id   UUID,                       -- requisition / purchase / audit row
  image_path     TEXT NOT NULL,
  media_kind     TEXT NOT NULL DEFAULT 'image' CHECK (media_kind IN ('image','video')),
  latitude       NUMERIC,
  longitude      NUMERIC,
  geo_accuracy   NUMERIC,                    -- metres, as reported by the device
  captured_at    TIMESTAMPTZ,                -- when the device took it
  note           TEXT,
  created_by     UUID DEFAULT auth.uid(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_photos_site_time
  ON public.stock_photos (canteen_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_photos_ref
  ON public.stock_photos (reference_id) WHERE reference_id IS NOT NULL;

ALTER TABLE public.stock_photos ENABLE ROW LEVEL SECURITY;

-- Append-only on purpose: evidence you can add to but never quietly edit
-- or erase. Only an owner may delete.
DROP POLICY IF EXISTS "stock_photos_select" ON public.stock_photos;
DROP POLICY IF EXISTS "stock_photos_insert" ON public.stock_photos;
DROP POLICY IF EXISTS "stock_photos_owner_delete" ON public.stock_photos;
CREATE POLICY "stock_photos_select" ON public.stock_photos FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "stock_photos_insert" ON public.stock_photos FOR INSERT TO authenticated
  WITH CHECK (public.is_store_keeper_or_above() AND public.can_access_canteen(canteen_id));
CREATE POLICY "stock_photos_owner_delete" ON public.stock_photos FOR DELETE TO authenticated
  USING (public.is_super_admin());

-- ---------- 3. Private bucket for those photos ----------
INSERT INTO storage.buckets (id, name, public)
VALUES ('stock-photos', 'stock-photos', false)
ON CONFLICT (id) DO NOTHING;

-- Paths are <canteen_id>/<type>/<timestamp>.<ext>, so the first folder
-- scopes access exactly like the invoices bucket does.
DROP POLICY IF EXISTS "stock_photos_read" ON storage.objects;
DROP POLICY IF EXISTS "stock_photos_write" ON storage.objects;
CREATE POLICY "stock_photos_read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'stock-photos'
         AND public.can_access_canteen(NULLIF((storage.foldername(name))[1], '')::uuid));
CREATE POLICY "stock_photos_write" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'stock-photos'
              AND public.is_store_keeper_or_above()
              AND public.can_access_canteen(NULLIF((storage.foldername(name))[1], '')::uuid));

-- ---------- 4. Issue photos become mandatory once the site starts using them ----------
-- A site that has ever attached an issue photo is treated as opted in: from
-- then on, issuing a requisition without one is refused. That way the rule
-- turns itself on per site without a settings screen, and nobody can quietly
-- opt back out.
CREATE OR REPLACE FUNCTION public.require_issue_photo(p_canteen_id UUID, p_req_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM public.stock_photos
                     WHERE canteen_id = p_canteen_id AND photo_type = 'issue')
      THEN true                                  -- site hasn't started yet
    ELSE EXISTS (SELECT 1 FROM public.stock_photos
                 WHERE canteen_id = p_canteen_id AND photo_type = 'issue'
                   AND reference_id = p_req_id)
  END;
$$;
REVOKE ALL ON FUNCTION public.require_issue_photo(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.require_issue_photo(UUID, UUID) TO authenticated;
