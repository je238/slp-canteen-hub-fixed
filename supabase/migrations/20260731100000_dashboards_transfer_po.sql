-- ============================================================
-- REMAINING SRS ITEMS
--   · Manager and Store Keeper dashboards
--   · Stock transfer between sites
--   · Purchase orders, payment status
--   · Cost per meal, wastage, vendor-wise stock
-- Safe to re-run.
-- ============================================================

-- ---------- 1. Payment status on purchases ----------
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS payment_status TEXT
  NOT NULL DEFAULT 'unpaid';
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS payment_ref TEXT;
DO $$ BEGIN
  ALTER TABLE public.purchases ADD CONSTRAINT purchases_payment_status_check
    CHECK (payment_status IN ('unpaid','partial','paid'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- 2. Purchase orders ----------
-- Raised before the goods arrive; the invoice that turns up later is matched
-- against it. Receiving still happens through the normal purchase flow.
CREATE TABLE IF NOT EXISTS public.purchase_orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canteen_id    UUID NOT NULL REFERENCES public.canteens(id) ON DELETE CASCADE,
  supplier_id   UUID REFERENCES public.suppliers(id) ON DELETE SET NULL,
  po_no         BIGINT GENERATED ALWAYS AS IDENTITY,
  po_date       DATE NOT NULL DEFAULT current_date,
  expected_date DATE,
  status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','partial','received','cancelled')),
  total_amount  NUMERIC NOT NULL DEFAULT 0,
  notes         TEXT,
  purchase_id   UUID REFERENCES public.purchases(id) ON DELETE SET NULL,
  created_by    UUID DEFAULT auth.uid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.purchase_order_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id         UUID NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  ingredient_id UUID REFERENCES public.ingredients(id) ON DELETE SET NULL,
  item_name     TEXT NOT NULL,
  quantity      NUMERIC NOT NULL CHECK (quantity > 0),
  unit          TEXT,
  rate          NUMERIC NOT NULL DEFAULT 0,
  total         NUMERIC GENERATED ALWAYS AS (quantity * rate) STORED
);

ALTER TABLE public.purchase_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "po_select" ON public.purchase_orders;
DROP POLICY IF EXISTS "po_write" ON public.purchase_orders;
CREATE POLICY "po_select" ON public.purchase_orders FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "po_write" ON public.purchase_orders FOR ALL TO authenticated
  USING (public.can_receive_stock() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.can_receive_stock() AND public.can_access_canteen(canteen_id));

DROP POLICY IF EXISTS "po_items_select" ON public.purchase_order_items;
DROP POLICY IF EXISTS "po_items_write" ON public.purchase_order_items;
CREATE POLICY "po_items_select" ON public.purchase_order_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.purchase_orders o WHERE o.id = po_id
                 AND public.can_access_canteen(o.canteen_id)));
CREATE POLICY "po_items_write" ON public.purchase_order_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.purchase_orders o WHERE o.id = po_id
                 AND public.can_receive_stock() AND public.can_access_canteen(o.canteen_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.purchase_orders o WHERE o.id = po_id
                 AND public.can_receive_stock() AND public.can_access_canteen(o.canteen_id)));

-- ---------- 3. Stock transfer between sites ----------
-- Two ledger rows in one transaction: out of the sending site, into the
-- receiving one. Both sites must be within the caller's reach.
CREATE OR REPLACE FUNCTION public.transfer_stock(
  p_from_canteen UUID, p_to_canteen UUID, p_items JSONB, p_note TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_line RECORD; v_src UUID; v_dst UUID; v_new NUMERIC; v_n INT := 0; v_ref UUID := gen_random_uuid();
BEGIN
  IF NOT public.can_receive_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can transfer stock';
  END IF;
  IF NOT (public.can_access_canteen(p_from_canteen) AND public.can_access_canteen(p_to_canteen)) THEN
    RAISE EXCEPTION 'You do not have access to both sites';
  END IF;
  IF p_from_canteen = p_to_canteen THEN
    RAISE EXCEPTION 'Pick two different sites';
  END IF;

  FOR v_line IN
    SELECT (e->>'ingredient_id')::uuid AS ing, (e->>'qty')::numeric AS qty
    FROM jsonb_array_elements(p_items) e
    ORDER BY (e->>'ingredient_id')::uuid
  LOOP
    CONTINUE WHEN v_line.qty IS NULL OR v_line.qty <= 0;

    SELECT id INTO v_src FROM public.ingredients
    WHERE id = v_line.ing AND canteen_id = p_from_canteen;
    IF v_src IS NULL THEN RAISE EXCEPTION 'Item is not stocked at the sending site'; END IF;

    -- same item name at the destination, created there if it doesn't exist
    SELECT d.id INTO v_dst FROM public.ingredients d
    JOIN public.ingredients s ON lower(btrim(s.name)) = lower(btrim(d.name))
    WHERE s.id = v_src AND d.canteen_id = p_to_canteen LIMIT 1;

    IF v_dst IS NULL THEN
      INSERT INTO public.ingredients (canteen_id, name, category, unit, current_stock, minimum_stock, cost_per_unit)
      SELECT p_to_canteen, name, category, unit, 0, 0, cost_per_unit
      FROM public.ingredients WHERE id = v_src
      RETURNING id INTO v_dst;
    END IF;

    UPDATE public.ingredients SET current_stock = current_stock - v_line.qty
      WHERE id = v_src RETURNING current_stock INTO v_new;
    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, reference_id, created_by)
    VALUES (v_src, p_from_canteen, -v_line.qty, v_new,
            'Transfer out' || coalesce(' — ' || p_note, ''), 'transfer', v_ref, auth.uid());

    UPDATE public.ingredients SET current_stock = current_stock + v_line.qty
      WHERE id = v_dst RETURNING current_stock INTO v_new;
    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, reference_id, created_by)
    VALUES (v_dst, p_to_canteen, v_line.qty, v_new,
            'Transfer in' || coalesce(' — ' || p_note, ''), 'transfer', v_ref, auth.uid());

    v_n := v_n + 1;
  END LOOP;

  RETURN jsonb_build_object('transferred', v_n, 'reference', v_ref);
