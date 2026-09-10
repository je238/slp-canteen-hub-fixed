-- One meal may serve three internal units. Wastage is recorded once per unit,
-- with its own weight and immutable photograph, by the manager.
CREATE TABLE IF NOT EXISTS public.menu_unit_wastage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_plan_id UUID NOT NULL REFERENCES public.menu_plans(id) ON DELETE RESTRICT,
  canteen_id UUID NOT NULL REFERENCES public.canteens(id) ON DELETE RESTRICT,
  unit_no SMALLINT NOT NULL CHECK (unit_no BETWEEN 1 AND 3),
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL DEFAULT 'kg' CHECK (unit = 'kg'),
  photo_path TEXT NOT NULL CHECK (btrim(photo_path) <> ''),
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (menu_plan_id, unit_no)
);

CREATE INDEX IF NOT EXISTS idx_menu_unit_wastage_site_time
  ON public.menu_unit_wastage (canteen_id, created_at DESC);

ALTER TABLE public.menu_unit_wastage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "site staff may read unit wastage" ON public.menu_unit_wastage;
CREATE POLICY "site staff may read unit wastage"
  ON public.menu_unit_wastage FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));

-- Writes go only through record_menu_unit_wastage(), which validates the
-- manager role, plan/site relationship, weight and photo path together.
REVOKE ALL ON TABLE public.menu_unit_wastage FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.menu_unit_wastage TO authenticated;

CREATE OR REPLACE FUNCTION public.record_menu_unit_wastage(
  p_menu_plan_id UUID,
  p_unit_no INT,
  p_quantity NUMERIC,
  p_photo_path TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_plan public.menu_plans%ROWTYPE;
  v_row public.menu_unit_wastage%ROWTYPE;
  v_expected_prefix TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF NOT public.is_manager_or_above() THEN
    RAISE EXCEPTION 'Only the manager can record wastage';
  END IF;

  SELECT * INTO v_plan FROM public.menu_plans
   WHERE id = p_menu_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Menu not found'; END IF;
  IF NOT public.can_access_canteen(v_plan.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;
  IF v_plan.status = 'draft' THEN
    RAISE EXCEPTION 'Publish the menu before recording wastage';
  END IF;
  IF p_unit_no NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'Unit must be 1, 2 or 3';
  END IF;
  IF coalesce(p_quantity, 0) <= 0 THEN
    RAISE EXCEPTION 'Enter the wastage weight';
  END IF;

  v_expected_prefix := v_plan.canteen_id::text || '/' || v_plan.id::text || '/';
  IF coalesce(p_photo_path, '') NOT LIKE v_expected_prefix || '%' THEN
    RAISE EXCEPTION 'This photo does not belong to this menu and site';
  END IF;

  INSERT INTO public.menu_unit_wastage
    (menu_plan_id, canteen_id, unit_no, quantity, photo_path, created_by)
  VALUES
    (v_plan.id, v_plan.canteen_id, p_unit_no, p_quantity, p_photo_path, auth.uid())
  RETURNING * INTO v_row;

  INSERT INTO public.action_logs
    (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES
    (auth.uid(), 'unit_wastage_recorded', 'menu_plan', v_plan.id, v_plan.canteen_id,
     jsonb_build_object('unit_no', p_unit_no, 'quantity_kg', p_quantity,
                        'photo_path', p_photo_path, 'menu_date', v_plan.menu_date,
                        'meal_period', v_plan.meal_period));

  RETURN jsonb_build_object('id', v_row.id, 'unit_no', v_row.unit_no,
                            'quantity', v_row.quantity, 'unit', v_row.unit,
                            'photo_path', v_row.photo_path);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Unit % ka wastage is menu ke liye pehle hi save ho chuka hai', p_unit_no;
END;
$$;

REVOKE ALL ON FUNCTION public.record_menu_unit_wastage(UUID, INT, NUMERIC, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_menu_unit_wastage(UUID, INT, NUMERIC, TEXT)
  TO authenticated;

-- The wastage bucket already stores immutable evidence. Re-state the upload
-- rule so the first path folder must be a site the manager can access.
DROP POLICY IF EXISTS "the manager files a wastage photo" ON storage.objects;
CREATE POLICY "the manager files a wastage photo"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'wastage'
    AND public.is_manager_or_above()
    AND public.can_access_canteen(((storage.foldername(name))[1])::uuid)
  );

COMMENT ON TABLE public.menu_unit_wastage IS
  'Immutable manager-recorded wastage weight and photo, separately for Unit 1, 2 and 3 under each meal menu.';
