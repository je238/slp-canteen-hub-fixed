-- Restore every field used by Reports and Comparison while retaining the
-- FIFO/service-date calculations introduced by the newer reporting function.

CREATE OR REPLACE FUNCTION public.period_summary(
  p_canteen_id UUID, p_start DATE, p_end DATE
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_t0 TIMESTAMPTZ := (p_start::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_t1 TIMESTAMPTZ := ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_purchase NUMERIC; v_consumption NUMERIC; v_heads BIGINT; v_sale NUMERIC;
  v_actual_heads BIGINT; v_provisional_heads BIGINT; v_meals BIGINT;
  v_expense NUMERIC; v_closing NUMERIC; v_wastage NUMERIC; v_opening_in NUMERIC;
  v_adjust NUMERIC; v_reqs BIGINT; v_alerts BIGINT; v_budget NUMERIC;
  v_top JSONB; v_vendors JSONB;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_start > p_end THEN
    RAISE EXCEPTION 'Invalid report date range';
  END IF;
  IF NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  SELECT coalesce(sum(total_amount) FILTER (WHERE NOT is_opening), 0),
         coalesce(sum(total_amount) FILTER (WHERE is_opening), 0)
    INTO v_purchase, v_opening_in FROM public.purchases
   WHERE canteen_id = p_canteen_id AND status = 'confirmed'
     AND created_at >= v_t0 AND created_at < v_t1;

  SELECT coalesce(sum(coalesce(abs(l.value), -l.change_qty * coalesce(i.cost_per_unit, 0))), 0)
    INTO v_consumption
    FROM public.stock_ledger l JOIN public.ingredients i ON i.id = l.ingredient_id
   WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('issue','recipe')
     AND l.change_qty < 0
     AND coalesce(l.service_date, (l.created_at AT TIME ZONE 'Asia/Kolkata')::date)
         BETWEEN p_start AND p_end;

  SELECT coalesce(sum(CASE WHEN l.reference_type = 'reprice' THEN coalesce(l.value, 0)
                    ELSE sign(l.change_qty) * abs(coalesce(l.value,
                         l.change_qty * coalesce(i.cost_per_unit, 0))) END), 0)
    INTO v_adjust
    FROM public.stock_ledger l JOIN public.ingredients i ON i.id = l.ingredient_id
   WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('manual','audit','reprice')
     AND coalesce(l.service_date, (l.created_at AT TIME ZONE 'Asia/Kolkata')::date)
         BETWEEN p_start AND p_end;

  SELECT coalesce(sum(coalesce(actual_headcount, expected_headcount, 0)), 0),
         coalesce(sum(actual_headcount) FILTER (WHERE actual_headcount IS NOT NULL), 0),
         coalesce(sum(expected_headcount) FILTER (WHERE actual_headcount IS NULL), 0),
         count(*)
    INTO v_heads, v_actual_heads, v_provisional_heads, v_meals
    FROM public.menu_plans
   WHERE canteen_id = p_canteen_id AND menu_date BETWEEN p_start AND p_end
     AND status <> 'draft';

  v_sale := public.computed_sale(p_canteen_id, p_start, p_end);

  SELECT coalesce(sum(amount), 0) INTO v_expense FROM public.expenses
   WHERE canteen_id = p_canteen_id AND expense_date BETWEEN p_start AND p_end;

  -- Period-end value: start with today's FIFO lot value and reverse every
  -- later movement. Values stamped on issue rows retain the original FIFO cost.
  SELECT coalesce(sum(r.stock_value), 0)
       - coalesce((SELECT sum(CASE
           WHEN l.reference_type = 'reprice' THEN coalesce(l.value, 0)
           WHEN l.change_qty > 0 THEN abs(coalesce(l.value, l.change_qty * coalesce(i2.cost_per_unit, 0)))
           WHEN l.change_qty < 0 THEN -abs(coalesce(l.value, l.change_qty * coalesce(i2.cost_per_unit, 0)))
           ELSE 0 END)
           FROM public.stock_ledger l JOIN public.ingredients i2 ON i2.id = l.ingredient_id
          WHERE l.canteen_id = p_canteen_id
            AND coalesce(l.service_date, (l.created_at AT TIME ZONE 'Asia/Kolkata')::date) > p_end), 0)
    INTO v_closing FROM public.ingredient_rates r WHERE r.canteen_id = p_canteen_id;
  v_closing := greatest(v_closing, 0);

  SELECT coalesce(sum(x.wasted), 0) INTO v_wastage
    FROM public.menu_plans m
    CROSS JOIN LATERAL (
      SELECT coalesce((SELECT sum(mi.wastage_qty) FROM public.menu_plan_items mi
                        WHERE mi.menu_plan_id = m.id), 0)
           + coalesce((SELECT sum(uw.quantity) FROM public.menu_unit_wastage uw
                        WHERE uw.menu_plan_id = m.id), 0) AS wasted
    ) x
   WHERE m.canteen_id = p_canteen_id AND m.menu_date BETWEEN p_start AND p_end;

  SELECT count(*) INTO v_reqs FROM public.requisitions
   WHERE canteen_id = p_canteen_id AND req_date BETWEEN p_start AND p_end;
  SELECT count(*) INTO v_alerts FROM public.fraud_alerts
   WHERE canteen_id = p_canteen_id AND status = 'open';
  SELECT food_budget INTO v_budget FROM public.site_budgets
   WHERE canteen_id = p_canteen_id AND budget_month = date_trunc('month', p_start)::date;

  SELECT coalesce(jsonb_agg(t), '[]'::jsonb) INTO v_top FROM (
    SELECT i.name, round(-sum(l.change_qty), 2) AS qty, i.unit,
           round(sum(coalesce(abs(l.value), -l.change_qty * coalesce(i.cost_per_unit, 0))), 2) AS value
      FROM public.stock_ledger l JOIN public.ingredients i ON i.id = l.ingredient_id
     WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('issue','recipe')
       AND l.change_qty < 0
       AND coalesce(l.service_date, (l.created_at AT TIME ZONE 'Asia/Kolkata')::date)
           BETWEEN p_start AND p_end
     GROUP BY i.name, i.unit ORDER BY 4 DESC LIMIT 10
  ) t;

  SELECT coalesce(jsonb_agg(v), '[]'::jsonb) INTO v_vendors FROM (
    SELECT coalesce(s.name, 'Unknown') AS vendor, count(*) AS bills,
           round(sum(p.total_amount), 2) AS amount
      FROM public.purchases p LEFT JOIN public.suppliers s ON s.id = p.supplier_id
     WHERE p.canteen_id = p_canteen_id AND p.status = 'confirmed' AND NOT p.is_opening
       AND p.created_at >= v_t0 AND p.created_at < v_t1
     GROUP BY s.name ORDER BY 3 DESC LIMIT 10
  ) v;

  RETURN jsonb_build_object(
    'start', p_start, 'end', p_end, 'days', (p_end - p_start) + 1,
    'purchase', round(v_purchase, 2), 'opening_stock_in', round(v_opening_in, 2),
    'consumption', round(v_consumption, 2), 'adjustments', round(v_adjust, 2),
    'headcount', v_heads, 'actual_headcount', v_actual_heads,
    'provisional_headcount', v_provisional_heads, 'meals_planned', v_meals,
    'sale', round(v_sale, 2), 'expenses', round(v_expense, 2),
    'closing_stock', round(v_closing, 2),
    'wastage', v_wastage, 'wastage_qty', v_wastage,
    'cost_per_plate', CASE WHEN v_heads > 0 THEN round(v_consumption / v_heads, 2) END,
    'cost_per_head', CASE WHEN v_heads > 0 THEN round(v_consumption / v_heads, 2) END,
    'food_cost_pct', CASE WHEN v_sale > 0 THEN round(v_consumption * 100 / v_sale, 2) END,
    'requisitions', v_reqs, 'open_alerts', v_alerts,
    'food_budget_month', v_budget,
    'budget_used_pct', CASE WHEN coalesce(v_budget, 0) > 0
                            THEN round(v_consumption * 100 / v_budget, 2) END,
    'top_items', v_top, 'vendors', v_vendors);
END;
$$;

REVOKE ALL ON FUNCTION public.period_summary(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.period_summary(UUID, DATE, DATE) TO authenticated;
