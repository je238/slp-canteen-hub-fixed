-- ============================================================
-- CORPORATE CREDIT BILLING
--
-- The Sun Pharma Plant-4 and Eicher canteens don't collect cash
-- from employees: the employee shows their company ID, the order
-- is booked against the company's account, and the company is
-- invoiced once a month.
--
--   * corporate_accounts  — one row per client company per canteen
--   * orders              — gains corporate_account_id + employee_code;
--                           such orders use payment_mode 'company' and
--                           payment_status 'credit' (receivable, not cash)
--   * corporate_invoices  — a generated monthly statement; generating it
--                           stamps every open credit order in the period
--                           so an order can never be billed twice
--
-- Safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.corporate_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canteen_id     UUID NOT NULL REFERENCES public.canteens(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  code           TEXT,               -- short label for the POS button, e.g. SUN-P4
  contact_person TEXT,
  contact_email  TEXT,
  contact_phone  TEXT,
  gstin          TEXT,
  billing_notes  TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (canteen_id, name)
);

CREATE TABLE IF NOT EXISTS public.corporate_invoices (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_account_id UUID NOT NULL REFERENCES public.corporate_accounts(id) ON DELETE CASCADE,
  canteen_id           UUID NOT NULL REFERENCES public.canteens(id),
  period_start         DATE NOT NULL,
  period_end           DATE NOT NULL,      -- inclusive
  order_count          INT NOT NULL DEFAULT 0,
  total_amount         NUMERIC NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'draft',  -- draft | sent | paid
  generated_by         UUID,
  generated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at              TIMESTAMPTZ
);

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS corporate_account_id UUID REFERENCES public.corporate_accounts(id);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS employee_code TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS corporate_invoice_id UUID REFERENCES public.corporate_invoices(id);

CREATE INDEX IF NOT EXISTS idx_orders_corporate
  ON public.orders (corporate_account_id, created_at)
  WHERE corporate_account_id IS NOT NULL;

-- ---------- RLS ----------
ALTER TABLE public.corporate_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.corporate_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "corporate_accounts_staff_select" ON public.corporate_accounts;
DROP POLICY IF EXISTS "corporate_accounts_manager_write" ON public.corporate_accounts;
CREATE POLICY "corporate_accounts_staff_select" ON public.corporate_accounts FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "corporate_accounts_manager_write" ON public.corporate_accounts FOR ALL TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

DROP POLICY IF EXISTS "corporate_invoices_staff_select" ON public.corporate_invoices;
DROP POLICY IF EXISTS "corporate_invoices_manager_write" ON public.corporate_invoices;
CREATE POLICY "corporate_invoices_staff_select" ON public.corporate_invoices FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "corporate_invoices_manager_write" ON public.corporate_invoices FOR ALL TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

-- ---------- Monthly statement generation ----------
-- Stamps every not-yet-invoiced, not-cancelled credit order for the
-- account inside [period_start, period_end] with a new invoice id, in one
-- transaction. Re-running for the same period only picks up orders that
-- were missed (e.g. placed after the first run) — never double-bills.
CREATE OR REPLACE FUNCTION public.generate_corporate_invoice(
  p_account_id   UUID,
  p_period_start DATE,
  p_period_end   DATE
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_account public.corporate_accounts%ROWTYPE;
  v_invoice public.corporate_invoices%ROWTYPE;
  v_count INT;
  v_total NUMERIC;
BEGIN
  IF NOT public.is_manager_or_above() THEN
    RAISE EXCEPTION 'Only managers can generate corporate invoices';
  END IF;

  SELECT * INTO v_account FROM public.corporate_accounts WHERE id = p_account_id;
  IF NOT FOUND OR NOT public.can_access_canteen(v_account.canteen_id) THEN
    RAISE EXCEPTION 'Unknown corporate account';
  END IF;
  IF p_period_end < p_period_start THEN
    RAISE EXCEPTION 'Invalid billing period';
  END IF;

  INSERT INTO public.corporate_invoices
    (corporate_account_id, canteen_id, period_start, period_end, generated_by)
  VALUES
    (p_account_id, v_account.canteen_id, p_period_start, p_period_end, auth.uid())
  RETURNING * INTO v_invoice;

  UPDATE public.orders
  SET corporate_invoice_id = v_invoice.id
  WHERE corporate_account_id = p_account_id
    AND corporate_invoice_id IS NULL
    AND status <> 'cancelled'
    AND created_at >= p_period_start
    AND created_at < p_period_end + 1;

  SELECT count(*), coalesce(sum(total_amount), 0) INTO v_count, v_total
  FROM public.orders WHERE corporate_invoice_id = v_invoice.id;

  IF v_count = 0 THEN
    DELETE FROM public.corporate_invoices WHERE id = v_invoice.id;
    RAISE EXCEPTION 'No unbilled orders found for this account in that period';
  END IF;

  UPDATE public.corporate_invoices
  SET order_count = v_count, total_amount = v_total
  WHERE id = v_invoice.id
  RETURNING * INTO v_invoice;

  RETURN to_jsonb(v_invoice);
END;
$$;

REVOKE ALL ON FUNCTION public.generate_corporate_invoice(UUID, DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_corporate_invoice(UUID, DATE, DATE) TO authenticated;

-- ---------- Seed the two known client companies ----------
-- (idempotent; only for canteens that already exist on this database)
INSERT INTO public.corporate_accounts (canteen_id, name, code)
SELECT c.id, x.name, x.code
FROM public.canteens c
CROSS JOIN (VALUES
  ('Sun Pharma Plant 4', 'SUN-P4'),
  ('Eicher',             'EICHER')
) AS x(name, code)
WHERE c.name ILIKE '%sun pharma%'
ON CONFLICT (canteen_id, name) DO NOTHING;
