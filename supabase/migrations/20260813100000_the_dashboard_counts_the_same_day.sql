-- ============================================================
-- THE DASHBOARD COUNTS THE SAME DAY EVERY OTHER SCREEN DOES
--
-- The dashboard said "Today's consumption ₹0" while the report said ₹18,514
-- for the same day. Both were doing what they were told and they disagreed,
-- which is the worst kind of wrong.
--
-- The goods left the store on the evening of the 12th, for the 13th's
-- cooking — which is how this canteen works and why the ledger carries the
-- day the food is FOR alongside the day it moved. The reports were changed
-- to read that. The dashboard was not, so it went on counting by the moment
-- the sack left the shelf.
--
-- It also valued stock at the last rate paid rather than at the lots on hand,
-- so its inventory figure drifted from the inventory page's.
--
-- Safe to re-run.
-- ============================================================
CREATE OR REPLACE FUNCTION public.manager_dashboard(p_canteen_id UUID, p_date DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_t0 TIMESTAMPTZ := (p_date::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_t1 TIMESTAMPTZ := ((p_date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_m0 DATE := date_trunc('month', p_date)::date;
  v_purchase NUMERIC; v_consumption NUMERIC; v_inv NUMERIC;
  v_low INT; v_month_cons NUMERIC; v_budget NUMERIC; v_pending INT;
  v_heads INT; v_menu JSONB;
BEGIN
  IF NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  -- Bought today. The opening count is not buying and is left out, the same
  -- way the reports leave it out.
  SELECT coalesce(sum(total_amount), 0) INTO v_purchase FROM public.purchases
  WHERE canteen_id = p_canteen_id AND status = 'confirmed' AND NOT is_opening
    AND created_at >= v_t0 AND created_at < v_t1;

  -- Eaten today: the day the food was FOR, not the evening the sack moved.
  SELECT coalesce(sum(coalesce(abs(l.value), -l.change_qty * r.latest_rate)), 0)
  INTO v_consumption
  FROM public.stock_ledger l JOIN public.ingredient_rates r ON r.ingredient_id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('issue','recipe')
    AND l.change_qty < 0
    AND coalesce(l.service_date, (l.created_at AT TIME ZONE 'Asia/Kolkata')::date) = p_date;

  -- Valued from the lots standing on the shelf, as everywhere else.
  SELECT coalesce(sum(r.stock_value), 0),
         count(*) FILTER (WHERE i.current_stock <= coalesce(i.reorder_level, i.minimum_stock, 0)
                            AND coalesce(i.reorder_level, i.minimum_stock, 0) > 0)
  INTO v_inv, v_low
  FROM public.ingredient_rates r
  JOIN public.ingredients i ON i.id = r.ingredient_id
  WHERE r.canteen_id = p_canteen_id;

  SELECT coalesce(sum(coalesce(abs(l.value), -l.change_qty * r.latest_rate)), 0)
  INTO v_month_cons
  FROM public.stock_ledger l JOIN public.ingredient_rates r ON r.ingredient_id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('issue','recipe')
    AND l.change_qty < 0
    AND coalesce(l.service_date, (l.created_at AT TIME ZONE 'Asia/Kolkata')::date) >= v_m0;

  SELECT food_budget INTO v_budget FROM public.site_budgets
  WHERE canteen_id = p_canteen_id AND budget_month = v_m0;

  SELECT count(*) INTO v_pending FROM public.requisitions
  WHERE canteen_id = p_canteen_id AND status = 'pending';

  SELECT coalesce(sum(coalesce(actual_headcount, expected_headcount, 0)), 0) INTO v_heads
  FROM public.menu_plans WHERE canteen_id = p_canteen_id AND menu_date = p_date;

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'meal_period'), '[]'::jsonb) INTO v_menu FROM (
    SELECT jsonb_build_object(
      'meal_period', m.meal_period, 'status', m.status,
      'expected_headcount', m.expected_headcount,
      'actual_headcount', m.actual_headcount,
      'dishes', coalesce((SELECT jsonb_agg(i.dish_name ORDER BY i.id)
                          FROM public.menu_plan_items i WHERE i.menu_plan_id = m.id), '[]'::jsonb)
    ) AS x
    FROM public.menu_plans m
    WHERE m.canteen_id = p_canteen_id AND m.menu_date = p_date
  ) s;

  RETURN jsonb_build_object(
    'todays_purchase', round(v_purchase, 2),
    'todays_consumption', round(v_consumption, 2),
    'inventory_value', round(v_inv, 2),
    'low_stock_items', coalesce(v_low, 0),
    'month_consumption', round(v_month_cons, 2),
    'food_budget', v_budget,
    'pending_requisitions', coalesce(v_pending, 0),
    'todays_headcount', coalesce(v_heads, 0),
    'cost_per_head', CASE WHEN v_heads > 0 THEN round(v_consumption / v_heads, 2) END,
    'todays_menu', v_menu);
END;
$$;
