-- Admins may repair a Chef's approved order without deleting its history.
-- Quantity may go up or down, but never below material already issued.
-- The ingredient may be replaced only before anything on that line is issued.

ALTER TABLE public.requisition_items
  ADD COLUMN IF NOT EXISTS original_ingredient_id uuid
    REFERENCES public.ingredients(id),
  ADD COLUMN IF NOT EXISTS admin_edit_reason text,
  ADD COLUMN IF NOT EXISTS admin_edited_by uuid
    REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS admin_edited_at timestamptz;

COMMENT ON COLUMN public.requisition_items.original_ingredient_id IS
  'Chef-selected ingredient retained when an admin replaces the effective item.';

CREATE OR REPLACE FUNCTION public.enforce_requisition_tolerance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE v_status text;
BEGIN
  -- Admin correction may be outside the manager's +/-7% band. Stock that has
  -- already left the store remains the hard floor.
  IF TG_OP = 'UPDATE'
     AND coalesce(current_setting('app.admin_order_correction', true), '') = 'on' THEN
    IF NEW.approved_qty >= coalesce(OLD.issued_qty, 0) THEN
      RETURN NEW;
    END IF;
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
      'Approved quantity % is outside the allowed +/-7%% of the requested %. Send it back to the chef instead.',
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

CREATE OR REPLACE FUNCTION public.admin_correct_requisition(
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
  v_new_qty numeric;
  v_new_ingredient uuid;
  v_old_qty numeric;
  v_issued numeric;
  v_new_unit text;
  v_old_name text;
  v_new_name text;
  v_changed integer := 0;
  v_left integer := 0;
  v_issued_total numeric := 0;
  v_status text;
  v_changes jsonb := '[]'::jsonb;
BEGIN
  IF nullif(btrim(coalesce(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Reason is required';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Order lines are required';
  END IF;
  IF NOT public.is_admin_editor() THEN
    RAISE EXCEPTION 'Only an admin can fully edit an approved order';
  END IF;

  SELECT * INTO v_req FROM public.requisitions WHERE id = p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_req.status <> 'approved' THEN
    RAISE EXCEPTION 'Only an approved order waiting at the store can be edited';
  END IF;
  IF NOT public.can_access_canteen(v_req.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  PERFORM set_config('app.admin_order_correction', 'on', true);

  FOR v_input IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    SELECT * INTO v_line
      FROM public.requisition_items
     WHERE id = (v_input->>'id')::uuid
       AND requisition_id = p_req_id
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'An order item was not found'; END IF;

    v_new_qty := round(coalesce((v_input->>'approved_qty')::numeric, -1), 3);
    v_new_ingredient := coalesce(nullif(v_input->>'ingredient_id', '')::uuid,
                                 v_line.ingredient_id);
    v_old_qty := coalesce(v_line.approved_qty, v_line.requested_qty);
    v_issued := coalesce(v_line.issued_qty, 0);

    IF v_new_qty < 0 THEN RAISE EXCEPTION 'Quantity cannot be negative'; END IF;
    IF v_new_qty < v_issued - 0.000000001 THEN
      RAISE EXCEPTION 'Quantity cannot be below % because that much has already been issued', v_issued;
    END IF;
    IF v_new_ingredient IS DISTINCT FROM v_line.ingredient_id AND v_issued > 0 THEN
      RAISE EXCEPTION 'An item cannot be changed after some of it has been issued';
    END IF;

    SELECT name, unit INTO v_new_name, v_new_unit
      FROM public.ingredients
     WHERE id = v_new_ingredient
       AND canteen_id = v_req.canteen_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'The replacement item is not available at this site'; END IF;
    SELECT name INTO v_old_name FROM public.ingredients WHERE id = v_line.ingredient_id;

    -- Two active lines for the same ingredient make issue/FIFO history
    -- ambiguous. An admin must choose a different item or cancel one line.
    IF v_new_qty > v_issued AND EXISTS (
      SELECT 1
        FROM public.requisition_items other
       WHERE other.requisition_id = p_req_id
         AND other.id <> v_line.id
         AND other.ingredient_id = v_new_ingredient
         AND greatest(coalesce(other.approved_qty, other.requested_qty)
                      - coalesce(other.issued_qty, 0), 0) > 0
    ) THEN
      RAISE EXCEPTION '% already has another active line in this order', v_new_name;
    END IF;

    CONTINUE WHEN abs(v_new_qty - v_old_qty) < 0.000000001
                  AND v_new_ingredient = v_line.ingredient_id;

    UPDATE public.requisition_items
       SET approved_qty = v_new_qty,
           ingredient_id = v_new_ingredient,
           unit = v_new_unit,
           original_ingredient_id = CASE
             WHEN v_new_ingredient IS DISTINCT FROM v_line.ingredient_id
               THEN coalesce(v_line.original_ingredient_id, v_line.ingredient_id)
             ELSE v_line.original_ingredient_id
           END,
           cancelled_qty = greatest(v_line.requested_qty - v_new_qty, 0),
           cancellation_reason = CASE WHEN v_new_qty < v_old_qty THEN btrim(p_reason)
                                      ELSE v_line.cancellation_reason END,
           cancelled_by = CASE WHEN v_new_qty < v_old_qty THEN auth.uid()
                               ELSE v_line.cancelled_by END,
           cancelled_at = CASE WHEN v_new_qty < v_old_qty THEN now()
                               ELSE v_line.cancelled_at END,
           admin_edit_reason = btrim(p_reason),
           admin_edited_by = auth.uid(),
           admin_edited_at = now()
     WHERE id = v_line.id;

    v_changed := v_changed + 1;
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'item_id', v_line.id,
      'old_item_id', v_line.ingredient_id, 'old_item', v_old_name,
      'new_item_id', v_new_ingredient, 'new_item', v_new_name,
      'old_qty', v_old_qty, 'new_qty', v_new_qty,
      'issued', v_issued
    ));
  END LOOP;

  IF v_changed = 0 THEN RAISE EXCEPTION 'No item or quantity was changed'; END IF;

  SELECT count(*) INTO v_left
    FROM public.requisition_items
   WHERE requisition_id = p_req_id
     AND greatest(coalesce(approved_qty, requested_qty) - coalesce(issued_qty, 0), 0) > 0;
  SELECT coalesce(sum(coalesce(issued_qty, 0)), 0) INTO v_issued_total
    FROM public.requisition_items WHERE requisition_id = p_req_id;

  IF v_left = 0 AND v_issued_total > 0 THEN
    v_status := 'issued';
    UPDATE public.requisitions
       SET status = 'issued', review_notes = btrim(p_reason),
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
  VALUES(auth.uid(), 'admin_corrected_requisition', 'requisition', p_req_id,
         v_req.canteen_id, jsonb_build_object(
           'req_no', v_req.req_no, 'reason', btrim(p_reason),
           'changes', v_changes, 'status', v_status
         ));

  INSERT INTO public.notifications(canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES
    (v_req.canteen_id, 'chef', format('Order #%s admin ne correct kiya', v_req.req_no),
     btrim(p_reason), '/requisitions', 'requisition', p_req_id),
    (v_req.canteen_id, 'store_keeper', format('Order #%s update hua', v_req.req_no),
     btrim(p_reason), '/requisitions', 'requisition', p_req_id);

  RETURN jsonb_build_object('changed_lines', v_changed, 'status', v_status,
                            'changes', v_changes);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_correct_requisition(uuid,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_correct_requisition(uuid,jsonb,text) TO authenticated;
