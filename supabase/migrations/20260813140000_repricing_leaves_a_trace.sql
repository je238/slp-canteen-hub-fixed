-- ============================================================
-- RE-PRICING LEAVES A TRACE
--
-- Correcting a rate changes what the shelf is worth without moving a gram,
-- and it wrote nothing to the ledger. So the value of the stock could rise or
-- fall with no line anywhere saying why, and the comparison column came out
-- three and a half thousand short with nowhere to look for it.
--
-- What the store is worth is a fact about the store. It belongs in the book
-- with everything else: no quantity, a value, and the words.
--
-- Safe to re-run.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_ingredient_rate(
  p_ingredient_id UUID, p_rate NUMERIC, p_reason TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ing public.ingredients%ROWTYPE;
  v_by_store BOOLEAN := false; v_reason TEXT; v_lots INT := 0; v_swing NUMERIC;
BEGIN
  IF p_rate IS NULL OR p_rate < 0 THEN
    RAISE EXCEPTION 'A rate cannot be negative';
  END IF;
  SELECT * INTO v_ing FROM public.ingredients WHERE id = p_ingredient_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown item'; END IF;
  IF NOT public.can_access_canteen(v_ing.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  IF public.is_admin_editor() THEN
    NULL;
  ELSIF public.is_store_keeper() AND public.stock_editing_is_open(v_ing.canteen_id) THEN
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

  v_swing := round(v_ing.current_stock * (p_rate - coalesce(v_ing.cost_per_unit, 0)), 2);

  PERFORM public.allow_stock_move();
  UPDATE public.ingredients SET cost_per_unit = p_rate WHERE id = p_ingredient_id;

  UPDATE public.ingredient_batches SET rate = p_rate
   WHERE ingredient_id = p_ingredient_id AND qty_remaining = qty_received;
  GET DIAGNOSTICS v_lots = ROW_COUNT;

  -- No quantity moved, so change_qty is zero and only the money is recorded.
  IF v_swing <> 0 THEN
    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason,
       reference_type, created_by, service_date, value)
    VALUES (p_ingredient_id, v_ing.canteen_id, 0, v_ing.current_stock,
            format('Rate corrected %s to %s per %s: %s',
                   coalesce(v_ing.cost_per_unit, 0), p_rate, v_ing.unit, v_reason),
            'reprice', auth.uid(), (now() AT TIME ZONE 'Asia/Kolkata')::date, v_swing);
  END IF;

  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'rate_corrected', 'ingredient', p_ingredient_id, v_ing.canteen_id,
          jsonb_build_object('item', v_ing.name, 'was', v_ing.cost_per_unit, 'now', p_rate,
                             'lots_repriced', v_lots, 'value_swing', v_swing,
                             'reason', v_reason, 'by_store_keeper', v_by_store));

  IF v_by_store THEN
    INSERT INTO public.notifications
      (canteen_id, target_role, title, body, link, ref_type, ref_id)
    VALUES (v_ing.canteen_id, 'admin',
            format('Rate corrected by the store keeper - %s', v_ing.name),
            format('%s: %s to %s per %s. %s lot(s) re-priced. The %s %s on hand is now worth %s, a swing of %s. Reason: "%s".',
                   v_ing.name, coalesce(v_ing.cost_per_unit, 0), p_rate, v_ing.unit, v_lots,
                   v_ing.current_stock, v_ing.unit, round(v_ing.current_stock * p_rate, 2),
                   v_swing, v_reason),
            '/inventory', 'ingredient', p_ingredient_id);
  END IF;

  RETURN jsonb_build_object('changed', true, 'was', v_ing.cost_per_unit, 'now', p_rate,
                            'lots_repriced', v_lots, 'value_swing', v_swing,
                            'by_store_keeper', v_by_store);