END;
$$;
REVOKE ALL ON FUNCTION public.transfer_stock(UUID,UUID,JSONB,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_stock(UUID,UUID,JSONB,TEXT) TO authenticated;

-- ---------- 4. Manager dashboard ----------
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

  SELECT coalesce(sum(current_stock * latest_rate), 0),
         count(*) FILTER (WHERE current_stock <= coalesce(reorder_level, minimum_stock, 0)
                            AND coalesce(reorder_level, minimum_stock, 0) > 0)
  INTO v_inv, v_low
  FROM public.ingredient_rates r
  JOIN public.ingredients i USING (id)
  WHERE r.canteen_id = p_canteen_id;

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

-- ---------- 5. Store keeper dashboard ----------
CREATE OR REPLACE FUNCTION public.store_keeper_dashboard(p_canteen_id UUID, p_date DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_t0 TIMESTAMPTZ := (p_date::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_t1 TIMESTAMPTZ := ((p_date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_pending INT; v_purchase NUMERIC; v_issue NUMERIC; v_bills INT;
  v_low JSONB; v_unpaid NUMERIC;
BEGIN
  SELECT count(*) INTO v_pending FROM public.requisitions
  WHERE canteen_id = p_canteen_id AND status = 'approved';

  SELECT coalesce(sum(total_amount), 0), count(*) INTO v_purchase, v_bills
  FROM public.purchases WHERE canteen_id = p_canteen_id AND status = 'confirmed'
    AND created_at >= v_t0 AND created_at < v_t1;

  SELECT coalesce(-sum(l.change_qty * r.latest_rate), 0) INTO v_issue
  FROM public.stock_ledger l JOIN public.ingredient_rates r ON r.ingredient_id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('issue','recipe')
    AND l.change_qty < 0 AND l.created_at >= v_t0 AND l.created_at < v_t1;

  SELECT coalesce(sum(total_amount), 0) INTO v_unpaid
  FROM public.purchases WHERE canteen_id = p_canteen_id AND status = 'confirmed'
    AND payment_status <> 'paid';

  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO v_low FROM (
    SELECT jsonb_build_object('name', i.name, 'stock', i.current_stock, 'unit', i.unit,
                              'reorder', coalesce(i.reorder_level, i.minimum_stock, 0)) AS x
    FROM public.ingredients i
    WHERE i.canteen_id = p_canteen_id
      AND coalesce(i.reorder_level, i.minimum_stock, 0) > 0
      AND i.current_stock <= coalesce(i.reorder_level, i.minimum_stock, 0)
    ORDER BY i.current_stock ASC LIMIT 20
  ) t;

  RETURN jsonb_build_object(
    'date', p_date,
    'pending_requests', v_pending,
    'todays_purchase', round(v_purchase, 2),
    'todays_bills', v_bills,
    'todays_issue_value', round(v_issue, 2),
    'unpaid_purchases', round(v_unpaid, 2),
    'low_stock', v_low
  );
END;
$$;

-- ---------- 6. Cost per meal, wastage, vendor-wise stock ----------
CREATE OR REPLACE FUNCTION public.meal_cost_report(
  p_canteen_id UUID, p_start DATE, p_end DATE
)
RETURNS TABLE (
  meal_period TEXT, meals INT, headcount BIGINT,
  wastage_qty NUMERIC, avg_headcount NUMERIC
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT m.meal_period,
         count(*)::int,
         coalesce(sum(coalesce(m.actual_headcount, m.expected_headcount, 0)), 0)::bigint,
         coalesce((SELECT sum(mi.wastage_qty) FROM public.menu_plan_items mi
                   WHERE mi.menu_plan_id = ANY(array_agg(m.id))), 0),
         round(avg(coalesce(m.actual_headcount, m.expected_headcount, 0)), 1)
  FROM public.menu_plans m
  WHERE m.canteen_id = p_canteen_id AND m.menu_date BETWEEN p_start AND p_end
  GROUP BY m.meal_period
  ORDER BY 3 DESC;
$$;

CREATE OR REPLACE FUNCTION public.vendor_stock_report(p_canteen_id UUID)
RETURNS TABLE (
  supplier_id UUID, vendor TEXT, items BIGINT,
  qty_remaining NUMERIC, value_remaining NUMERIC, oldest_batch TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT b.supplier_id, coalesce(s.name, 'Unknown vendor'),
         count(DISTINCT b.ingredient_id),
         round(sum(b.qty_remaining), 3),
         round(sum(b.qty_remaining * b.rate), 2),
         min(b.received_at)
  FROM public.ingredient_batches b
  LEFT JOIN public.suppliers s ON s.id = b.supplier_id
  WHERE b.canteen_id = p_canteen_id AND b.qty_remaining > 0
  GROUP BY b.supplier_id, s.name
  ORDER BY 5 DESC;
$$;

REVOKE ALL ON FUNCTION public.manager_dashboard(UUID,DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.store_keeper_dashboard(UUID,DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.meal_cost_report(UUID,DATE,DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.vendor_stock_report(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manager_dashboard(UUID,DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.store_keeper_dashboard(UUID,DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.meal_cost_report(UUID,DATE,DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.vendor_stock_report(UUID) TO authenticated;
