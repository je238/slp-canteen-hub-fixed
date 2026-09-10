-- ============================================================
-- PLATE-COUNT BILLING (the real operating model)
--
-- There is no POS at these canteens: food is served, plates are
-- counted, and the company pays per plate at a contracted rate.
--
--   * corporate_meal_rates — per company: meal type (Breakfast /
--     Lunch / ...), the per-plate rate, and optionally a "thali
--     recipe" (defined for 1 plate) used for automatic stock
--     deduction.
--   * meal_entries — one row per company + date + meal with the
--     plate count. amount = plates × rate (frozen at entry time).
--     Inserting/updating an entry automatically deducts
--     (delta plates × thali recipe) from ingredient stock via the
--     stock ledger, so the anti-theft variance report keeps
--     working without any POS.
--   * generate_corporate_invoice_from_meals — stamps the month's
--     un-invoiced entries onto a corporate_invoices row; entries
--     on an invoice are locked against edits.
--
-- Safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.corporate_meal_rates (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_account_id UUID NOT NULL REFERENCES public.corporate_accounts(id) ON DELETE CASCADE,
  meal_type            TEXT NOT NULL,
  rate                 NUMERIC NOT NULL CHECK (rate >= 0),
  recipe_id            UUID REFERENCES public.recipes(id) ON DELETE SET NULL,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (corporate_account_id, meal_type)
);

CREATE TABLE IF NOT EXISTS public.meal_entries (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canteen_id           UUID NOT NULL REFERENCES public.canteens(id),
  corporate_account_id UUID NOT NULL REFERENCES public.corporate_accounts(id),
  entry_date           DATE NOT NULL,
  meal_type            TEXT NOT NULL,
  plates               INT NOT NULL CHECK (plates >= 0),
  rate                 NUMERIC NOT NULL CHECK (rate >= 0),
  amount               NUMERIC GENERATED ALWAYS AS (plates * rate) STORED,
  corporate_invoice_id UUID REFERENCES public.corporate_invoices(id),
  notes                TEXT,
  created_by           UUID DEFAULT auth.uid(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (corporate_account_id, entry_date, meal_type)
);

CREATE INDEX IF NOT EXISTS idx_meal_entries_period
  ON public.meal_entries (corporate_account_id, entry_date);

-- ---------- RLS ----------
ALTER TABLE public.corporate_meal_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meal_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "meal_rates_staff_select" ON public.corporate_meal_rates;
DROP POLICY IF EXISTS "meal_rates_manager_write" ON public.corporate_meal_rates;
CREATE POLICY "meal_rates_staff_select" ON public.corporate_meal_rates FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.corporate_accounts a WHERE a.id = corporate_account_id AND public.can_access_canteen(a.canteen_id)));
CREATE POLICY "meal_rates_manager_write" ON public.corporate_meal_rates FOR ALL TO authenticated
  USING (public.is_manager_or_above() AND EXISTS (SELECT 1 FROM public.corporate_accounts a WHERE a.id = corporate_account_id AND public.can_access_canteen(a.canteen_id)))
  WITH CHECK (public.is_manager_or_above() AND EXISTS (SELECT 1 FROM public.corporate_accounts a WHERE a.id = corporate_account_id AND public.can_access_canteen(a.canteen_id)));

-- The person on the floor (cashier role) may enter and correct counts;
-- deleting rows is owner-only. Invoiced rows are frozen by trigger below.
DROP POLICY IF EXISTS "meal_entries_staff_select" ON public.meal_entries;
DROP POLICY IF EXISTS "meal_entries_staff_insert" ON public.meal_entries;
DROP POLICY IF EXISTS "meal_entries_staff_update" ON public.meal_entries;
DROP POLICY IF EXISTS "meal_entries_owner_delete" ON public.meal_entries;
CREATE POLICY "meal_entries_staff_select" ON public.meal_entries FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "meal_entries_staff_insert" ON public.meal_entries FOR INSERT TO authenticated
  WITH CHECK (public.can_access_canteen(canteen_id));
CREATE POLICY "meal_entries_staff_update" ON public.meal_entries FOR UPDATE TO authenticated
  USING (public.can_access_canteen(canteen_id))
  WITH CHECK (public.can_access_canteen(canteen_id));
CREATE POLICY "meal_entries_owner_delete" ON public.meal_entries FOR DELETE TO authenticated
  USING (public.is_owner());

