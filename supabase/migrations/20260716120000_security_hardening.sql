-- ============================================================
-- SECURITY + CORRECTNESS HARDENING (from 5-agent review, 2026-07-16)
-- Closes confirmed loopholes. Every block is idempotent / re-runnable.
-- ============================================================

-- ---------- A. Defensive anon lockdown ----------
-- Live has no "Allow anon full access" policies (verified), but the leftover
-- table GRANTs from 20260303 are still present. Strip them so anon can never
-- write even if a stray permissive policy is ever re-introduced.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_ledger','ingredients','orders','order_items',
    'purchases','purchase_items','recipes','recipe_ingredients','expenses',
    'staff','attendance','action_logs','fraud_alerts','ingredient_usage_log',
    'suppliers','user_roles','meal_entries','meal_plan','corporate_accounts',
    'corporate_invoices','corporate_meal_rates']
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon', t);
  END LOOP;
END $$;

DO $$
DECLARE p RECORD;
BEGIN
  FOR p IN SELECT policyname, tablename FROM pg_policies
           WHERE schemaname='public' AND policyname ILIKE 'Allow anon full access%'
  LOOP EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, p.tablename); END LOOP;
END $$;

-- ---------- B. created_by DEFAULT actually lands ----------
-- The column pre-existed, so ADD COLUMN IF NOT EXISTS skipped the DEFAULT.
ALTER TABLE public.stock_ledger ALTER COLUMN created_by SET DEFAULT auth.uid();
ALTER TABLE public.purchases    ALTER COLUMN created_by SET DEFAULT auth.uid();

