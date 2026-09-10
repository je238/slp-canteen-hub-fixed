-- ============================================================
-- THE RATE CARD, AND THE SALE FIGURE IT MAKES POSSIBLE
--
-- The owner's contracted per-plate rates for Eicher (given 03 Aug 2026):
--   breakfast ₹11 · lunch ₹54 · evening snacks ₹11 · dinner ₹54 · mid night ₹11
--
-- Until now the app could count plates but not bill them — the client's own
-- Cost sheet carried a Sale column typed by hand, and July's and August's
-- were stale copies of June's. With rates in the database the sale is
-- computed: plates served × contracted rate, per meal, per unit. Nobody
-- types a sale figure again.
--
-- Rates are master data: staff read them, admin and super admin set them —
-- the same rule as every other recorded figure. meal_period is free text so
-- guest/OT/training/VVIP rates can be added as their own rows when the
-- owner supplies them.
--
-- Safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.meal_rates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  canteen_id UUID NOT NULL REFERENCES public.canteens(id) ON DELETE CASCADE,
  meal_period TEXT NOT NULL,
  rate NUMERIC NOT NULL CHECK (rate >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (canteen_id, meal_period)
);
ALTER TABLE public.meal_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "meal_rates_staff_select" ON public.meal_rates;
CREATE POLICY "meal_rates_staff_select" ON public.meal_rates FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));

DROP POLICY IF EXISTS "meal_rates_admin_write" ON public.meal_rates;
CREATE POLICY "meal_rates_admin_write" ON public.meal_rates FOR ALL TO authenticated
  USING (public.is_admin_editor()) WITH CHECK (public.is_admin_editor());

-- The owner's rates, for every Eicher unit. Idempotent.
INSERT INTO public.meal_rates (canteen_id, meal_period, rate)
SELECT c.id, r.period, r.rate
FROM public.canteens c
CROSS JOIN (VALUES
  ('breakfast', 11), ('lunch', 54), ('evening_snacks', 11),
  ('dinner', 54), ('night_snacks', 11), ('tea', 0)
) AS r(period, rate)
WHERE c.name ILIKE 'Eicher%'
ON CONFLICT (canteen_id, meal_period) DO NOTHING;

-- ---------- Sale, computed ----------
-- plates served (or expected, until the count is entered) × the rate.
CREATE OR REPLACE FUNCTION public.computed_sale(p_canteen_id UUID, p_start DATE, p_end DATE)
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT coalesce(sum(coalesce(m.actual_headcount, m.expected_headcount, 0) * r.rate), 0)
  FROM public.menu_plans m
  JOIN public.meal_rates r ON r.canteen_id = m.canteen_id AND r.meal_period = m.meal_period
  WHERE m.canteen_id = p_canteen_id AND m.status <> 'draft'
    AND m.menu_date BETWEEN p_start AND p_end;
$$;

-- operations_summary: revenue becomes the computed sale when rates exist,
-- falling back to recorded meal entries for any site without a rate card.
CREATE OR REPLACE FUNCTION public.operations_summary(p_canteen_id UUID, p_start DATE, p_end DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_heads BIGINT; v_revenue NUMERIC; v_consumption NUMERIC;
  v_purchase NUMERIC; v_meals BIGINT; v_wastage NUMERIC; v_reqs BIGINT;
BEGIN
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

  SELECT coalesce(-sum(l.change_qty * coalesce(i.cost_per_unit, 0)), 0)
  INTO v_consumption
  FROM public.stock_ledger l JOIN public.ingredients i ON i.id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('recipe','issue')
    AND l.created_at >= (p_start::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND l.created_at <  ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');

  SELECT coalesce(sum(total_amount), 0) INTO v_purchase
  FROM public.purchases
  WHERE canteen_id = p_canteen_id AND status = 'confirmed'
    AND created_at >= (p_start::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND created_at <  ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');

  SELECT coalesce(sum(mi.wastage_qty), 0) INTO v_wastage
  FROM public.menu_plan_items mi JOIN public.menu_plans m ON m.id = mi.menu_plan_id
  WHERE m.canteen_id = p_canteen_id AND m.menu_date BETWEEN p_start AND p_end;

  SELECT count(*) INTO v_reqs FROM public.requisitions
  WHERE canteen_id = p_canteen_id AND req_date BETWEEN p_start AND p_end;

  RETURN jsonb_build_object(
    'headcount', v_heads,
    'meals_served', v_meals,
    'revenue', v_revenue,
    'consumption', v_consumption,
    'purchase', v_purchase,
    'wastage_qty', v_wastage,
    'requisitions', v_reqs,
    'cost_per_person', CASE WHEN v_heads > 0 THEN round(v_consumption / v_heads, 2) END,
    'revenue_per_person', CASE WHEN v_heads > 0 THEN round(v_revenue / v_heads, 2) END,
    'food_cost_pct', CASE WHEN v_revenue > 0 THEN round(v_consumption * 100 / v_revenue, 2) END,
    'margin_per_person', CASE WHEN v_heads > 0
                              THEN round((v_revenue - v_consumption) / v_heads, 2) END
  );
END;
$$;

-- period_summary gains the same sale figure and a food-cost %.
-- Same body as before, plus 'sale' and 'food_cost_pct' in the result.
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
  v_reqs BIGINT; v_alerts BIGINT; v_budget NUMERIC; v_sale NUMERIC;
  v_top JSONB; v_vendors JSONB;
BEGIN
  SELECT coalesce(sum(coalesce(actual_headcount, expected_headcount, 0)), 0), count(*)
  INTO v_heads, v_meals
  FROM public.menu_plans
  WHERE canteen_id = p_canteen_id AND menu_date BETWEEN p_start AND p_end;

  v_sale := public.computed_sale(p_canteen_id, p_start, p_end);

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
    'sale', v_sale,
    'food_cost_pct', CASE WHEN v_sale > 0 THEN round(v_consumption * 100 / v_sale, 2) END,
    'food_budget_month', v_budget,
    'budget_used_pct', CASE WHEN coalesce(v_budget, 0) > 0
                            THEN round(v_consumption * 100 / v_budget, 2) END,
    'top_items', v_top,
    'vendors', v_vendors
  );
END;
$$;
