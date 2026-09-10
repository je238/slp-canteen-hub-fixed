-- ============================================================
-- FIFO BATCH CONSUMPTION
-- Confirming a purchase now opens a batch per ingredient; every issue
-- eats the oldest batch first, so stock ageing and expiry are real
-- rather than decorative. Batch tracking is advisory: current_stock
-- stays the single source of truth for availability, batches explain
-- WHICH stock it is and what it cost.
-- Safe to re-run.
-- ============================================================

-- Consume p_qty from the oldest open batches. Returns the weighted cost of
-- what was consumed, so consumption can be valued at what was actually paid.
CREATE OR REPLACE FUNCTION public.consume_batches_fifo(
  p_ingredient_id UUID, p_canteen_id UUID, p_qty NUMERIC
)
RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_left NUMERIC := p_qty; v_take NUMERIC; v_cost NUMERIC := 0; v_b RECORD;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN RETURN 0; END IF;

  FOR v_b IN
    SELECT id, qty_remaining, rate FROM public.ingredient_batches
    WHERE ingredient_id = p_ingredient_id AND canteen_id = p_canteen_id
      AND qty_remaining > 0
    ORDER BY received_at, id
    FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := least(v_left, v_b.qty_remaining);
    UPDATE public.ingredient_batches
      SET qty_remaining = qty_remaining - v_take WHERE id = v_b.id;
    v_cost := v_cost + v_take * coalesce(v_b.rate, 0);
    v_left := v_left - v_take;
  END LOOP;

  -- Anything left over came from stock with no batch record (opening stock,
  -- manual adjustments). Value it at the ingredient's standard cost.
  IF v_left > 0 THEN
    v_cost := v_cost + v_left *
      coalesce((SELECT cost_per_unit FROM public.ingredients WHERE id = p_ingredient_id), 0);
  END IF;

  RETURN v_cost;