-- ---------- C. Variance report: net out restocks/corrections ----------
-- Positive 'recipe' rows (cancel-restocks, downward plate corrections) were
-- dropped by the sign filter, manufacturing phantom consumption. Net them.
CREATE OR REPLACE FUNCTION public.stock_variance_report(
  p_canteen_id UUID, p_start DATE, p_end DATE
)
RETURNS TABLE (
  ingredient_id UUID, name TEXT, unit TEXT, cost_per_unit NUMERIC,
  current_stock NUMERIC, purchased_qty NUMERIC, consumed_qty NUMERIC,
  manual_adjust NUMERIC, audit_adjust NUMERIC, audit_loss_value NUMERIC
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  SELECT i.id, i.name, i.unit, i.cost_per_unit, i.current_stock,
    coalesce(sum(l.change_qty) FILTER (WHERE l.reference_type='purchase'), 0),
    coalesce(-sum(l.change_qty) FILTER (WHERE l.reference_type IN ('recipe','issue')), 0),
    coalesce(sum(l.change_qty) FILTER (WHERE l.reference_type='manual'), 0),
    coalesce(sum(l.change_qty) FILTER (WHERE l.reference_type='audit'), 0),
    coalesce(-sum(l.change_qty * i.cost_per_unit) FILTER (WHERE l.reference_type='audit' AND l.change_qty<0), 0)
  FROM public.ingredients i
  LEFT JOIN public.stock_ledger l ON l.ingredient_id=i.id
    AND l.created_at >= (p_start::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND l.created_at <  ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
  WHERE i.canteen_id = p_canteen_id
  GROUP BY i.id, i.name, i.unit, i.cost_per_unit, i.current_stock
  ORDER BY 10 DESC, i.name;
$$;
REVOKE ALL ON FUNCTION public.stock_variance_report(UUID,DATE,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_variance_report(UUID,DATE,DATE) TO authenticated;

-- ---------- D. Indexes for the register/variance/invoice queries ----------
CREATE INDEX IF NOT EXISTS idx_stock_ledger_canteen_time ON public.stock_ledger (canteen_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_ing_time ON public.stock_ledger (ingredient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_ref ON public.stock_ledger (reference_id) WHERE reference_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_corp_inv ON public.orders (corporate_invoice_id) WHERE corporate_invoice_id IS NOT NULL;

-- ---------- E. Fraud alerts on 'manual' shortages too, with dedup + floor ----------
CREATE OR REPLACE FUNCTION public.flag_audit_shortage()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ing public.ingredients%ROWTYPE; v_loss NUMERIC;
BEGIN
  -- fire on audit AND manual downward moves (manual was a laundering bypass)
  IF NEW.reference_type NOT IN ('audit','manual') OR NEW.change_qty >= 0 OR NEW.ingredient_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_ing FROM public.ingredients WHERE id = NEW.ingredient_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  v_loss := abs(NEW.change_qty) * coalesce(v_ing.cost_per_unit, 0);

  -- ₹300 floor, or ≥₹50 loss on a high-value item; dedup an open alert
  -- for the same ingredient the same day so re-audits don't spam/launder.
  IF v_loss >= 300 OR (coalesce(v_ing.cost_per_unit,0) >= 300 AND v_loss >= 50) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.fraud_alerts
      WHERE ingredient_id = NEW.ingredient_id AND status = 'open'
        AND alert_type = 'stock_discrepancy'
        AND created_at >= date_trunc('day', now())
    ) THEN
      INSERT INTO public.fraud_alerts
        (canteen_id, ingredient_id, alert_type, severity, title, description, loss_value, status)
      VALUES (NEW.canteen_id, NEW.ingredient_id, 'stock_discrepancy',
        CASE WHEN v_loss >= 2000 THEN 'critical' ELSE 'warning' END,
        (CASE WHEN NEW.reference_type='manual' THEN 'Manual shortage: ' ELSE 'Audit shortage: ' END) || v_ing.name,
        format('%s %s below system stock (%s). Est. loss ₹%s.',
               abs(NEW.change_qty), v_ing.unit, coalesce(NEW.reason,'no reason'), round(v_loss)),
        v_loss, 'open');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------- F. meal_entries.rate is server-authoritative (no cashier re-pricing) ----------
-- Override the client rate with the contracted rate from corporate_meal_rates
-- whenever one exists, so a saved entry can never be re-priced by editing.
CREATE OR REPLACE FUNCTION public.enforce_meal_entry_rate()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rate NUMERIC;
BEGIN
  SELECT rate INTO v_rate FROM public.corporate_meal_rates
  WHERE corporate_account_id = NEW.corporate_account_id AND meal_type = NEW.meal_type
  LIMIT 1;
  IF v_rate IS NOT NULL THEN NEW.rate := v_rate; END IF;

  -- account must belong to the entry's canteen (cross-canteen billing guard)
  IF NOT EXISTS (
    SELECT 1 FROM public.corporate_accounts a
    WHERE a.id = NEW.corporate_account_id AND a.canteen_id = NEW.canteen_id
  ) THEN
    RAISE EXCEPTION 'Corporate account does not belong to this canteen';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_enforce_meal_entry_rate ON public.meal_entries;
CREATE TRIGGER trg_enforce_meal_entry_rate
  BEFORE INSERT OR UPDATE ON public.meal_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_meal_entry_rate();

-- ---------- G. fraud_alerts: managers may resolve, only owner may delete ----------
DROP POLICY IF EXISTS "fraud_alerts_manager_write" ON public.fraud_alerts;
DROP POLICY IF EXISTS "fraud_alerts_manager_update" ON public.fraud_alerts;
DROP POLICY IF EXISTS "fraud_alerts_staff_insert" ON public.fraud_alerts;
DROP POLICY IF EXISTS "fraud_alerts_owner_delete" ON public.fraud_alerts;
CREATE POLICY "fraud_alerts_manager_update" ON public.fraud_alerts FOR UPDATE TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));
CREATE POLICY "fraud_alerts_staff_insert" ON public.fraud_alerts FOR INSERT TO authenticated
  WITH CHECK (public.can_access_canteen(canteen_id));
CREATE POLICY "fraud_alerts_owner_delete" ON public.fraud_alerts FOR DELETE TO authenticated
  USING (public.is_owner());

-- ---------- H. Orders on an invoice are frozen (mirror the meal-entry freeze) ----------
CREATE OR REPLACE FUNCTION public.freeze_invoiced_order()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.corporate_invoice_id IS NOT NULL THEN
      RAISE EXCEPTION 'Order is on a corporate invoice and cannot be deleted.';
    END IF;
    RETURN OLD;
  END IF;
  -- block edits to an already-invoiced order, except the NULL->value stamping
  IF OLD.corporate_invoice_id IS NOT NULL AND NEW.corporate_invoice_id = OLD.corporate_invoice_id THEN
    RAISE EXCEPTION 'Order is on a corporate invoice and cannot be changed.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_freeze_invoiced_order ON public.orders;
CREATE TRIGGER trg_freeze_invoiced_order
  BEFORE UPDATE OR DELETE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.freeze_invoiced_order();

-- ---------- I. Invoice-image storage scoped to the caller's canteen ----------
DROP POLICY IF EXISTS "invoices_staff_read" ON storage.objects;
DROP POLICY IF EXISTS "invoices_manager_insert" ON storage.objects;
CREATE POLICY "invoices_staff_read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'invoices'
         AND public.can_access_canteen(NULLIF((storage.foldername(name))[1], '')::uuid));
CREATE POLICY "invoices_manager_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'invoices' AND public.is_manager_or_above()
              AND public.can_access_canteen(NULLIF((storage.foldername(name))[1], '')::uuid));

-- ---------- J. Atomic server-side stock issue (kills the read-modify-write race) ----------
-- The browser's useRecordDailyUsage does select-subtract-write; two concurrent
-- saves lose a deduction. This RPC does it atomically and writes the ledger in
-- the same transaction, with the balance read back from the DB (not the client).
CREATE OR REPLACE FUNCTION public.record_stock_issue(
  p_canteen_id UUID, p_items JSONB
)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_line RECORD; v_new NUMERIC; v_n INT := 0;
BEGIN
  FOR v_line IN
    SELECT (e->>'ingredient_id')::uuid AS ing, (e->>'qty')::numeric AS qty, e->>'name' AS name
    FROM jsonb_array_elements(p_items) e
    ORDER BY (e->>'ingredient_id')::uuid   -- stable order avoids deadlocks
  LOOP
    IF v_line.qty IS NULL OR v_line.qty <= 0 THEN CONTINUE; END IF;
    UPDATE public.ingredients
      SET current_stock = current_stock - v_line.qty
      WHERE id = v_line.ing AND canteen_id = p_canteen_id
      RETURNING current_stock INTO v_new;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown ingredient in this canteen'; END IF;
    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type)
    VALUES (v_line.ing, p_canteen_id, -v_line.qty, v_new,
            'Daily usage — ' || coalesce(v_line.name,''), 'issue');
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('saved', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.record_stock_issue(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_stock_issue(UUID, JSONB) TO authenticated;
