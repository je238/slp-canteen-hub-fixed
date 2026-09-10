-- ============================================================
-- THE COLUMN MUST ADD UP
--
-- Two things wrong on the comparison screen, and the second is the serious one.
--
-- "Stock in hand" showed the same figure in both columns and called it
-- "same". It was reading the shelf as it stands today for BOTH periods — so
-- a month in which the store went from empty to seven and a half lakh read as
-- no change at all.
--
-- And the column did not add up:
--
--     opening 7,68,746 + bought 4,860 - eaten 18,514 = 7,55,092
--     stock in hand                                    7,59,185
--
-- Four thousand rupees with nowhere to come from. It is the hand corrections
-- and rate changes made while the setting-up window is open — real, and
-- entirely legitimate, but invisible. A column that does not add up is the
-- fastest way to lose an owner's trust in every other figure on the page, so
-- the adjustments get a line of their own and the arithmetic closes.
--
-- Safe to re-run.
-- ============================================================
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

  -- Counted by hand or re-priced: signed, so a count downwards shows as a
  -- loss and a count upwards as a gain.
  SELECT coalesce(sum(sign(l.change_qty) * abs(coalesce(l.value,
                        l.change_qty * coalesce(i.cost_per_unit, 0)))), 0)
    INTO v_adjust
  FROM public.stock_ledger l JOIN public.ingredients i ON i.id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id
    AND l.reference_type IN ('manual', 'audit')
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

  -- The shelf as it stood at the END OF THIS PERIOD: today's shelf, wound
  -- back through every movement that has happened since. Reading "now" for a
  -- period that closed a month ago made an empty June look like a full August.
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
    'purchase', round(v_purchase, 2),
    'opening_stock_in', round(v_opening_in, 2),
    'consumption', round(v_consumption, 2),
    'adjustments', round(v_adjust, 2),
    'headcount', v_heads,
    'sale', round(v_sale, 2),
    'expenses', v_expense,
    'closing_stock', round(v_closing, 2),
    'wastage', v_wastage,
    'cost_per_plate', CASE WHEN v_heads > 0 THEN round(v_consumption / v_heads, 2) END,
    'food_cost_pct', CASE WHEN v_sale > 0 THEN round(v_consumption * 100 / v_sale, 2) END);
END;
$$;
