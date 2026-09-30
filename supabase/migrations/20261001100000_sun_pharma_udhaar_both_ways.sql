-- ============================================================
-- SUN PHARMA UDHAAR, BOTH WAYS, AT A REAL PRICE
--
-- Eicher borrows from the Sun Pharma central kitchen and gives it back later;
-- that flow existed. Three things were wrong with it.
--
-- 1. Every borrowed line went in at ₹0. The receive function did
--    coalesce(rate, cost_per_unit, 0), but the screen always sent rate = 0
--    (it fell back to a field that does not exist), and coalesce() does not
--    skip a zero. 117 lines — 150 L oil, 1,200 kg rice, 200+ L Amul Gold —
--    sat on the shelf as free stock. When the kitchen cooked with it, the
--    meal was charged nothing, so food cost read low and profit read high.
--
-- 2. Giving it back walked the ordinary FIFO queue. FIFO takes the OLDEST lot,
--    which is stock Eicher paid for; the borrowed ₹0 lot stayed behind to be
--    cooked for free. Returning goods should take back the goods that came
--    in on that transfer first, and only then anything else.
--
-- 3. It only ran one way. Eicher also lends to Sun Pharma, and there was no
--    way to record it except as consumption or a hand adjustment — either of
--    which makes it look eaten.
--
-- Now a transfer has a direction:
--   in   Sun Pharma se liya   — stock up, Eicher owes it back
--   out  Sun Pharma ko diya   — stock down, Sun Pharma owes it back
-- Neither direction is food cost: reports count only 'issue' and 'recipe'.
-- Both carry a real rupee value, so "who owes whom how much" has an answer.
--
-- Also here: a guard so the invoice scanner can no longer save its own
-- reasoning, a whole letterhead, or a repeated syllable as a vendor name.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.central_kitchen_transfers
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'in';
ALTER TABLE public.central_kitchen_transfers
  DROP CONSTRAINT IF EXISTS central_kitchen_transfers_direction_check;
ALTER TABLE public.central_kitchen_transfers
  ADD CONSTRAINT central_kitchen_transfers_direction_check CHECK (direction IN ('in','out'));

COMMENT ON COLUMN public.central_kitchen_transfers.direction IS
  'in = borrowed from the other kitchen (we owe it back); out = lent to it (it owes us).';

-- ---------- What an item costs to replace ----------
-- The last price actually paid on a confirmed bill (on or before the date if
-- one is given); failing that, what the lots on the shelf are worth; failing
-- that, the item's own rate.
CREATE OR REPLACE FUNCTION public.item_replacement_rate(p_ingredient_id uuid, p_on date DEFAULT NULL)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(
    (SELECT pi.rate FROM public.purchase_items pi
       JOIN public.purchases p ON p.id = pi.purchase_id
      WHERE pi.ingredient_id = p_ingredient_id AND p.status = 'confirmed' AND pi.rate > 0
        AND (p_on IS NULL OR (p.created_at AT TIME ZONE 'Asia/Kolkata')::date <= p_on)
      ORDER BY p.created_at DESC LIMIT 1),
    (SELECT pi.rate FROM public.purchase_items pi
       JOIN public.purchases p ON p.id = pi.purchase_id
      WHERE pi.ingredient_id = p_ingredient_id AND p.status = 'confirmed' AND pi.rate > 0
      ORDER BY p.created_at DESC LIMIT 1),
    (SELECT round(sum(b.qty_remaining * b.rate) / nullif(sum(b.qty_remaining), 0), 4)
       FROM public.ingredient_batches b
      WHERE b.ingredient_id = p_ingredient_id AND b.qty_remaining > 0 AND b.rate > 0),
    (SELECT nullif(cost_per_unit, 0) FROM public.ingredients WHERE id = p_ingredient_id),
    0);
