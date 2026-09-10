-- ============================================================
-- A RECEIPT IS WORTH WHAT ARRIVED, NOT WHAT THE PAPER CLAIMED
--
-- The opening count went in as 27 lines the store keeper read off his own
-- notebook and confirmed on screen. Those lines built the stock, the lots and
-- the inventory value: ₹5,44,392, and every one of those figures agrees.
--
-- The Purchases tile said ₹5,21,472.
--
-- The gap is not stock and it is not tax. add_stock_from_invoice records
-- whatever the reader thought the paper's grand total was, and keeps it even
-- when the lines underneath are corrected on screen before saving — which is
-- exactly what the review step is FOR. So the total was a number the reader
-- guessed off a photo, sitting in the books next to 27 lines a person had
-- actually checked, and disagreeing with them.
--
-- Two numbers that should match and don't is the single most corrosive thing
-- that can happen here. Nobody can tell which is wrong, so everything nearby
-- becomes suspect — and this is a system whose only job is to be believed
-- when it says a figure is off.
--
-- So: the value of a receipt is the sum of its lines. The paper's own stated
-- total is still kept, because a bill that does not add up is worth knowing
-- about — but it is kept as a claim to be checked, not as the truth.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.purchases
  ADD COLUMN IF NOT EXISTS stated_total NUMERIC;

COMMENT ON COLUMN public.purchases.stated_total IS
  'What the paper itself claimed the total was. Kept for checking against '
  'total_amount, which is the sum of the lines actually received.';

-- ---------- Existing rows: the lines are what arrived ----------
-- A confirmed receipt cannot be re-priced, and that guard is the right one to
-- have — it is what stops a total being quietly walked up after the goods are
-- in. It is stood down for this one correction, inside this transaction, and
-- what is being corrected is the app's own recording mistake, not a price.
ALTER TABLE public.purchases DISABLE TRIGGER trg_guard_confirmed_purchase;
ALTER TABLE public.purchases DISABLE TRIGGER trg_guard_purchase_edit;
DO $$
DECLARE r RECORD; v_lines NUMERIC;
BEGIN
  FOR r IN SELECT id, total_amount FROM public.purchases LOOP
    SELECT coalesce(sum(total), 0) INTO v_lines
    FROM public.purchase_items WHERE purchase_id = r.id;

    IF v_lines > 0 AND abs(v_lines - coalesce(r.total_amount, 0)) > 0.5 THEN
      UPDATE public.purchases
         SET stated_total = coalesce(stated_total, total_amount),
             total_amount = v_lines,
             notes = coalesce(notes, '') ||
                     format(' · corrected: the paper stated ₹%s, the %s lines received add to ₹%s',
                            round(coalesce(r.total_amount, 0)),
                            (SELECT count(*) FROM public.purchase_items WHERE purchase_id = r.id),
                            round(v_lines))
       WHERE id = r.id;
    END IF;
  END LOOP;
END $$;
ALTER TABLE public.purchases ENABLE TRIGGER trg_guard_purchase_edit;
ALTER TABLE public.purchases ENABLE TRIGGER trg_guard_confirmed_purchase;

