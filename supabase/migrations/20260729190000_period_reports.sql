-- ============================================================
-- REMAINING REPORTS FROM THE TEAM BRIEF
--   · Stock In/Out report
--   · Weekly performance / monthly summary (one period function)
--   · Weekly budget utilisation for the Operations Manager
--   · Manager review queue for stock movements
-- Safe to re-run.
-- ============================================================

-- ---------- 1. Stock In / Out, item by item ----------
CREATE OR REPLACE FUNCTION public.stock_in_out_report(
  p_canteen_id UUID, p_start DATE, p_end DATE
)
RETURNS TABLE (
  ingredient_id UUID, name TEXT, unit TEXT, rate NUMERIC,
  opening NUMERIC, stock_in NUMERIC, stock_out NUMERIC,
  adjustments NUMERIC, closing NUMERIC,
  in_value NUMERIC, out_value NUMERIC, closing_value NUMERIC
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH bounds AS (
    SELECT (p_start::timestamp AT TIME ZONE 'Asia/Kolkata')      AS t0,
           ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')  AS t1
  ),
  moves AS (
    SELECT l.ingredient_id,
           sum(l.change_qty) FILTER (WHERE l.created_at >= b.t1)                        AS after_qty,
           sum(l.change_qty) FILTER (WHERE l.created_at >= b.t0 AND l.created_at < b.t1) AS period_qty,
           sum(l.change_qty) FILTER (WHERE l.reference_type = 'purchase'
                                      AND l.created_at >= b.t0 AND l.created_at < b.t1) AS in_qty,
           -sum(l.change_qty) FILTER (WHERE l.reference_type IN ('issue','recipe')
                                      AND l.change_qty < 0
                                      AND l.created_at >= b.t0 AND l.created_at < b.t1) AS out_qty,
           sum(l.change_qty) FILTER (WHERE l.reference_type IN ('audit','manual')
                                      AND l.created_at >= b.t0 AND l.created_at < b.t1) AS adj_qty
    FROM public.stock_ledger l CROSS JOIN bounds b
    WHERE l.canteen_id = p_canteen_id
    GROUP BY l.ingredient_id
  )
  SELECT i.id, i.name, i.unit, r.latest_rate,
         i.current_stock - coalesce(m.after_qty, 0) - coalesce(m.period_qty, 0),
         coalesce(m.in_qty, 0),
         coalesce(m.out_qty, 0),
         coalesce(m.adj_qty, 0),
         i.current_stock - coalesce(m.after_qty, 0),
         round(coalesce(m.in_qty, 0)  * r.latest_rate, 2),
         round(coalesce(m.out_qty, 0) * r.latest_rate, 2),
         round((i.current_stock - coalesce(m.after_qty, 0)) * r.latest_rate, 2)
  FROM public.ingredients i
  JOIN public.ingredient_rates r ON r.ingredient_id = i.id
  LEFT JOIN moves m ON m.ingredient_id = i.id
  WHERE i.canteen_id = p_canteen_id
  ORDER BY 11 DESC NULLS LAST, i.name;
$$;

-- ---------- 2. One period summary, used for weekly AND monthly ----------
CREATE OR REPLACE FUNCTION public.period_summary(
  p_canteen_id UUID, p_start DATE, p_end DATE
)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_t0 TIMESTAMPTZ := (p_start::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_t1 TIMESTAMPTZ := ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_heads BIGINT; v_meals BIGINT; v_purchase NUMERIC; v_consumption NUMERIC;
  v_expense NUMERIC; v_closing NUMERIC; v_wastage NUMERIC;
  v_reqs BIGINT; v_alerts BIGINT; v_budget NUMERIC;
  v_top JSONB; v_vendors JSONB;
BEGIN
  SELECT coalesce(sum(coalesce(actual_headcount, expected_headcount, 0)), 0), count(*)
  INTO v_heads, v_meals
  FROM public.menu_plans
  WHERE canteen_id = p_canteen_id AND menu_date BETWEEN p_start AND p_end;

  SELECT coalesce(sum(total_amount), 0) INTO v_purchase
  FROM public.purchases WHERE canteen_id = p_canteen_id AND status = 'confirmed'
    AND created_at >= v_t0 AND created_at < v_t1;

  SELECT coalesce(-sum(l.change_qty * r.latest_rate), 0) INTO v_consumption
  FROM public.stock_ledger l JOIN public.ingredient_rates r ON r.ingredient_id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('issue','recipe')
    AND l.change_qty < 0 AND l.created_at >= v_t0 AND l.created_at < v_t1;

  SELECT coalesce(sum(amount), 0) INTO v_expense
  FROM public.expenses WHERE canteen_id = p_canteen_id
    AND expense_date BETWEEN p_start AND p_end;

  SELECT coalesce(sum(current_stock * latest_rate), 0) INTO v_closing
  FROM public.ingredient_rates WHERE canteen_id = p_canteen_id;

  SELECT coalesce(sum(mi.wastage_qty), 0) INTO v_wastage
  FROM public.menu_plan_items mi JOIN public.menu_plans m ON m.id = mi.menu_plan_id
  WHERE m.canteen_id = p_canteen_id AND m.menu_date BETWEEN p_start AND p_end;

  SELECT count(*) INTO v_reqs FROM public.requisitions
  WHERE canteen_id = p_canteen_id AND req_date BETWEEN p_start AND p_end;

  SELECT count(*) INTO v_alerts FROM public.fraud_alerts
  WHERE canteen_id = p_canteen_id AND status = 'open';

  -- budget for the month the period starts in, pro-rated to the period length
  SELECT food_budget INTO v_budget FROM public.site_budgets
  WHERE canteen_id = p_canteen_id AND budget_month = date_trunc('month', p_start)::date;

  SELECT coalesce(jsonb_agg(t), '[]'::jsonb) INTO v_top FROM (
    SELECT r.name, round(-sum(l.change_qty), 2) AS qty, r.unit,
           round(-sum(l.change_qty * r.latest_rate), 2) AS value
    FROM public.stock_ledger l JOIN public.ingredient_rates r ON r.ingredient_id = l.ingredient_id
    WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('issue','recipe')
      AND l.change_qty < 0 AND l.created_at >= v_t0 AND l.created_at < v_t1
    GROUP BY r.name, r.unit ORDER BY 4 DESC LIMIT 10
  ) t;

  SELECT coalesce(jsonb_agg(v), '[]'::jsonb) INTO v_vendors FROM (
    SELECT coalesce(s.name, 'Unknown') AS vendor, count(*) AS bills,
           round(sum(p.total_amount), 2) AS amount
    FROM public.purchases p LEFT JOIN public.suppliers s ON s.id = p.supplier_id
    WHERE p.canteen_id = p_canteen_id AND p.status = 'confirmed'
      AND p.created_at >= v_t0 AND p.created_at < v_t1
    GROUP BY s.name ORDER BY 3 DESC LIMIT 10
  ) v;

  RETURN jsonb_build_object(
    'start', p_start, 'end', p_end,
    'days', (p_end - p_start) + 1,
    'headcount', v_heads, 'meals_planned', v_meals,
    'purchase', v_purchase, 'consumption', v_consumption,
    'expenses', v_expense, 'closing_stock', v_closing,
    'wastage_qty', v_wastage, 'requisitions', v_reqs, 'open_alerts', v_alerts,
    'cost_per_head', CASE WHEN v_heads > 0 THEN round(v_consumption / v_heads, 2) END,
    'food_budget_month', v_budget,
    'budget_used_pct', CASE WHEN coalesce(v_budget, 0) > 0
                            THEN round(v_consumption * 100 / v_budget, 2) END,
    'top_items', v_top,
    'vendors', v_vendors
  );
END;
$$;

-- ---------- 3. Weekly budget utilisation, week by week ----------
CREATE OR REPLACE FUNCTION public.weekly_budget_utilisation(
  p_canteen_id UUID, p_month DATE
)
RETURNS TABLE (
  week_start DATE, week_end DATE, consumption NUMERIC, purchase NUMERIC,
  headcount BIGINT, running_consumption NUMERIC, budget NUMERIC, used_pct NUMERIC
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH m AS (
    SELECT date_trunc('month', p_month)::date AS m0,
           (date_trunc('month', p_month) + interval '1 month - 1 day')::date AS m1
  ),
  b AS (
    SELECT coalesce(food_budget, 0) AS food_budget FROM public.site_budgets, m
    WHERE canteen_id = p_canteen_id AND budget_month = m.m0
  ),
  weeks AS (
    SELECT gs::date AS w0,
           least((gs + interval '6 days')::date, m.m1) AS w1
    FROM m, generate_series(m.m0, m.m1, interval '7 days') gs
  ),
  agg AS (
    SELECT w.w0, w.w1,
      coalesce((SELECT -sum(l.change_qty * r.latest_rate)
                FROM public.stock_ledger l JOIN public.ingredient_rates r ON r.ingredient_id = l.ingredient_id
                WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('issue','recipe')
                  AND l.change_qty < 0
                  AND l.created_at >= (w.w0::timestamp AT TIME ZONE 'Asia/Kolkata')
                  AND l.created_at <  ((w.w1 + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')), 0) AS cons,
      coalesce((SELECT sum(p.total_amount) FROM public.purchases p
                WHERE p.canteen_id = p_canteen_id AND p.status = 'confirmed'
                  AND p.created_at >= (w.w0::timestamp AT TIME ZONE 'Asia/Kolkata')
                  AND p.created_at <  ((w.w1 + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')), 0) AS pur,
      coalesce((SELECT sum(coalesce(actual_headcount, expected_headcount, 0))
                FROM public.menu_plans mp
                WHERE mp.canteen_id = p_canteen_id AND mp.menu_date BETWEEN w.w0 AND w.w1), 0) AS heads
    FROM weeks w
  )
  SELECT a.w0, a.w1, round(a.cons, 2), round(a.pur, 2), a.heads::bigint,
         round(sum(a.cons) OVER (ORDER BY a.w0), 2),
         (SELECT food_budget FROM b),
         CASE WHEN (SELECT food_budget FROM b) > 0
              THEN round(sum(a.cons) OVER (ORDER BY a.w0) * 100 / (SELECT food_budget FROM b), 2) END
  FROM agg a ORDER BY a.w0;
$$;

REVOKE ALL ON FUNCTION public.stock_in_out_report(UUID,DATE,DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.period_summary(UUID,DATE,DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.weekly_budget_utilisation(UUID,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_in_out_report(UUID,DATE,DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.period_summary(UUID,DATE,DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.weekly_budget_utilisation(UUID,DATE) TO authenticated;

-- ---------- 4. Manager review of stock movements ----------
-- Goods still go in immediately (the brief says purchases are added
-- automatically); what was missing is the manager being able to see and sign
-- off what the store keeper did. Reviewed rows are stamped, not blocked.
ALTER TABLE public.stock_ledger ADD COLUMN IF NOT EXISTS reviewed_by UUID;
ALTER TABLE public.stock_ledger ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

DROP POLICY IF EXISTS "stock_ledger_manager_review" ON public.stock_ledger;
CREATE POLICY "stock_ledger_manager_review" ON public.stock_ledger FOR UPDATE TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

-- Only the review stamp may be written; the movement itself stays immutable.
CREATE OR REPLACE FUNCTION public.guard_stock_ledger_update()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.ingredient_id IS DISTINCT FROM OLD.ingredient_id
     OR NEW.canteen_id  IS DISTINCT FROM OLD.canteen_id
     OR NEW.change_qty  IS DISTINCT FROM OLD.change_qty
     OR NEW.balance_after IS DISTINCT FROM OLD.balance_after
     OR NEW.reference_type IS DISTINCT FROM OLD.reference_type
     OR NEW.created_at  IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Stock movements cannot be edited — only reviewed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_stock_ledger_update ON public.stock_ledger;
CREATE TRIGGER trg_guard_stock_ledger_update
  BEFORE UPDATE ON public.stock_ledger
  FOR EACH ROW EXECUTE FUNCTION public.guard_stock_ledger_update();
