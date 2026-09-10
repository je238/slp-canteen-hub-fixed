-- ============================================================
-- YOU CANNOT ISSUE STOCK THAT IS NOT IN THE STORE
--
-- issue_requisition subtracted the approved quantity with no check that the
-- store actually held it, so 21 kg of atta went out of a shelf holding 0 and
-- the register settled at minus 21.
--
-- A negative balance is not a small cosmetic wrong. It means goods left the
-- building that were never received on paper — the delivery was never
-- entered, the vendor is still owed for it, and the day's consumption looks
-- perfectly ordinary. It is the one shape of error that hides an unrecorded
-- purchase, and it was the one the rest of this system could not see.
--
-- The issue is now refused, naming the item and what is really on the shelf,
-- which forces the bill to be entered before the goods move. A CHECK on the
-- column itself is the backstop, so any path added later fails loudly rather
-- than quietly going negative.
--
-- Safe to re-run.
-- ============================================================

-- Fix the row the missing check already produced.
DO $$
BEGIN
  PERFORM public.allow_stock_move();
  UPDATE public.ingredients SET current_stock = 0 WHERE current_stock < 0;
END $$;

ALTER TABLE public.ingredients DROP CONSTRAINT IF EXISTS ingredients_stock_not_negative;
ALTER TABLE public.ingredients
  ADD CONSTRAINT ingredients_stock_not_negative CHECK (current_stock >= 0);

CREATE OR REPLACE FUNCTION public.issue_requisition(p_req_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.requisitions%ROWTYPE; v_line RECORD; v_new NUMERIC;
        v_n INT := 0; v_cost NUMERIC; v_total NUMERIC := 0; v_short TEXT := '';
BEGIN
  SELECT * INTO v_req FROM public.requisitions WHERE id = p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown requisition'; END IF;
  IF v_req.status = 'issued' THEN RETURN jsonb_build_object('already', true); END IF;
  IF v_req.status <> 'approved' THEN
    RAISE EXCEPTION 'Only an approved requisition can be issued (current status: %)', v_req.status;
  END IF;
  IF NOT public.can_issue_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can issue stock';
  END IF;
  IF NOT public.can_access_canteen(v_req.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  -- Check the whole order before moving any of it, so a short line does not
  -- leave half a requisition issued.
  SELECT string_agg(format('%s: asked %s, only %s on the shelf',
                           i.name, ri.approved_qty, i.current_stock), '; ')
  INTO v_short
  FROM public.requisition_items ri
  JOIN public.ingredients i ON i.id = ri.ingredient_id
  WHERE ri.requisition_id = p_req_id
    AND coalesce(ri.approved_qty, 0) > 0
    AND i.current_stock < ri.approved_qty;

  IF coalesce(v_short, '') <> '' THEN
    RAISE EXCEPTION
      'Not enough stock to issue this order — %. Record the delivery first, then issue.', v_short;
  END IF;

  PERFORM public.allow_stock_move();

  FOR v_line IN
    SELECT ri.id, ri.ingredient_id, coalesce(ri.approved_qty, 0) AS qty, i.name
    FROM public.requisition_items ri JOIN public.ingredients i ON i.id = ri.ingredient_id
    WHERE ri.requisition_id = p_req_id AND coalesce(ri.approved_qty, 0) > 0
    ORDER BY ri.ingredient_id
  LOOP
    UPDATE public.ingredients SET current_stock = current_stock - v_line.qty
      WHERE id = v_line.ingredient_id AND canteen_id = v_req.canteen_id
      RETURNING current_stock INTO v_new;
    IF NOT FOUND THEN RAISE EXCEPTION 'Ingredient % does not belong to this site', v_line.name; END IF;

    v_cost := public.consume_batches_fifo(v_line.ingredient_id, v_req.canteen_id, v_line.qty);
    v_total := v_total + v_cost;

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, reference_id, created_by)
    VALUES (v_line.ingredient_id, v_req.canteen_id, -v_line.qty, v_new,
            'Requisition #' || v_req.req_no || ' issued to kitchen', 'issue', p_req_id, auth.uid());

    UPDATE public.requisition_items SET issued_qty = v_line.qty WHERE id = v_line.id;
    v_n := v_n + 1;
  END LOOP;

  UPDATE public.requisitions SET status = 'issued', issued_by = auth.uid(), issued_at = now()
  WHERE id = p_req_id;
  RETURN jsonb_build_object('issued_lines', v_n, 'fifo_value', round(v_total, 2));
END;
$$;
