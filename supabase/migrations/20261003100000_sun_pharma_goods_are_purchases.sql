-- ============================================================
-- SUN PHARMA GOODS ARE EICHER PURCHASES, AND BOTH SHELVES MOVE
--
-- From 3 Oct 2026, as the owner asked:
--   · goods Eicher borrows from Sun Pharma are an Eicher purchase from the
--     vendor "Sun Pharma", at the transfer rate — so the purchase reports
--     carry them (until now ₹3.41 lakh in September never reached them);
--   · goods Eicher gives back against that borrowing are a purchase return
--     (a minus line at the price they came in at), so purchases are not
--     counted twice;
--   · anything Eicher sends to Sun Pharma — lent, or given back — leaves
--     Eicher's shelf and lands on Sun Pharma's shelf in the app; anything
--     Sun Pharma sends comes off Sun Pharma's shelf, as far as it holds it.
-- Lending Eicher's own goods is not a purchase either way.
--
-- purchases.source tells these apart from vendor bills: 'sun_pharma_in',
-- 'sun_pharma_return'. They need no paper bill. The CK-<n> lots now carry
-- the purchase id, which is what shows "Sun Pharma ka maal" on the shelf.
--
-- Sun Pharma's items are matched to Eicher's by name (case and spacing
-- ignored); an item Sun Pharma has never held is created there with the
-- same name, unit and category.
--
-- Earlier transfers are left as they were: this applies from today.
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'vendor';
ALTER TABLE public.central_kitchen_transfers ADD COLUMN IF NOT EXISTS purchase_id uuid REFERENCES public.purchases(id);
CREATE INDEX IF NOT EXISTS idx_purchases_source ON public.purchases (canteen_id, source) WHERE source <> 'vendor';