$$;
REVOKE ALL ON FUNCTION public.item_replacement_rate(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.item_replacement_rate(uuid, date) TO authenticated;

-- One name for the other kitchen. Free text had produced "Sun Pharma Central
-- Kitchen", "Central kitchen", "central kitchen se" and "p" for the same place.
CREATE OR REPLACE FUNCTION public.udhaar_party_name(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p IS NULL OR length(btrim(p)) < 3 OR btrim(p) ~* '(sun|pharma|central|kitchen)'
      THEN 'Sun Pharma Central Kitchen'
    ELSE btrim(p) END;
$$;

-- Take goods out of a named lot first, then the ordinary FIFO queue.
-- Caller must already have raised allow_stock_move().
CREATE OR REPLACE FUNCTION public.consume_named_lot_then_fifo(
  p_ingredient_id uuid, p_canteen_id uuid, p_qty numeric, p_batch_no text
) RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_left numeric := p_qty; v_take numeric; v_value numeric := 0; b record;
BEGIN
  FOR b IN
    SELECT id, qty_remaining, rate FROM public.ingredient_batches
     WHERE ingredient_id = p_ingredient_id AND canteen_id = p_canteen_id
       AND batch_no = p_batch_no AND qty_remaining > 0
     ORDER BY received_at, id FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := least(v_left, b.qty_remaining);
    UPDATE public.ingredient_batches SET qty_remaining = qty_remaining - v_take WHERE id = b.id;
    v_value := v_value + v_take * coalesce(b.rate, 0);
    v_left := v_left - v_take;
  END LOOP;
  IF v_left > 0 THEN
    v_value := v_value + public.consume_batches_fifo(p_ingredient_id, p_canteen_id, v_left);
  END IF;
  RETURN round(v_value, 2);
END;
$$;
REVOKE ALL ON FUNCTION public.consume_named_lot_then_fifo(uuid, uuid, numeric, text) FROM PUBLIC, anon, authenticated;

-- ---------- 1. Borrow from Sun Pharma (direction in) ----------
CREATE OR REPLACE FUNCTION public.receive_central_kitchen_transfer(
  p_canteen_id uuid, p_source_name text, p_transfer_date date,
  p_expected_return_date date, p_items jsonb, p_notes text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_transfer public.central_kitchen_transfers%ROWTYPE;
  v_input jsonb; v_ing public.ingredients%ROWTYPE;
  v_qty numeric; v_rate numeric; v_new_balance numeric;
  v_count integer := 0; v_value numeric := 0;
BEGIN
  IF NOT public.can_receive_stock() OR NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'Only the authorised Store Keeper can receive Central Kitchen stock';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item is required';
  END IF;
  IF p_expected_return_date IS NOT NULL
     AND p_expected_return_date < coalesce(p_transfer_date, current_date) THEN
    RAISE EXCEPTION 'Return date cannot be before the received date';
  END IF;

  INSERT INTO public.central_kitchen_transfers(
    canteen_id, source_name, transfer_date, expected_return_date, notes, received_by, direction
  ) VALUES (
    p_canteen_id, public.udhaar_party_name(p_source_name),
    coalesce(p_transfer_date, current_date), p_expected_return_date,
    nullif(btrim(coalesce(p_notes, '')), ''), auth.uid(), 'in'
  ) RETURNING * INTO v_transfer;

  FOR v_input IN
    SELECT value FROM jsonb_array_elements(p_items) ORDER BY (value->>'ingredient_id')::uuid
  LOOP
    v_qty := round(coalesce((v_input->>'qty')::numeric, 0), 3);
    IF v_qty <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_ing FROM public.ingredients
     WHERE id = (v_input->>'ingredient_id')::uuid AND canteen_id = p_canteen_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Central Kitchen item is not part of this site inventory'; END IF;
    IF EXISTS (SELECT 1 FROM public.central_kitchen_transfer_items
                WHERE transfer_id = v_transfer.id AND ingredient_id = v_ing.id) THEN
      RAISE EXCEPTION '% is repeated in this transfer', v_ing.name;
    END IF;

    -- A typed rate wins. A blank or zero rate means "I don't know", and the
    -- answer is what it would cost to buy — never free.
    v_rate := nullif(greatest(coalesce((v_input->>'rate')::numeric, 0), 0), 0);
    v_rate := coalesce(v_rate, public.item_replacement_rate(v_ing.id, v_transfer.transfer_date));

    INSERT INTO public.central_kitchen_transfer_items(transfer_id, ingredient_id, qty_received, unit, rate)
    VALUES (v_transfer.id, v_ing.id, v_qty, v_ing.unit, v_rate);

    PERFORM public.allow_stock_move();
    UPDATE public.ingredients SET current_stock = current_stock + v_qty
     WHERE id = v_ing.id RETURNING current_stock INTO v_new_balance;

    INSERT INTO public.ingredient_batches(ingredient_id, canteen_id, batch_no, qty_received, qty_remaining, rate, received_at)
    VALUES (v_ing.id, p_canteen_id, 'CK-' || v_transfer.transfer_no::text, v_qty, v_qty, v_rate, now());

    INSERT INTO public.stock_ledger(ingredient_id, canteen_id, change_qty, balance_after, reason,
      reference_type, reference_id, created_by, service_date, value)
    VALUES (v_ing.id, p_canteen_id, v_qty, v_new_balance,
      format('Sun Pharma se udhaar liya — transfer #%s; wapas dena hai', v_transfer.transfer_no),
      'central_kitchen_in', v_transfer.id, auth.uid(), v_transfer.transfer_date, round(v_qty * v_rate, 2));
    v_count := v_count + 1;
    v_value := v_value + v_qty * v_rate;
  END LOOP;

  IF v_count = 0 THEN RAISE EXCEPTION 'Every quantity is zero'; END IF;

  INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'central_kitchen_transfer_received', 'central_kitchen_transfer', v_transfer.id, p_canteen_id,
    jsonb_build_object('transfer_no', v_transfer.transfer_no, 'source', v_transfer.source_name,
      'items', v_count, 'value', round(v_value, 2), 'expected_return_date', v_transfer.expected_return_date));

  RETURN jsonb_build_object('id', v_transfer.id, 'transfer_no', v_transfer.transfer_no,
    'items_received', v_count, 'value', round(v_value, 2), 'status', 'open');
END;
$$;

-- ---------- 2. Give borrowed goods back (direction in) ----------
CREATE OR REPLACE FUNCTION public.return_central_kitchen_transfer(
  p_transfer_id uuid, p_items jsonb, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_transfer public.central_kitchen_transfers%ROWTYPE;
  v_line public.central_kitchen_transfer_items%ROWTYPE;
  v_input jsonb; v_qty numeric; v_balance numeric; v_cost numeric;
  v_count integer := 0; v_status text; v_changes jsonb := '[]'::jsonb;
BEGIN
  IF nullif(btrim(coalesce(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Return reason is required'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one return item is required';
  END IF;

  SELECT * INTO v_transfer FROM public.central_kitchen_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Central Kitchen transfer not found'; END IF;
  IF v_transfer.direction <> 'in' THEN
    RAISE EXCEPTION 'Ye udhaar Sun Pharma ko diya gaya tha — "Wapas aaya" se record karein';
  END IF;
  IF v_transfer.status = 'returned' THEN RAISE EXCEPTION 'This transfer is already fully returned'; END IF;
  IF NOT public.can_receive_stock() OR NOT public.can_access_canteen(v_transfer.canteen_id) THEN
    RAISE EXCEPTION 'Only the authorised Store Keeper can return Central Kitchen stock';
  END IF;

  FOR v_input IN
    SELECT value FROM jsonb_array_elements(p_items) ORDER BY (value->>'item_id')::uuid
  LOOP
    v_qty := round(coalesce((v_input->>'qty')::numeric, 0), 3);
    IF v_qty <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_line FROM public.central_kitchen_transfer_items
     WHERE id = (v_input->>'item_id')::uuid AND transfer_id = p_transfer_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'A transfer item was not found'; END IF;
    IF v_qty > v_line.qty_received - v_line.qty_returned + 0.000000001 THEN
      RAISE EXCEPTION 'Return quantity exceeds the pending Central Kitchen quantity';
    END IF;

    PERFORM public.allow_stock_move();
    UPDATE public.ingredients SET current_stock = current_stock - v_qty
     WHERE id = v_line.ingredient_id AND canteen_id = v_transfer.canteen_id AND current_stock >= v_qty
     RETURNING current_stock INTO v_balance;
    IF NOT FOUND THEN RAISE EXCEPTION 'Shelf stock is less than the quantity being returned'; END IF;

    -- The goods that came in on this transfer go back first.
    v_cost := public.consume_named_lot_then_fifo(
      v_line.ingredient_id, v_transfer.canteen_id, v_qty, 'CK-' || v_transfer.transfer_no::text);

    UPDATE public.central_kitchen_transfer_items
       SET qty_returned = qty_returned + v_qty, last_returned_at = now()
     WHERE id = v_line.id;

    INSERT INTO public.stock_ledger(ingredient_id, canteen_id, change_qty, balance_after, reason,
      reference_type, reference_id, created_by, service_date, value)
    VALUES (v_line.ingredient_id, v_transfer.canteen_id, -v_qty, v_balance,
      format('Sun Pharma ko udhaar wapas — transfer #%s; %s', v_transfer.transfer_no, btrim(p_reason)),
      'central_kitchen_return', v_transfer.id, auth.uid(), current_date, v_cost);

    v_count := v_count + 1;
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'item_id', v_line.id, 'ingredient_id', v_line.ingredient_id, 'qty', v_qty, 'unit', v_line.unit, 'value', v_cost));
  END LOOP;

  IF v_count = 0 THEN RAISE EXCEPTION 'Every return quantity is zero'; END IF;

  SELECT CASE WHEN bool_and(qty_returned >= qty_received) THEN 'returned' ELSE 'partially_returned' END
    INTO v_status FROM public.central_kitchen_transfer_items WHERE transfer_id = p_transfer_id;
  UPDATE public.central_kitchen_transfers SET status = v_status, updated_at = now() WHERE id = p_transfer_id;

  INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'central_kitchen_transfer_returned', 'central_kitchen_transfer', p_transfer_id, v_transfer.canteen_id,
    jsonb_build_object('transfer_no', v_transfer.transfer_no, 'reason', btrim(p_reason), 'status', v_status, 'changes', v_changes));

  RETURN jsonb_build_object('transfer_no', v_transfer.transfer_no, 'returned_lines', v_count, 'status', v_status, 'changes', v_changes);
END;
$$;

-- ---------- 3. Lend to Sun Pharma (direction out) ----------
CREATE OR REPLACE FUNCTION public.lend_central_kitchen_transfer(
  p_canteen_id uuid, p_party_name text, p_transfer_date date,
  p_expected_return_date date, p_items jsonb, p_notes text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_transfer public.central_kitchen_transfers%ROWTYPE;
  v_input jsonb; v_ing public.ingredients%ROWTYPE;
  v_qty numeric; v_cost numeric; v_rate numeric; v_balance numeric;
  v_count integer := 0; v_value numeric := 0;
BEGIN
  IF NOT public.can_receive_stock() OR NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'Sirf Store Keeper udhaar de sakta hai';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item is required';
  END IF;
  IF p_expected_return_date IS NOT NULL
     AND p_expected_return_date < coalesce(p_transfer_date, current_date) THEN
    RAISE EXCEPTION 'Return date cannot be before the lending date';
  END IF;

  INSERT INTO public.central_kitchen_transfers(
    canteen_id, source_name, transfer_date, expected_return_date, notes, received_by, direction
  ) VALUES (
    p_canteen_id, public.udhaar_party_name(p_party_name),
    coalesce(p_transfer_date, current_date), p_expected_return_date,
    nullif(btrim(coalesce(p_notes, '')), ''), auth.uid(), 'out'
  ) RETURNING * INTO v_transfer;

  FOR v_input IN
    SELECT value FROM jsonb_array_elements(p_items) ORDER BY (value->>'ingredient_id')::uuid
  LOOP
    v_qty := round(coalesce((v_input->>'qty')::numeric, 0), 3);
    IF v_qty <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_ing FROM public.ingredients
     WHERE id = (v_input->>'ingredient_id')::uuid AND canteen_id = p_canteen_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Item is not part of this site inventory'; END IF;
    IF EXISTS (SELECT 1 FROM public.central_kitchen_transfer_items
                WHERE transfer_id = v_transfer.id AND ingredient_id = v_ing.id) THEN
      RAISE EXCEPTION '% is repeated in this transfer', v_ing.name;
    END IF;
    IF v_ing.current_stock < v_qty THEN
      RAISE EXCEPTION '%: shelf par sirf % % hai, % % udhaar nahi de sakte',
        v_ing.name, round(v_ing.current_stock, 3), v_ing.unit, v_qty, v_ing.unit;
    END IF;

    PERFORM public.allow_stock_move();
    UPDATE public.ingredients SET current_stock = current_stock - v_qty
     WHERE id = v_ing.id RETURNING current_stock INTO v_balance;

    -- The goods leave at what they cost Eicher, oldest lot first — the same
    -- figure the shelf was carrying them at.
    v_cost := round(public.consume_batches_fifo(v_ing.id, p_canteen_id, v_qty), 2);
    v_rate := CASE WHEN v_cost > 0 THEN round(v_cost / v_qty, 4)
                   ELSE public.item_replacement_rate(v_ing.id, v_transfer.transfer_date) END;

    INSERT INTO public.central_kitchen_transfer_items(transfer_id, ingredient_id, qty_received, unit, rate)
    VALUES (v_transfer.id, v_ing.id, v_qty, v_ing.unit, v_rate);

    INSERT INTO public.stock_ledger(ingredient_id, canteen_id, change_qty, balance_after, reason,
      reference_type, reference_id, created_by, service_date, value)
    VALUES (v_ing.id, p_canteen_id, -v_qty, v_balance,
      format('Sun Pharma ko udhaar diya — transfer #%s; wapas aana hai', v_transfer.transfer_no),
      'central_kitchen_lend', v_transfer.id, auth.uid(), v_transfer.transfer_date, round(v_qty * v_rate, 2));

    v_count := v_count + 1;
    v_value := v_value + v_qty * v_rate;
  END LOOP;

  IF v_count = 0 THEN RAISE EXCEPTION 'Every quantity is zero'; END IF;

  INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'central_kitchen_transfer_lent', 'central_kitchen_transfer', v_transfer.id, p_canteen_id,
    jsonb_build_object('transfer_no', v_transfer.transfer_no, 'party', v_transfer.source_name,
      'items', v_count, 'value', round(v_value, 2), 'expected_return_date', v_transfer.expected_return_date));

  RETURN jsonb_build_object('id', v_transfer.id, 'transfer_no', v_transfer.transfer_no,
    'items_lent', v_count, 'value', round(v_value, 2), 'status', 'open');
END;
$$;
REVOKE ALL ON FUNCTION public.lend_central_kitchen_transfer(uuid, text, date, date, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lend_central_kitchen_transfer(uuid, text, date, date, jsonb, text) TO authenticated;

-- ---------- 4. Lent goods come back (direction out) ----------
-- They come back at the value they left at, so lending and getting back is
-- worth exactly nothing to the books — which is the truth.
CREATE OR REPLACE FUNCTION public.receive_back_central_kitchen_transfer(
  p_transfer_id uuid, p_items jsonb, p_note text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_transfer public.central_kitchen_transfers%ROWTYPE;
  v_line public.central_kitchen_transfer_items%ROWTYPE;
  v_input jsonb; v_qty numeric; v_balance numeric;
  v_count integer := 0; v_status text; v_changes jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item is required';
  END IF;

  SELECT * INTO v_transfer FROM public.central_kitchen_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF v_transfer.direction <> 'out' THEN
    RAISE EXCEPTION 'Ye udhaar Sun Pharma se liya gaya tha — "Wapas bhejo" se record karein';
  END IF;
  IF v_transfer.status = 'returned' THEN RAISE EXCEPTION 'Sab saman pehle hi wapas aa chuka hai'; END IF;
  IF NOT public.can_receive_stock() OR NOT public.can_access_canteen(v_transfer.canteen_id) THEN
    RAISE EXCEPTION 'Sirf Store Keeper wapsi record kar sakta hai';
  END IF;

  FOR v_input IN
    SELECT value FROM jsonb_array_elements(p_items) ORDER BY (value->>'item_id')::uuid
  LOOP
    v_qty := round(coalesce((v_input->>'qty')::numeric, 0), 3);
    IF v_qty <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_line FROM public.central_kitchen_transfer_items
     WHERE id = (v_input->>'item_id')::uuid AND transfer_id = p_transfer_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'A transfer item was not found'; END IF;
    IF v_qty > v_line.qty_received - v_line.qty_returned + 0.000000001 THEN
      RAISE EXCEPTION 'Jitna udhaar diya tha usse zyada wapas nahi aa sakta';
    END IF;

    PERFORM public.allow_stock_move();
    UPDATE public.ingredients SET current_stock = current_stock + v_qty
     WHERE id = v_line.ingredient_id AND canteen_id = v_transfer.canteen_id
     RETURNING current_stock INTO v_balance;

    INSERT INTO public.ingredient_batches(ingredient_id, canteen_id, batch_no, qty_received, qty_remaining, rate, received_at)
    VALUES (v_line.ingredient_id, v_transfer.canteen_id, 'CKB-' || v_transfer.transfer_no::text,
            v_qty, v_qty, v_line.rate, now());

    UPDATE public.central_kitchen_transfer_items
       SET qty_returned = qty_returned + v_qty, last_returned_at = now()
     WHERE id = v_line.id;

    INSERT INTO public.stock_ledger(ingredient_id, canteen_id, change_qty, balance_after, reason,
      reference_type, reference_id, created_by, service_date, value)
    VALUES (v_line.ingredient_id, v_transfer.canteen_id, v_qty, v_balance,
      format('Sun Pharma se udhaar wapas aaya — transfer #%s%s', v_transfer.transfer_no,
             coalesce('; ' || nullif(btrim(p_note), ''), '')),
      'central_kitchen_lend_back', v_transfer.id, auth.uid(), current_date, round(v_qty * v_line.rate, 2));

    v_count := v_count + 1;
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'item_id', v_line.id, 'ingredient_id', v_line.ingredient_id, 'qty', v_qty, 'unit', v_line.unit,
      'value', round(v_qty * v_line.rate, 2)));
  END LOOP;

  IF v_count = 0 THEN RAISE EXCEPTION 'Every quantity is zero'; END IF;

  SELECT CASE WHEN bool_and(qty_returned >= qty_received) THEN 'returned' ELSE 'partially_returned' END
    INTO v_status FROM public.central_kitchen_transfer_items WHERE transfer_id = p_transfer_id;
  UPDATE public.central_kitchen_transfers SET status = v_status, updated_at = now() WHERE id = p_transfer_id;

  INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'central_kitchen_transfer_received_back', 'central_kitchen_transfer', p_transfer_id, v_transfer.canteen_id,
    jsonb_build_object('transfer_no', v_transfer.transfer_no, 'status', v_status, 'changes', v_changes));

  RETURN jsonb_build_object('transfer_no', v_transfer.transfer_no, 'returned_lines', v_count, 'status', v_status);
END;
$$;
REVOKE ALL ON FUNCTION public.receive_back_central_kitchen_transfer(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_back_central_kitchen_transfer(uuid, jsonb, text) TO authenticated;

-- ---------- 5. Price the borrowed lines that went in at ₹0 ----------
-- Only what is still on the shelf is repriced. What the kitchen already
-- cooked was charged ₹0 on its day, and rewriting that would change a closed
-- day's food cost; the size of that gap is logged instead.
DO $$
DECLARE r record; v_rate numeric; v_lots int := 0; v_lines int := 0;
        v_shelf numeric := 0; v_gone numeric := 0; v_rem numeric;
BEGIN
  PERFORM public.allow_stock_move();

  UPDATE public.central_kitchen_transfers
     SET source_name = public.udhaar_party_name(source_name)
   WHERE source_name IS DISTINCT FROM public.udhaar_party_name(source_name);

  FOR r IN
    SELECT i.id AS line_id, i.ingredient_id, i.qty_received, t.transfer_no, t.transfer_date, t.canteen_id
      FROM public.central_kitchen_transfer_items i
      JOIN public.central_kitchen_transfers t ON t.id = i.transfer_id
     WHERE t.direction = 'in' AND coalesce(i.rate, 0) = 0
  LOOP
    v_rate := public.item_replacement_rate(r.ingredient_id, r.transfer_date);
    CONTINUE WHEN coalesce(v_rate, 0) = 0;

    UPDATE public.central_kitchen_transfer_items SET rate = v_rate WHERE id = r.line_id;
    v_lines := v_lines + 1;

    SELECT coalesce(sum(qty_remaining), 0) INTO v_rem FROM public.ingredient_batches
     WHERE ingredient_id = r.ingredient_id AND canteen_id = r.canteen_id
       AND batch_no = 'CK-' || r.transfer_no::text AND coalesce(rate, 0) = 0;

    UPDATE public.ingredient_batches SET rate = v_rate
     WHERE ingredient_id = r.ingredient_id AND canteen_id = r.canteen_id
       AND batch_no = 'CK-' || r.transfer_no::text AND coalesce(rate, 0) = 0;
    IF FOUND THEN v_lots := v_lots + 1; END IF;

    v_shelf := v_shelf + v_rem * v_rate;
    v_gone  := v_gone + greatest(r.qty_received - v_rem, 0) * v_rate;
  END LOOP;

  INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (NULL, 'central_kitchen_zero_rates_repriced', 'central_kitchen_transfer', NULL,
    (SELECT id FROM public.canteens WHERE name ILIKE 'Eicher%' LIMIT 1),
    jsonb_build_object('lines_repriced', v_lines, 'lots_repriced', v_lots,
      'shelf_value_added', round(v_shelf, 2),
      'already_used_or_returned_at_zero', round(v_gone, 2),
      'note', 'Borrowed Sun Pharma stock had gone in at ₹0. Remaining lots now carry the last paid rate. Goods already used were charged ₹0 on their day and were not rewritten.'));

  RAISE NOTICE 'repriced % lines, % lots; shelf +₹%; left the ₹0 lots before this fix ≈ ₹%',
    v_lines, v_lots, round(v_shelf), round(v_gone);
END $$;

-- ---------- 6. Vendor names ----------
-- The scanner's model sometimes wrote its own reasoning, a whole letterhead,
-- or one syllable repeated a thousand times into the vendor name, and the app
-- saved it as a new vendor. Every later bill then tried to match against it.
CREATE OR REPLACE FUNCTION public.clean_vendor_name(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text;
BEGIN
  v := regexp_replace(coalesce(p, ''), '[​-‍﻿]', '', 'g');
  v := split_part(v, E'\n', 1);
  v := regexp_replace(v, '\s+', ' ', 'g');
  RETURN btrim(v);
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_supplier_name()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.name := public.clean_vendor_name(NEW.name);
  IF length(NEW.name) < 2 THEN RAISE EXCEPTION 'Vendor ka naam khaali hai'; END IF;
  IF length(NEW.name) > 60
     OR NEW.name ~* '(let''s|\mwait\M|vendor name|as per|letterhead|context|\mcheck\M|invoice_|receipt no)'
     OR NEW.name ~ '(.{3,})\1\1' THEN
    RAISE EXCEPTION 'Vendor ka naam galat padha gaya ("%…"). Bill par jo dukaan ka naam hai wahi chhota likhein.', left(NEW.name, 40);
  END IF;
  IF EXISTS (SELECT 1 FROM public.suppliers s
              WHERE s.id <> NEW.id
                AND lower(regexp_replace(s.name, '[^[:alnum:]]', '', 'g')) = lower(regexp_replace(NEW.name, '[^[:alnum:]]', '', 'g'))) THEN
    RAISE EXCEPTION 'Vendor "%" pehle se hai', NEW.name;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_supplier_name ON public.suppliers;
CREATE TRIGGER trg_guard_supplier_name
  BEFORE INSERT OR UPDATE OF name ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.guard_supplier_name();

-- Two real vendors with real bills whose names carried the model's reasoning.
DO $$
BEGIN
  PERFORM public.allow_stock_move();
  UPDATE public.suppliers SET name = 'Manwani Traders'
   WHERE id = 'abb9ef4d-98bc-4fc1-987d-bee9a3e3028a' AND length(name) > 60;
  UPDATE public.suppliers SET name = 'Madhav Paneer'
   WHERE id = 'ca8b4ac0-4ea1-4944-afcf-f95e480d227a' AND length(name) > 60;
END $$;