END;
$$;
REVOKE ALL ON FUNCTION public.set_ingredient_rate(UUID, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_ingredient_rate(UUID, NUMERIC, TEXT) TO authenticated;

-- ---------- Re-pricing joins the adjustments line ----------
CREATE OR REPLACE FUNCTION public.period_summary(p_canteen_id UUID, p_start DATE, p_end DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_purchase NUMERIC; v_consumption NUMERIC; v_heads BIGINT; v_sale NUMERIC;
  v_expense NUMERIC; v_closing NUMERIC; v_wastage NUMERIC; v_opening_in NUMERIC;
  v_adjust NUMERIC;
BEGIN
  IF NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  SELECT coalesce(sum(total_amount) FILTER (WHERE NOT is_opening), 0),
         coalesce(sum(total_amount) FILTER (WHERE is_opening), 0)
    INTO v_purchase, v_opening_in
  FROM public.purchases
  WHERE canteen_id = p_canteen_id AND status = 'confirmed'
    AND created_at >= (p_start::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND created_at <  ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');

  SELECT coalesce(sum(coalesce(abs(l.value), -l.change_qty * coalesce(i.cost_per_unit, 0))), 0)
    INTO v_consumption
  FROM public.stock_ledger l JOIN public.ingredients i ON i.id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id
    AND l.reference_type IN ('issue', 'recipe') AND l.change_qty < 0
    AND coalesce(l.service_date, (l.created_at AT TIME ZONE 'Asia/Kolkata')::date)
        BETWEEN p_start AND p_end;

  SELECT coalesce(sum(
           CASE WHEN l.reference_type = 'reprice' THEN coalesce(l.value, 0)
                ELSE sign(l.change_qty) * abs(coalesce(l.value,
                       l.change_qty * coalesce(i.cost_per_unit, 0))) END), 0)
    INTO v_adjust
  FROM public.stock_ledger l JOIN public.ingredients i ON i.id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id
    AND l.reference_type IN ('manual', 'audit', 'reprice')
    AND coalesce(l.service_date, (l.created_at AT TIME ZONE 'Asia/Kolkata')::date)
        BETWEEN p_start AND p_end;

  SELECT coalesce(sum(coalesce(actual_headcount, expected_headcount, 0)), 0) INTO v_heads
  FROM public.menu_plans
  WHERE canteen_id = p_canteen_id AND menu_date BETWEEN p_start AND p_end
    AND status <> 'draft';

  v_sale := public.computed_sale(p_canteen_id, p_start, p_end);

  SELECT coalesce(sum(amount), 0) INTO v_expense
  FROM public.expenses
  WHERE canteen_id = p_canteen_id AND expense_date BETWEEN p_start AND p_end;

  SELECT coalesce(sum(r.stock_value), 0)
       - coalesce((SELECT sum(l.change_qty * coalesce(i2.cost_per_unit, 0))
                     FROM public.stock_ledger l
                     JOIN public.ingredients i2 ON i2.id = l.ingredient_id
                    WHERE l.canteen_id = p_canteen_id
                      AND coalesce(l.service_date,
                                   (l.created_at AT TIME ZONE 'Asia/Kolkata')::date) > p_end), 0)
    INTO v_closing
  FROM public.ingredient_rates r WHERE r.canteen_id = p_canteen_id;
  v_closing := greatest(v_closing, 0);

  SELECT coalesce(sum(mi.wastage_qty), 0) INTO v_wastage
  FROM public.menu_plan_items mi JOIN public.menu_plans m ON m.id = mi.menu_plan_id
  WHERE m.canteen_id = p_canteen_id AND m.menu_date BETWEEN p_start AND p_end;

  RETURN jsonb_build_object(
    'purchase', round(v_purchase, 2), 'opening_stock_in', round(v_opening_in, 2),
    'consumption', round(v_consumption, 2), 'adjustments', round(v_adjust, 2),
    'headcount', v_heads, 'sale', round(v_sale, 2), 'expenses', v_expense,
    'closing_stock', round(v_closing, 2), 'wastage', v_wastage,
    'cost_per_plate', CASE WHEN v_heads > 0 THEN round(v_consumption / v_heads, 2) END,
    'food_cost_pct', CASE WHEN v_sale > 0 THEN round(v_consumption * 100 / v_sale, 2) END);
END;
$$;
