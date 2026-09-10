-- ============================================================
-- WHAT WAS ALREADY THERE IS NOT WHAT YOU BOUGHT
--
-- Two things on the comparison screen that cannot both be true:
--
--     Purchases      ₹11,05,682
--     Consumption            ₹0
--     Stock in hand   ₹7,87,657
--
-- Nothing was eaten, so the shelf cannot hold less than what arrived. And the
-- month did not see eleven lakh of buying — that figure is the opening count,
-- the food that was already in the store on the day the app started. It went
-- in through the goods-receipt screen because that is the only door stock has,
-- and it came out the other side looking like a month's shopping.
--
-- Left alone, the owner opens the first month's report and sees eleven lakh
-- spent in a fortnight against two lakh of sale. Nothing about that is real.
--
-- So two corrections:
--
--   * a receipt can be marked as the opening count. The goods, the lots, the
--     ledger and the value are all untouched — it simply stops being counted
--     as this month's buying, because it was not.
--   * stock in hand is valued from the lots on the shelf, the same way every
--     other screen now values it. It was multiplying quantity by the last
--     rate paid, which is how it managed to come out BELOW the goods that
--     had just arrived.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.purchases
  ADD COLUMN IF NOT EXISTS is_opening BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.purchases.is_opening IS
  'Stock that was already in the store when the app started. Holds real goods '
  'and real lots, but is not this period''s buying and is left out of purchase '
  'totals.';

CREATE OR REPLACE FUNCTION public.mark_as_opening_stock(p_purchase_id UUID, p_is_opening BOOLEAN DEFAULT true)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_p public.purchases%ROWTYPE;
BEGIN
  SELECT * INTO v_p FROM public.purchases WHERE id = p_purchase_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown receipt'; END IF;
  IF NOT public.is_admin_editor() THEN
    RAISE EXCEPTION 'Only an admin can mark a receipt as opening stock';
  END IF;
  IF NOT public.can_access_canteen(v_p.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  UPDATE public.purchases SET is_opening = p_is_opening WHERE id = p_purchase_id;

  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'marked_opening_stock', 'purchase', p_purchase_id, v_p.canteen_id,
          jsonb_build_object('is_opening', p_is_opening, 'value', v_p.total_amount));

  RETURN jsonb_build_object('is_opening', p_is_opening, 'value', v_p.total_amount);
