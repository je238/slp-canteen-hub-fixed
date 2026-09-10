-- A chef may discover that the quantity already issued is enough. Closing
-- only the UNISSUED remainder releases its commitment; it never adds stock.

ALTER TABLE public.requisition_items
  ADD COLUMN IF NOT EXISTS cancelled_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

ALTER TABLE public.requisition_items
  DROP CONSTRAINT IF EXISTS requisition_items_cancelled_qty_check;
ALTER TABLE public.requisition_items
  ADD CONSTRAINT requisition_items_cancelled_qty_check CHECK (cancelled_qty >= 0);

CREATE OR REPLACE FUNCTION public.enforce_requisition_tolerance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE v_status text;
BEGIN
  -- Only close_requisition_item_pending sets this transaction-local flag.
  -- The effective approval becomes what was already issued, while the amount
  -- the manager originally approved is retained in cancelled_qty.
  IF TG_OP = 'UPDATE'
     AND coalesce(current_setting('app.close_pending', true), '') = 'on' THEN
    IF NEW.approved_qty = coalesce(OLD.issued_qty, 0)
       AND NEW.approved_qty <= coalesce(OLD.approved_qty, OLD.requested_qty) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Only the unissued remainder may be closed';
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

CREATE OR REPLACE FUNCTION public.close_requisition_item_pending(
  p_requisition_item_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_line public.requisition_items%ROWTYPE;
  v_req public.requisitions%ROWTYPE;
  v_pending numeric;
  v_left integer;
  v_item_name text;
BEGIN
  IF nullif(btrim(coalesce(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Reason is required — say why the remaining material is not needed';
  END IF;

  SELECT * INTO v_line FROM public.requisition_items
  WHERE id = p_requisition_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order item not found'; END IF;

  SELECT * INTO v_req FROM public.requisitions
  WHERE id = v_line.requisition_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Requisition not found'; END IF;

  IF NOT public.is_chef() OR v_req.requested_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the chef who raised this order can close its pending quantity';
  END IF;
  IF NOT public.can_access_canteen(v_req.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;
  IF v_req.status <> 'approved' THEN
    RAISE EXCEPTION 'Only a partially issued approved order can be closed';
  END IF;
  IF coalesce(v_line.issued_qty, 0) <= 0 THEN
    RAISE EXCEPTION 'Nothing has been issued yet — ask the manager to send the order back instead';
  END IF;

  v_pending := greatest(coalesce(v_line.approved_qty, v_line.requested_qty)
                        - coalesce(v_line.issued_qty, 0), 0);
  IF v_pending <= 0 THEN RAISE EXCEPTION 'Nothing is pending on this item'; END IF;

  PERFORM public.allow_stock_move();
  PERFORM set_config('app.close_pending', 'on', true);

  UPDATE public.requisition_items
     SET cancelled_qty = coalesce(cancelled_qty, 0) + v_pending,
         cancellation_reason = btrim(p_reason),
         cancelled_by = auth.uid(),
         cancelled_at = now(),
         approved_qty = coalesce(issued_qty, 0)
   WHERE id = p_requisition_item_id;

  SELECT name INTO v_item_name FROM public.ingredients WHERE id = v_line.ingredient_id;

  SELECT count(*) INTO v_left
  FROM public.requisition_items
  WHERE requisition_id = v_req.id
    AND greatest(coalesce(approved_qty, requested_qty) - coalesce(issued_qty, 0), 0) > 0;

  IF v_left = 0 THEN
    UPDATE public.requisitions
       SET status = 'issued',
           issued_by = coalesce(issued_by, (
             SELECT sl.created_by FROM public.stock_ledger sl
             WHERE sl.reference_type='issue' AND sl.reference_id=v_req.id
             ORDER BY sl.created_at DESC LIMIT 1
           )),
           issued_at = coalesce(issued_at, (
             SELECT max(sl.created_at) FROM public.stock_ledger sl
             WHERE sl.reference_type='issue' AND sl.reference_id=v_req.id
           ), now())
     WHERE id = v_req.id;
  END IF;

  INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES(auth.uid(), 'chef_closed_pending_quantity', 'requisition_item',
         p_requisition_item_id, v_req.canteen_id,
         jsonb_build_object('req_no', v_req.req_no, 'item', v_item_name,
                            'issued_qty', coalesce(v_line.issued_qty,0),
                            'cancelled_pending_qty', v_pending,
                            'reason', btrim(p_reason)));

  RETURN jsonb_build_object('req_no', v_req.req_no, 'item', v_item_name,
                            'closed_qty', v_pending, 'remaining_lines', v_left,
                            'status', CASE WHEN v_left=0 THEN 'issued' ELSE 'approved' END);
END;
$$;

REVOKE ALL ON FUNCTION public.close_requisition_item_pending(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_requisition_item_pending(uuid,text) TO authenticated;
