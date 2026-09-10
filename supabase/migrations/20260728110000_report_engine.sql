-- ============================================================
-- REPORT ENGINE
-- Aggregations run in Postgres, not the browser: the ledger grows
-- forever and shipping it to the client to sum would stop scaling.
-- All are SECURITY INVOKER so RLS still decides what a caller sees.
-- Date params are inclusive DATEs interpreted in IST.
-- Safe to re-run.
-- ============================================================

-- ---------- Purchases: vendor-wise and item-wise ----------
CREATE OR REPLACE FUNCTION public.purchase_report(
  p_canteen_id UUID, p_start DATE, p_end DATE
)
RETURNS TABLE (
  scope TEXT, label TEXT, qty NUMERIC, amount NUMERIC, txn_count BIGINT
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH win AS (
    SELECT p.id, p.total_amount, p.supplier_id, p.created_at
    FROM public.purchases p
    WHERE p.canteen_id = p_canteen_id AND p.status = 'confirmed'
      AND p.created_at >= (p_start::timestamp AT TIME ZONE 'Asia/Kolkata')
      AND p.created_at <  ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
  )
  SELECT 'vendor', coalesce(s.name, 'Unknown vendor'), NULL::numeric,
         sum(w.total_amount), count(*)
  FROM win w LEFT JOIN public.suppliers s ON s.id = w.supplier_id
  GROUP BY s.name
  UNION ALL
  SELECT 'item', pi.item_name, sum(pi.quantity), sum(pi.total), count(*)
  FROM win w JOIN public.purchase_items pi ON pi.purchase_id = w.id
  GROUP BY pi.item_name
  UNION ALL
  SELECT 'day', to_char(w.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD'),
         NULL::numeric, sum(w.total_amount), count(*)
  FROM win w
  GROUP BY 2
  ORDER BY 1, 4 DESC NULLS LAST;
$$;

-- ---------- Consumption: what left the store, by item and by day ----------
CREATE OR REPLACE FUNCTION public.consumption_report(
  p_canteen_id UUID, p_start DATE, p_end DATE
)
RETURNS TABLE (
  scope TEXT, label TEXT, qty NUMERIC, value NUMERIC, unit TEXT
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH win AS (
    SELECT l.*, i.name, i.unit, coalesce(i.cost_per_unit, 0) AS cost
    FROM public.stock_ledger l
    JOIN public.ingredients i ON i.id = l.ingredient_id
    WHERE l.canteen_id = p_canteen_id
      AND l.reference_type IN ('recipe','issue')
      AND l.created_at >= (p_start::timestamp AT TIME ZONE 'Asia/Kolkata')
      AND l.created_at <  ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
  )
  SELECT 'item', name, -sum(change_qty), -sum(change_qty * cost), max(unit)
  FROM win GROUP BY name
  UNION ALL
  SELECT 'day', to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD'),
         NULL::numeric, -sum(change_qty * cost), NULL
  FROM win GROUP BY 2
  ORDER BY 1, 4 DESC NULLS LAST;
$$;

-- ---------- Operations: headcount, cost per person, wastage ----------
CREATE OR REPLACE FUNCTION public.operations_summary(
  p_canteen_id UUID, p_start DATE, p_end DATE
)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_heads BIGINT; v_revenue NUMERIC; v_consumption NUMERIC;
  v_purchase NUMERIC; v_meals BIGINT; v_wastage NUMERIC; v_reqs BIGINT;
BEGIN
  SELECT coalesce(sum(plates), 0), coalesce(sum(amount), 0), count(*)
  INTO v_heads, v_revenue, v_meals
  FROM public.meal_entries
  WHERE canteen_id = p_canteen_id AND entry_date BETWEEN p_start AND p_end;

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

-- ---------- Site comparison for the Super Admin / Ops dashboards ----------
CREATE OR REPLACE FUNCTION public.site_performance(p_start DATE, p_end DATE)
RETURNS TABLE (
  canteen_id UUID, site_name TEXT, headcount BIGINT, revenue NUMERIC,
  consumption NUMERIC, purchase NUMERIC, food_cost_pct NUMERIC,
  cost_per_person NUMERIC, inventory_value NUMERIC, open_alerts BIGINT
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT c.id, c.name,
    coalesce(me.heads, 0), coalesce(me.revenue, 0),
    coalesce(cons.value, 0), coalesce(pur.value, 0),
    CASE WHEN coalesce(me.revenue, 0) > 0
         THEN round(coalesce(cons.value, 0) * 100 / me.revenue, 2) END,
    CASE WHEN coalesce(me.heads, 0) > 0
         THEN round(coalesce(cons.value, 0) / me.heads, 2) END,
    coalesce(inv.value, 0),
    coalesce(al.n, 0)
  FROM public.canteens c
  LEFT JOIN (
    SELECT canteen_id, sum(plates) heads, sum(amount) revenue
    FROM public.meal_entries WHERE entry_date BETWEEN p_start AND p_end
    GROUP BY canteen_id
  ) me ON me.canteen_id = c.id
  LEFT JOIN (
    SELECT l.canteen_id, -sum(l.change_qty * coalesce(i.cost_per_unit, 0)) value
    FROM public.stock_ledger l JOIN public.ingredients i ON i.id = l.ingredient_id
    WHERE l.reference_type IN ('recipe','issue')
      AND l.created_at >= (p_start::timestamp AT TIME ZONE 'Asia/Kolkata')
      AND l.created_at <  ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
    GROUP BY l.canteen_id
  ) cons ON cons.canteen_id = c.id
  LEFT JOIN (
    SELECT canteen_id, sum(total_amount) value FROM public.purchases
    WHERE status = 'confirmed'
      AND created_at >= (p_start::timestamp AT TIME ZONE 'Asia/Kolkata')
      AND created_at <  ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
    GROUP BY canteen_id
  ) pur ON pur.canteen_id = c.id
  LEFT JOIN (
    SELECT canteen_id, sum(current_stock * coalesce(cost_per_unit, 0)) value
    FROM public.ingredients GROUP BY canteen_id
  ) inv ON inv.canteen_id = c.id
  LEFT JOIN (
    SELECT canteen_id, count(*) n FROM public.fraud_alerts
    WHERE status = 'open' GROUP BY canteen_id
  ) al ON al.canteen_id = c.id
  ORDER BY 4 DESC;
$$;

REVOKE ALL ON FUNCTION public.purchase_report(UUID,DATE,DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.consumption_report(UUID,DATE,DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.operations_summary(UUID,DATE,DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.site_performance(DATE,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purchase_report(UUID,DATE,DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consumption_report(UUID,DATE,DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.operations_summary(UUID,DATE,DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.site_performance(DATE,DATE) TO authenticated;
