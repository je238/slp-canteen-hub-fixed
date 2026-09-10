-- A wrong approval must be correctable until stock physically moves.
-- The chef's requested quantity remains immutable. Managers may only lower
-- the effective approved quantity, never below what has already been issued.

CREATE OR REPLACE FUNCTION public.enforce_requisition_tolerance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE v_status text;
BEGIN
  -- The chef closes only the remainder after a partial issue.
  IF TG_OP = 'UPDATE'
     AND coalesce(current_setting('app.close_pending', true), '') = 'on' THEN
    IF NEW.approved_qty = coalesce(OLD.issued_qty, 0)
       AND NEW.approved_qty <= coalesce(OLD.approved_qty, OLD.requested_qty) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Only the unissued remainder may be closed';
  END IF;

  -- A manager correction is deliberately allowed outside ±7%, but only
  -- downwards and never below material that has already left the store.
  IF TG_OP = 'UPDATE'
     AND coalesce(current_setting('app.manager_order_correction', true), '') = 'on' THEN
    IF NEW.approved_qty >= coalesce(OLD.issued_qty, 0)
       AND NEW.approved_qty <= coalesce(OLD.approved_qty, OLD.requested_qty) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'A correction may only reduce the unissued quantity';
  END IF;

  IF NEW.approved_qty IS NULL THEN RETURN NEW; END IF;
  IF NEW.approved_qty < 0 THEN RAISE EXCEPTION 'Approved quantity cannot be negative'; END IF;
  IF NEW.approved_qty > 0 AND
     (NEW.approved_qty < NEW.requested_qty * 0.93 OR
      NEW.approved_qty > NEW.requested_qty * 1.07) THEN
    RAISE EXCEPTION
      'Approved quantity % is outside the allowed ±7%% of the requested %. Send it back to the chef instead.',
      NEW.approved_qty, NEW.requested_qty;
  END IF;
  SELECT status INTO v_status FROM public.requisitions WHERE id = NEW.requisition_id;
  IF TG_OP = 'UPDATE' AND v_status = 'issued'
     AND NEW.approved_qty IS DISTINCT FROM OLD.approved_qty THEN
    RAISE EXCEPTION 'This requisition has already been issued and cannot be changed.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.manager_correct_requisition(
  p_req_id uuid,
  p_lines jsonb,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_req public.requisitions%ROWTYPE;
  v_line public.requisition_items%ROWTYPE;
  v_input jsonb;
  v_new numeric;
  v_old numeric;
  v_issued numeric;
  v_delta numeric;
  v_changed integer := 0;
  v_left integer := 0;
  v_issued_total numeric := 0;
  v_status text;
  v_changes jsonb := '[]'::jsonb;
  v_name text;
