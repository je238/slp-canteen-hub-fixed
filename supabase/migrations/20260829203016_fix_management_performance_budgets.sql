-- Management dashboards must use the same accounting engine as Reports.
-- The old implementations still read the retired meal_entries table and
-- valued issues at today's master rate instead of their FIFO issue value.

CREATE OR REPLACE FUNCTION public.site_performance(p_start DATE, p_end DATE)
RETURNS TABLE (
  canteen_id UUID, site_name TEXT, headcount BIGINT, revenue NUMERIC,
  consumption NUMERIC, purchase NUMERIC, food_cost_pct NUMERIC,
  cost_per_person NUMERIC, inventory_value NUMERIC, open_alerts BIGINT
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_site RECORD;
  v_summary JSONB;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_start > p_end THEN
    RAISE EXCEPTION 'Invalid report date range';
  END IF;

  FOR v_site IN
    SELECT c.id, c.name
    FROM public.canteens c
    WHERE public.can_access_canteen(c.id)
    ORDER BY c.name
  LOOP
    v_summary := public.period_summary(v_site.id, p_start, p_end);
    canteen_id := v_site.id;
    site_name := v_site.name;
    headcount := COALESCE((v_summary->>'headcount')::BIGINT, 0);
    revenue := COALESCE((v_summary->>'sale')::NUMERIC, 0);
    consumption := COALESCE((v_summary->>'consumption')::NUMERIC, 0);
    purchase := COALESCE((v_summary->>'purchase')::NUMERIC, 0);
    food_cost_pct := (v_summary->>'food_cost_pct')::NUMERIC;
    cost_per_person := (v_summary->>'cost_per_head')::NUMERIC;
    SELECT COALESCE(SUM(r.stock_value), 0)
      INTO inventory_value
      FROM public.ingredient_rates r
      WHERE r.canteen_id = v_site.id;
    open_alerts := COALESCE((v_summary->>'open_alerts')::BIGINT, 0);
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.site_performance(DATE,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_performance(DATE,DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.budget_vs_actual(p_canteen_id UUID, p_month DATE)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_month DATE := date_trunc('month', p_month)::DATE;
  v_start DATE := GREATEST(date_trunc('month', p_month)::DATE, DATE '2026-08-19');
  v_month_end DATE := (date_trunc('month', p_month) + INTERVAL '1 month - 1 day')::DATE;
  v_report_end DATE := LEAST(v_month_end, (now() AT TIME ZONE 'Asia/Kolkata')::DATE);
  v_b public.site_budgets%ROWTYPE;
  v JSONB := '{}'::JSONB;
  v_purchase NUMERIC := 0;
  v_consumption NUMERIC := 0;
  v_expense NUMERIC := 0;
  v_revenue NUMERIC := 0;
  v_days_elapsed INTEGER := 0;
  v_days_in_month INTEGER := extract(day from v_month_end)::INTEGER;
BEGIN
  IF NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  SELECT * INTO v_b FROM public.site_budgets
  WHERE canteen_id = p_canteen_id AND budget_month = v_month;

  IF v_report_end >= v_start THEN
    v := public.period_summary(p_canteen_id, v_start, v_report_end);
    v_purchase := COALESCE((v->>'purchase')::NUMERIC, 0);
    v_consumption := COALESCE((v->>'consumption')::NUMERIC, 0);
    v_expense := COALESCE((v->>'expenses')::NUMERIC, 0);
    v_revenue := COALESCE((v->>'sale')::NUMERIC, 0);
    v_days_elapsed := (v_report_end - v_start) + 1;
  END IF;

  RETURN jsonb_build_object(
    'month', v_month, 'reporting_start', v_start, 'reporting_end', v_report_end,
    'days_elapsed', v_days_elapsed, 'days_in_month', v_days_in_month,
    'food_budget', COALESCE(v_b.food_budget, 0),
    'labour_budget', COALESCE(v_b.labour_budget, 0),
    'purchase_budget', COALESCE(v_b.purchase_budget, 0),
    'target_food_cost_pct', v_b.food_cost_pct,
    'actual_purchase', round(v_purchase, 2),
    'actual_consumption', round(v_consumption, 2),
    'actual_expense', round(v_expense, 2),
    'revenue', round(v_revenue, 2),
    'food_cost_pct', CASE WHEN v_revenue > 0 THEN round(v_consumption * 100 / v_revenue, 2) END,
    'food_used_pct', CASE WHEN COALESCE(v_b.food_budget,0) > 0 THEN round(v_consumption * 100 / v_b.food_budget, 2) END,
    'purchase_used_pct', CASE WHEN COALESCE(v_b.purchase_budget,0) > 0 THEN round(v_purchase * 100 / v_b.purchase_budget, 2) END,
    'projected_food', CASE WHEN v_days_elapsed > 0 THEN round(v_consumption / v_days_elapsed * v_days_in_month, 2) END,
    'projected_purchase', CASE WHEN v_days_elapsed > 0 THEN round(v_purchase / v_days_elapsed * v_days_in_month, 2) END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.budget_vs_actual(UUID,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.budget_vs_actual(UUID,DATE) TO authenticated;
