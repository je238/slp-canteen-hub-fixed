-- The manager makes the complete commercial decision before approval.
-- After approval the order is operationally locked; only the existing,
-- separately-audited Admin correction RPC may repair it.

CREATE OR REPLACE FUNCTION public.guard_requisition_item_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_req public.requisitions%ROWTYPE;
BEGIN
  IF public.is_admin_editor() THEN RETURN NEW; END IF;
  IF coalesce(current_setting('app.stock_move', true), '') = 'on' THEN RETURN NEW; END IF;

  IF coalesce(current_setting('app.manager_order_review', true), '') = 'on' THEN
    SELECT * INTO v_req FROM public.requisitions WHERE id = NEW.requisition_id;
    IF v_req.status <> 'pending'
       OR NOT public.is_manager_or_above()
       OR NOT public.can_access_canteen(v_req.canteen_id) THEN
      RAISE EXCEPTION 'Manager full edit is allowed only while the order is pending approval';
    END IF;
    IF NEW.requested_qty IS DISTINCT FROM OLD.requested_qty THEN
      RAISE EXCEPTION 'Chef requested quantity is audit history and cannot be overwritten';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.requested_qty IS DISTINCT FROM OLD.requested_qty
     OR NEW.ingredient_id IS DISTINCT FROM OLD.ingredient_id
     OR NEW.rate IS DISTINCT FROM OLD.rate THEN
    RAISE EXCEPTION 'Chef request cannot be edited outside manager review';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_requisition_tolerance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_req public.requisitions%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE'
     AND coalesce(current_setting('app.admin_order_correction', true), '') = 'on' THEN
    IF NEW.approved_qty >= coalesce(OLD.issued_qty, 0) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Quantity cannot be below material already issued';
  END IF;

  IF TG_OP = 'UPDATE'
     AND coalesce(current_setting('app.close_pending', true), '') = 'on' THEN
    IF NEW.approved_qty = coalesce(OLD.issued_qty, 0)
       AND NEW.approved_qty <= coalesce(OLD.approved_qty, OLD.requested_qty) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Only the unissued remainder may be closed';
  END IF;

  IF TG_OP = 'UPDATE'
     AND coalesce(current_setting('app.manager_order_review', true), '') = 'on' THEN
    SELECT * INTO v_req FROM public.requisitions WHERE id = NEW.requisition_id;
    IF v_req.status <> 'pending'
       OR NOT public.is_manager_or_above()
       OR NOT public.can_access_canteen(v_req.canteen_id) THEN
      RAISE EXCEPTION 'Manager may set the final quantity only before approval';
    END IF;
    IF NEW.approved_qty IS NULL OR NEW.approved_qty < 0 THEN
      RAISE EXCEPTION 'Final quantity must be zero or more';
    END IF;
    IF coalesce(OLD.issued_qty, 0) > 0 THEN
      RAISE EXCEPTION 'Issued material cannot be changed';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.approved_qty IS NULL THEN RETURN NEW; END IF;
  IF NEW.approved_qty < 0 THEN RAISE EXCEPTION 'Approved quantity cannot be negative'; END IF;

  IF TG_OP = 'UPDATE' AND NEW.approved_qty IS DISTINCT FROM OLD.approved_qty THEN
    RAISE EXCEPTION 'Approved orders are locked. Use the audited Admin correction flow.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.manager_review_requisition(
  p_req_id uuid,
  p_lines jsonb,
  p_approve boolean,
  p_review_notes text DEFAULT NULL
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
  v_new_qty numeric;
  v_new_ingredient uuid;
  v_new_name text;
  v_new_unit text;
  v_new_rate numeric;
  v_old_name text;
  v_total integer;
  v_changed integer := 0;
  v_active integer := 0;
  v_status text;
  v_changes jsonb := '[]'::jsonb;
