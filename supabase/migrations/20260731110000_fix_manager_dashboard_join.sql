-- manager_dashboard joined ingredient_rates to ingredients USING (id), but
-- the view exposes ingredient_id — so the whole dashboard errored out and
-- the manager saw only the store keeper half of the screen.
-- Safe to re-run.

CREATE OR REPLACE FUNCTION public.manager_dashboard(p_canteen_id UUID, p_date DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_t0 TIMESTAMPTZ := (p_date::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_t1 TIMESTAMPTZ := ((p_date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_m0 DATE := date_trunc('month', p_date)::date;
  v_purchase NUMERIC; v_consumption NUMERIC; v_inv NUMERIC;
  v_budget NUMERIC; v_month_cons NUMERIC; v_low INT; v_pending INT;
  v_menu JSONB; v_heads INT;
BEGIN
  SELECT coalesce(sum(total_amount), 0) INTO v_purchase FROM public.purchases
  WHERE canteen_id = p_canteen_id AND status = 'confirmed'
    AND created_at >= v_t0 AND created_at < v_t1;

  SELECT coalesce(-sum(l.change_qty * r.latest_rate), 0) INTO v_consumption
  FROM public.stock_ledger l JOIN public.ingredient_rates r ON r.ingredient_id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('issue','recipe')
    AND l.change_qty < 0 AND l.created_at >= v_t0 AND l.created_at < v_t1;

  -- inventory value at invoice rates, plus how many items sit at or below
  -- their reorder level
  SELECT coalesce(sum(i.current_stock * r.latest_rate), 0),
         count(*) FILTER (
           WHERE coalesce(i.reorder_level, i.minimum_stock, 0) > 0
             AND i.current_stock <= coalesce(i.reorder_level, i.minimum_stock, 0))
  INTO v_inv, v_low
  FROM public.ingredients i
  JOIN public.ingredient_rates r ON r.ingredient_id = i.id
  WHERE i.canteen_id = p_canteen_id;

  SELECT coalesce(-sum(l.change_qty * r.latest_rate), 0) INTO v_month_cons
  FROM public.stock_ledger l JOIN public.ingredient_rates r ON r.ingredient_id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('issue','recipe')
    AND l.change_qty < 0
    AND l.created_at >= (v_m0::timestamp AT TIME ZONE 'Asia/Kolkata');

  SELECT food_budget INTO v_budget FROM public.site_budgets
  WHERE canteen_id = p_canteen_id AND budget_month = v_m0;

  SELECT count(*) INTO v_pending FROM public.requisitions
  WHERE canteen_id = p_canteen_id AND status = 'pending';

  SELECT coalesce(sum(coalesce(actual_headcount, expected_headcount, 0)), 0) INTO v_heads
  FROM public.menu_plans WHERE canteen_id = p_canteen_id AND menu_date = p_date;

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'meal_period'), '[]'::jsonb) INTO v_menu FROM (
    SELECT jsonb_build_object(
      'meal_period', m.meal_period, 'status', m.status,
      'headcount', coalesce(m.actual_headcount, m.expected_headcount, 0),
      'dishes', (SELECT coalesce(jsonb_agg(mi.dish_name), '[]'::jsonb)
                 FROM public.menu_plan_items mi WHERE mi.menu_plan_id = m.id)
    ) AS x
    FROM public.menu_plans m
    WHERE m.canteen_id = p_canteen_id AND m.menu_date = p_date
  ) t;

  RETURN jsonb_build_object(
    'date', p_date,
    'todays_menu', v_menu,
    'headcount', v_heads,
    'todays_purchase', round(v_purchase, 2),
    'todays_consumption', round(v_consumption, 2),
    'inventory_value', round(v_inv, 2),
    'low_stock_items', v_low,
    'pending_requisitions', v_pending,
    'food_budget', coalesce(v_budget, 0),
    'month_consumption', round(v_month_cons, 2),
    'budget_balance', CASE WHEN coalesce(v_budget,0) > 0
                           THEN round(v_budget - v_month_cons, 2) END,
    'budget_used_pct', CASE WHEN coalesce(v_budget,0) > 0
                           THEN round(v_month_cons * 100 / v_budget, 2) END,
    'cost_per_head', CASE WHEN v_heads > 0 THEN round(v_consumption / v_heads, 2) END
  );
END;
$$;
REVOKE ALL ON FUNCTION public.manager_dashboard(UUID,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manager_dashboard(UUID,DATE) TO authenticated;