-- ---------- Automatic stock deduction from plate counts ----------
-- The thali recipe is defined for ONE plate (yield_qty plates if > 1).
-- Deducts on insert, adjusts by delta on update, restocks on delete.
-- Also freezes entries that are already on an invoice.
CREATE OR REPLACE FUNCTION public.process_meal_entry()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_recipe UUID;
  v_yield NUMERIC;
  v_delta INT;           -- plates to deduct (negative = restock)
  v_ri RECORD;
  v_qty NUMERIC;
  v_new_stock NUMERIC;
  v_label TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.corporate_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'This entry is already on an invoice and cannot be changed.';
  END IF;
  IF TG_OP = 'DELETE' AND OLD.corporate_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'This entry is already on an invoice and cannot be deleted.';
  END IF;

  v_delta := CASE TG_OP
    WHEN 'INSERT' THEN NEW.plates
    WHEN 'UPDATE' THEN NEW.plates - OLD.plates
    ELSE -OLD.plates
  END;

  IF v_delta = 0 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT r.recipe_id INTO v_recipe
  FROM public.corporate_meal_rates r
  WHERE r.corporate_account_id = COALESCE(NEW.corporate_account_id, OLD.corporate_account_id)
    AND r.meal_type = COALESCE(NEW.meal_type, OLD.meal_type)
  LIMIT 1;

  IF v_recipe IS NULL THEN
    RETURN COALESCE(NEW, OLD);   -- no thali recipe linked: billing only
  END IF;

  SELECT greatest(coalesce(yield_qty, 1), 1) INTO v_yield FROM public.recipes WHERE id = v_recipe;
  v_label := COALESCE(NEW.meal_type, OLD.meal_type) || ' × ' || abs(v_delta)::text || ' plates ('
             || to_char(COALESCE(NEW.entry_date, OLD.entry_date), 'DD Mon') || ')';

  FOR v_ri IN
    SELECT ri.ingredient_id, ri.quantity
    FROM public.recipe_ingredients ri
    WHERE ri.recipe_id = v_recipe AND ri.ingredient_id IS NOT NULL
  LOOP
    v_qty := v_ri.quantity / v_yield * v_delta;   -- positive = consumed

    UPDATE public.ingredients
    SET current_stock = current_stock - v_qty
    WHERE id = v_ri.ingredient_id
    RETURNING current_stock INTO v_new_stock;

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, reference_id)
    VALUES
      (v_ri.ingredient_id, COALESCE(NEW.canteen_id, OLD.canteen_id), -v_qty, v_new_stock,
       CASE WHEN v_delta > 0 THEN 'Plate count: ' ELSE 'Plate count corrected: ' END || v_label,
       'recipe', COALESCE(NEW.id, OLD.id));
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_process_meal_entry ON public.meal_entries;
CREATE TRIGGER trg_process_meal_entry
  BEFORE INSERT OR UPDATE OR DELETE ON public.meal_entries
  FOR EACH ROW EXECUTE FUNCTION public.process_meal_entry();

-- ---------- Monthly invoice from plate counts ----------
CREATE OR REPLACE FUNCTION public.generate_corporate_invoice_from_meals(
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
  v_plates BIGINT;
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

  UPDATE public.meal_entries
  SET corporate_invoice_id = v_invoice.id
  WHERE corporate_account_id = p_account_id
    AND corporate_invoice_id IS NULL
    AND entry_date BETWEEN p_period_start AND p_period_end;

  SELECT count(*), coalesce(sum(plates), 0), coalesce(sum(amount), 0)
  INTO v_count, v_plates, v_total
  FROM public.meal_entries WHERE corporate_invoice_id = v_invoice.id;

  IF v_count = 0 THEN
    DELETE FROM public.corporate_invoices WHERE id = v_invoice.id;
    RAISE EXCEPTION 'No unbilled plate entries for this company in that period';
  END IF;

  UPDATE public.corporate_invoices
  SET order_count = v_count, total_amount = v_total
  WHERE id = v_invoice.id
  RETURNING * INTO v_invoice;

  RETURN to_jsonb(v_invoice) || jsonb_build_object('total_plates', v_plates);
END;
$$;

REVOKE ALL ON FUNCTION public.generate_corporate_invoice_from_meals(UUID, DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_corporate_invoice_from_meals(UUID, DATE, DATE) TO authenticated;

-- The invoiced-entry freeze must also hold for the stamping UPDATE above:
-- process_meal_entry blocks updates where OLD.corporate_invoice_id is set,
-- and stamping sets it from NULL, so the guard passes and no stock moves
-- (plates unchanged → v_delta = 0).

-- ---------- Seed default meal types for the known companies ----------
INSERT INTO public.corporate_meal_rates (corporate_account_id, meal_type, rate)
SELECT ca.id, m.meal_type, 0
FROM public.corporate_accounts ca
CROSS JOIN (VALUES ('Breakfast'), ('Lunch'), ('Evening Tea'), ('Dinner')) AS m(meal_type)
ON CONFLICT (corporate_account_id, meal_type) DO NOTHING;