BEGIN
  IF NOT (public.is_admin_editor() OR public.is_manager_or_above()) THEN
    RAISE EXCEPTION 'Only a manager or admin can review an order';
  END IF;

  SELECT * INTO v_req FROM public.requisitions WHERE id = p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'This order is no longer waiting for approval';
  END IF;
  IF NOT public.can_access_canteen(v_req.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  IF NOT p_approve THEN
    UPDATE public.requisitions
       SET status = 'rejected', review_notes = nullif(btrim(coalesce(p_review_notes, '')), '')
     WHERE id = p_req_id;
    INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
    VALUES(auth.uid(), 'requisition_rejected', 'requisition', p_req_id, v_req.canteen_id,
           jsonb_build_object('req_no', v_req.req_no, 'reason', p_review_notes));
    RETURN jsonb_build_object('status', 'rejected');
  END IF;

  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Final order lines are required';
  END IF;
  SELECT count(*) INTO v_total FROM public.requisition_items WHERE requisition_id = p_req_id;
  IF jsonb_array_length(p_lines) <> v_total
     OR (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_lines)) <> v_total THEN
    RAISE EXCEPTION 'Every order line must be reviewed exactly once';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_lines) x
     WHERE coalesce((x->>'approved_qty')::numeric, -1) > 0
     GROUP BY (x->>'ingredient_id')
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'The same item cannot appear on two active order lines';
  END IF;

  PERFORM set_config('app.manager_order_review', 'on', true);

  FOR v_input IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    SELECT * INTO v_line
      FROM public.requisition_items
     WHERE id = (v_input->>'id')::uuid AND requisition_id = p_req_id
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'An order item was not found'; END IF;

    v_new_qty := round(coalesce((v_input->>'approved_qty')::numeric, -1), 3);
    v_new_ingredient := nullif(v_input->>'ingredient_id', '')::uuid;
    IF v_new_qty < 0 THEN RAISE EXCEPTION 'Final quantity must be zero or more'; END IF;
    IF v_new_ingredient IS NULL THEN RAISE EXCEPTION 'Final item is required'; END IF;

    SELECT name, unit, cost_per_unit INTO v_new_name, v_new_unit, v_new_rate
      FROM public.ingredients
     WHERE id = v_new_ingredient AND canteen_id = v_req.canteen_id
       AND archived_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Selected item is not available at this site'; END IF;
    SELECT name INTO v_old_name FROM public.ingredients WHERE id = v_line.ingredient_id;

    IF v_new_qty > 0 THEN v_active := v_active + 1; END IF;
    IF v_new_ingredient IS DISTINCT FROM v_line.ingredient_id
       OR abs(v_new_qty - v_line.requested_qty) > 0.000000001 THEN
      v_changed := v_changed + 1;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'line_id', v_line.id,
        'chef_item_id', v_line.ingredient_id, 'chef_item', v_old_name,
        'final_item_id', v_new_ingredient, 'final_item', v_new_name,
        'chef_qty', v_line.requested_qty, 'final_qty', v_new_qty
      ));
    END IF;

    UPDATE public.requisition_items
       SET approved_qty = v_new_qty,
           ingredient_id = v_new_ingredient,
           unit = v_new_unit,
           rate = CASE WHEN v_new_ingredient IS DISTINCT FROM v_line.ingredient_id
                       THEN coalesce(v_new_rate, 0) ELSE v_line.rate END,
           original_ingredient_id = CASE
             WHEN v_new_ingredient IS DISTINCT FROM v_line.ingredient_id
               THEN coalesce(v_line.original_ingredient_id, v_line.ingredient_id)
             ELSE v_line.original_ingredient_id
           END,
           cancelled_qty = greatest(v_line.requested_qty - v_new_qty, 0),
           cancellation_reason = CASE WHEN v_new_qty < v_line.requested_qty
                                      THEN nullif(btrim(coalesce(p_review_notes, '')), '') ELSE NULL END,
           cancelled_by = CASE WHEN v_new_qty < v_line.requested_qty THEN auth.uid() ELSE NULL END,
           cancelled_at = CASE WHEN v_new_qty < v_line.requested_qty THEN now() ELSE NULL END
     WHERE id = v_line.id;
  END LOOP;

  IF v_changed > 0 AND nullif(btrim(coalesce(p_review_notes, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Reason is required when the manager changes the order';
  END IF;

  v_status := CASE WHEN v_active = 0 THEN 'cancelled' ELSE 'approved' END;
  UPDATE public.requisitions
     SET status = v_status,
         review_notes = nullif(btrim(coalesce(p_review_notes, '')), ''),
         reviewed_by = auth.uid(), reviewed_at = now()
   WHERE id = p_req_id;

  INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES(auth.uid(), 'manager_reviewed_requisition', 'requisition', p_req_id, v_req.canteen_id,
         jsonb_build_object('req_no', v_req.req_no, 'status', v_status,
                            'reason', p_review_notes, 'changes', v_changes));

  RETURN jsonb_build_object('status', v_status, 'active_lines', v_active,
                            'changed_lines', v_changed, 'changes', v_changes);
END;
$$;

REVOKE ALL ON FUNCTION public.manager_review_requisition(uuid,jsonb,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manager_review_requisition(uuid,jsonb,boolean,text) TO authenticated;

-- Retire the old post-approval manager-edit API. Admins use
-- admin_correct_requisition, which records the before/after values and reason.
REVOKE ALL ON FUNCTION public.manager_correct_requisition(uuid,jsonb,text) FROM authenticated;

COMMENT ON FUNCTION public.manager_review_requisition(uuid,jsonb,boolean,text) IS
  'Atomically sets Manager final items/quantities and approves or rejects a pending Chef requisition.';

