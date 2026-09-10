-- ============================================================
-- THREE HOLES FOUND BY THE OWNER'S AUDIT
--
-- 1. The store keeper could set current_stock to any number with a plain
--    UPDATE — no ledger row, no alert. Steal 60 kg, type the lower figure,
--    and the blind audit then agrees with the books. This defeated every
--    other control at once.
-- 2. A confirmed purchase's total could be rewritten afterwards.
-- 3. The chef could inflate a menu's headcount after material was issued,
--    which is exactly what the per-head theft check divides by.
--
-- Stock may now only move through the sanctioned functions. They mark the
-- transaction with a flag the guard trigger checks; a bare UPDATE has no
-- flag and is refused.
-- Safe to re-run.
-- ============================================================

-- ---------- 1. current_stock is off-limits except through a stock function ----------
CREATE OR REPLACE FUNCTION public.guard_ingredient_stock()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.current_stock IS DISTINCT FROM OLD.current_stock
     AND coalesce(current_setting('app.stock_move', true), '') <> 'on' THEN
    RAISE EXCEPTION
      'Stock cannot be edited directly. Use goods receipt, issue, transfer or a stock audit so the movement is recorded.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_ingredient_stock ON public.ingredients;
CREATE TRIGGER trg_guard_ingredient_stock
  BEFORE UPDATE ON public.ingredients
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingredient_stock();

-- Every legitimate path raises the flag for its own transaction only.
CREATE OR REPLACE FUNCTION public.allow_stock_move()
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT set_config('app.stock_move', 'on', true);
$$;
REVOKE ALL ON FUNCTION public.allow_stock_move() FROM PUBLIC, anon, authenticated;

