-- ============================================================
-- A RECEIVED BILL CHANGES ONLY AFTER ADMIN APPROVAL
--
-- The owner (13 Nov 2026): the store keeper may change anything on a bill
-- after booking it in (item, name, quantity, unit, rate), with a reason, but
-- the change waits for an Admin or Super Admin. Nothing on the bill, the
-- shelf or the lots moves until one of them approves.
--
-- Until now the store keeper's "Galat entry sudharo" applied at once
-- (34 corrections, one on 11/11). Now:
--   request_purchase_line_change()  store keeper / manager: files the change
--   review_purchase_line_change()   admin+: approve applies it, reject drops it
--   correct_confirmed_purchase_line() is admin-only (it is what approval runs)
--
-- Approval also covers a line whose stock has partly gone to the kitchen,
-- which the direct correction refuses: the same item's quantity moves by the
-- difference only, so what the kitchen already used is left as it was.
--
-- Safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.purchase_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canteen_id uuid NOT NULL REFERENCES public.canteens(id) ON DELETE CASCADE,
  purchase_id uuid NOT NULL REFERENCES public.purchases(id) ON DELETE CASCADE,
  purchase_item_id uuid NOT NULL REFERENCES public.purchase_items(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES auth.users(id),
  reason text NOT NULL,
  old_values jsonb NOT NULL,
  new_values jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One open request per bill line: a second change waits for the first answer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_change_requests_open_line
  ON public.purchase_change_requests (purchase_item_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_purchase_change_requests_pending
  ON public.purchase_change_requests (canteen_id, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_purchase_change_requests_purchase
  ON public.purchase_change_requests (purchase_id);

ALTER TABLE public.purchase_change_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchase_change_requests_select ON public.purchase_change_requests;
CREATE POLICY purchase_change_requests_select
  ON public.purchase_change_requests FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
REVOKE ALL ON TABLE public.purchase_change_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.purchase_change_requests TO authenticated;

-- ------------------------------------------------------------
-- File a change. Checks what the correction itself would check up front, so
-- the admin is not asked to approve something that cannot be applied.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_purchase_line_change(
  p_purchase_item_id uuid,
  p_ingredient_id uuid DEFAULT NULL,
  p_new_item_name text DEFAULT NULL,
  p_new_category text DEFAULT 'Uncategorised',
  p_new_unit text DEFAULT NULL,
  p_new_quantity numeric DEFAULT NULL,
  p_new_rate numeric DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_line public.purchase_items%ROWTYPE;
  v_purchase public.purchases%ROWTYPE;
  v_ing public.ingredients%ROWTYPE;
  v_old jsonb;
  v_new jsonb;
  v_unit text;
  v_name text;
  v_id uuid;
  v_who text;
BEGIN
  IF NOT public.can_receive_stock() THEN
    RAISE EXCEPTION 'Sirf Store Keeper, Manager ya Admin bill badalne ki request bhej sakte hain';
  END IF;
  IF nullif(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'Change ka reason likhna zaroori hai';
  END IF;
  IF p_new_quantity IS NULL OR p_new_quantity <= 0 THEN
    RAISE EXCEPTION 'Correct quantity zero se zyada honi chahiye';
  END IF;
  IF p_new_rate IS NULL OR p_new_rate < 0 THEN
    RAISE EXCEPTION 'Rate zero se kam nahi ho sakta';
  END IF;

  SELECT * INTO v_line FROM public.purchase_items WHERE id = p_purchase_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice item nahi mila'; END IF;
  SELECT * INTO v_purchase FROM public.purchases WHERE id = v_line.purchase_id;
  IF NOT FOUND OR v_purchase.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Sirf received/confirmed invoice badal sakte ho';
  END IF;
  IF NOT public.can_access_canteen(v_purchase.canteen_id) THEN
    RAISE EXCEPTION 'Aapko is site ka access nahi hai';
  END IF;
  IF v_line.ingredient_id IS NULL THEN
    RAISE EXCEPTION 'Is purani line ka inventory item missing hai; Admin se correction karvao';
  END IF;
  IF EXISTS (SELECT 1 FROM public.purchase_change_requests
              WHERE purchase_item_id = v_line.id AND status = 'pending') THEN
    RAISE EXCEPTION 'Is line ka ek change pehle se Admin approval ke liye ruka hai';
  END IF;

  IF p_ingredient_id IS NOT NULL THEN
    SELECT * INTO v_ing FROM public.ingredients
     WHERE id = p_ingredient_id AND canteen_id = v_purchase.canteen_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Correct inventory item is site me nahi mila'; END IF;
    IF nullif(btrim(p_new_unit), '') IS NOT NULL
       AND lower(btrim(v_ing.unit)) <> lower(btrim(p_new_unit)) THEN
      RAISE EXCEPTION 'Selected item ki unit % hai; quantity usi unit me bharo', v_ing.unit;
    END IF;
    v_name := v_ing.name;
    v_unit := v_ing.unit;
  ELSE
    IF nullif(btrim(p_new_item_name), '') IS NULL OR nullif(btrim(p_new_unit), '') IS NULL THEN
      RAISE EXCEPTION 'Naye item ka naam aur unit dono bharo';
    END IF;
    IF EXISTS (SELECT 1 FROM public.ingredients
                WHERE canteen_id = v_purchase.canteen_id
                  AND lower(btrim(name)) = lower(btrim(p_new_item_name))) THEN
      RAISE EXCEPTION 'Ye item inventory me pehle se hai; existing item select karo';
    END IF;
    v_name := btrim(p_new_item_name);
    v_unit := btrim(p_new_unit);
  END IF;

  IF p_ingredient_id = v_line.ingredient_id
     AND p_new_quantity = coalesce(v_line.stock_quantity, v_line.quantity)
     AND p_new_rate = coalesce(v_line.rate, 0) THEN
    RAISE EXCEPTION 'Kuch badla hi nahi — item, quantity ya rate badlo';
  END IF;

  v_old := jsonb_build_object(
    'ingredient_id', v_line.ingredient_id, 'item_name', v_line.item_name,
    'quantity', coalesce(v_line.stock_quantity, v_line.quantity),
    'unit', coalesce(v_line.stock_unit, v_line.unit),
    'rate', v_line.rate, 'total', v_line.total);
  v_new := jsonb_build_object(
    'ingredient_id', p_ingredient_id, 'item_name', v_name,
    'new_item_name', CASE WHEN p_ingredient_id IS NULL THEN v_name END,
    'category', coalesce(nullif(btrim(p_new_category), ''), 'Uncategorised'),
    'quantity', p_new_quantity, 'unit', v_unit,
    'rate', p_new_rate, 'total', round(p_new_quantity * p_new_rate, 2));

  INSERT INTO public.purchase_change_requests
    (canteen_id, purchase_id, purchase_item_id, requested_by, reason, old_values, new_values)
  VALUES
    (v_purchase.canteen_id, v_purchase.id, v_line.id, auth.uid(), btrim(p_reason), v_old, v_new)
  RETURNING id INTO v_id;

  SELECT coalesce(nullif(btrim(u.raw_user_meta_data->>'full_name'), ''), u.email) INTO v_who
    FROM auth.users u WHERE u.id = auth.uid();

  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'purchase_change_requested', 'purchase_item', v_line.id, v_purchase.canteen_id,
          jsonb_build_object('request_id', v_id, 'purchase_id', v_purchase.id,
                             'reason', btrim(p_reason), 'old', v_old, 'new', v_new));

  INSERT INTO public.notifications (canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES (v_purchase.canteen_id, 'admin', 'Bill change approval chahiye',
          format('%s: %s %s @ ₹%s → %s %s %s @ ₹%s. Reason: %s. — %s',
                 v_line.item_name, v_old->>'quantity', v_old->>'unit', coalesce(v_line.rate, 0),
                 v_name, p_new_quantity, v_unit, p_new_rate, btrim(p_reason), coalesce(v_who, 'Store')),
          '/purchases?changes=1', 'purchase_change', v_id);

  RETURN jsonb_build_object('requested', true, 'request_id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.request_purchase_line_change(uuid, uuid, text, text, text, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_purchase_line_change(uuid, uuid, text, text, text, numeric, numeric, text) TO authenticated;

-- ------------------------------------------------------------
-- A line whose stock has partly gone to the kitchen: the same item only.
-- The shelf and the lot move by (new − old) quantity; what the kitchen has
-- already used stays as it was. Internal, run only by review below.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_issued_purchase_line_change(
  p_purchase_item_id uuid, p_new_quantity numeric, p_new_rate numeric, p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_line public.purchase_items%ROWTYPE;
  v_purchase public.purchases%ROWTYPE;
  v_ing public.ingredients%ROWTYPE;
  v_old_qty numeric;
  v_delta numeric;
  v_batches integer;
  v_balance numeric;
  v_total numeric;
  v_old jsonb;
  v_new jsonb;
  v_correction_id uuid;
BEGIN
  IF NOT public.is_admin_editor() THEN
    RAISE EXCEPTION 'Sirf Admin approve kar sakta hai';
  END IF;
  SELECT * INTO v_line FROM public.purchase_items WHERE id = p_purchase_item_id FOR UPDATE;
  SELECT * INTO v_purchase FROM public.purchases WHERE id = v_line.purchase_id FOR UPDATE;
  SELECT * INTO v_ing FROM public.ingredients WHERE id = v_line.ingredient_id FOR UPDATE;

  SELECT count(*) INTO v_batches FROM public.ingredient_batches
   WHERE purchase_id = v_purchase.id AND ingredient_id = v_line.ingredient_id;
  IF v_batches <> 1 THEN
    RAISE EXCEPTION 'Is line ka lot saaf nahi mila (% lots); stock count se sudharein', v_batches;
  END IF;

  v_old_qty := coalesce(v_line.stock_quantity, v_line.quantity);
  v_delta := p_new_quantity - v_old_qty;
  IF v_ing.current_stock + v_delta < 0 THEN
    RAISE EXCEPTION 'Shelf par sirf % % % hai; quantity % kam nahi ho sakti. Pehle stock count karein.',
      v_ing.current_stock, v_ing.unit, v_ing.name, -v_delta;
  END IF;
  v_total := round(p_new_quantity * p_new_rate, 2);

  PERFORM public.allow_stock_move();

  UPDATE public.ingredient_batches
     SET qty_received = qty_received + v_delta,
         qty_remaining = greatest(qty_remaining + v_delta, 0),
         rate = p_new_rate
   WHERE purchase_id = v_purchase.id AND ingredient_id = v_line.ingredient_id;

  UPDATE public.ingredients
     SET current_stock = current_stock + v_delta,
         cost_per_unit = CASE WHEN p_new_rate > 0 THEN p_new_rate ELSE cost_per_unit END,
         updated_at = now()
   WHERE id = v_ing.id
   RETURNING current_stock INTO v_balance;

  IF v_delta <> 0 THEN
    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason,
       reference_type, reference_id, created_by, service_date, value)
    VALUES
      (v_ing.id, v_purchase.canteen_id, v_delta, v_balance,
       'Invoice correction (approved) — ' || v_line.item_name || ' — ' || btrim(p_reason),
       'purchase_correction', v_purchase.id, auth.uid(),
       (now() AT TIME ZONE 'Asia/Kolkata')::date, round(v_delta * p_new_rate, 2));
  END IF;

  v_old := jsonb_build_object('ingredient_id', v_line.ingredient_id, 'item_name', v_line.item_name,
    'quantity', v_line.quantity, 'stock_quantity', v_old_qty, 'unit', v_line.unit,
    'rate', v_line.rate, 'total', v_line.total);
  v_new := jsonb_build_object('ingredient_id', v_line.ingredient_id, 'item_name', v_line.item_name,
    'quantity', p_new_quantity, 'stock_quantity', p_new_quantity, 'unit', v_line.unit,
    'rate', p_new_rate, 'total', v_total, 'issued_lot', true);

  UPDATE public.purchase_items
     SET quantity = p_new_quantity,
         stock_quantity = p_new_quantity,
         stock_unit = coalesce(stock_unit, unit),
         rate = p_new_rate,
         total = v_total,
         conversion_confirmed = true,
         conversion_confirmed_at = now(),
         conversion_confirmed_by = auth.uid(),
         conversion_note = 'Corrected after issue (approved): ' || btrim(p_reason)
   WHERE id = v_line.id;

  UPDATE public.purchases p
     SET total_amount = (SELECT coalesce(sum(pi.total), 0) FROM public.purchase_items pi WHERE pi.purchase_id = p.id)
   WHERE p.id = v_purchase.id;

  INSERT INTO public.purchase_line_corrections
    (canteen_id, purchase_id, purchase_item_id, corrected_by, reason, old_values, new_values)
  VALUES (v_purchase.canteen_id, v_purchase.id, v_line.id, auth.uid(), btrim(p_reason), v_old, v_new)
  RETURNING id INTO v_correction_id;

  RETURN jsonb_build_object('corrected', true, 'issued_lot', true, 'correction_id', v_correction_id,
                            'old', v_old, 'new', v_new);
END;
$$;
REVOKE ALL ON FUNCTION public.apply_issued_purchase_line_change(uuid, numeric, numeric, text) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- Admin / Super Admin answers a request.
-- ------------------------------------------------------------
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
    VALUES (auth.uid(), 'purchase_change_rejected', 'purchase_item', v_req.purchase_item_id, v_req.canteen_id,
            jsonb_build_object('request_id', v_req.id, 'note', nullif(btrim(p_note), '')));
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

  UPDATE public.purchase_change_requests
     SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(),
         review_note = nullif(btrim(p_note), '')
   WHERE id = v_req.id;
  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'purchase_change_approved', 'purchase_item', v_req.purchase_item_id, v_req.canteen_id,
          jsonb_build_object('request_id', v_req.id, 'requested_by', v_req.requested_by,
                             'reason', v_req.reason, 'result', v_result));
  INSERT INTO public.notifications (canteen_id, target_user, title, body, link, ref_type, ref_id)
  VALUES (v_req.canteen_id, v_req.requested_by, 'Bill change approve hua',
          format('%s: ab %s %s @ ₹%s.', v_new->>'item_name', v_new->>'quantity', v_new->>'unit', v_new->>'rate'),
          '/purchases', 'purchase_change', v_req.id);
  RETURN jsonb_build_object('approved', true, 'result', v_result);
END;
$$;
REVOKE ALL ON FUNCTION public.review_purchase_line_change(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_purchase_line_change(uuid, boolean, text) TO authenticated;

-- ------------------------------------------------------------
-- Direct correction: Admin / Super Admin only from now on (the live body,
-- with only the permission check changed).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.correct_confirmed_purchase_line(p_purchase_item_id uuid, p_ingredient_id uuid DEFAULT NULL::uuid, p_new_item_name text DEFAULT NULL::text, p_new_category text DEFAULT 'Uncategorised'::text, p_new_unit text DEFAULT NULL::text, p_new_quantity numeric DEFAULT NULL::numeric, p_new_rate numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_line public.purchase_items%ROWTYPE;
  v_purchase public.purchases%ROWTYPE;
  v_old_ing public.ingredients%ROWTYPE;
  v_new_ing public.ingredients%ROWTYPE;
  v_old jsonb; v_new jsonb; v_old_qty numeric;
  v_batch_received numeric; v_batch_remaining numeric; v_batch_count integer;
  v_same_lines integer; v_old_balance numeric; v_new_balance numeric;
  v_received_at timestamptz; v_expiry date; v_new_total numeric;
  v_correction_id uuid;
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  -- From 13 Nov 2026 only Admin/Super Admin change a received bill directly;
  -- everyone else sends request_purchase_line_change() for their approval.
  IF NOT public.is_admin_editor() THEN
    RAISE EXCEPTION 'Received bill sirf Admin badal sakta hai. Change approval ke liye bhejein.';
  END IF;
  IF nullif(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'Correction ka reason likhna zaroori hai';
  END IF;
  IF p_new_quantity IS NULL OR p_new_quantity <= 0 THEN
    RAISE EXCEPTION 'Correct quantity zero se zyada honi chahiye';
  END IF;
  IF p_new_rate IS NULL OR p_new_rate < 0 THEN
    RAISE EXCEPTION 'Rate zero se kam nahi ho sakta';
  END IF;

  SELECT * INTO v_line FROM public.purchase_items
   WHERE id = p_purchase_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice item nahi mila'; END IF;
  SELECT * INTO v_purchase FROM public.purchases
   WHERE id = v_line.purchase_id FOR UPDATE;
  IF NOT FOUND OR v_purchase.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Sirf received/confirmed invoice sudhar sakte ho';
  END IF;
  IF NOT public.can_access_canteen(v_purchase.canteen_id) THEN
    RAISE EXCEPTION 'Aapko is site ka access nahi hai';
  END IF;
  IF v_line.ingredient_id IS NULL THEN
    RAISE EXCEPTION 'Is old line ka inventory item missing hai; Admin se correction karvao';
  END IF;

  SELECT * INTO v_old_ing FROM public.ingredients
   WHERE id = v_line.ingredient_id AND canteen_id = v_purchase.canteen_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Old inventory item nahi mila'; END IF;

  SELECT count(*) INTO v_same_lines FROM public.purchase_items
   WHERE purchase_id = v_line.purchase_id AND ingredient_id = v_line.ingredient_id;
  IF v_same_lines <> 1 THEN
    RAISE EXCEPTION 'Is bill me same inventory item ek se zyada line par hai; Admin review required';
  END IF;

  PERFORM 1 FROM public.ingredient_batches
   WHERE purchase_id = v_line.purchase_id AND ingredient_id = v_line.ingredient_id
   FOR UPDATE;
  SELECT count(*), coalesce(sum(qty_received), 0), coalesce(sum(qty_remaining), 0),
         min(received_at), max(expiry_date)
    INTO v_batch_count, v_batch_received, v_batch_remaining, v_received_at, v_expiry
    FROM public.ingredient_batches
   WHERE purchase_id = v_line.purchase_id AND ingredient_id = v_line.ingredient_id;

  v_old_qty := coalesce(v_line.stock_quantity, v_line.quantity);
  IF v_batch_count = 0 OR abs(v_batch_received - v_old_qty) > 0.000001 THEN
    RAISE EXCEPTION 'Is invoice line ka lot exact match nahi hua; Admin review required';
  END IF;
  IF abs(v_batch_remaining - v_batch_received) > 0.000001 THEN
    RAISE EXCEPTION 'Is item ka kuch maal kitchen issue ho chuka hai; purani consumption bachane ke liye Admin review required';
  END IF;
  IF v_old_ing.current_stock < v_old_qty THEN
    RAISE EXCEPTION 'Shelf stock old invoice quantity se kam hai; pehle physical count check karo';
  END IF;

  IF p_ingredient_id IS NOT NULL THEN
    SELECT * INTO v_new_ing FROM public.ingredients
     WHERE id = p_ingredient_id AND canteen_id = v_purchase.canteen_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Correct inventory item is site me nahi mila'; END IF;
    IF nullif(btrim(p_new_unit), '') IS NOT NULL
       AND lower(btrim(v_new_ing.unit)) <> lower(btrim(p_new_unit)) THEN
      RAISE EXCEPTION 'Selected item ki unit % hai; quantity usi unit me bharo', v_new_ing.unit;
    END IF;
  ELSE
    IF nullif(btrim(p_new_item_name), '') IS NULL OR nullif(btrim(p_new_unit), '') IS NULL THEN
      RAISE EXCEPTION 'Naye item ka naam aur unit dono bharo';
    END IF;
    SELECT * INTO v_new_ing FROM public.ingredients
     WHERE canteen_id = v_purchase.canteen_id
       AND lower(btrim(name)) = lower(btrim(p_new_item_name))
     LIMIT 1 FOR UPDATE;
    IF FOUND THEN RAISE EXCEPTION 'Ye item inventory me pehle se hai; existing item select karo'; END IF;
    PERFORM public.allow_stock_move();
    INSERT INTO public.ingredients
      (canteen_id, name, category, unit, current_stock, minimum_stock, cost_per_unit)
    VALUES
      (v_purchase.canteen_id, btrim(p_new_item_name),
       coalesce(nullif(btrim(p_new_category), ''), 'Uncategorised'),
       btrim(p_new_unit), 0, 0, p_new_rate)
    RETURNING * INTO v_new_ing;
  END IF;

  v_old := jsonb_build_object(
    'ingredient_id', v_line.ingredient_id, 'item_name', v_line.item_name,
    'quantity', v_line.quantity, 'stock_quantity', v_old_qty,
    'unit', v_line.unit, 'rate', v_line.rate, 'total', v_line.total);
  v_new_total := round(p_new_quantity * p_new_rate, 2);
  v_new := jsonb_build_object(
    'ingredient_id', v_new_ing.id, 'item_name', v_new_ing.name,
    'quantity', p_new_quantity, 'stock_quantity', p_new_quantity,
    'unit', v_new_ing.unit, 'rate', p_new_rate, 'total', v_new_total);

  PERFORM public.allow_stock_move();
  UPDATE public.ingredients SET current_stock = current_stock - v_old_qty, updated_at = now()
   WHERE id = v_old_ing.id RETURNING current_stock INTO v_old_balance;
  DELETE FROM public.ingredient_batches
   WHERE purchase_id = v_line.purchase_id AND ingredient_id = v_line.ingredient_id;
  UPDATE public.ingredients
     SET current_stock = current_stock + p_new_quantity,
         cost_per_unit = CASE WHEN p_new_rate > 0 THEN p_new_rate ELSE cost_per_unit END,
         updated_at = now()
   WHERE id = v_new_ing.id RETURNING current_stock INTO v_new_balance;
  INSERT INTO public.ingredient_batches
    (ingredient_id, canteen_id, supplier_id, purchase_id, qty_received,
     qty_remaining, rate, received_at, expiry_date)
  VALUES
    (v_new_ing.id, v_purchase.canteen_id, v_purchase.supplier_id,
     v_purchase.id, p_new_quantity, p_new_quantity, p_new_rate,
     coalesce(v_received_at, v_purchase.created_at), v_expiry);

  INSERT INTO public.stock_ledger
    (ingredient_id, canteen_id, change_qty, balance_after, reason,
     reference_type, reference_id, created_by, service_date, value)
  VALUES
    (v_old_ing.id, v_purchase.canteen_id, -v_old_qty, v_old_balance,
     'Invoice correction reverse — ' || v_line.item_name || ' — ' || btrim(p_reason),
     'purchase_correction', v_purchase.id, auth.uid(), v_today,
     -round(v_old_qty * v_line.rate, 2));
  INSERT INTO public.stock_ledger
    (ingredient_id, canteen_id, change_qty, balance_after, reason,
     reference_type, reference_id, created_by, service_date, value)
  VALUES
    (v_new_ing.id, v_purchase.canteen_id, p_new_quantity, v_new_balance,
     'Invoice correction add — ' || v_new_ing.name || ' — ' || btrim(p_reason),
     'purchase_correction', v_purchase.id, auth.uid(), v_today, v_new_total);

  UPDATE public.purchase_items
     SET ingredient_id = v_new_ing.id, item_name = v_new_ing.name,
         quantity = p_new_quantity, stock_quantity = p_new_quantity,
         unit = v_new_ing.unit, stock_unit = v_new_ing.unit,
         rate = p_new_rate, total = v_new_total, matched = true,
         conversion_confirmed = true, conversion_confirmed_at = now(),
         conversion_confirmed_by = auth.uid(),
         conversion_note = 'Corrected after receiving: ' || btrim(p_reason)
   WHERE id = v_line.id;
  UPDATE public.purchases p
     SET total_amount = (SELECT coalesce(sum(pi.total), 0)
                           FROM public.purchase_items pi WHERE pi.purchase_id = p.id)
   WHERE p.id = v_purchase.id;

  INSERT INTO public.purchase_line_corrections
    (canteen_id, purchase_id, purchase_item_id, corrected_by, reason, old_values, new_values)
  VALUES
    (v_purchase.canteen_id, v_purchase.id, v_line.id, auth.uid(),
     btrim(p_reason), v_old, v_new)
  RETURNING id INTO v_correction_id;
  INSERT INTO public.action_logs
    (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES
    (auth.uid(), 'confirmed_purchase_line_corrected', 'purchase_item', v_line.id,
     v_purchase.canteen_id,
     jsonb_build_object('purchase_id', v_purchase.id, 'reason', btrim(p_reason),
                        'old', v_old, 'new', v_new, 'correction_id', v_correction_id));
  INSERT INTO public.notifications
    (canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES
    (v_purchase.canteen_id, 'admin', 'Confirmed invoice corrected',
     format('%s %s @ ₹%s changed to %s %s @ ₹%s. Reason: %s',
            v_line.quantity, v_line.unit, v_line.rate,
            p_new_quantity, v_new_ing.unit, p_new_rate, btrim(p_reason)),
     '/purchases', 'purchase', v_purchase.id);

  RETURN jsonb_build_object('corrected', true, 'correction_id', v_correction_id,
                            'purchase_id', v_purchase.id, 'old', v_old, 'new', v_new);
END;
$function$;
