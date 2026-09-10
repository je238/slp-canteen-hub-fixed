-- ============================================================
-- ONE NOTICE PER RECEIPT, AND IT KNOWS WHAT IS ON IT
--
-- Two faults in what went in an hour ago, both mine.
--
-- First: the notice fired the moment the purchases row appeared, which is
-- before any of its lines exist — they are inserted in the loop that follows.
-- So every notice said "0 item(s)", which is worse than saying nothing: an
-- admin who reads "0 items, ₹5,44,392" twice learns to stop reading them.
--
-- Second: purchases already had trg_notify_purchase_ins from an earlier round
-- doing the same job less well. The admin was getting two notices for one
-- delivery. A control that cries twice is a control people mute.
--
-- So the older one goes, and the new one is raised at the END of the receipt
-- function, once the lines are actually there and can be counted.
--
-- Safe to re-run.
-- ============================================================

DROP TRIGGER IF EXISTS trg_notify_goods_received ON public.purchases;
DROP TRIGGER IF EXISTS trg_notify_purchase_ins ON public.purchases;
DROP TRIGGER IF EXISTS trg_notify_purchase_upd ON public.purchases;

CREATE OR REPLACE FUNCTION public.notify_goods_received(p_purchase_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p public.purchases%ROWTYPE; v_lines INT; v_supplier TEXT; v_items TEXT;
BEGIN
  SELECT * INTO p FROM public.purchases WHERE id = p_purchase_id;
  IF NOT FOUND OR p.status <> 'confirmed' THEN RETURN; END IF;

  -- The biggest few lines by value, so the admin can tell at a glance whether
  -- this is the delivery they were expecting without opening anything.
  SELECT string_agg(item_name || ' ' || quantity || coalesce(unit, ''), ', ' ORDER BY total DESC)
    INTO v_items
  FROM (SELECT item_name, quantity, unit, total FROM public.purchase_items
         WHERE purchase_id = p_purchase_id ORDER BY total DESC LIMIT 4) top;

  SELECT count(*) INTO v_lines FROM public.purchase_items WHERE purchase_id = p_purchase_id;
  SELECT name INTO v_supplier FROM public.suppliers WHERE id = p.supplier_id;

  INSERT INTO public.notifications
    (canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES (
    p.canteen_id, 'admin',
    CASE WHEN p.invoice_image_url IS NULL
         THEN format('Goods received — ₹%s, NO BILL PHOTO', round(coalesce(p.total_amount, 0)))
         ELSE format('Goods received — ₹%s', round(coalesce(p.total_amount, 0)))
    END,
    format('%s item(s) from %s: %s. %s',
           coalesce(v_lines, 0),
           coalesce(v_supplier, 'an unnamed vendor'),
           coalesce(v_items, '—'),
           CASE
             WHEN p.invoice_image_url IS NULL
               THEN 'No photo of the bill was attached — worth asking why before this is settled.'
             WHEN p.stated_total IS NOT NULL
                  AND abs(p.stated_total - coalesce(p.total_amount, 0)) > 0.5
               THEN format('The bill claims ₹%s but the lines received add to ₹%s. Check the photo.',
                           round(p.stated_total), round(p.total_amount))
             ELSE 'Photo of the bill is attached.'
           END),
    '/purchases', 'purchase', p.id);
END;
$$;
REVOKE ALL ON FUNCTION public.notify_goods_received(UUID) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.notify_goods_received();

-- Raised at the end of the receipt, once the lines exist to be counted.
CREATE OR REPLACE FUNCTION public.add_stock_from_invoice(
  p_canteen_id UUID, p_supplier_id UUID, p_items JSONB,
  p_notes TEXT DEFAULT NULL, p_image_path TEXT DEFAULT NULL, p_total NUMERIC DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_purchase UUID; v_line RECORD; v_ing UUID; v_new NUMERIC;
  v_created INT := 0; v_topped INT := 0; v_sum NUMERIC := 0;
  v_today DATE := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF NOT public.can_receive_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can take stock in';
  END IF;
  IF NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;
  PERFORM public.allow_stock_move();

  SELECT coalesce(sum((e->>'total')::numeric), 0) INTO v_sum
  FROM jsonb_array_elements(p_items) e;

  INSERT INTO public.purchases
    (canteen_id, supplier_id, total_amount, stated_total, notes, invoice_image_url,
     status, approved_at, created_by)
  VALUES (p_canteen_id, p_supplier_id, v_sum, p_total, p_notes, p_image_path,
          'confirmed', now(), auth.uid())
  RETURNING id INTO v_purchase;

  FOR v_line IN
    SELECT nullif(btrim(e->>'name'), '') AS name,
           coalesce((e->>'quantity')::numeric, 0) AS qty,
           coalesce(nullif(e->>'unit', ''), 'kg') AS unit,
           coalesce((e->>'rate')::numeric, 0) AS rate,
           coalesce((e->>'total')::numeric, 0) AS total,
           coalesce(nullif(e->>'category', ''), 'Uncategorised') AS category
    FROM jsonb_array_elements(p_items) e
  LOOP
    CONTINUE WHEN v_line.name IS NULL OR v_line.qty <= 0;

    SELECT id INTO v_ing FROM public.ingredients
    WHERE canteen_id = p_canteen_id AND lower(btrim(name)) = lower(v_line.name) LIMIT 1;

    IF v_ing IS NULL THEN
      INSERT INTO public.ingredients
        (canteen_id, name, category, unit, current_stock, minimum_stock, cost_per_unit)
      VALUES (p_canteen_id, v_line.name, v_line.category, v_line.unit, 0, 0, v_line.rate)
      RETURNING id INTO v_ing;
      v_created := v_created + 1;
    ELSE
      v_topped := v_topped + 1;
    END IF;

    UPDATE public.ingredients
      SET current_stock = current_stock + v_line.qty,
          cost_per_unit = CASE WHEN v_line.rate > 0 THEN v_line.rate ELSE cost_per_unit END
      WHERE id = v_ing RETURNING current_stock INTO v_new;

    INSERT INTO public.purchase_items
      (purchase_id, item_name, quantity, unit, rate, total, ingredient_id)
    VALUES (v_purchase, v_line.name, v_line.qty, v_line.unit, v_line.rate, v_line.total, v_ing);

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason,
       reference_type, reference_id, created_by, service_date, value)
    VALUES (v_ing, p_canteen_id, v_line.qty, v_new,
            'Invoice stock-in — ' || v_line.name, 'purchase', v_purchase, auth.uid(),
            v_today, round(v_line.qty * v_line.rate, 2));

    INSERT INTO public.ingredient_batches
      (ingredient_id, canteen_id, supplier_id, purchase_id, qty_received, qty_remaining, rate)
    VALUES (v_ing, p_canteen_id, p_supplier_id, v_purchase, v_line.qty, v_line.qty, v_line.rate);
  END LOOP;

  -- Now the lines exist, so the admin can be told what actually arrived.
  PERFORM public.notify_goods_received(v_purchase);

  RETURN jsonb_build_object(
    'purchase_id', v_purchase, 'new_items', v_created, 'existing_items', v_topped,
    'total', v_sum, 'stated_total', p_total,
    'mismatch', CASE WHEN p_total IS NOT NULL AND abs(p_total - v_sum) > 0.5
                     THEN round(p_total - v_sum, 2) END);
END;
$$;
