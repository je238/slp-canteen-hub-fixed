-- ============================================================
-- TAKING STOCK IN BY HAND, AND LOCKING IT ONCE IT IS IN
--
-- Not every delivery arrives with a bill the camera can read. Handwritten
-- slips, a torn corner, a phone with no signal, and — right now — an opening
-- count written out in a notebook. Until today the only way stock could be
-- taken in was through the scanner, which made the reader a single point of
-- failure for the one thing the store keeper must always be able to do.
--
-- So the same receipt can now be typed. It is the SAME operation underneath:
-- the lots, the ledger row, the goods-receipt record and the guards are all
-- identical. Only the reading of the paper is done by a person.
--
-- And one hole closed while here. Everything about a receipt was already
-- locked against the person who entered it — the stock figure, the ledger,
-- the bill lines, the receipt itself — except ingredient_batches, which sat
-- open. That table is what FIFO reads to decide what stock is worth. A store
-- keeper could not change how much was on the shelf, but could change what it
-- was worth, and quietly move the cost of a shortage onto another month. It
-- now answers to the same flag as everything else: only the stock functions
-- may write it, never a person with a browser.
--
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_ingredient_batches()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- Raised for the length of one transaction by the receipt, issue, return
  -- and merge functions. A REST call carries no such flag.
  IF coalesce(current_setting('app.stock_move', true), '') <> 'on' THEN
    RAISE EXCEPTION
      'Stock lots cannot be edited directly — they are what the books value the stock at. Use a goods receipt, an issue or a stock audit.';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_ingredient_batches ON public.ingredient_batches;
CREATE TRIGGER trg_guard_ingredient_batches
  BEFORE INSERT OR UPDATE OR DELETE ON public.ingredient_batches
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingredient_batches();

-- ---------- A goods receipt, typed ----------
-- Deliberately a thin wrapper over the receipt the scanner already uses:
-- one path for stock coming in means one set of rules, one ledger shape and
-- one place a mistake can hide. `p_manual` only changes what the note says,
-- so anyone reading the books later can tell a typed receipt from a scanned
-- one without having to guess.
CREATE OR REPLACE FUNCTION public.add_stock_by_hand(
  p_canteen_id UUID,
  p_items JSONB,
  p_supplier_id UUID DEFAULT NULL,
  p_note TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_note TEXT;
BEGIN
  IF NOT public.can_receive_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can take stock in';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Nothing to take in — add at least one item';
  END IF;

  -- Said plainly in the record itself. A receipt with no bill behind it is
  -- not wrong, but it is worth being able to see at a glance.
  v_note := coalesce(nullif(btrim(p_note), ''), 'Stock taken in by hand');
  v_note := v_note || ' · entered by hand, no bill scanned';

  RETURN public.add_stock_from_invoice(
    p_canteen_id, p_supplier_id, p_items, v_note, NULL, NULL);
END;
$$;
REVOKE ALL ON FUNCTION public.add_stock_by_hand(UUID, JSONB, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_stock_by_hand(UUID, JSONB, UUID, TEXT) TO authenticated;
