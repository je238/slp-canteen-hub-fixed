-- ============================================================
-- STORE KEEPER CAN ASK TO CHANGE A BILL'S VENDOR
--
-- The owner (13 Nov 2026): the store keeper needs to change the vendor on
-- today's bills and old ones, with a reason. Like every other bill change
-- (20261113110000) it waits for an Admin / Super Admin; nothing moves until
-- approval. On approval the purchase and its stock lots move to the new
-- vendor, so vendor payables and rate history follow.
--
-- purchase_change_requests now carries kind 'line' (an item line) or
-- 'vendor' (the whole bill; purchase_item_id is empty).
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.purchase_change_requests
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'line';
ALTER TABLE public.purchase_change_requests
  ALTER COLUMN purchase_item_id DROP NOT NULL;
ALTER TABLE public.purchase_change_requests
  DROP CONSTRAINT IF EXISTS purchase_change_requests_kind_check;
ALTER TABLE public.purchase_change_requests
  ADD CONSTRAINT purchase_change_requests_kind_check CHECK (
    (kind = 'line' AND purchase_item_id IS NOT NULL) OR (kind = 'vendor' AND purchase_item_id IS NULL));

-- One open vendor change per bill.
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_change_requests_open_vendor
  ON public.purchase_change_requests (purchase_id) WHERE status = 'pending' AND kind = 'vendor';

