-- ============================================================
-- SEPARATION OF DUTIES FIX
--
-- Rank was being used for permissions that are about ROLE, not seniority.
-- chef (30) outranks store_keeper (20), so `is_store_keeper_or_above()`
-- silently included the chef — the person who raises a requisition could
-- also approve it and issue the stock against it. That defeats the whole
-- point of the approval chain.
--
-- Duties now:
--   raise      : chef, store keeper, manager+
--   approve    : manager+ only          (never the requester)
--   issue      : store keeper, manager+ (never the chef)
--
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_store_keeper()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles
                 WHERE user_id = auth.uid() AND lower(role) = 'store_keeper');
$$;

-- Who may physically move stock out of the store.
CREATE OR REPLACE FUNCTION public.can_issue_stock()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_store_keeper() OR public.is_manager_or_above();
$$;

REVOKE ALL ON FUNCTION public.is_store_keeper() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_issue_stock() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_store_keeper() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_issue_stock() TO authenticated;

-- ---------- Requisition header ----------
-- Anyone on site who works with food may raise one; only issue-capable or
-- approving roles may change one afterwards.
DROP POLICY IF EXISTS "requisitions_update" ON public.requisitions;
CREATE POLICY "requisitions_update" ON public.requisitions FOR UPDATE TO authenticated
  USING (public.can_access_canteen(canteen_id)
         AND (public.is_manager_or_above() OR public.can_issue_stock()))
  WITH CHECK (public.can_access_canteen(canteen_id)
         AND (public.is_manager_or_above() OR public.can_issue_stock()));

-- ---------- Requisition lines ----------
-- Split INSERT from UPDATE: the chef writes the request, only a manager or
-- the store keeper may alter quantities afterwards.
DROP POLICY IF EXISTS "requisition_items_write" ON public.requisition_items;
DROP POLICY IF EXISTS "requisition_items_insert" ON public.requisition_items;
DROP POLICY IF EXISTS "requisition_items_update" ON public.requisition_items;
CREATE POLICY "requisition_items_insert" ON public.requisition_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.requisitions r
                      WHERE r.id = requisition_id
                        AND public.can_access_canteen(r.canteen_id)
                        AND public.is_store_keeper_or_above()));
CREATE POLICY "requisition_items_update" ON public.requisition_items FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.requisitions r
                 WHERE r.id = requisition_id
                   AND public.can_access_canteen(r.canteen_id)
                   AND (public.is_manager_or_above() OR public.can_issue_stock())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.requisitions r
                 WHERE r.id = requisition_id
                   AND public.can_access_canteen(r.canteen_id)
                   AND (public.is_manager_or_above() OR public.can_issue_stock())));

-- ---------- Approval is a manager act, enforced in the row itself ----------
CREATE OR REPLACE FUNCTION public.enforce_requisition_review()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Moving a requisition into approved/rejected is a manager's decision.
  IF NEW.status IN ('approved','rejected')
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NOT public.is_manager_or_above() THEN
    RAISE EXCEPTION 'Only a unit manager or above can approve or reject a requisition';
  END IF;

  -- Issuing is the store keeper's act (a manager may cover for them).
  IF NEW.status = 'issued' AND OLD.status IS DISTINCT FROM NEW.status
     AND NOT public.can_issue_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can issue stock';
  END IF;

  -- Nobody approves their own request, whatever their role.
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.requested_by IS NOT NULL AND NEW.requested_by = auth.uid()
     AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'You cannot approve a requisition you raised yourself';
  END IF;

  IF NEW.status IN ('approved','rejected') AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.reviewed_by := auth.uid();
    NEW.reviewed_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_requisition_review ON public.requisitions;
CREATE TRIGGER trg_requisition_review
  BEFORE UPDATE ON public.requisitions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_requisition_review();

-- ---------- The issue RPC uses the duty check, not the rank ladder ----------
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
  IF NOT public.can_issue_stock() THEN
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

-- ---------- Same duty split for direct stock issues and photos ----------
CREATE OR REPLACE FUNCTION public.record_stock_issue(p_canteen_id UUID, p_items JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_line RECORD; v_new NUMERIC; v_n INT := 0; v_cost NUMERIC; v_total NUMERIC := 0;
BEGIN
  IF NOT public.can_issue_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can issue stock';
  END IF;
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
