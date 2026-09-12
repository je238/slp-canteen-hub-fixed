-- Admin-only rate correction for confirmed purchase lines whose stock has
-- already been issued. Quantity, item and shelf balance remain unchanged.
CREATE OR REPLACE FUNCTION public.correct_consumed_purchase_line_rate(
  p_purchase_item_id uuid,
  p_new_rate numeric,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_line public.purchase_items%ROWTYPE;
  v_purchase public.purchases%ROWTYPE;
  v_ingredient public.ingredients%ROWTYPE;
  v_old jsonb;
  v_new jsonb;
  v_received numeric;
  v_remaining numeric;
  v_consumed numeric;
  v_new_total numeric;
  v_purchase_delta numeric;
  v_consumed_value_delta numeric;
  v_correction_id uuid;
BEGIN
  IF NOT public.is_admin_editor() THEN
    RAISE EXCEPTION 'Only Admin can change the rate after stock has gone to the kitchen';
  END IF;
  IF nullif(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'Correction ka reason likhna zaroori hai';
  END IF;
  IF p_new_rate IS NULL OR p_new_rate < 0 THEN
    RAISE EXCEPTION 'Rate zero se kam nahi ho sakta';
  END IF;

  SELECT * INTO v_line
    FROM public.purchase_items
   WHERE id = p_purchase_item_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice item nahi mila';
  END IF;

  SELECT * INTO v_purchase
    FROM public.purchases
   WHERE id = v_line.purchase_id
   FOR UPDATE;
  IF NOT FOUND OR v_purchase.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Sirf received/confirmed invoice ka rate sudhar sakte ho';
  END IF;
  IF NOT public.can_access_canteen(v_purchase.canteen_id) THEN
    RAISE EXCEPTION 'Aapko is site ka access nahi hai';
  END IF;
  IF v_line.ingredient_id IS NULL THEN
    RAISE EXCEPTION 'Is invoice line ka inventory item missing hai';
  END IF;

  SELECT * INTO v_ingredient
    FROM public.ingredients
   WHERE id = v_line.ingredient_id
     AND canteen_id = v_purchase.canteen_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory item nahi mila';
  END IF;

  PERFORM 1
    FROM public.ingredient_batches
   WHERE purchase_id = v_purchase.id
     AND ingredient_id = v_line.ingredient_id
   FOR UPDATE;

  SELECT coalesce(sum(qty_received), 0), coalesce(sum(qty_remaining), 0)
    INTO v_received, v_remaining
    FROM public.ingredient_batches
   WHERE purchase_id = v_purchase.id
     AND ingredient_id = v_line.ingredient_id;

  IF v_received <= 0
     OR abs(v_received - coalesce(v_line.stock_quantity, v_line.quantity)) > 0.000001 THEN
    RAISE EXCEPTION 'Is invoice line ka lot exact match nahi hua; Admin review required';
  END IF;

  IF v_remaining >= v_received - 0.000001 THEN
    RAISE EXCEPTION 'Lot abhi untouched hai; normal invoice correction use karo';
  END IF;

  IF p_new_rate = coalesce(v_line.rate, 0) THEN
    RETURN jsonb_build_object('corrected', false, 'reason', 'rate_unchanged');
  END IF;

  v_consumed := greatest(v_received - v_remaining, 0);
  v_new_total := round(coalesce(v_line.quantity, 0) * p_new_rate, 2);
  v_purchase_delta := v_new_total - coalesce(v_line.total, 0);
  v_consumed_value_delta := round(v_consumed * (p_new_rate - coalesce(v_line.rate, 0)), 2);

  v_old := jsonb_build_object(
    'ingredient_id', v_line.ingredient_id,
    'item_name', v_line.item_name,
    'quantity', v_line.quantity,
    'stock_quantity', v_line.stock_quantity,
    'unit', v_line.unit,
    'rate', v_line.rate,
    'total', v_line.total,
    'lot_received', v_received,
    'lot_remaining', v_remaining,
    'lot_consumed', v_consumed
  );
  v_new := jsonb_build_object(
    'ingredient_id', v_line.ingredient_id,
    'item_name', v_line.item_name,
    'quantity', v_line.quantity,
    'stock_quantity', v_line.stock_quantity,
    'unit', v_line.unit,
    'rate', p_new_rate,
    'total', v_new_total,
    'lot_received', v_received,
    'lot_remaining', v_remaining,
    'lot_consumed', v_consumed,
    'consumed_value_delta', v_consumed_value_delta,
    'rate_only', true
  );

  PERFORM public.allow_stock_move();

  UPDATE public.purchase_items
     SET rate = p_new_rate,
         total = v_new_total,
         conversion_confirmed = true,
         conversion_confirmed_at = now(),
         conversion_confirmed_by = auth.uid(),
         conversion_note = 'Admin rate correction after issue: ' || btrim(p_reason)
   WHERE id = v_line.id;

  UPDATE public.ingredient_batches
     SET rate = p_new_rate
   WHERE purchase_id = v_purchase.id
     AND ingredient_id = v_line.ingredient_id;

  UPDATE public.purchases p
     SET total_amount = (
       SELECT coalesce(sum(pi.total), 0)
         FROM public.purchase_items pi
        WHERE pi.purchase_id = p.id
     )
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
    (auth.uid(), 'consumed_purchase_line_rate_corrected', 'purchase_item', v_line.id,
     v_purchase.canteen_id,
     jsonb_build_object(
       'purchase_id', v_purchase.id,
       'reason', btrim(p_reason),
       'old_rate', v_line.rate,
       'new_rate', p_new_rate,
       'purchase_delta', v_purchase_delta,
       'consumed_qty', v_consumed,
       'consumed_value_delta', v_consumed_value_delta,
       'correction_id', v_correction_id
     ));

  INSERT INTO public.notifications
    (canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES
    (v_purchase.canteen_id, 'admin', 'Issued purchase rate corrected',
     format('%s: %s %s ka rate ₹%s se ₹%s hua. Stock quantity nahi badli. Reason: %s',
            v_line.item_name, v_line.quantity, v_line.unit,
            coalesce(v_line.rate, 0), p_new_rate, btrim(p_reason)),
     '/purchases', 'purchase', v_purchase.id);

  RETURN jsonb_build_object(
    'corrected', true,
    'rate_only', true,
    'correction_id', v_correction_id,
    'purchase_id', v_purchase.id,
    'old_rate', v_line.rate,
    'new_rate', p_new_rate,
    'purchase_delta', v_purchase_delta,
    'consumed_qty', v_consumed,
    'consumed_value_delta', v_consumed_value_delta
  );
END;
$$;

REVOKE ALL ON FUNCTION public.correct_consumed_purchase_line_rate(uuid, numeric, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_consumed_purchase_line_rate(uuid, numeric, text)
  TO authenticated;

COMMENT ON FUNCTION public.correct_consumed_purchase_line_rate(uuid, numeric, text) IS
  'Admin-only audited rate correction for an already-issued confirmed purchase lot. Does not change quantity or shelf stock.';