END;
$$;
REVOKE ALL ON FUNCTION public.mark_as_opening_stock(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_as_opening_stock(UUID, BOOLEAN) TO authenticated;

-- ---------- The period report ----------
CREATE OR REPLACE FUNCTION public.period_summary(p_canteen_id UUID, p_start DATE, p_end DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_purchase NUMERIC; v_consumption NUMERIC; v_heads BIGINT; v_sale NUMERIC;
  v_expense NUMERIC; v_closing NUMERIC; v_wastage NUMERIC; v_opening_in NUMERIC;
BEGIN
  IF NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  -- What was actually bought in the period. The opening count is left out:
  -- it is goods that were already there, not money spent this month.
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

  SELECT coalesce(sum(coalesce(actual_headcount, expected_headcount, 0)), 0) INTO v_heads
  FROM public.menu_plans
  WHERE canteen_id = p_canteen_id AND menu_date BETWEEN p_start AND p_end
    AND status <> 'draft';

  v_sale := public.computed_sale(p_canteen_id, p_start, p_end);

  SELECT coalesce(sum(amount), 0) INTO v_expense
  FROM public.expenses
  WHERE canteen_id = p_canteen_id AND expense_date BETWEEN p_start AND p_end;

  -- The shelf, valued from the lots standing on it — the same figure the
  -- inventory page and the chef's order screen use.
  SELECT coalesce(sum(stock_value), 0) INTO v_closing
  FROM public.ingredient_rates WHERE canteen_id = p_canteen_id;

  SELECT coalesce(sum(mi.wastage_qty), 0) INTO v_wastage
  FROM public.menu_plan_items mi JOIN public.menu_plans m ON m.id = mi.menu_plan_id
  WHERE m.canteen_id = p_canteen_id AND m.menu_date BETWEEN p_start AND p_end;

  RETURN jsonb_build_object(
    'purchase', round(v_purchase, 2),
    'opening_stock_in', round(v_opening_in, 2),
    'consumption', round(v_consumption, 2),
    'headcount', v_heads,
    'sale', round(v_sale, 2),
    'expenses', v_expense, 'closing_stock', round(v_closing, 2),
    'wastage', v_wastage,
    'cost_per_plate', CASE WHEN v_heads > 0 THEN round(v_consumption / v_heads, 2) END,
    'food_cost_pct', CASE WHEN v_sale > 0 THEN round(v_consumption * 100 / v_sale, 2) END);
END;
$$;

-- ---------- The operations summary ----------
CREATE OR REPLACE FUNCTION public.operations_summary(p_canteen_id UUID, p_start DATE, p_end DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_heads BIGINT; v_revenue NUMERIC; v_consumption NUMERIC;
  v_purchase NUMERIC; v_meals BIGINT; v_wastage NUMERIC; v_reqs BIGINT;
BEGIN
  IF NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  v_revenue := public.computed_sale(p_canteen_id, p_start, p_end);
  IF v_revenue = 0 THEN
    SELECT coalesce(sum(amount), 0) INTO v_revenue
    FROM public.meal_entries
    WHERE canteen_id = p_canteen_id AND entry_date BETWEEN p_start AND p_end;
  END IF;

  SELECT coalesce(sum(coalesce(actual_headcount, expected_headcount, 0)), 0), count(*)
  INTO v_heads, v_meals
  FROM public.menu_plans
  WHERE canteen_id = p_canteen_id AND menu_date BETWEEN p_start AND p_end
    AND status <> 'draft';

  SELECT coalesce(sum(coalesce(abs(l.value), -l.change_qty * coalesce(i.cost_per_unit, 0))), 0)
  INTO v_consumption
  FROM public.stock_ledger l JOIN public.ingredients i ON i.id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('recipe','issue')
    AND l.change_qty < 0
    AND coalesce(l.service_date,
                 (l.created_at AT TIME ZONE 'Asia/Kolkata')::date) BETWEEN p_start AND p_end;

  SELECT coalesce(sum(total_amount), 0) INTO v_purchase
  FROM public.purchases
  WHERE canteen_id = p_canteen_id AND status = 'confirmed' AND NOT is_opening
    AND created_at >= (p_start::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND created_at <  ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');

  SELECT coalesce(sum(mi.wastage_qty), 0) INTO v_wastage
  FROM public.menu_plan_items mi JOIN public.menu_plans m ON m.id = mi.menu_plan_id
  WHERE m.canteen_id = p_canteen_id AND m.menu_date BETWEEN p_start AND p_end;

  SELECT count(*) INTO v_reqs FROM public.requisitions
  WHERE canteen_id = p_canteen_id AND req_date BETWEEN p_start AND p_end;

  RETURN jsonb_build_object(
    'headcount', v_heads, 'meals_served', v_meals, 'revenue', v_revenue,
    'consumption', v_consumption, 'purchase', v_purchase,
    'wastage_qty', v_wastage, 'requisitions', v_reqs,
    'cost_per_person', CASE WHEN v_heads > 0 THEN round(v_consumption / v_heads, 2) END,
    'revenue_per_person', CASE WHEN v_heads > 0 THEN round(v_revenue / v_heads, 2) END,
    'food_cost_pct', CASE WHEN v_revenue > 0 THEN round(v_consumption * 100 / v_revenue, 2) END,
    'margin_per_person', CASE WHEN v_heads > 0
                              THEN round((v_revenue - v_consumption) / v_heads, 2) END);
END;
$$;

-- ---------- The daily reconciliation ----------
CREATE OR REPLACE FUNCTION public.daily_reconciliation(p_canteen_id UUID, p_date DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE v_in NUMERIC; v_out NUMERIC; v_stock NUMERIC; v_heads INT;
BEGIN
  SELECT coalesce(sum(coalesce(l.value, l.change_qty * r.latest_rate)), 0) INTO v_in
  FROM public.stock_ledger l
  JOIN public.ingredient_rates r ON r.ingredient_id = l.ingredient_id
  LEFT JOIN public.purchases p ON p.id = l.reference_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type = 'purchase'
    AND NOT coalesce(p.is_opening, false)
    AND coalesce(l.service_date, (l.created_at AT TIME ZONE 'Asia/Kolkata')::date) = p_date;

  SELECT coalesce(sum(coalesce(abs(l.value), -l.change_qty * r.latest_rate)), 0) INTO v_out
  FROM public.stock_ledger l
  JOIN public.ingredient_rates r ON r.ingredient_id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('issue','recipe')
    AND l.change_qty < 0
    AND coalesce(l.service_date, (l.created_at AT TIME ZONE 'Asia/Kolkata')::date) = p_date;

  SELECT coalesce(sum(stock_value), 0) INTO v_stock
  FROM public.ingredient_rates WHERE canteen_id = p_canteen_id;

  SELECT coalesce(sum(coalesce(actual_headcount, expected_headcount, 0)), 0) INTO v_heads
  FROM public.menu_plans WHERE canteen_id = p_canteen_id AND menu_date = p_date;

  RETURN jsonb_build_object(
    'date', p_date, 'stock_in_value', round(v_in, 2),
    'consumption_value', round(v_out, 2), 'closing_stock_value', round(v_stock, 2),
    'headcount', v_heads,
    'cost_per_head', CASE WHEN v_heads > 0 THEN round(v_out / v_heads, 2) END);
END;
$$;
