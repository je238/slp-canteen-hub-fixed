-- A path-shaped string is not evidence. Refuse the wastage row unless the
-- manager's photo upload already exists in the private wastage bucket.
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
  IF NOT EXISTS (
    SELECT 1 FROM storage.objects o
     WHERE o.bucket_id = 'wastage' AND o.name = p_photo_path
  ) THEN
    RAISE EXCEPTION 'Wastage photo upload nahi hui — dobara photo lagayein';
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
