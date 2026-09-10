-- Reports keep historical dish-level wastage and add the new Unit 1/2/3
-- records. The UI no longer creates new dish-level wastage, so nothing is
-- double-counted going forward.

CREATE OR REPLACE FUNCTION public.meal_cost_report(
  p_canteen_id UUID, p_start DATE, p_end DATE
) RETURNS TABLE(
  meal_period TEXT, meals INT, headcount BIGINT,
  wastage_qty NUMERIC, avg_headcount NUMERIC
) LANGUAGE sql STABLE SET search_path = public AS $$
  WITH per_plan AS (
    SELECT m.id, m.meal_period,
           coalesce(m.actual_headcount, m.expected_headcount, 0) AS heads,
           coalesce((SELECT sum(mi.wastage_qty)
                       FROM public.menu_plan_items mi
                      WHERE mi.menu_plan_id = m.id), 0)
         + coalesce((SELECT sum(uw.quantity)
                       FROM public.menu_unit_wastage uw
                      WHERE uw.menu_plan_id = m.id), 0) AS wasted
      FROM public.menu_plans m
     WHERE m.canteen_id = p_canteen_id
       AND m.menu_date BETWEEN p_start AND p_end
  )
  SELECT p.meal_period, count(*)::int,
         coalesce(sum(p.heads), 0)::bigint,
         coalesce(sum(p.wasted), 0),
         round(avg(p.heads), 1)
    FROM per_plan p
   GROUP BY p.meal_period
   ORDER BY 3 DESC;
$$;

CREATE OR REPLACE FUNCTION public.operations_summary(
  p_canteen_id UUID, p_start DATE, p_end DATE
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_heads BIGINT; v_revenue NUMERIC; v_consumption NUMERIC;
  v_purchase NUMERIC; v_meals BIGINT; v_wastage NUMERIC; v_reqs BIGINT;
BEGIN
  IF NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  v_revenue := public.computed_sale(p_canteen_id, p_start, p_end);
  IF v_revenue = 0 THEN
    SELECT coalesce(sum(amount), 0) INTO v_revenue FROM public.meal_entries
     WHERE canteen_id = p_canteen_id AND entry_date BETWEEN p_start AND p_end;
  END IF;

  SELECT coalesce(sum(coalesce(actual_headcount, expected_headcount, 0)), 0), count(*)
    INTO v_heads, v_meals FROM public.menu_plans
   WHERE canteen_id = p_canteen_id AND menu_date BETWEEN p_start AND p_end
     AND status <> 'draft';

  SELECT coalesce(sum(coalesce(abs(l.value), -l.change_qty * coalesce(i.cost_per_unit, 0))), 0)
    INTO v_consumption
    FROM public.stock_ledger l JOIN public.ingredients i ON i.id = l.ingredient_id
   WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('recipe','issue')
     AND l.change_qty < 0
     AND coalesce(l.service_date, (l.created_at AT TIME ZONE 'Asia/Kolkata')::date)
         BETWEEN p_start AND p_end;

  SELECT coalesce(sum(total_amount), 0) INTO v_purchase FROM public.purchases
   WHERE canteen_id = p_canteen_id AND status = 'confirmed' AND NOT is_opening
     AND created_at >= (p_start::timestamp AT TIME ZONE 'Asia/Kolkata')
     AND created_at < ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');

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

  RETURN jsonb_build_object(
    'headcount', v_heads, 'meals_served', v_meals, 'revenue', v_revenue,
    'consumption', v_consumption, 'purchase', v_purchase,
    'wastage_qty', v_wastage, 'requisitions', v_reqs,
    'cost_per_person', CASE WHEN v_heads > 0 THEN round(v_consumption / v_heads, 2) END,
    'revenue_per_person', CASE WHEN v_heads > 0 THEN round(v_revenue / v_heads, 2) END,
    'food_cost_pct', CASE WHEN v_revenue > 0 THEN round(v_consumption * 100 / v_revenue, 2) END,
    'margin_per_person', CASE WHEN v_heads > 0 THEN round((v_revenue - v_consumption) / v_heads, 2) END);
END;
$$;

CREATE OR REPLACE FUNCTION public.period_summary(
  p_canteen_id UUID, p_start DATE, p_end DATE
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
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
    INTO v_purchase, v_opening_in FROM public.purchases
   WHERE canteen_id = p_canteen_id AND status = 'confirmed'
     AND created_at >= (p_start::timestamp AT TIME ZONE 'Asia/Kolkata')
     AND created_at < ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');

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

  SELECT coalesce(sum(coalesce(actual_headcount, expected_headcount, 0)), 0)
    INTO v_heads FROM public.menu_plans
   WHERE canteen_id = p_canteen_id AND menu_date BETWEEN p_start AND p_end
     AND status <> 'draft';

  v_sale := public.computed_sale(p_canteen_id, p_start, p_end);

  SELECT coalesce(sum(amount), 0) INTO v_expense FROM public.expenses
   WHERE canteen_id = p_canteen_id AND expense_date BETWEEN p_start AND p_end;

  SELECT coalesce(sum(r.stock_value), 0)
       - coalesce((SELECT sum(l.change_qty * coalesce(i2.cost_per_unit, 0))
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

  RETURN jsonb_build_object(
    'purchase', round(v_purchase, 2), 'opening_stock_in', round(v_opening_in, 2),
    'consumption', round(v_consumption, 2), 'adjustments', round(v_adjust, 2),
    'headcount', v_heads, 'sale', round(v_sale, 2), 'expenses', v_expense,
    'closing_stock', round(v_closing, 2), 'wastage', v_wastage,
    'cost_per_plate', CASE WHEN v_heads > 0 THEN round(v_consumption / v_heads, 2) END,
    'food_cost_pct', CASE WHEN v_sale > 0 THEN round(v_consumption * 100 / v_sale, 2) END);
END;
$$;

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
    SELECT m.menu_date, m.meal_period, 'Unit ' || w.unit_no,
           NULL::numeric, w.quantity, w.unit, NULL::numeric,
           w.photo_path, coalesce(u.email, '—'), w.created_at
      FROM public.menu_unit_wastage w
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
