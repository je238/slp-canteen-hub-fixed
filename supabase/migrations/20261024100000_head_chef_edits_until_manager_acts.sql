-- ============================================================
-- THE HEAD CHEF CAN RE-EDIT AN ORDER UNTIL THE MANAGER ACTS
--
-- Once the Head Chef pressed "Manager ko bhejo" the order was locked for
-- them: a quantity they forgot to raise or cut could not be corrected,
-- even though the Manager had not looked at it yet (24/10/2026). The Head
-- Chef review now opens again while the order is still pending with the
-- Manager; once the Manager approves, rejects or cancels, it is closed.
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.head_chef_review_requisition(p_req_id uuid, p_lines jsonb, p_approve boolean, p_review_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_req public.requisitions%ROWTYPE;
  v_line public.requisition_items%ROWTYPE;
  v_input jsonb;
  v_qty numeric;
  v_ingredient uuid;
  v_chef_name text;
  v_head_chef_name text;
  v_removed boolean;
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
  -- 'approved' here means forwarded to the Manager, who has not acted yet.
  IF v_req.status <> 'pending' OR v_req.head_chef_status NOT IN ('pending', 'approved') THEN
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

    SELECT name, archived_at IS NOT NULL INTO v_head_chef_name, v_removed
      FROM public.ingredients
     WHERE id = v_ingredient AND canteen_id = v_req.canteen_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Selected item is not available at this site'; END IF;
    -- A line whose item was taken out of inventory may still be dropped (qty 0);
    -- only ordering a removed item is refused.
    IF v_removed AND v_qty > 0 THEN
      RAISE EXCEPTION '% inventory se hata diya gaya hai. Is line ko 0 karein ya doosra item chunein.', v_head_chef_name;
    END IF;
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
$function$;
