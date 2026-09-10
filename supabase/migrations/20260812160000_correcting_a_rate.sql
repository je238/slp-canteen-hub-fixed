-- ============================================================
-- CORRECTING A RATE, WHILE THE SETUP WINDOW IS OPEN
--
-- A rate lives in two places, and that is the whole difficulty.
--
-- The item carries cost_per_unit — what a kilo is reckoned to cost. Each lot
-- carries its own rate, taken from the bill it came in on, and that is what
-- FIFO charges the kitchen. Change only the first and an item that came in on
-- a bill does not move at all, and the person who typed it concludes the app
-- ignored them.
--
-- So this changes both — but only lots NOTHING HAS BEEN DRAWN FROM. A lot
-- that has been partly issued has already been charged to a meal at its old
-- rate; going back and re-pricing it would quietly rewrite what a day's food
-- cost after the fact, which is the one thing this system exists to prevent.
--
-- Same window, same rules as correcting a quantity: the store keeper while
-- the setup window is open, an admin always, every change written to the log
-- and told to the admin as it happens.
--
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_ingredient_rate(
  p_ingredient_id UUID, p_rate NUMERIC, p_reason TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ing public.ingredients%ROWTYPE;
  v_by_store BOOLEAN := false; v_reason TEXT; v_lots INT := 0; v_open BOOLEAN;
BEGIN
  IF p_rate IS NULL OR p_rate < 0 THEN
    RAISE EXCEPTION 'A rate cannot be negative';
  END IF;
  SELECT * INTO v_ing FROM public.ingredients WHERE id = p_ingredient_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown item'; END IF;
  IF NOT public.can_access_canteen(v_ing.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  v_open := public.stock_editing_is_open(v_ing.canteen_id);

  IF public.is_admin_editor() THEN
    NULL;
  ELSIF public.is_store_keeper() AND v_open THEN
    v_by_store := true;
  ELSE
    RAISE EXCEPTION
      'A rate can only be corrected by an admin, or by the store keeper while the setup window is open.';
  END IF;

  v_reason := btrim(coalesce(p_reason, ''));
  IF v_reason = '' THEN
    IF v_by_store THEN v_reason := 'Opening rate corrected by the store keeper';
    ELSE RAISE EXCEPTION 'A reason is required for a rate correction';
    END IF;
  END IF;

  IF coalesce(v_ing.cost_per_unit, 0) = p_rate THEN
    RETURN jsonb_build_object('changed', false);
  END IF;

  -- Raised BEFORE the item is touched, not after. guard_ingredient_edit
  -- honours this flag and refuses everyone else — without it the store
  -- keeper hit "Item details can only be changed by an admin" on his own
  -- correction, from inside the very function meant to let him make it.
  PERFORM public.allow_stock_move();
  UPDATE public.ingredients SET cost_per_unit = p_rate WHERE id = p_ingredient_id;

  -- Untouched lots only. A lot that has been drawn from has already priced a
  -- meal; re-rating it now would change what that day's food cost.
  UPDATE public.ingredient_batches
     SET rate = p_rate
   WHERE ingredient_id = p_ingredient_id
     AND qty_remaining = qty_received;
  GET DIAGNOSTICS v_lots = ROW_COUNT;

  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'rate_corrected', 'ingredient', p_ingredient_id, v_ing.canteen_id,
          jsonb_build_object('item', v_ing.name, 'was', v_ing.cost_per_unit, 'now', p_rate,
                             'lots_repriced', v_lots, 'reason', v_reason,
                             'by_store_keeper', v_by_store));

  IF v_by_store THEN
    INSERT INTO public.notifications
      (canteen_id, target_role, title, body, link, ref_type, ref_id)
    VALUES (v_ing.canteen_id, 'admin',
            format('Rate corrected by the store keeper — %s', v_ing.name),
            format('%s: ₹%s → ₹%s per %s. %s lot(s) re-priced, %s %s on hand now worth ₹%s. Reason: "%s".',
                   v_ing.name, coalesce(v_ing.cost_per_unit, 0), p_rate, v_ing.unit,
                   v_lots, v_ing.current_stock, v_ing.unit,
                   round(v_ing.current_stock * p_rate, 2), v_reason),
            '/inventory', 'ingredient', p_ingredient_id);
  END IF;

  RETURN jsonb_build_object('changed', true, 'was', v_ing.cost_per_unit, 'now', p_rate,
                            'lots_repriced', v_lots, 'by_store_keeper', v_by_store);
END;
$$;
REVOKE ALL ON FUNCTION public.set_ingredient_rate(UUID, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_ingredient_rate(UUID, NUMERIC, TEXT) TO authenticated;