END;
$$;
REVOKE ALL ON FUNCTION public.consume_batches_fifo(UUID,UUID,NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_batches_fifo(UUID,UUID,NUMERIC) TO authenticated;

-- ---------- Purchase confirmation opens batches ----------
CREATE OR REPLACE FUNCTION public.confirm_purchase(p_purchase_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_canteen UUID; v_status TEXT; v_supplier UUID; v_row RECORD; v_new NUMERIC;
BEGIN
  SELECT canteen_id, status, supplier_id INTO v_canteen, v_status, v_supplier
  FROM public.purchases WHERE id = p_purchase_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown purchase'; END IF;
  IF v_status = 'confirmed' THEN
    RETURN jsonb_build_object('already', true);
  END IF;

  FOR v_row IN
    SELECT ingredient_id, sum(quantity) AS qty,
           CASE WHEN sum(quantity) > 0 THEN sum(total) / sum(quantity) ELSE 0 END AS rate,
           max(shelf) AS shelf
    FROM (
      SELECT pi.ingredient_id, pi.quantity, pi.total, i.shelf_life_days AS shelf
      FROM public.purchase_items pi
      JOIN public.ingredients i ON i.id = pi.ingredient_id
      WHERE pi.purchase_id = p_purchase_id AND pi.ingredient_id IS NOT NULL
    ) x
    GROUP BY ingredient_id
  LOOP
    UPDATE public.ingredients
      SET current_stock = current_stock + v_row.qty
      WHERE id = v_row.ingredient_id
      RETURNING current_stock INTO v_new;
    IF NOT FOUND THEN CONTINUE; END IF;

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, reference_id)
    VALUES (v_row.ingredient_id, v_canteen, v_row.qty, v_new,
            'Purchase confirmed #' || left(p_purchase_id::text, 8), 'purchase', p_purchase_id);

    INSERT INTO public.ingredient_batches
      (ingredient_id, canteen_id, supplier_id, purchase_id, qty_received, qty_remaining, rate, expiry_date)
    VALUES (v_row.ingredient_id, v_canteen, v_supplier, p_purchase_id,
            v_row.qty, v_row.qty, v_row.rate,
            CASE WHEN v_row.shelf IS NOT NULL
                 THEN (current_date + (v_row.shelf || ' days')::interval)::date END);
  END LOOP;

  UPDATE public.purchases
    SET status = 'confirmed', approved_at = now()
    WHERE id = p_purchase_id;

  RETURN jsonb_build_object('confirmed', true);
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_purchase(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_purchase(UUID) TO authenticated;

-- ---------- Issues eat the oldest batch first ----------
CREATE OR REPLACE FUNCTION public.record_stock_issue(p_canteen_id UUID, p_items JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_line RECORD; v_new NUMERIC; v_n INT := 0; v_cost NUMERIC; v_total NUMERIC := 0;
BEGIN
  FOR v_line IN
    SELECT (e->>'ingredient_id')::uuid AS ing, (e->>'qty')::numeric AS qty, e->>'name' AS name
    FROM jsonb_array_elements(p_items) e
    ORDER BY (e->>'ingredient_id')::uuid
  LOOP
    IF v_line.qty IS NULL OR v_line.qty <= 0 THEN CONTINUE; END IF;
    UPDATE public.ingredients
      SET current_stock = current_stock - v_line.qty
      WHERE id = v_line.ing AND canteen_id = p_canteen_id
      RETURNING current_stock INTO v_new;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown ingredient in this canteen'; END IF;

    v_cost := public.consume_batches_fifo(v_line.ing, p_canteen_id, v_line.qty);
    v_total := v_total + v_cost;

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type)
    VALUES (v_line.ing, p_canteen_id, -v_line.qty, v_new,
            'Daily usage — ' || coalesce(v_line.name,'') ||
            ' (FIFO ₹' || round(v_cost) || ')', 'issue');
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('saved', v_n, 'fifo_value', round(v_total, 2));
END;
$$;
REVOKE ALL ON FUNCTION public.record_stock_issue(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_stock_issue(UUID, JSONB) TO authenticated;

-- ---------- Requisition issue also consumes FIFO ----------
CREATE OR REPLACE FUNCTION public.issue_requisition(p_req_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_req public.requisitions%ROWTYPE; v_line RECORD; v_new NUMERIC;
        v_n INT := 0; v_cost NUMERIC; v_total NUMERIC := 0;
BEGIN
  SELECT * INTO v_req FROM public.requisitions WHERE id = p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown requisition'; END IF;
  IF v_req.status = 'issued' THEN RETURN jsonb_build_object('already', true); END IF;
  IF v_req.status <> 'approved' THEN
    RAISE EXCEPTION 'Only an approved requisition can be issued (current status: %)', v_req.status;
  END IF;
  IF NOT public.is_store_keeper_or_above() THEN
    RAISE EXCEPTION 'Only the store keeper can issue stock';
  END IF;

  FOR v_line IN
    SELECT ri.id, ri.ingredient_id, coalesce(ri.approved_qty, 0) AS qty, i.name
    FROM public.requisition_items ri
    JOIN public.ingredients i ON i.id = ri.ingredient_id
    WHERE ri.requisition_id = p_req_id AND coalesce(ri.approved_qty, 0) > 0
    ORDER BY ri.ingredient_id
  LOOP
    UPDATE public.ingredients
      SET current_stock = current_stock - v_line.qty
      WHERE id = v_line.ingredient_id AND canteen_id = v_req.canteen_id
      RETURNING current_stock INTO v_new;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Ingredient % does not belong to this site', v_line.name;
    END IF;

    v_cost := public.consume_batches_fifo(v_line.ingredient_id, v_req.canteen_id, v_line.qty);
    v_total := v_total + v_cost;

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, reference_id)
    VALUES (v_line.ingredient_id, v_req.canteen_id, -v_line.qty, v_new,
            'Requisition #' || v_req.req_no || ' issued to kitchen', 'issue', p_req_id);

    UPDATE public.requisition_items SET issued_qty = v_line.qty WHERE id = v_line.id;
    v_n := v_n + 1;
  END LOOP;

  UPDATE public.requisitions
    SET status = 'issued', issued_by = auth.uid(), issued_at = now()
    WHERE id = p_req_id;

  RETURN jsonb_build_object('issued_lines', v_n, 'fifo_value', round(v_total, 2));
END;
$$;
REVOKE ALL ON FUNCTION public.issue_requisition(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_requisition(UUID) TO authenticated;
