-- ============================================================
-- AN APPROVAL CAN BE TAKEN BACK, UNTIL THE GOODS MOVE
--
-- The chef asked for eleven things the store did not have — Carrot Red 15 kg
-- against a shelf of nothing, 1400 disposable plates against nothing — and
-- the manager approved all of it. That much is a human mistake and will keep
-- happening; a manager approving thirty-eight lines on a phone is not going
-- to check each one against the shelf.
--
-- What made it a problem is that there was no way back. A pending order can
-- be rejected, but an APPROVED one had nowhere to go: not editable, not
-- rejectable, not cancellable. It simply sat there, unissuable, until someone
-- deleted rows out of the database. That is not a workflow, it is a dead end,
-- and the only way out of a dead end is the thing this app exists to prevent
-- — someone handing over goods without a record.
--
-- So an approval can be taken back, right up until the stock actually moves.
-- After it has moved it cannot, because then it is not a decision any more,
-- it is a fact about where the food went.
--
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.send_requisition_back(p_req_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.requisitions%ROWTYPE; v_n INT;
BEGIN
  SELECT * INTO v_req FROM public.requisitions WHERE id = p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown requisition'; END IF;

  IF v_req.status = 'issued' THEN
    RAISE EXCEPTION
      'This order has already been issued — the goods have left the store. Record a return instead.';
  END IF;
  IF v_req.status NOT IN ('approved', 'pending') THEN
    RAISE EXCEPTION 'Only a pending or approved order can be sent back (this one is %)', v_req.status;
  END IF;
  IF NOT (public.is_admin_editor() OR public.is_manager_or_above()) THEN
    RAISE EXCEPTION 'Only the manager or an admin can send an order back';
  END IF;
  IF NOT public.can_access_canteen(v_req.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  -- The approved quantities go with the approval. What the chef ASKED for
  -- stays exactly as it was: that is the record of the request and it is not
  -- the manager's to rewrite.
  UPDATE public.requisition_items SET approved_qty = NULL
   WHERE requisition_id = p_req_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE public.requisitions
     SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL,
         review_notes = coalesce(nullif(btrim(p_reason), ''), review_notes)
   WHERE id = p_req_id;

  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'requisition_sent_back', 'requisition', p_req_id, v_req.canteen_id,
          jsonb_build_object('was', v_req.status, 'lines', v_n, 'reason', p_reason));

  -- The status change fires the ordinary "requisition is pending" notice,
  -- which after a send-back reads as though the chef raised it again. One
  -- event, one notice: drop that one and say what actually happened.
  DELETE FROM public.notifications
   WHERE ref_type = 'requisition' AND ref_id = p_req_id
     AND created_at >= now() - interval '1 minute';

  INSERT INTO public.notifications (canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES (v_req.canteen_id, 'chef',
          format('Order #%s sent back', v_req.req_no),
          coalesce(nullif(btrim(p_reason), ''),
                   'The manager has sent this order back. Check the quantities and send it again.'),
          '/requisitions', 'requisition', p_req_id);

  RETURN jsonb_build_object('status', 'pending', 'lines_cleared', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.send_requisition_back(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_requisition_back(UUID, TEXT) TO authenticated;

-- ---------- Or drop it altogether ----------
CREATE OR REPLACE FUNCTION public.cancel_requisition(p_req_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.requisitions%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM public.requisitions WHERE id = p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown requisition'; END IF;
  IF v_req.status = 'issued' THEN
    RAISE EXCEPTION
      'This order has already been issued — the goods have left the store. Record a return instead.';
  END IF;
  IF NOT (public.is_admin_editor() OR public.is_manager_or_above()) THEN
    RAISE EXCEPTION 'Only the manager or an admin can cancel an order';
  END IF;
  IF NOT public.can_access_canteen(v_req.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  -- Cancelled, not deleted. An order that was raised and then dropped is
  -- worth being able to see afterwards.
  UPDATE public.requisitions
     SET status = 'cancelled',
         review_notes = coalesce(nullif(btrim(p_reason), ''), review_notes)
   WHERE id = p_req_id;

  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'requisition_cancelled', 'requisition', p_req_id, v_req.canteen_id,
          jsonb_build_object('was', v_req.status, 'reason', p_reason));

  RETURN jsonb_build_object('status', 'cancelled');
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_requisition(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_requisition(UUID, TEXT) TO authenticated;

-- ---------- What the store will not be able to hand over ----------
-- Read before approving, so the shortfall is a decision rather than a
-- surprise at the counter with a chef waiting.
CREATE OR REPLACE FUNCTION public.requisition_shortfall(p_req_id UUID)
RETURNS TABLE (
  ingredient_id UUID, name TEXT, unit TEXT,
  wanted NUMERIC, on_shelf NUMERIC, short_by NUMERIC
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT i.id, i.name, i.unit,
         coalesce(ri.approved_qty, ri.requested_qty),
         i.current_stock,
         round(coalesce(ri.approved_qty, ri.requested_qty) - i.current_stock, 3)
  FROM public.requisition_items ri
  JOIN public.ingredients i ON i.id = ri.ingredient_id
  JOIN public.requisitions r ON r.id = ri.requisition_id
  WHERE ri.requisition_id = p_req_id
    AND coalesce(ri.approved_qty, ri.requested_qty) > i.current_stock
    AND public.can_access_canteen(r.canteen_id)
  ORDER BY (coalesce(ri.approved_qty, ri.requested_qty) - i.current_stock) DESC;
$$;
REVOKE ALL ON FUNCTION public.requisition_shortfall(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.requisition_shortfall(UUID) TO authenticated;
