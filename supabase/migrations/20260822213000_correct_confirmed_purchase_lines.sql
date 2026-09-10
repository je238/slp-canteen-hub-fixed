-- Correct a confirmed invoice line without erasing the original bill or its history.
-- A line may be corrected only while the lot created by that line is untouched.

CREATE TABLE IF NOT EXISTS public.purchase_line_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canteen_id uuid NOT NULL REFERENCES public.canteens(id) ON DELETE CASCADE,
  purchase_id uuid NOT NULL REFERENCES public.purchases(id) ON DELETE CASCADE,
  purchase_item_id uuid NOT NULL REFERENCES public.purchase_items(id) ON DELETE CASCADE,
  corrected_by uuid REFERENCES auth.users(id),
  reason text NOT NULL,
  old_values jsonb NOT NULL,
  new_values jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchase_line_corrections_purchase
  ON public.purchase_line_corrections (purchase_id, created_at DESC);

ALTER TABLE public.purchase_line_corrections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchase_line_corrections_select ON public.purchase_line_corrections;
CREATE POLICY purchase_line_corrections_select
  ON public.purchase_line_corrections FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));

REVOKE ALL ON TABLE public.purchase_line_corrections FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.purchase_line_corrections TO authenticated;

CREATE OR REPLACE FUNCTION public.correct_confirmed_purchase_line(
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
  v_old_ing public.ingredients%ROWTYPE;
  v_new_ing public.ingredients%ROWTYPE;
  v_old jsonb;
  v_new jsonb;
  v_old_qty numeric;
  v_batch_received numeric;
  v_batch_remaining numeric;
  v_batch_count integer;
  v_same_lines integer;
  v_old_balance numeric;
  v_new_balance numeric;
  v_received_at timestamptz;
  v_expiry date;
  v_new_total numeric;
  v_correction_id uuid;
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF NOT public.can_receive_stock() THEN
    RAISE EXCEPTION 'Only the Store Keeper, Manager or Admin can correct a received invoice';
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
   WHERE id = v_line.ingredient_id AND canteen_id = v_purchase.canteen_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Old inventory item nahi mila'; END IF;

  -- Older receipts do not identify each lot by purchase_item_id. Refuse an
  -- ambiguous correction instead of guessing when the same item occurs twice.
  SELECT count(*) INTO v_same_lines FROM public.purchase_items
   WHERE purchase_id = v_line.purchase_id
     AND ingredient_id = v_line.ingredient_id;
  IF v_same_lines <> 1 THEN
    RAISE EXCEPTION 'Is bill me same inventory item ek se zyada line par hai; Admin review required';
  END IF;

  PERFORM 1 FROM public.ingredient_batches
   WHERE purchase_id = v_line.purchase_id
     AND ingredient_id = v_line.ingredient_id
   FOR UPDATE;

  SELECT count(*), coalesce(sum(qty_received), 0), coalesce(sum(qty_remaining), 0),
         min(received_at), max(expiry_date)
    INTO v_batch_count, v_batch_received, v_batch_remaining, v_received_at, v_expiry
    FROM public.ingredient_batches
   WHERE purchase_id = v_line.purchase_id
     AND ingredient_id = v_line.ingredient_id;

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
     WHERE id = p_ingredient_id AND canteen_id = v_purchase.canteen_id
     FOR UPDATE;
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
    IF FOUND THEN
      RAISE EXCEPTION 'Ye item inventory me pehle se hai; existing item select karo';
    END IF;

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

  UPDATE public.ingredients
     SET current_stock = current_stock - v_old_qty,
         updated_at = now()
   WHERE id = v_old_ing.id
   RETURNING current_stock INTO v_old_balance;

  DELETE FROM public.ingredient_batches
   WHERE purchase_id = v_line.purchase_id
     AND ingredient_id = v_line.ingredient_id;

  UPDATE public.ingredients
     SET current_stock = current_stock + p_new_quantity,
         cost_per_unit = CASE WHEN p_new_rate > 0 THEN p_new_rate ELSE cost_per_unit END,
         updated_at = now()
   WHERE id = v_new_ing.id
   RETURNING current_stock INTO v_new_balance;

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
     SET ingredient_id = v_new_ing.id,
         item_name = v_new_ing.name,
         quantity = p_new_quantity,
         stock_quantity = p_new_quantity,
         unit = v_new_ing.unit,
         stock_unit = v_new_ing.unit,
         rate = p_new_rate,
         total = v_new_total,
         matched = true,
         conversion_confirmed = true,
         conversion_confirmed_at = now(),
         conversion_confirmed_by = auth.uid(),
         conversion_note = 'Corrected after receiving: ' || btrim(p_reason)
   WHERE id = v_line.id;

  UPDATE public.purchases p
     SET total_amount = (SELECT coalesce(sum(pi.total), 0)
                           FROM public.purchase_items pi
                          WHERE pi.purchase_id = p.id)
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
$$;

REVOKE ALL ON FUNCTION public.correct_confirmed_purchase_line(
  uuid, uuid, text, text, text, numeric, numeric, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_confirmed_purchase_line(
  uuid, uuid, text, text, text, numeric, numeric, text
) TO authenticated;