-- ---------- From now on ----------
CREATE OR REPLACE FUNCTION public.add_stock_from_invoice(
  p_canteen_id UUID, p_supplier_id UUID, p_items JSONB,
  p_notes TEXT DEFAULT NULL, p_image_path TEXT DEFAULT NULL, p_total NUMERIC DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_purchase UUID; v_line RECORD; v_ing UUID; v_new NUMERIC;
  v_created INT := 0; v_topped INT := 0; v_sum NUMERIC := 0;
  v_today DATE := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF NOT public.can_receive_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can take stock in';
  END IF;
  IF NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;
  PERFORM public.allow_stock_move();

  SELECT coalesce(sum((e->>'total')::numeric), 0) INTO v_sum
  FROM jsonb_array_elements(p_items) e;

  -- The lines are what arrived, so the lines are what it is worth. p_total is
  -- the paper's own claim and is kept beside it to be checked, never in place
  -- of it.
  INSERT INTO public.purchases
    (canteen_id, supplier_id, total_amount, stated_total, notes, invoice_image_url,
     status, approved_at, created_by)
  VALUES (p_canteen_id, p_supplier_id, v_sum, p_total, p_notes, p_image_path,
          'confirmed', now(), auth.uid())
  RETURNING id INTO v_purchase;

  FOR v_line IN
    SELECT nullif(btrim(e->>'name'), '') AS name,
           coalesce((e->>'quantity')::numeric, 0) AS qty,
           coalesce(nullif(e->>'unit', ''), 'kg') AS unit,
           coalesce((e->>'rate')::numeric, 0) AS rate,
           coalesce((e->>'total')::numeric, 0) AS total,
           coalesce(nullif(e->>'category', ''), 'Uncategorised') AS category
    FROM jsonb_array_elements(p_items) e
  LOOP
    CONTINUE WHEN v_line.name IS NULL OR v_line.qty <= 0;

    SELECT id INTO v_ing FROM public.ingredients
    WHERE canteen_id = p_canteen_id AND lower(btrim(name)) = lower(v_line.name) LIMIT 1;

    IF v_ing IS NULL THEN
      INSERT INTO public.ingredients
        (canteen_id, name, category, unit, current_stock, minimum_stock, cost_per_unit)
      VALUES (p_canteen_id, v_line.name, v_line.category, v_line.unit, 0, 0, v_line.rate)
      RETURNING id INTO v_ing;
      v_created := v_created + 1;
    ELSE
      v_topped := v_topped + 1;
    END IF;

    UPDATE public.ingredients
      SET current_stock = current_stock + v_line.qty,
          cost_per_unit = CASE WHEN v_line.rate > 0 THEN v_line.rate ELSE cost_per_unit END
      WHERE id = v_ing RETURNING current_stock INTO v_new;

    INSERT INTO public.purchase_items
      (purchase_id, item_name, quantity, unit, rate, total, ingredient_id)
    VALUES (v_purchase, v_line.name, v_line.qty, v_line.unit, v_line.rate, v_line.total, v_ing);

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason,
       reference_type, reference_id, created_by, service_date, value)
    VALUES (v_ing, p_canteen_id, v_line.qty, v_new,
            'Invoice stock-in — ' || v_line.name, 'purchase', v_purchase, auth.uid(),
            v_today, round(v_line.qty * v_line.rate, 2));

    INSERT INTO public.ingredient_batches
      (ingredient_id, canteen_id, supplier_id, purchase_id, qty_received, qty_remaining, rate)
    VALUES (v_ing, p_canteen_id, p_supplier_id, v_purchase, v_line.qty, v_line.qty, v_line.rate);
  END LOOP;

  RETURN jsonb_build_object(
    'purchase_id', v_purchase, 'new_items', v_created, 'existing_items', v_topped,
    'total', v_sum,
    -- so the screen can say so rather than leaving it to be found in a report
    'stated_total', p_total,
    'mismatch', CASE WHEN p_total IS NOT NULL AND abs(p_total - v_sum) > 0.5
                     THEN round(p_total - v_sum, 2) END);
END;
$$;

-- ---------- Bills whose own total does not match what they carried ----------
-- Worth seeing: a vendor bill that adds up wrong is either a mistake or a
-- charge for goods that never came off the truck.
CREATE OR REPLACE FUNCTION public.receipts_that_do_not_add_up(p_canteen_id UUID, p_days INT DEFAULT 90)
RETURNS TABLE (
  purchase_id UUID, received_on DATE, supplier TEXT,
  lines_add_to NUMERIC, paper_said NUMERIC, difference NUMERIC
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT p.id, (p.created_at AT TIME ZONE 'Asia/Kolkata')::date, s.name,
         p.total_amount, p.stated_total, round(p.stated_total - p.total_amount, 2)
  FROM public.purchases p
  LEFT JOIN public.suppliers s ON s.id = p.supplier_id
  WHERE p.canteen_id = p_canteen_id
    AND p.stated_total IS NOT NULL
    AND abs(p.stated_total - p.total_amount) > 0.5
    AND p.created_at >= (timezone('Asia/Kolkata', now())::date - p_days)
    AND public.can_access_canteen(p_canteen_id)
  ORDER BY abs(p.stated_total - p.total_amount) DESC;
$$;
REVOKE ALL ON FUNCTION public.receipts_that_do_not_add_up(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receipts_that_do_not_add_up(UUID, INT) TO authenticated;