CREATE OR REPLACE FUNCTION public.sun_pharma_site() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM public.canteens WHERE name ILIKE '%sun%pharma%' OR name ILIKE 'sunpharma%' ORDER BY created_at LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.sun_pharma_site() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sun_pharma_supplier(p_canteen_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v uuid;
BEGIN
  SELECT id INTO v FROM public.suppliers
   WHERE lower(regexp_replace(name, '\s+', '', 'g')) IN ('sunpharma', 'sunpharma(udhaar)')
     AND (canteen_id = p_canteen_id OR canteen_id IS NULL)
   ORDER BY canteen_id NULLS LAST LIMIT 1;
  IF v IS NULL THEN
    INSERT INTO public.suppliers (name, canteen_id) VALUES ('Sun Pharma', p_canteen_id) RETURNING id INTO v;
  END IF;
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.sun_pharma_supplier(uuid) FROM PUBLIC, anon, authenticated;

-- One purchase per transfer movement. Confirmed and needing no paper.
CREATE OR REPLACE FUNCTION public.sun_purchase_open(p_canteen_id uuid, p_transfer public.central_kitchen_transfers, p_kind text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v uuid;
BEGIN
  INSERT INTO public.purchases
    (canteen_id, supplier_id, total_amount, notes, status, approved_at, created_by, bill_status, source)
  VALUES
    (p_canteen_id, public.sun_pharma_supplier(p_canteen_id), 0,
     CASE p_kind WHEN 'sun_pharma_in' THEN format('SUN PHARMA se aaya — transfer #%s', p_transfer.transfer_no)
                 ELSE format('SUN PHARMA ko wapas — transfer #%s', p_transfer.transfer_no) END,
     'confirmed', now(), auth.uid(), 'received', p_kind)
  RETURNING id INTO v;
  IF p_kind = 'sun_pharma_in' THEN
    UPDATE public.central_kitchen_transfers SET purchase_id = v WHERE id = p_transfer.id;
  END IF;
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.sun_purchase_open(uuid, public.central_kitchen_transfers, text) FROM PUBLIC, anon, authenticated;

-- A line on it; a minus quantity for goods given back. Stock is moved by the
-- transfer function itself, never by this purchase.
CREATE OR REPLACE FUNCTION public.sun_purchase_add(p_purchase uuid, p_ing public.ingredients, p_qty numeric, p_rate numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.purchase_items (purchase_id, item_name, quantity, unit, rate, total, ingredient_id, matched)
  VALUES (p_purchase, p_ing.name, p_qty, p_ing.unit, round(p_rate, 4), round(p_qty * p_rate, 2), p_ing.id, true);
  PERFORM public.allow_stock_move();   -- the confirmed-purchase guards let a stock function total it
  UPDATE public.purchases SET total_amount = coalesce(total_amount, 0) + round(p_qty * p_rate, 2) WHERE id = p_purchase;
END;
$$;
REVOKE ALL ON FUNCTION public.sun_purchase_add(uuid, public.ingredients, numeric, numeric) FROM PUBLIC, anon, authenticated;

-- Sun Pharma's shelf for the same item: plus opens a lot at the transfer
-- rate; minus takes only what Sun Pharma holds there (it is not tracked
-- daily in the app, so it can never be driven below zero).
CREATE OR REPLACE FUNCTION public.sun_site_move(p_ing public.ingredients, p_qty numeric, p_rate numeric, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_site uuid := public.sun_pharma_site(); v_sun public.ingredients%ROWTYPE; v_take numeric; v_bal numeric; v_cost numeric;
BEGIN
  IF v_site IS NULL OR v_site = p_ing.canteen_id OR p_qty = 0 THEN RETURN; END IF;
  SELECT * INTO v_sun FROM public.ingredients
   WHERE canteen_id = v_site AND archived_at IS NULL
     AND lower(regexp_replace(name, '\s+', '', 'g')) = lower(regexp_replace(p_ing.name, '\s+', '', 'g'))
   ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    IF p_qty < 0 THEN RETURN; END IF;
    INSERT INTO public.ingredients (canteen_id, name, unit, category, current_stock, minimum_stock, cost_per_unit)
    VALUES (v_site, p_ing.name, p_ing.unit, p_ing.category, 0, 0, round(p_rate, 2))
    RETURNING * INTO v_sun;
  END IF;

  PERFORM public.allow_stock_move();
  IF p_qty > 0 THEN
    UPDATE public.ingredients SET current_stock = current_stock + p_qty WHERE id = v_sun.id RETURNING current_stock INTO v_bal;
    INSERT INTO public.ingredient_batches (ingredient_id, canteen_id, batch_no, qty_received, qty_remaining, rate, received_at)
    VALUES (v_sun.id, v_site, 'FROM-EICHER', p_qty, p_qty, round(p_rate, 4), now());
    INSERT INTO public.stock_ledger (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, created_by, service_date, value)
    VALUES (v_sun.id, v_site, p_qty, v_bal, p_reason, 'site_transfer_in', auth.uid(), (now() AT TIME ZONE 'Asia/Kolkata')::date, round(p_qty * p_rate, 2));
  ELSE
    v_take := least(-p_qty, greatest(coalesce(v_sun.current_stock, 0), 0));
    IF v_take <= 0 THEN RETURN; END IF;
    UPDATE public.ingredients SET current_stock = current_stock - v_take WHERE id = v_sun.id RETURNING current_stock INTO v_bal;
    v_cost := public.consume_batches_fifo(v_sun.id, v_site, v_take);
    INSERT INTO public.stock_ledger (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, created_by, service_date, value)
    VALUES (v_sun.id, v_site, -v_take, v_bal, p_reason, 'site_transfer_out', auth.uid(), (now() AT TIME ZONE 'Asia/Kolkata')::date, round(v_cost, 2));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.sun_site_move(public.ingredients, numeric, numeric, text) FROM PUBLIC, anon, authenticated;

-- How much of each item on a shelf came from Sun Pharma and is still there:
-- what is left in the lots its transfers opened.
CREATE OR REPLACE FUNCTION public.sun_pharma_stock(p_canteen_id uuid)
RETURNS TABLE (ingredient_id uuid, qty numeric, value numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.ingredient_id, round(sum(b.qty_remaining), 3), round(sum(b.qty_remaining * b.rate), 2)
    FROM public.ingredient_batches b
   WHERE b.canteen_id = p_canteen_id AND b.qty_remaining > 0 AND b.batch_no LIKE 'CK-%'
     AND public.can_access_canteen(p_canteen_id)
   GROUP BY b.ingredient_id;
$$;
REVOKE ALL ON FUNCTION public.sun_pharma_stock(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sun_pharma_stock(uuid) TO authenticated;

-- Vendor-bill notifications stay quiet for Sun Pharma transfers.
CREATE OR REPLACE FUNCTION public.notify_goods_received()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lines INT; v_supplier TEXT;
BEGIN
  IF NEW.status <> 'confirmed' THEN RETURN NEW; END IF;
  -- A Sun Pharma transfer is not a vendor bill: no photo to chase, and the
  -- udhaar page already records it.
  IF coalesce(NEW.source, 'vendor') <> 'vendor' THEN RETURN NEW; END IF;

  SELECT count(*) INTO v_lines FROM public.purchase_items WHERE purchase_id = NEW.id;
  SELECT name INTO v_supplier FROM public.suppliers WHERE id = NEW.supplier_id;

  INSERT INTO public.notifications
    (canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES (
    NEW.canteen_id, 'admin',
    CASE WHEN NEW.invoice_image_url IS NULL
         THEN format('Goods received — ₹%s, NO BILL PHOTO', round(coalesce(NEW.total_amount, 0)))
         ELSE format('Goods received — ₹%s', round(coalesce(NEW.total_amount, 0)))
    END,
    format('%s from %s. %s',
           coalesce(v_lines, 0) || ' item(s)',
           coalesce(v_supplier, 'an unnamed vendor'),
           CASE
             WHEN NEW.invoice_image_url IS NULL
               THEN 'No photo of the bill was attached — worth asking why before this is settled.'
             WHEN NEW.stated_total IS NOT NULL
                  AND abs(NEW.stated_total - coalesce(NEW.total_amount, 0)) > 0.5
               THEN format('The bill claims ₹%s but the lines received add to ₹%s. Check the photo.',
                           round(NEW.stated_total), round(NEW.total_amount))
             ELSE 'Photo of the bill is attached.'
           END),
    '/purchases', 'purchase', NEW.id);

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_purchase_recorded()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_site TEXT; v_vendor TEXT;
BEGIN
  IF NEW.status <> 'confirmed' THEN RETURN NEW; END IF;
  -- A Sun Pharma transfer is not a vendor bill: no photo to chase, and the
  -- udhaar page already records it.
  IF coalesce(NEW.source, 'vendor') <> 'vendor' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'confirmed' THEN RETURN NEW; END IF;

  SELECT name INTO v_site FROM public.canteens WHERE id = NEW.canteen_id;
  SELECT name INTO v_vendor FROM public.suppliers WHERE id = NEW.supplier_id;

  INSERT INTO public.notifications
    (canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES (
    NEW.canteen_id, 'admin',
    'Bill recorded — ₹' || round(NEW.total_amount)::text,
    coalesce(v_vendor, 'Vendor not named') || ' at ' || coalesce(v_site, 'site') ||
    CASE WHEN NEW.invoice_image_url IS NOT NULL
         THEN ' · photo attached' ELSE ' · NO PHOTO' END,
    '/purchases', 'purchase', NEW.id
  );
  RETURN NEW;
END;
$$;


-- ---------- 1. Borrow from Sun Pharma ----------
CREATE OR REPLACE FUNCTION public.receive_central_kitchen_transfer(
  p_canteen_id uuid, p_source_name text, p_transfer_date date,
  p_expected_return_date date, p_items jsonb, p_notes text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_transfer public.central_kitchen_transfers%ROWTYPE;
  v_input jsonb; v_ing public.ingredients%ROWTYPE;
  v_qty numeric; v_rate numeric; v_new_balance numeric;
  v_count integer := 0; v_value numeric := 0; v_purchase uuid;
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
  v_purchase := public.sun_purchase_open(p_canteen_id, v_transfer, 'sun_pharma_in');

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

    INSERT INTO public.ingredient_batches(ingredient_id, canteen_id, batch_no, qty_received, qty_remaining, rate, received_at, purchase_id)
    VALUES (v_ing.id, p_canteen_id, 'CK-' || v_transfer.transfer_no::text, v_qty, v_qty, v_rate, now(), v_purchase);
    PERFORM public.sun_purchase_add(v_purchase, v_ing, v_qty, v_rate);
    PERFORM public.sun_site_move(v_ing, -v_qty, v_rate, format('Eicher ko diya — transfer #%s', v_transfer.transfer_no));

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
    'items_received', v_count, 'value', round(v_value, 2), 'status', 'open', 'purchase_id', v_purchase);
END;
$$;

-- ---------- 2. Give borrowed goods back ----------
CREATE OR REPLACE FUNCTION public.return_central_kitchen_transfer(
  p_transfer_id uuid, p_items jsonb, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_transfer public.central_kitchen_transfers%ROWTYPE;
  v_line public.central_kitchen_transfer_items%ROWTYPE;
  v_input jsonb; v_qty numeric; v_balance numeric; v_cost numeric;
  v_count integer := 0; v_status text; v_changes jsonb := '[]'::jsonb;
  v_purchase uuid; v_ing public.ingredients%ROWTYPE;
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

  v_purchase := public.sun_purchase_open(v_transfer.canteen_id, v_transfer, 'sun_pharma_return');

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

    -- Back at the price it came in at: the purchase it reverses.
    SELECT * INTO v_ing FROM public.ingredients WHERE id = v_line.ingredient_id;
    PERFORM public.sun_purchase_add(v_purchase, v_ing, -v_qty, v_line.rate);
    PERFORM public.sun_site_move(v_ing, v_qty, v_line.rate, format('Eicher ne udhaar lautaya — transfer #%s', v_transfer.transfer_no));

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

-- ---------- 3. Lend to Sun Pharma ----------
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
    PERFORM public.sun_site_move(v_ing, v_qty, v_rate, format('Eicher se udhaar aaya — transfer #%s', v_transfer.transfer_no));

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

-- ---------- 4. Lent goods come back ----------
CREATE OR REPLACE FUNCTION public.receive_back_central_kitchen_transfer(
  p_transfer_id uuid, p_items jsonb, p_note text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_transfer public.central_kitchen_transfers%ROWTYPE;
  v_line public.central_kitchen_transfer_items%ROWTYPE;
  v_input jsonb; v_qty numeric; v_balance numeric;
  v_count integer := 0; v_status text; v_changes jsonb := '[]'::jsonb;
  v_ing public.ingredients%ROWTYPE;
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

    SELECT * INTO v_ing FROM public.ingredients WHERE id = v_line.ingredient_id;
    PERFORM public.sun_site_move(v_ing, -v_qty, v_line.rate, format('Eicher ko udhaar lautaya — transfer #%s', v_transfer.transfer_no));

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

REVOKE ALL ON FUNCTION public.receive_central_kitchen_transfer(uuid, text, date, date, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_central_kitchen_transfer(uuid, text, date, date, jsonb, text) TO authenticated;
REVOKE ALL ON FUNCTION public.return_central_kitchen_transfer(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.return_central_kitchen_transfer(uuid, jsonb, text) TO authenticated;
REVOKE ALL ON FUNCTION public.lend_central_kitchen_transfer(uuid, text, date, date, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lend_central_kitchen_transfer(uuid, text, date, date, jsonb, text) TO authenticated;
REVOKE ALL ON FUNCTION public.receive_back_central_kitchen_transfer(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_back_central_kitchen_transfer(uuid, jsonb, text) TO authenticated;
