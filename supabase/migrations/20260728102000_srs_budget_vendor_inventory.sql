-- ============================================================
-- SRS: BUDGET MODULE · VENDOR PORTAL · INVENTORY DEPTH
-- Safe to re-run.
-- ============================================================

-- ---------- 1. Site budgets (Operations Manager) ----------
CREATE TABLE IF NOT EXISTS public.site_budgets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canteen_id         UUID NOT NULL REFERENCES public.canteens(id) ON DELETE CASCADE,
  budget_month       DATE NOT NULL,             -- always the 1st of the month
  food_budget        NUMERIC NOT NULL DEFAULT 0 CHECK (food_budget >= 0),
  labour_budget      NUMERIC NOT NULL DEFAULT 0 CHECK (labour_budget >= 0),
  purchase_budget    NUMERIC NOT NULL DEFAULT 0 CHECK (purchase_budget >= 0),
  food_cost_pct      NUMERIC,                   -- target food cost %
  notes              TEXT,
  created_by         UUID DEFAULT auth.uid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (canteen_id, budget_month)
);

-- Budget vs actual for one site+month, in one round trip.
-- Actual food cost = confirmed purchases + issues valued at cost.
CREATE OR REPLACE FUNCTION public.budget_vs_actual(p_canteen_id UUID, p_month DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_start DATE := date_trunc('month', p_month)::date;
  v_end   DATE := (date_trunc('month', p_month) + interval '1 month')::date;
  v_b public.site_budgets%ROWTYPE;
  v_purchase NUMERIC; v_consumption NUMERIC; v_expense NUMERIC; v_revenue NUMERIC;
BEGIN
  SELECT * INTO v_b FROM public.site_budgets
  WHERE canteen_id = p_canteen_id AND budget_month = v_start;

  SELECT coalesce(sum(total_amount), 0) INTO v_purchase
  FROM public.purchases
  WHERE canteen_id = p_canteen_id AND status = 'confirmed'
    AND created_at >= (v_start::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND created_at <  (v_end::timestamp   AT TIME ZONE 'Asia/Kolkata');

  SELECT coalesce(-sum(l.change_qty * i.cost_per_unit), 0) INTO v_consumption
  FROM public.stock_ledger l JOIN public.ingredients i ON i.id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('recipe','issue')
    AND l.created_at >= (v_start::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND l.created_at <  (v_end::timestamp   AT TIME ZONE 'Asia/Kolkata');

  SELECT coalesce(sum(amount), 0) INTO v_expense
  FROM public.expenses
  WHERE canteen_id = p_canteen_id AND expense_date >= v_start AND expense_date < v_end;

  SELECT coalesce(sum(amount), 0) INTO v_revenue
  FROM public.meal_entries
  WHERE canteen_id = p_canteen_id AND entry_date >= v_start AND entry_date < v_end;

  RETURN jsonb_build_object(
    'month', v_start,
    'food_budget',     coalesce(v_b.food_budget, 0),
    'labour_budget',   coalesce(v_b.labour_budget, 0),
    'purchase_budget', coalesce(v_b.purchase_budget, 0),
    'target_food_cost_pct', v_b.food_cost_pct,
    'actual_purchase',    v_purchase,
    'actual_consumption', v_consumption,
    'actual_expense',     v_expense,
    'revenue',            v_revenue,
    'food_cost_pct', CASE WHEN v_revenue > 0 THEN round(v_consumption * 100 / v_revenue, 2) END,
    'food_used_pct', CASE WHEN coalesce(v_b.food_budget,0) > 0
                          THEN round(v_consumption * 100 / v_b.food_budget, 2) END,
    'purchase_used_pct', CASE WHEN coalesce(v_b.purchase_budget,0) > 0
                          THEN round(v_purchase * 100 / v_b.purchase_budget, 2) END
  );
END;
$$;
REVOKE ALL ON FUNCTION public.budget_vs_actual(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.budget_vs_actual(UUID, DATE) TO authenticated;

ALTER TABLE public.site_budgets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "site_budgets_select" ON public.site_budgets;
DROP POLICY IF EXISTS "site_budgets_ops_write" ON public.site_budgets;
CREATE POLICY "site_budgets_select" ON public.site_budgets FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
-- Only ops_manager and above (rank 50+) set budgets — a unit manager cannot
-- raise their own ceiling.
CREATE POLICY "site_budgets_ops_write" ON public.site_budgets FOR ALL TO authenticated
  USING (public.my_rank() >= 50 AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.my_rank() >= 50 AND public.can_access_canteen(canteen_id));

-- ---------- 2. Vendor portal ----------
-- The vendor logs in and uploads a bill: photo, line items, total value.
-- Nothing touches stock until a store keeper verifies and converts it.
CREATE TABLE IF NOT EXISTS public.vendor_bills (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id   UUID NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  canteen_id    UUID NOT NULL REFERENCES public.canteens(id),
  bill_no       TEXT,
  bill_date     DATE,
  total_value   NUMERIC NOT NULL DEFAULT 0 CHECK (total_value >= 0),
  gstin         TEXT,
  image_path    TEXT,
  status        TEXT NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('submitted','verified','rejected','converted')),
  purchase_id   UUID REFERENCES public.purchases(id) ON DELETE SET NULL,
  notes         TEXT,
  review_notes  TEXT,
  submitted_by  UUID DEFAULT auth.uid(),
  verified_by   UUID,
  verified_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.vendor_bill_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_bill_id  UUID NOT NULL REFERENCES public.vendor_bills(id) ON DELETE CASCADE,
  item_name       TEXT NOT NULL,
  quantity        NUMERIC NOT NULL DEFAULT 0,
  unit            TEXT,
  rate            NUMERIC NOT NULL DEFAULT 0,
  total           NUMERIC NOT NULL DEFAULT 0,
  ingredient_id   UUID REFERENCES public.ingredients(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_bills_supplier ON public.vendor_bills (supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_bills_site ON public.vendor_bills (canteen_id, status);

ALTER TABLE public.vendor_bills      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_bill_items ENABLE ROW LEVEL SECURITY;

-- A vendor sees ONLY their own bills, and only while still submitted.
DROP POLICY IF EXISTS "vendor_bills_select" ON public.vendor_bills;
DROP POLICY IF EXISTS "vendor_bills_vendor_insert" ON public.vendor_bills;
DROP POLICY IF EXISTS "vendor_bills_vendor_update_own" ON public.vendor_bills;
DROP POLICY IF EXISTS "vendor_bills_staff_update" ON public.vendor_bills;
CREATE POLICY "vendor_bills_select" ON public.vendor_bills FOR SELECT TO authenticated
  USING (supplier_id = public.my_supplier_id() OR public.can_access_canteen(canteen_id));
CREATE POLICY "vendor_bills_vendor_insert" ON public.vendor_bills FOR INSERT TO authenticated
  WITH CHECK (supplier_id = public.my_supplier_id() OR
              (public.is_store_keeper_or_above() AND public.can_access_canteen(canteen_id)));
CREATE POLICY "vendor_bills_vendor_update_own" ON public.vendor_bills FOR UPDATE TO authenticated
  USING (supplier_id = public.my_supplier_id() AND status = 'submitted')
  WITH CHECK (supplier_id = public.my_supplier_id() AND status = 'submitted');
CREATE POLICY "vendor_bills_staff_update" ON public.vendor_bills FOR UPDATE TO authenticated
  USING (public.is_store_keeper_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_store_keeper_or_above() AND public.can_access_canteen(canteen_id));

DROP POLICY IF EXISTS "vendor_bill_items_select" ON public.vendor_bill_items;
DROP POLICY IF EXISTS "vendor_bill_items_write" ON public.vendor_bill_items;
CREATE POLICY "vendor_bill_items_select" ON public.vendor_bill_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.vendor_bills b WHERE b.id = vendor_bill_id
                 AND (b.supplier_id = public.my_supplier_id() OR public.can_access_canteen(b.canteen_id))));
CREATE POLICY "vendor_bill_items_write" ON public.vendor_bill_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.vendor_bills b WHERE b.id = vendor_bill_id
                 AND ((b.supplier_id = public.my_supplier_id() AND b.status = 'submitted')
                      OR (public.is_store_keeper_or_above() AND public.can_access_canteen(b.canteen_id)))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.vendor_bills b WHERE b.id = vendor_bill_id
                 AND ((b.supplier_id = public.my_supplier_id() AND b.status = 'submitted')
                      OR (public.is_store_keeper_or_above() AND public.can_access_canteen(b.canteen_id)))));

-- Store keeper converts a verified vendor bill into a draft purchase.
CREATE OR REPLACE FUNCTION public.convert_vendor_bill(p_bill_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_bill public.vendor_bills%ROWTYPE; v_purchase_id UUID;
BEGIN
  SELECT * INTO v_bill FROM public.vendor_bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown vendor bill'; END IF;
  IF v_bill.status = 'converted' THEN
    RETURN jsonb_build_object('already', true, 'purchase_id', v_bill.purchase_id);
  END IF;
  IF NOT public.is_store_keeper_or_above() THEN
    RAISE EXCEPTION 'Only the store keeper can accept a vendor bill';
  END IF;

  INSERT INTO public.purchases (canteen_id, supplier_id, total_amount, notes, invoice_image_url, status)
  VALUES (v_bill.canteen_id, v_bill.supplier_id, v_bill.total_value,
          'Vendor bill ' || coalesce(v_bill.bill_no, '') || ' (self-uploaded)',
          v_bill.image_path, 'draft')
  RETURNING id INTO v_purchase_id;

  INSERT INTO public.purchase_items (purchase_id, item_name, quantity, unit, rate, total, ingredient_id)
  SELECT v_purchase_id, item_name, quantity, unit, rate, total, ingredient_id
  FROM public.vendor_bill_items WHERE vendor_bill_id = p_bill_id;

  UPDATE public.vendor_bills
    SET status = 'converted', purchase_id = v_purchase_id,
        verified_by = auth.uid(), verified_at = now()
    WHERE id = p_bill_id;

  RETURN jsonb_build_object('purchase_id', v_purchase_id);
END;
$$;
REVOKE ALL ON FUNCTION public.convert_vendor_bill(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_vendor_bill(UUID) TO authenticated;

-- ---------- 3. Inventory depth ----------
ALTER TABLE public.ingredients ADD COLUMN IF NOT EXISTS maximum_stock NUMERIC;
ALTER TABLE public.ingredients ADD COLUMN IF NOT EXISTS reorder_level NUMERIC;
ALTER TABLE public.ingredients ADD COLUMN IF NOT EXISTS shelf_life_days INT;

-- Batch/lot tracking for FIFO, ageing and expiry.
CREATE TABLE IF NOT EXISTS public.ingredient_batches (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ingredient_id  UUID NOT NULL REFERENCES public.ingredients(id) ON DELETE CASCADE,
  canteen_id     UUID NOT NULL REFERENCES public.canteens(id) ON DELETE CASCADE,
  supplier_id    UUID REFERENCES public.suppliers(id) ON DELETE SET NULL,
  purchase_id    UUID REFERENCES public.purchases(id) ON DELETE SET NULL,
  batch_no       TEXT,
  qty_received   NUMERIC NOT NULL CHECK (qty_received > 0),
  qty_remaining  NUMERIC NOT NULL CHECK (qty_remaining >= 0),
  rate           NUMERIC NOT NULL DEFAULT 0,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expiry_date    DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_batches_fifo
  ON public.ingredient_batches (ingredient_id, received_at)
  WHERE qty_remaining > 0;

ALTER TABLE public.ingredient_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "batches_select" ON public.ingredient_batches;
DROP POLICY IF EXISTS "batches_write" ON public.ingredient_batches;
CREATE POLICY "batches_select" ON public.ingredient_batches FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "batches_write" ON public.ingredient_batches FOR ALL TO authenticated
  USING (public.is_store_keeper_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_store_keeper_or_above() AND public.can_access_canteen(canteen_id));

-- Stock ageing / dead stock: how old is what's left, and when did it last move.
CREATE OR REPLACE FUNCTION public.stock_ageing(p_canteen_id UUID)
RETURNS TABLE (
  ingredient_id UUID, name TEXT, unit TEXT, current_stock NUMERIC,
  stock_value NUMERIC, last_issue_at TIMESTAMPTZ, days_since_movement INT,
  oldest_batch_at TIMESTAMPTZ, days_of_stock NUMERIC, movement_class TEXT
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH mv AS (
    SELECT l.ingredient_id,
           max(l.created_at) FILTER (WHERE l.reference_type IN ('recipe','issue')) AS last_issue,
           -sum(l.change_qty) FILTER (WHERE l.reference_type IN ('recipe','issue')
                                        AND l.created_at > now() - interval '30 days') AS out_30d
    FROM public.stock_ledger l
    WHERE l.canteen_id = p_canteen_id
    GROUP BY l.ingredient_id
  )
  SELECT i.id, i.name, i.unit, i.current_stock,
         round(i.current_stock * coalesce(i.cost_per_unit, 0), 2),
         mv.last_issue,
         CASE WHEN mv.last_issue IS NULL THEN NULL
              ELSE extract(day FROM now() - mv.last_issue)::int END,
         (SELECT min(b.received_at) FROM public.ingredient_batches b
          WHERE b.ingredient_id = i.id AND b.qty_remaining > 0),
         CASE WHEN coalesce(mv.out_30d, 0) > 0
              THEN round(i.current_stock / (mv.out_30d / 30.0), 1) END,
         CASE
           WHEN coalesce(i.current_stock, 0) <= 0 THEN 'empty'
           WHEN mv.last_issue IS NULL OR mv.last_issue < now() - interval '60 days' THEN 'dead'
           WHEN mv.last_issue < now() - interval '21 days' THEN 'slow'
           WHEN coalesce(mv.out_30d, 0) > 0 AND i.current_stock / (mv.out_30d / 30.0) < 7 THEN 'fast'
           ELSE 'normal'
         END
  FROM public.ingredients i
  LEFT JOIN mv ON mv.ingredient_id = i.id
  WHERE i.canteen_id = p_canteen_id
  ORDER BY 5 DESC NULLS LAST;
$$;
REVOKE ALL ON FUNCTION public.stock_ageing(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_ageing(UUID) TO authenticated;