BEGIN
  IF nullif(btrim(coalesce(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Reason is required';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Order lines are required';
  END IF;

  SELECT * INTO v_req FROM public.requisitions WHERE id = p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_req.status <> 'approved' THEN
    RAISE EXCEPTION 'Only an approved order waiting at the store can be corrected';
  END IF;
  IF NOT (public.is_admin_editor() OR public.is_manager_or_above()) THEN
    RAISE EXCEPTION 'Only the manager or an admin can edit an approved order';
  END IF;
  IF NOT public.can_access_canteen(v_req.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  PERFORM set_config('app.manager_order_correction', 'on', true);

  FOR v_input IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    SELECT * INTO v_line
      FROM public.requisition_items
     WHERE id = (v_input->>'id')::uuid
       AND requisition_id = p_req_id
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'An order item was not found'; END IF;

    v_new := round(coalesce((v_input->>'approved_qty')::numeric, -1), 3);
    v_old := coalesce(v_line.approved_qty, v_line.requested_qty);
    v_issued := coalesce(v_line.issued_qty, 0);

    IF v_new < 0 THEN RAISE EXCEPTION 'Quantity cannot be negative'; END IF;
    IF v_new > v_old + 0.000000001 THEN
      RAISE EXCEPTION 'Quantity can only be reduced. Send a fresh top-up order for more material.';
    END IF;
    IF v_new < v_issued - 0.000000001 THEN
      RAISE EXCEPTION 'Quantity cannot be below % because that much has already been issued', v_issued;
    END IF;
    CONTINUE WHEN abs(v_new - v_old) < 0.000000001;

    v_delta := v_old - v_new;
    SELECT name INTO v_name FROM public.ingredients WHERE id = v_line.ingredient_id;

    UPDATE public.requisition_items
       SET approved_qty = v_new,
           cancelled_qty = coalesce(cancelled_qty, 0) + v_delta,
           cancellation_reason = btrim(p_reason),
           cancelled_by = auth.uid(),
           cancelled_at = now()
     WHERE id = v_line.id;

    v_changed := v_changed + 1;
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'item_id', v_line.id, 'item', v_name, 'was', v_old, 'now', v_new,
      'issued', v_issued, 'removed', v_delta
    ));
  END LOOP;

  IF v_changed = 0 THEN RAISE EXCEPTION 'No quantity was changed'; END IF;

  SELECT count(*), coalesce(sum(coalesce(issued_qty, 0)), 0)
    INTO v_left, v_issued_total
    FROM public.requisition_items
   WHERE requisition_id = p_req_id
     AND greatest(coalesce(approved_qty, requested_qty) - coalesce(issued_qty, 0), 0) > 0;

  -- The aggregate above filters to pending rows, so calculate issued total
  -- separately when there is no pending row left.
  SELECT coalesce(sum(coalesce(issued_qty, 0)), 0) INTO v_issued_total
    FROM public.requisition_items WHERE requisition_id = p_req_id;

  IF v_left = 0 AND v_issued_total > 0 THEN
    v_status := 'issued';
    UPDATE public.requisitions
       SET status = 'issued',
           review_notes = btrim(p_reason),
           issued_by = coalesce(issued_by, (
             SELECT sl.created_by FROM public.stock_ledger sl
              WHERE sl.reference_type = 'issue' AND sl.reference_id = p_req_id
              ORDER BY sl.created_at DESC LIMIT 1
           )),
           issued_at = coalesce(issued_at, (
             SELECT max(sl.created_at) FROM public.stock_ledger sl
              WHERE sl.reference_type = 'issue' AND sl.reference_id = p_req_id
           ), now())
     WHERE id = p_req_id;
  ELSIF v_left = 0 THEN
    v_status := 'cancelled';
    UPDATE public.requisitions
       SET status = 'cancelled', review_notes = btrim(p_reason)
     WHERE id = p_req_id;
  ELSE
    v_status := 'approved';
    UPDATE public.requisitions SET review_notes = btrim(p_reason) WHERE id = p_req_id;
  END IF;

  INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES(auth.uid(), 'manager_corrected_requisition', 'requisition', p_req_id,
         v_req.canteen_id, jsonb_build_object(
           'req_no', v_req.req_no, 'reason', btrim(p_reason),
           'changes', v_changes, 'status', v_status
         ));

  INSERT INTO public.notifications(canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES(v_req.canteen_id, 'chef', format('Order #%s corrected', v_req.req_no),
         btrim(p_reason), '/requisitions', 'requisition', p_req_id);

  RETURN jsonb_build_object('changed_lines', v_changed, 'status', v_status,
                            'changes', v_changes);
END;
$$;

REVOKE ALL ON FUNCTION public.manager_correct_requisition(uuid,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manager_correct_requisition(uuid,jsonb,text) TO authenticated;

-- Cancelling is only valid before any line has left the store. Once even one
-- line is issued, the manager closes the unissued remainder and the kitchen
-- returns anything physically unused.
CREATE OR REPLACE FUNCTION public.cancel_requisition(p_req_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_req public.requisitions%ROWTYPE; v_issued numeric;
BEGIN
  IF nullif(btrim(coalesce(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Reason is required';
  END IF;
  SELECT * INTO v_req FROM public.requisitions WHERE id = p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown requisition'; END IF;
  IF v_req.status NOT IN ('pending', 'approved') THEN
    RAISE EXCEPTION 'Only a pending or approved order can be cancelled';
  END IF;
  IF NOT (public.is_admin_editor() OR public.is_manager_or_above()) THEN
    RAISE EXCEPTION 'Only the manager or an admin can cancel an order';
  END IF;
  IF NOT public.can_access_canteen(v_req.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  SELECT coalesce(sum(coalesce(issued_qty, 0)), 0) INTO v_issued
    FROM public.requisition_items WHERE requisition_id = p_req_id;
  IF v_issued > 0 THEN
    RAISE EXCEPTION 'Some goods have already been issued. Cancel only the remaining quantities, then record a kitchen return.';
  END IF;

  UPDATE public.requisitions
     SET status = 'cancelled', review_notes = btrim(p_reason)
   WHERE id = p_req_id;

  INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES(auth.uid(), 'requisition_cancelled', 'requisition', p_req_id, v_req.canteen_id,
         jsonb_build_object('was', v_req.status, 'reason', btrim(p_reason)));

  INSERT INTO public.notifications(canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES(v_req.canteen_id, 'chef', format('Order #%s cancelled', v_req.req_no),
         btrim(p_reason), '/requisitions', 'requisition', p_req_id);

  RETURN jsonb_build_object('status', 'cancelled');
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_requisition(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_requisition(uuid,text) TO authenticated;

-- Sending an approval back is also forbidden after a partial issue.
CREATE OR REPLACE FUNCTION public.send_requisition_back(p_req_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_req public.requisitions%ROWTYPE; v_n integer; v_issued numeric;
BEGIN
  SELECT * INTO v_req FROM public.requisitions WHERE id = p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown requisition'; END IF;
  IF v_req.status NOT IN ('approved', 'pending') THEN
    RAISE EXCEPTION 'Only a pending or approved order can be sent back';
  END IF;
  SELECT coalesce(sum(coalesce(issued_qty, 0)), 0) INTO v_issued
    FROM public.requisition_items WHERE requisition_id = p_req_id;
  IF v_issued > 0 THEN
    RAISE EXCEPTION 'Some goods have already been issued. Correct only the remaining quantities and return issued stock separately.';
  END IF;
  IF NOT (public.is_admin_editor() OR public.is_manager_or_above()) THEN
    RAISE EXCEPTION 'Only the manager or an admin can send an order back';
  END IF;
  IF NOT public.can_access_canteen(v_req.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  UPDATE public.requisition_items SET approved_qty = NULL WHERE requisition_id = p_req_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.requisitions
     SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL,
         review_notes = coalesce(nullif(btrim(p_reason), ''), review_notes)
   WHERE id = p_req_id;

  INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES(auth.uid(), 'requisition_sent_back', 'requisition', p_req_id, v_req.canteen_id,
         jsonb_build_object('was', v_req.status, 'lines', v_n, 'reason', p_reason));
  DELETE FROM public.notifications
   WHERE ref_type = 'requisition' AND ref_id = p_req_id
     AND created_at >= now() - interval '1 minute';
  INSERT INTO public.notifications(canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES(v_req.canteen_id, 'chef', format('Order #%s sent back', v_req.req_no),
         coalesce(nullif(btrim(p_reason), ''), 'Manager ne order wapas bheja hai.'),
         '/requisitions', 'requisition', p_req_id);
  RETURN jsonb_build_object('status', 'pending', 'lines_cleared', v_n);
END;
$$;

REVOKE ALL ON FUNCTION public.send_requisition_back(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_requisition_back(uuid,text) TO authenticated;