-- ---------- 2. Manual adjustment, with a reason and a ledger row ----------
CREATE OR REPLACE FUNCTION public.adjust_stock(
  p_ingredient_id UUID, p_new_stock NUMERIC, p_reason TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ing public.ingredients%ROWTYPE; v_delta NUMERIC;
BEGIN
  IF coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'A reason is required for a manual stock adjustment';
  END IF;
  SELECT * INTO v_ing FROM public.ingredients WHERE id = p_ingredient_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown item'; END IF;
  IF NOT (public.can_receive_stock() AND public.can_access_canteen(v_ing.canteen_id)) THEN
    RAISE EXCEPTION 'You cannot adjust stock at this site';
  END IF;

  v_delta := p_new_stock - v_ing.current_stock;
  IF v_delta = 0 THEN RETURN jsonb_build_object('changed', false); END IF;

  PERFORM public.allow_stock_move();
  UPDATE public.ingredients SET current_stock = p_new_stock WHERE id = p_ingredient_id;

  INSERT INTO public.stock_ledger
    (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, created_by)
  VALUES (p_ingredient_id, v_ing.canteen_id, v_delta, p_new_stock,
          btrim(p_reason), 'manual', auth.uid());

  RETURN jsonb_build_object('changed', true, 'delta', v_delta);
END;
$$;
REVOKE ALL ON FUNCTION public.adjust_stock(UUID, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adjust_stock(UUID, NUMERIC, TEXT) TO authenticated;

-- ---------- 3. Blind audit submission ----------
CREATE OR REPLACE FUNCTION public.submit_stock_audit(
  p_canteen_id UUID, p_entries JSONB      -- [{ingredient_id, counted, reason}]
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_line RECORD; v_cur NUMERIC; v_delta NUMERIC; v_n INT := 0; v_short NUMERIC := 0;
BEGIN
  IF NOT (public.can_receive_stock() AND public.can_access_canteen(p_canteen_id)) THEN
    RAISE EXCEPTION 'You cannot record a stock audit at this site';
  END IF;

  PERFORM public.allow_stock_move();

  FOR v_line IN
    SELECT (e->>'ingredient_id')::uuid AS ing,
           (e->>'counted')::numeric AS counted,
           coalesce(nullif(btrim(e->>'reason'), ''), 'Stock audit') AS reason
    FROM jsonb_array_elements(p_entries) e
  LOOP
    SELECT current_stock INTO v_cur FROM public.ingredients
    WHERE id = v_line.ing AND canteen_id = p_canteen_id;
    CONTINUE WHEN NOT FOUND OR v_line.counted IS NULL;

    v_delta := v_line.counted - v_cur;
    CONTINUE WHEN v_delta = 0;

    UPDATE public.ingredients SET current_stock = v_line.counted WHERE id = v_line.ing;

    -- reference_type 'audit' is what fires the shortage alert trigger
    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, created_by)
    VALUES (v_line.ing, p_canteen_id, v_delta, v_line.counted,
            v_line.reason, 'audit', auth.uid());

    IF v_delta < 0 THEN v_short := v_short + abs(v_delta); END IF;
    v_n := v_n + 1;
  END LOOP;

  RETURN jsonb_build_object('adjusted', v_n, 'shortage_qty', v_short);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_stock_audit(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_stock_audit(UUID, JSONB) TO authenticated;

-- ---------- 4. Teach the existing stock functions to raise the flag ----------
CREATE OR REPLACE FUNCTION public.add_stock_from_invoice(
  p_canteen_id UUID, p_supplier_id UUID, p_items JSONB,
  p_notes TEXT DEFAULT NULL, p_image_path TEXT DEFAULT NULL, p_total NUMERIC DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_purchase UUID; v_line RECORD; v_ing UUID; v_new NUMERIC;
  v_created INT := 0; v_topped INT := 0; v_sum NUMERIC := 0;
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

  INSERT INTO public.purchases
    (canteen_id, supplier_id, total_amount, notes, invoice_image_url, status, approved_at, created_by)
  VALUES (p_canteen_id, p_supplier_id, coalesce(p_total, v_sum), p_notes, p_image_path,
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
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, reference_id, created_by)
    VALUES (v_ing, p_canteen_id, v_line.qty, v_new,
            'Invoice stock-in — ' || v_line.name, 'purchase', v_purchase, auth.uid());

    INSERT INTO public.ingredient_batches
      (ingredient_id, canteen_id, supplier_id, purchase_id, qty_received, qty_remaining, rate)
    VALUES (v_ing, p_canteen_id, p_supplier_id, v_purchase, v_line.qty, v_line.qty, v_line.rate);
  END LOOP;

  RETURN jsonb_build_object('purchase_id', v_purchase, 'new_items', v_created,
                            'existing_items', v_topped, 'total', coalesce(p_total, v_sum));
END;
$$;
REVOKE ALL ON FUNCTION public.add_stock_from_invoice(UUID,UUID,JSONB,TEXT,TEXT,NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_stock_from_invoice(UUID,UUID,JSONB,TEXT,TEXT,NUMERIC) TO authenticated;

-- issue_requisition / record_stock_issue / confirm_purchase / transfer_stock
-- keep their bodies; they only need the flag, so wrap the existing logic by
-- re-declaring them with the PERFORM added at the top.
CREATE OR REPLACE FUNCTION public.record_stock_issue(p_canteen_id UUID, p_items JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_line RECORD; v_new NUMERIC; v_n INT := 0; v_cost NUMERIC; v_total NUMERIC := 0;
BEGIN
  IF NOT public.can_issue_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can issue stock';
  END IF;
  IF NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;
  PERFORM public.allow_stock_move();

  FOR v_line IN
    SELECT (e->>'ingredient_id')::uuid AS ing, (e->>'qty')::numeric AS qty, e->>'name' AS name
    FROM jsonb_array_elements(p_items) e ORDER BY (e->>'ingredient_id')::uuid
  LOOP
    CONTINUE WHEN v_line.qty IS NULL OR v_line.qty <= 0;
    UPDATE public.ingredients SET current_stock = current_stock - v_line.qty
      WHERE id = v_line.ing AND canteen_id = p_canteen_id
      RETURNING current_stock INTO v_new;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown ingredient in this canteen'; END IF;

    v_cost := public.consume_batches_fifo(v_line.ing, p_canteen_id, v_line.qty);
    v_total := v_total + v_cost;

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, created_by)
    VALUES (v_line.ing, p_canteen_id, -v_line.qty, v_new,
            'Daily usage — ' || coalesce(v_line.name,'') || ' (FIFO ₹' || round(v_cost) || ')',
            'issue', auth.uid());
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('saved', v_n, 'fifo_value', round(v_total, 2));
END;
$$;
REVOKE ALL ON FUNCTION public.record_stock_issue(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_stock_issue(UUID, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.issue_requisition(p_req_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.requisitions%ROWTYPE; v_line RECORD; v_new NUMERIC;
        v_n INT := 0; v_cost NUMERIC; v_total NUMERIC := 0;
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
REVOKE ALL ON FUNCTION public.issue_requisition(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_requisition(UUID) TO authenticated;

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
  IF p_from_canteen = p_to_canteen THEN RAISE EXCEPTION 'Pick two different sites'; END IF;
  PERFORM public.allow_stock_move();

  FOR v_line IN
    SELECT (e->>'ingredient_id')::uuid AS ing, (e->>'qty')::numeric AS qty
    FROM jsonb_array_elements(p_items) e ORDER BY (e->>'ingredient_id')::uuid
  LOOP
    CONTINUE WHEN v_line.qty IS NULL OR v_line.qty <= 0;
    SELECT id INTO v_src FROM public.ingredients WHERE id = v_line.ing AND canteen_id = p_from_canteen;
    IF v_src IS NULL THEN RAISE EXCEPTION 'Item is not stocked at the sending site'; END IF;

    SELECT d.id INTO v_dst FROM public.ingredients d
    JOIN public.ingredients s ON lower(btrim(s.name)) = lower(btrim(d.name))
    WHERE s.id = v_src AND d.canteen_id = p_to_canteen LIMIT 1;

    IF v_dst IS NULL THEN
      INSERT INTO public.ingredients (canteen_id, name, category, unit, current_stock, minimum_stock, cost_per_unit)
      SELECT p_to_canteen, name, category, unit, 0, 0, cost_per_unit
      FROM public.ingredients WHERE id = v_src RETURNING id INTO v_dst;
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

CREATE OR REPLACE FUNCTION public.confirm_purchase(p_purchase_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_canteen UUID; v_status TEXT; v_supplier UUID; v_row RECORD; v_new NUMERIC;
BEGIN
  IF NOT public.can_receive_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can confirm a purchase';
  END IF;
  SELECT canteen_id, status, supplier_id INTO v_canteen, v_status, v_supplier
  FROM public.purchases WHERE id = p_purchase_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown purchase'; END IF;
  IF NOT public.can_access_canteen(v_canteen) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;
  IF v_status = 'confirmed' THEN RETURN jsonb_build_object('already', true); END IF;
  PERFORM public.allow_stock_move();

  FOR v_row IN
    SELECT ingredient_id, sum(quantity) AS qty,
           CASE WHEN sum(quantity) > 0 THEN sum(total) / sum(quantity) ELSE 0 END AS rate,
           max(shelf) AS shelf
    FROM (SELECT pi.ingredient_id, pi.quantity, pi.total, i.shelf_life_days AS shelf
          FROM public.purchase_items pi JOIN public.ingredients i ON i.id = pi.ingredient_id
          WHERE pi.purchase_id = p_purchase_id AND pi.ingredient_id IS NOT NULL) x
    GROUP BY ingredient_id
  LOOP
    UPDATE public.ingredients SET current_stock = current_stock + v_row.qty
      WHERE id = v_row.ingredient_id RETURNING current_stock INTO v_new;
    IF NOT FOUND THEN CONTINUE; END IF;

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, reference_id, created_by)
    VALUES (v_row.ingredient_id, v_canteen, v_row.qty, v_new,
            'Purchase confirmed #' || left(p_purchase_id::text, 8), 'purchase', p_purchase_id, auth.uid());

    INSERT INTO public.ingredient_batches
      (ingredient_id, canteen_id, supplier_id, purchase_id, qty_received, qty_remaining, rate, expiry_date)
    VALUES (v_row.ingredient_id, v_canteen, v_supplier, p_purchase_id, v_row.qty, v_row.qty, v_row.rate,
            CASE WHEN v_row.shelf IS NOT NULL
                 THEN (current_date + (v_row.shelf || ' days')::interval)::date END);
  END LOOP;

  UPDATE public.purchases SET status = 'confirmed', approved_at = now() WHERE id = p_purchase_id;
  RETURN jsonb_build_object('confirmed', true);
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_purchase(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_purchase(UUID) TO authenticated;

-- ---------- 5. A confirmed purchase's money is fixed ----------
CREATE OR REPLACE FUNCTION public.guard_confirmed_purchase()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.status = 'confirmed' AND NOT public.is_super_admin() THEN
    IF NEW.total_amount IS DISTINCT FROM OLD.total_amount
       OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
       OR NEW.canteen_id  IS DISTINCT FROM OLD.canteen_id
       OR NEW.status      IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'A confirmed purchase cannot be re-priced. Record a correction instead.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_confirmed_purchase ON public.purchases;
CREATE TRIGGER trg_guard_confirmed_purchase
  BEFORE UPDATE ON public.purchases
  FOR EACH ROW EXECUTE FUNCTION public.guard_confirmed_purchase();

-- ---------- 6. Headcount is the manager's, and freezes once material moves ----------
CREATE OR REPLACE FUNCTION public.guard_menu_headcount()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.expected_headcount IS DISTINCT FROM OLD.expected_headcount
     OR NEW.actual_headcount IS DISTINCT FROM OLD.actual_headcount THEN

    IF NOT public.is_manager_or_above() THEN
      RAISE EXCEPTION 'Only a unit manager or above can change the headcount';
    END IF;

    IF EXISTS (SELECT 1 FROM public.requisitions r
               WHERE r.menu_plan_id = NEW.id AND r.status = 'issued') THEN
      RAISE EXCEPTION
        'Material has already been issued against this menu — the headcount can no longer be changed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_menu_headcount ON public.menu_plans;
CREATE TRIGGER trg_guard_menu_headcount
  BEFORE UPDATE ON public.menu_plans
  FOR EACH ROW EXECUTE FUNCTION public.guard_menu_headcount();
