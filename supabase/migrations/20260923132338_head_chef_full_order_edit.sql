-- Head Chef gets the same pre-approval item/quantity editing freedom as the
-- Manager, while Chef's original request remains immutable audit history.

ALTER TABLE public.requisition_items
  ADD COLUMN IF NOT EXISTS head_chef_ingredient_id uuid
    REFERENCES public.ingredients(id);

CREATE INDEX IF NOT EXISTS idx_requisition_items_head_chef_ingredient
  ON public.requisition_items (head_chef_ingredient_id)
  WHERE head_chef_ingredient_id IS NOT NULL;

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

  IF coalesce(current_setting('app.head_chef_review', true), '') = 'on' THEN
    SELECT * INTO v_req FROM public.requisitions WHERE id = NEW.requisition_id;
    IF v_req.status <> 'pending'
       OR NOT v_req.head_chef_required
       OR NOT public.is_head_chef()
       OR NOT public.can_access_canteen(v_req.canteen_id) THEN
      RAISE EXCEPTION 'Head Chef may edit only a pending order for their site';
    END IF;
    IF NEW.requested_qty IS DISTINCT FROM OLD.requested_qty
       OR NEW.ingredient_id IS DISTINCT FROM OLD.ingredient_id
       OR NEW.unit IS DISTINCT FROM OLD.unit
       OR NEW.rate IS DISTINCT FROM OLD.rate
       OR NEW.approved_qty IS DISTINCT FROM OLD.approved_qty THEN
      RAISE EXCEPTION 'Chef request history cannot be overwritten';
    END IF;
    IF NEW.head_chef_qty IS NULL OR NEW.head_chef_qty < 0 THEN
      RAISE EXCEPTION 'Head Chef quantity must be zero or more';
    END IF;
    IF NEW.head_chef_ingredient_id IS NULL THEN
      RAISE EXCEPTION 'Head Chef item is required';
    END IF;
    RETURN NEW;
  END IF;

  IF coalesce(current_setting('app.manager_order_review', true), '') = 'on' THEN
    SELECT * INTO v_req FROM public.requisitions WHERE id = NEW.requisition_id;
    IF v_req.status <> 'pending'
       OR NOT public.is_manager_or_above()
       OR NOT public.can_access_canteen(v_req.canteen_id) THEN
      RAISE EXCEPTION 'Manager full edit is allowed only while the order is pending approval';
    END IF;
    IF NEW.requested_qty IS DISTINCT FROM OLD.requested_qty
       OR NEW.head_chef_qty IS DISTINCT FROM OLD.head_chef_qty
       OR NEW.head_chef_ingredient_id IS DISTINCT FROM OLD.head_chef_ingredient_id THEN
      RAISE EXCEPTION 'Chef and Head Chef order history cannot be overwritten';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.requested_qty IS DISTINCT FROM OLD.requested_qty
     OR NEW.head_chef_qty IS DISTINCT FROM OLD.head_chef_qty
     OR NEW.head_chef_ingredient_id IS DISTINCT FROM OLD.head_chef_ingredient_id
     OR NEW.ingredient_id IS DISTINCT FROM OLD.ingredient_id
     OR NEW.rate IS DISTINCT FROM OLD.rate THEN
    RAISE EXCEPTION 'Order history cannot be edited outside its approved review flow';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_requisition_item_edit() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.head_chef_review_requisition(
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
  v_qty numeric;
  v_ingredient uuid;
  v_chef_name text;
  v_head_chef_name text;
  v_total integer;
  v_changed integer := 0;
  v_active integer := 0;
  v_changes jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.is_head_chef() THEN
    RAISE EXCEPTION 'Only the Head Chef can review this order';
  END IF;

  SELECT * INTO v_req FROM public.requisitions WHERE id = p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_req.status <> 'pending' OR v_req.head_chef_status <> 'pending' THEN
    RAISE EXCEPTION 'This order is no longer waiting for Head Chef review';
  END IF;
  IF NOT v_req.head_chef_required THEN
    RAISE EXCEPTION 'This order does not require Head Chef review';
  END IF;
  IF NOT public.can_access_canteen(v_req.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  PERFORM set_config('app.head_chef_review', 'on', true);

  IF NOT p_approve THEN
    IF nullif(btrim(coalesce(p_review_notes, '')), '') IS NULL THEN
      RAISE EXCEPTION 'Reject karne ka reason zaroori hai';
    END IF;
    UPDATE public.requisitions
       SET status = 'rejected', head_chef_status = 'rejected',
           head_chef_reviewed_by = auth.uid(), head_chef_reviewed_at = now(),
           head_chef_notes = btrim(p_review_notes), review_notes = btrim(p_review_notes)
     WHERE id = p_req_id;
    INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
    VALUES(auth.uid(), 'head_chef_rejected_requisition', 'requisition', p_req_id, v_req.canteen_id,
           jsonb_build_object('req_no', v_req.req_no, 'reason', p_review_notes));
    RETURN jsonb_build_object('status', 'rejected');
  END IF;

  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Reviewed order lines are required';
  END IF;
  SELECT count(*) INTO v_total FROM public.requisition_items WHERE requisition_id = p_req_id;
  IF jsonb_array_length(p_lines) <> v_total
     OR (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_lines)) <> v_total THEN
    RAISE EXCEPTION 'Every order line must be reviewed exactly once';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) x
     WHERE coalesce((x->>'head_chef_qty')::numeric, -1) > 0
     GROUP BY (x->>'ingredient_id') HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'The same item cannot appear on two active order lines';
  END IF;

  FOR v_input IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    SELECT * INTO v_line
      FROM public.requisition_items
     WHERE id = (v_input->>'id')::uuid AND requisition_id = p_req_id
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'An order item was not found'; END IF;

    v_qty := round(coalesce((v_input->>'head_chef_qty')::numeric, -1), 3);
    v_ingredient := nullif(v_input->>'ingredient_id', '')::uuid;
    IF v_qty < 0 THEN RAISE EXCEPTION 'Head Chef quantity must be zero or more'; END IF;
    IF v_ingredient IS NULL THEN RAISE EXCEPTION 'Head Chef item is required'; END IF;

    SELECT name INTO v_head_chef_name
      FROM public.ingredients
     WHERE id = v_ingredient AND canteen_id = v_req.canteen_id AND archived_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Selected item is not available at this site'; END IF;
    SELECT name INTO v_chef_name FROM public.ingredients WHERE id = v_line.ingredient_id;

    IF v_qty > 0 THEN v_active := v_active + 1; END IF;
    IF v_ingredient IS DISTINCT FROM v_line.ingredient_id
       OR abs(v_qty - v_line.requested_qty) > 0.000000001 THEN
      v_changed := v_changed + 1;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'line_id', v_line.id,
        'chef_item_id', v_line.ingredient_id, 'chef_item', v_chef_name,
        'head_chef_item_id', v_ingredient, 'head_chef_item', v_head_chef_name,
        'chef_qty', v_line.requested_qty, 'head_chef_qty', v_qty
      ));
    END IF;

    UPDATE public.requisition_items
       SET head_chef_qty = v_qty,
           head_chef_ingredient_id = v_ingredient
     WHERE id = v_line.id;
  END LOOP;

  IF v_changed > 0 AND nullif(btrim(coalesce(p_review_notes, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Order change kiya hai, isliye reason zaroori hai';
  END IF;

  UPDATE public.requisitions
     SET head_chef_status = 'approved',
         head_chef_reviewed_by = auth.uid(), head_chef_reviewed_at = now(),
         head_chef_notes = nullif(btrim(coalesce(p_review_notes, '')), '')
   WHERE id = p_req_id;

  INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES(auth.uid(), 'head_chef_reviewed_requisition', 'requisition', p_req_id, v_req.canteen_id,
         jsonb_build_object('req_no', v_req.req_no, 'reason', p_review_notes,
                            'active_lines', v_active, 'changed_lines', v_changed,
                            'changes', v_changes));

  RETURN jsonb_build_object('status', 'forwarded_to_manager',
                            'active_lines', v_active,
                            'changed_lines', v_changed, 'changes', v_changes);
END;
$$;
REVOKE ALL ON FUNCTION public.head_chef_review_requisition(uuid,jsonb,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.head_chef_review_requisition(uuid,jsonb,boolean,text) TO authenticated;

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
  v_base_qty numeric;
  v_new_ingredient uuid;
  v_base_ingredient uuid;
  v_new_name text;
  v_base_name text;
  v_new_unit text;
  v_new_rate numeric;
  v_chef_name text;
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
  IF v_req.status <> 'pending' THEN RAISE EXCEPTION 'This order is no longer waiting for approval'; END IF;
  IF NOT public.can_access_canteen(v_req.canteen_id) THEN RAISE EXCEPTION 'You do not have access to this site'; END IF;
  IF v_req.head_chef_required AND v_req.head_chef_status <> 'approved' THEN
    RAISE EXCEPTION 'Head Chef review is required before Manager approval';
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

  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Final order lines are required'; END IF;
  SELECT count(*) INTO v_total FROM public.requisition_items WHERE requisition_id = p_req_id;
  IF jsonb_array_length(p_lines) <> v_total
     OR (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_lines)) <> v_total THEN
    RAISE EXCEPTION 'Every order line must be reviewed exactly once';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) x
     WHERE coalesce((x->>'approved_qty')::numeric, -1) > 0
     GROUP BY (x->>'ingredient_id') HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'The same item cannot appear on two active order lines';
  END IF;

  PERFORM set_config('app.manager_order_review', 'on', true);

  FOR v_input IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    SELECT * INTO v_line FROM public.requisition_items
     WHERE id = (v_input->>'id')::uuid AND requisition_id = p_req_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'An order item was not found'; END IF;

    v_new_qty := round(coalesce((v_input->>'approved_qty')::numeric, -1), 3);
    v_new_ingredient := nullif(v_input->>'ingredient_id', '')::uuid;
    v_base_qty := coalesce(v_line.head_chef_qty, v_line.requested_qty);
    v_base_ingredient := coalesce(v_line.head_chef_ingredient_id, v_line.ingredient_id);
    IF v_new_qty < 0 THEN RAISE EXCEPTION 'Final quantity must be zero or more'; END IF;
    IF v_new_ingredient IS NULL THEN RAISE EXCEPTION 'Final item is required'; END IF;

    SELECT name, unit, cost_per_unit INTO v_new_name, v_new_unit, v_new_rate
      FROM public.ingredients
     WHERE id = v_new_ingredient AND canteen_id = v_req.canteen_id AND archived_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Selected item is not available at this site'; END IF;
    SELECT name INTO v_chef_name FROM public.ingredients WHERE id = v_line.ingredient_id;
    SELECT name INTO v_base_name FROM public.ingredients WHERE id = v_base_ingredient;

    IF v_new_qty > 0 THEN v_active := v_active + 1; END IF;
    IF v_new_ingredient IS DISTINCT FROM v_base_ingredient
       OR abs(v_new_qty - v_base_qty) > 0.000000001 THEN
      v_changed := v_changed + 1;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'line_id', v_line.id,
        'chef_item_id', v_line.ingredient_id, 'chef_item', v_chef_name,
        'head_chef_item_id', v_line.head_chef_ingredient_id,
        'head_chef_item', v_base_name,
        'final_item_id', v_new_ingredient, 'final_item', v_new_name,
        'chef_qty', v_line.requested_qty, 'head_chef_qty', v_line.head_chef_qty,
        'manager_base_qty', v_base_qty, 'final_qty', v_new_qty
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
             ELSE v_line.original_ingredient_id END,
           cancelled_qty = greatest(v_line.requested_qty - v_new_qty, 0),
           cancellation_reason = CASE WHEN v_new_qty < v_line.requested_qty
             THEN nullif(btrim(coalesce(p_review_notes, '')), '') ELSE NULL END,
           cancelled_by = CASE WHEN v_new_qty < v_line.requested_qty THEN auth.uid() ELSE NULL END,
           cancelled_at = CASE WHEN v_new_qty < v_line.requested_qty THEN now() ELSE NULL END
     WHERE id = v_line.id;
  END LOOP;

  IF v_changed > 0 AND nullif(btrim(coalesce(p_review_notes, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Reason is required when the manager changes the Head Chef order';
  END IF;

  v_status := CASE WHEN v_active = 0 THEN 'cancelled' ELSE 'approved' END;
  UPDATE public.requisitions
     SET status = v_status, review_notes = nullif(btrim(coalesce(p_review_notes, '')), ''),
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

COMMENT ON FUNCTION public.head_chef_review_requisition(uuid,jsonb,boolean,text) IS
  'Head Chef can fully edit pending Chef order items and quantities, including zero, before forwarding to Manager.';
COMMENT ON FUNCTION public.manager_review_requisition(uuid,jsonb,boolean,text) IS
  'Manager makes the final full edit after Head Chef and approves or rejects the pending order.';

NOTIFY pgrst, 'reload schema';
