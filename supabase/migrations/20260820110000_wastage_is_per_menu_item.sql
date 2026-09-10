-- Lunch and dinner wastage is weighed per dish and per internal Unit 1/2/3.
-- The previous menu-level table has no rows yet, so it can be tightened
-- without rewriting or losing any live record.

ALTER TABLE public.menu_unit_wastage
  ADD COLUMN IF NOT EXISTS menu_plan_item_id UUID
    REFERENCES public.menu_plan_items(id) ON DELETE RESTRICT;

ALTER TABLE public.menu_unit_wastage
  ALTER COLUMN menu_plan_item_id SET NOT NULL;

ALTER TABLE public.menu_unit_wastage
  DROP CONSTRAINT IF EXISTS menu_unit_wastage_menu_plan_id_unit_no_key;

ALTER TABLE public.menu_unit_wastage
  ADD CONSTRAINT menu_unit_wastage_item_unit_key
  UNIQUE (menu_plan_item_id, unit_no);

CREATE INDEX IF NOT EXISTS idx_menu_unit_wastage_item
  ON public.menu_unit_wastage (menu_plan_item_id);

DROP FUNCTION IF EXISTS public.record_menu_unit_wastage(UUID, INT, NUMERIC, TEXT);

CREATE OR REPLACE FUNCTION public.record_menu_item_unit_wastage(
  p_menu_plan_item_id UUID,
  p_unit_no INT,
  p_quantity NUMERIC,
  p_photo_path TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item public.menu_plan_items%ROWTYPE;
  v_plan public.menu_plans%ROWTYPE;
  v_row public.menu_unit_wastage%ROWTYPE;
  v_expected_prefix TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF NOT public.is_manager_or_above() THEN
    RAISE EXCEPTION 'Only the manager can record wastage';
  END IF;

  SELECT * INTO v_item FROM public.menu_plan_items
   WHERE id = p_menu_plan_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Menu item not found'; END IF;

  SELECT * INTO v_plan FROM public.menu_plans
   WHERE id = v_item.menu_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Menu not found'; END IF;
  IF NOT public.can_access_canteen(v_plan.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;
  IF v_plan.status = 'draft' THEN
    RAISE EXCEPTION 'Publish the menu before recording wastage';
  END IF;
  IF v_plan.meal_period NOT IN ('lunch', 'dinner') THEN
    RAISE EXCEPTION 'Unit-wise item wastage is recorded for lunch and dinner';
  END IF;
  IF p_unit_no NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'Unit must be 1, 2 or 3';
  END IF;
  IF coalesce(p_quantity, 0) <= 0 THEN
    RAISE EXCEPTION 'Enter the wastage weight';
  END IF;

  v_expected_prefix := v_plan.canteen_id::text || '/' || v_plan.id::text ||
                       '/' || v_item.id::text || '/';
  IF coalesce(p_photo_path, '') NOT LIKE v_expected_prefix || '%' THEN
    RAISE EXCEPTION 'This photo does not belong to this menu item and site';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM storage.objects o
     WHERE o.bucket_id = 'wastage' AND o.name = p_photo_path
  ) THEN
    RAISE EXCEPTION 'Wastage photo upload nahi hui — dobara photo lagayein';
  END IF;

  INSERT INTO public.menu_unit_wastage
    (menu_plan_id, menu_plan_item_id, canteen_id, unit_no,
     quantity, photo_path, created_by)
  VALUES
    (v_plan.id, v_item.id, v_plan.canteen_id, p_unit_no,
     p_quantity, p_photo_path, auth.uid())
  RETURNING * INTO v_row;

  INSERT INTO public.action_logs
    (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES
    (auth.uid(), 'item_unit_wastage_recorded', 'menu_plan_item', v_item.id,
     v_plan.canteen_id,
     jsonb_build_object('dish', v_item.dish_name, 'unit_no', p_unit_no,
                        'quantity_kg', p_quantity, 'photo_path', p_photo_path,
                        'menu_date', v_plan.menu_date,
                        'meal_period', v_plan.meal_period));

  RETURN jsonb_build_object('id', v_row.id, 'dish', v_item.dish_name,
                            'unit_no', v_row.unit_no,
                            'quantity', v_row.quantity, 'unit', v_row.unit,
                            'photo_path', v_row.photo_path);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION '% ke Unit % ka wastage pehle hi save ho chuka hai',
    v_item.dish_name, p_unit_no;
END;
$$;

REVOKE ALL ON FUNCTION public.record_menu_item_unit_wastage(UUID, INT, NUMERIC, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_menu_item_unit_wastage(UUID, INT, NUMERIC, TEXT)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.wastage_log(p_canteen_id UUID, p_days INT DEFAULT 30)
RETURNS TABLE (
  menu_date DATE, meal_period TEXT, dish TEXT,
  produced NUMERIC, wasted NUMERIC, unit TEXT,
  share_wasted NUMERIC, photo TEXT, recorded_by TEXT, recorded_at TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT * FROM (
    SELECT m.menu_date, m.meal_period, i.dish_name,
           i.produced_qty, i.wastage_qty, i.unit,
           CASE WHEN coalesce(i.produced_qty, 0) > 0
                THEN round(i.wastage_qty * 100 / i.produced_qty, 1) END,
           i.wastage_photo_url, coalesce(u.email, '—'), i.wastage_at
      FROM public.menu_plan_items i
      JOIN public.menu_plans m ON m.id = i.menu_plan_id
      LEFT JOIN public.user_directory u ON u.id = i.wastage_by
     WHERE m.canteen_id = p_canteen_id AND coalesce(i.wastage_qty, 0) > 0
       AND m.menu_date >= (timezone('Asia/Kolkata', now())::date - p_days)
    UNION ALL
    SELECT m.menu_date, m.meal_period,
           i.dish_name || ' · Unit ' || w.unit_no,
           i.produced_qty, w.quantity, w.unit,
           CASE WHEN coalesce(i.produced_qty, 0) > 0
                THEN round(w.quantity * 100 / i.produced_qty, 1) END,
           w.photo_path, coalesce(u.email, '—'), w.created_at
      FROM public.menu_unit_wastage w
      JOIN public.menu_plan_items i ON i.id = w.menu_plan_item_id
      JOIN public.menu_plans m ON m.id = w.menu_plan_id
      LEFT JOIN public.user_directory u ON u.id = w.created_by
     WHERE m.canteen_id = p_canteen_id
       AND m.menu_date >= (timezone('Asia/Kolkata', now())::date - p_days)
  ) x(menu_date, meal_period, dish, produced, wasted, unit,
      share_wasted, photo, recorded_by, recorded_at)
  WHERE public.can_access_canteen(p_canteen_id)
  ORDER BY menu_date DESC, meal_period, dish;
$$;

REVOKE ALL ON FUNCTION public.wastage_log(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wastage_log(UUID, INT) TO authenticated;