CREATE OR REPLACE FUNCTION public.request_purchase_vendor_change(
  p_purchase_id uuid, p_supplier_id uuid, p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_purchase public.purchases%ROWTYPE;
  v_old_name text;
  v_new_name text;
  v_id uuid;
  v_who text;
BEGIN
  IF NOT public.can_receive_stock() THEN
    RAISE EXCEPTION 'Sirf Store Keeper, Manager ya Admin vendor badalne ki request bhej sakte hain';
  END IF;
  IF nullif(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'Vendor badalne ka reason likhna zaroori hai';
  END IF;
  SELECT * INTO v_purchase FROM public.purchases WHERE id = p_purchase_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill nahi mila'; END IF;
  IF NOT public.can_access_canteen(v_purchase.canteen_id) THEN
    RAISE EXCEPTION 'Aapko is site ka access nahi hai';
  END IF;
  IF p_supplier_id IS NULL THEN RAISE EXCEPTION 'Naya vendor chunein'; END IF;
  SELECT name INTO v_new_name FROM public.suppliers
   WHERE id = p_supplier_id AND (canteen_id IS NULL OR canteen_id = v_purchase.canteen_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Ye vendor is site ka nahi hai'; END IF;
  IF p_supplier_id IS NOT DISTINCT FROM v_purchase.supplier_id THEN
    RAISE EXCEPTION 'Is bill ka vendor pehle se %', v_new_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.purchase_change_requests
              WHERE purchase_id = v_purchase.id AND kind = 'vendor' AND status = 'pending') THEN
    RAISE EXCEPTION 'Is bill ka vendor change pehle se Admin approval ke liye ruka hai';
  END IF;
  SELECT name INTO v_old_name FROM public.suppliers WHERE id = v_purchase.supplier_id;

  INSERT INTO public.purchase_change_requests
    (canteen_id, purchase_id, purchase_item_id, kind, requested_by, reason, old_values, new_values)
  VALUES
    (v_purchase.canteen_id, v_purchase.id, NULL, 'vendor', auth.uid(), btrim(p_reason),
     jsonb_build_object('supplier_id', v_purchase.supplier_id, 'supplier_name', coalesce(v_old_name, 'Koi vendor nahi'),
                        'item_name', 'Vendor: ' || coalesce(v_old_name, 'koi nahi')),
     jsonb_build_object('supplier_id', p_supplier_id, 'supplier_name', v_new_name,
                        'item_name', 'Vendor: ' || v_new_name))
  RETURNING id INTO v_id;

  SELECT coalesce(nullif(btrim(u.raw_user_meta_data->>'full_name'), ''), u.email) INTO v_who
    FROM auth.users u WHERE u.id = auth.uid();

  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'purchase_vendor_change_requested', 'purchase', v_purchase.id, v_purchase.canteen_id,
          jsonb_build_object('request_id', v_id, 'reason', btrim(p_reason),
                             'old_supplier', v_old_name, 'new_supplier', v_new_name));
  INSERT INTO public.notifications (canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES (v_purchase.canteen_id, 'admin', 'Bill ka vendor badalne ki approval chahiye',
          format('Bill ₹%s (%s): vendor %s → %s. Reason: %s. — %s',
                 coalesce(v_purchase.stated_total, v_purchase.total_amount),
                 to_char(v_purchase.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon'),
                 coalesce(v_old_name, 'koi nahi'), v_new_name, btrim(p_reason), coalesce(v_who, 'Store')),
          '/purchases?changes=1', 'purchase_change', v_id);
  RETURN jsonb_build_object('requested', true, 'request_id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.request_purchase_vendor_change(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_purchase_vendor_change(uuid, uuid, text) TO authenticated;

-- Review now answers both kinds.
CREATE OR REPLACE FUNCTION public.review_purchase_line_change(
  p_request_id uuid, p_approve boolean, p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_req public.purchase_change_requests%ROWTYPE;
  v_line public.purchase_items%ROWTYPE;
  v_new jsonb;
  v_result jsonb;
  v_reason text;
  v_same_item boolean;
  v_done text;
BEGIN
  IF NOT public.is_admin_editor() THEN
    RAISE EXCEPTION 'Bill change sirf Admin ya Super Admin approve kar sakta hai';
  END IF;
  SELECT * INTO v_req FROM public.purchase_change_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request nahi mili'; END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Is request ka faisla pehle ho chuka hai (%)', v_req.status;
  END IF;
  IF NOT public.can_access_canteen(v_req.canteen_id) THEN
    RAISE EXCEPTION 'Aapko is site ka access nahi hai';
  END IF;

  IF NOT p_approve THEN
    UPDATE public.purchase_change_requests
       SET status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(),
           review_note = nullif(btrim(p_note), '')
     WHERE id = v_req.id;
    INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
    VALUES (auth.uid(), 'purchase_change_rejected',
            CASE v_req.kind WHEN 'vendor' THEN 'purchase' ELSE 'purchase_item' END,
            coalesce(v_req.purchase_item_id, v_req.purchase_id), v_req.canteen_id,
            jsonb_build_object('request_id', v_req.id, 'kind', v_req.kind, 'note', nullif(btrim(p_note), '')));
    INSERT INTO public.notifications (canteen_id, target_user, title, body, link, ref_type, ref_id)
    VALUES (v_req.canteen_id, v_req.requested_by, 'Bill change mana hua',
            format('%s ka change approve nahi hua.%s Bill pehle jaisa hai.',
                   v_req.old_values->>'item_name',
                   coalesce(' Admin: ' || nullif(btrim(p_note), '') || '.', '')),
            '/purchases', 'purchase_change', v_req.id);
    RETURN jsonb_build_object('approved', false);
  END IF;

  v_new := v_req.new_values;
  v_reason := v_req.reason || ' (approved)';

  IF v_req.kind = 'vendor' THEN
    IF NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id = (v_new->>'supplier_id')::uuid) THEN
      RAISE EXCEPTION 'Naya vendor ab list mein nahi hai; request mana karein';
    END IF;
    PERFORM public.allow_stock_move();
    UPDATE public.purchases SET supplier_id = (v_new->>'supplier_id')::uuid WHERE id = v_req.purchase_id;
    UPDATE public.ingredient_batches SET supplier_id = (v_new->>'supplier_id')::uuid WHERE purchase_id = v_req.purchase_id;
    v_result := jsonb_build_object('vendor_changed', true,
      'old', v_req.old_values->>'supplier_name', 'new', v_new->>'supplier_name');
    v_done := format('Vendor ab %s hai.', v_new->>'supplier_name');
  ELSE
    SELECT * INTO v_line FROM public.purchase_items WHERE id = v_req.purchase_item_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Bill ki ye line ab nahi rahi'; END IF;
    v_same_item := (v_new->>'ingredient_id')::uuid IS NOT DISTINCT FROM v_line.ingredient_id;
    BEGIN
      v_result := public.correct_confirmed_purchase_line(
        v_req.purchase_item_id, (v_new->>'ingredient_id')::uuid, v_new->>'new_item_name',
        v_new->>'category', v_new->>'unit', (v_new->>'quantity')::numeric,
        (v_new->>'rate')::numeric, v_reason);
    EXCEPTION WHEN raise_exception THEN
      -- Some of this line has gone to the kitchen: the direct correction
      -- refuses that, approval may still move quantity and rate of the same item.
      IF SQLERRM NOT LIKE '%kitchen issue ho chuka%' THEN RAISE; END IF;
      IF NOT v_same_item THEN
        RAISE EXCEPTION 'Is line ka maal kitchen ja chuka hai, isliye item nahi badal sakta — sirf quantity/rate. Request reject karke stock count se sudharein.';
      END IF;
      v_result := public.apply_issued_purchase_line_change(
        v_req.purchase_item_id, (v_new->>'quantity')::numeric, (v_new->>'rate')::numeric, v_reason);
    END;
    v_done := format('%s: ab %s %s @ ₹%s.', v_new->>'item_name', v_new->>'quantity', v_new->>'unit', v_new->>'rate');
  END IF;

  UPDATE public.purchase_change_requests
     SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(),
         review_note = nullif(btrim(p_note), '')
   WHERE id = v_req.id;
  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'purchase_change_approved',
          CASE v_req.kind WHEN 'vendor' THEN 'purchase' ELSE 'purchase_item' END,
          coalesce(v_req.purchase_item_id, v_req.purchase_id), v_req.canteen_id,
          jsonb_build_object('request_id', v_req.id, 'kind', v_req.kind, 'requested_by', v_req.requested_by,
                             'reason', v_req.reason, 'result', v_result));
  INSERT INTO public.notifications (canteen_id, target_user, title, body, link, ref_type, ref_id)
  VALUES (v_req.canteen_id, v_req.requested_by, 'Bill change approve hua', v_done,
          '/purchases', 'purchase_change', v_req.id);
  RETURN jsonb_build_object('approved', true, 'result', v_result);
END;
$$;
REVOKE ALL ON FUNCTION public.review_purchase_line_change(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_purchase_line_change(uuid, boolean, text) TO authenticated;
