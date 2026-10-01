-- ============================================================
-- GOODS WITHOUT A BILL TAKE THE LAST BILLED RATE, AND THE STORE KEEPER
-- SEES EVERY BILL STILL OWED AND EVERY MISTAKE ON A BILL
--
-- 1. Rate until the bill comes. receive_stock_without_bill() valued goods at
--    ingredients.cost_per_unit, a field nobody keeps current: on 3 Sept 72 L
--    of Amul Gold went in at ₹70/L when the bills said about ₹46. Now the
--    provisional rate is the item's last rate on a REAL bill (not another
--    no-bill guess); failing that, the last purchase rate, the lots, the
--    standard cost. Only an item that has never been priced takes the rate
--    the store keeper types, and if none is typed the line says so.
--    The bill, when it comes, still finalises the rate as before.
--
-- 2. store_bill_desk(site) — for the store keeper's dashboard:
--      pending   bills not yet received, oldest first, with days waiting
--      unfinal   bill paper attached but rates not yet finalised
--      mistakes  the last 30 days of problems on bills: total ≠ lines+GST,
--                a line an admin had to correct, a rate 20%+ above the last
--                bill, a line not matched to a store item, no vendor
--    The same checks the admin's Executive Alerts make, now shown to the
--    person who can fix them.
--
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.provisional_rate(p_ingredient_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(
    (SELECT pi.rate FROM public.purchase_items pi
       JOIN public.purchases p ON p.id = pi.purchase_id
      WHERE pi.ingredient_id = p_ingredient_id AND p.status = 'confirmed' AND pi.rate > 0
        AND coalesce(p.bill_status, 'received') <> 'pending'
        AND (p.notes IS NULL OR p.notes NOT ILIKE 'NO BILL%' OR p.bill_finalized_at IS NOT NULL)
      ORDER BY p.created_at DESC LIMIT 1),
    nullif(public.item_replacement_rate(p_ingredient_id), 0),
    0);
$$;
REVOKE ALL ON FUNCTION public.provisional_rate(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.provisional_rate(uuid) TO authenticated;

-- What the no-bill screen shows before saving: the rate each item will take
-- and the date of the bill it came from.
CREATE OR REPLACE FUNCTION public.no_bill_rate_preview(p_canteen_id uuid, p_ingredient_ids uuid[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(jsonb_object_agg(i.id, jsonb_build_object(
           'rate', round(public.provisional_rate(i.id), 2),
           'from', (SELECT (p.created_at AT TIME ZONE 'Asia/Kolkata')::date
                      FROM public.purchase_items pi JOIN public.purchases p ON p.id = pi.purchase_id
                     WHERE pi.ingredient_id = i.id AND p.status = 'confirmed' AND pi.rate > 0
                       AND coalesce(p.bill_status, 'received') <> 'pending'
                       AND (p.notes IS NULL OR p.notes NOT ILIKE 'NO BILL%' OR p.bill_finalized_at IS NOT NULL)
                     ORDER BY p.created_at DESC LIMIT 1))), '{}'::jsonb)
    FROM public.ingredients i
   WHERE i.canteen_id = p_canteen_id AND i.id = ANY (p_ingredient_ids)
     AND public.can_access_canteen(p_canteen_id);
$$;
REVOKE ALL ON FUNCTION public.no_bill_rate_preview(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.no_bill_rate_preview(uuid, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.receive_stock_without_bill(
  p_canteen_id UUID,
  p_supplier_id UUID,
  p_items JSONB,          -- [{ingredient_id, quantity, rate?}] rate used only for a never-priced item
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_purchase UUID;
  v_line RECORD;
  v_ing public.ingredients%ROWTYPE;
  v_new NUMERIC;
  v_rate NUMERIC;
  v_sum NUMERIC := 0;
  v_count INT := 0;
  v_unpriced INT := 0;
  v_today DATE := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF NOT public.can_receive_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can receive goods without a bill';
  END IF;
  IF NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one received item';
  END IF;

  INSERT INTO public.purchases
    (canteen_id, supplier_id, total_amount, stated_total, notes,
     invoice_image_url, status, approved_at, created_by, bill_status)
  VALUES
    (p_canteen_id, p_supplier_id, 0, NULL,
     concat('NO BILL — ', coalesce(nullif(btrim(p_notes), ''), 'bill will be attached later')),
     NULL, 'confirmed', now(), auth.uid(), 'pending')
  RETURNING id INTO v_purchase;

  PERFORM public.allow_stock_move();

  FOR v_line IN
    SELECT (e->>'ingredient_id')::uuid AS ingredient_id,
           coalesce((e->>'quantity')::numeric, 0) AS qty,
           nullif(e->>'rate', '')::numeric AS typed_rate
    FROM jsonb_array_elements(p_items) e
  LOOP
    CONTINUE WHEN v_line.qty <= 0;

    SELECT * INTO v_ing
    FROM public.ingredients
    WHERE id = v_line.ingredient_id AND canteen_id = p_canteen_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Choose an inventory item from this site';
    END IF;

    -- The last billed rate; a typed rate only for an item never priced.
    v_rate := public.provisional_rate(v_ing.id);
    IF coalesce(v_rate, 0) = 0 THEN
      v_rate := greatest(coalesce(v_line.typed_rate, 0), 0);
      IF v_rate = 0 THEN v_unpriced := v_unpriced + 1; END IF;
    END IF;

    UPDATE public.ingredients
       SET current_stock = current_stock + v_line.qty
     WHERE id = v_ing.id
     RETURNING current_stock INTO v_new;

    INSERT INTO public.purchase_items
      (purchase_id, item_name, quantity, unit, rate, total, ingredient_id)
    VALUES
      (v_purchase, v_ing.name, v_line.qty, v_ing.unit, v_rate,
       round(v_line.qty * v_rate, 2), v_ing.id);

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason,
       reference_type, reference_id, created_by, service_date, value)
    VALUES
      (v_ing.id, p_canteen_id, v_line.qty, v_new,
       'No-bill stock-in — ' || v_ing.name,
       'purchase', v_purchase, auth.uid(), v_today,
       round(v_line.qty * v_rate, 2));

    INSERT INTO public.ingredient_batches
      (ingredient_id, canteen_id, supplier_id, purchase_id,
       qty_received, qty_remaining, rate)
    VALUES
      (v_ing.id, p_canteen_id, p_supplier_id, v_purchase,
       v_line.qty, v_line.qty, v_rate);

    v_sum := v_sum + round(v_line.qty * v_rate, 2);
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN RAISE EXCEPTION 'Add at least one positive quantity'; END IF;

  UPDATE public.purchases SET total_amount = v_sum WHERE id = v_purchase;

  PERFORM public.notify_goods_received(v_purchase);
  RETURN jsonb_build_object(
    'purchase_id', v_purchase,
    'items_received', v_count,
    'provisional_value', v_sum,
    'unpriced_items', v_unpriced,
    'bill_status', 'pending'
  );
END;
$$;
REVOKE ALL ON FUNCTION public.receive_stock_without_bill(UUID, UUID, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_stock_without_bill(UUID, UUID, JSONB, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.store_bill_desk(p_canteen_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_since timestamptz := now() - interval '30 days';
  v_pending jsonb; v_unfinal jsonb; v_mistakes jsonb;
BEGIN
  IF NOT public.can_access_canteen(p_canteen_id) THEN RAISE EXCEPTION 'You do not have access to this site'; END IF;

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'date'), '[]'::jsonb) INTO v_pending FROM (
    SELECT jsonb_build_object(
      'purchase_id', p.id, 'date', (p.created_at AT TIME ZONE 'Asia/Kolkata')::date,
      'days', v_today - (p.created_at AT TIME ZONE 'Asia/Kolkata')::date,
      'vendor', coalesce(s.name, 'Vendor nahi dala'), 'value', round(coalesce(p.total_amount, 0), 2),
      'items', (SELECT string_agg(pi.item_name || ' ' || trim(to_char(pi.quantity, 'FM999990.###')) || ' ' || pi.unit, ', ' ORDER BY pi.total DESC)
                  FROM public.purchase_items pi WHERE pi.purchase_id = p.id),
      'unpriced', (SELECT count(*) FROM public.purchase_items pi WHERE pi.purchase_id = p.id AND coalesce(pi.rate, 0) = 0)) x
      FROM public.purchases p LEFT JOIN public.suppliers s ON s.id = p.supplier_id
     WHERE p.canteen_id = p_canteen_id AND p.status = 'confirmed' AND p.bill_status = 'pending') q;

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'date'), '[]'::jsonb) INTO v_unfinal FROM (
    SELECT jsonb_build_object(
      'purchase_id', p.id, 'date', (p.created_at AT TIME ZONE 'Asia/Kolkata')::date,
      'days', v_today - (p.created_at AT TIME ZONE 'Asia/Kolkata')::date,
      'vendor', coalesce(s.name, 'Vendor nahi dala'), 'value', round(coalesce(p.total_amount, 0), 2)) x
      FROM public.purchases p LEFT JOIN public.suppliers s ON s.id = p.supplier_id
     WHERE p.canteen_id = p_canteen_id AND p.status = 'confirmed'
       AND coalesce(p.bill_status, 'received') <> 'pending'
       AND p.notes ILIKE 'NO BILL%' AND p.bill_finalized_at IS NULL) q;

  WITH recent AS (
    SELECT p.*, s.name AS vendor
      FROM public.purchases p LEFT JOIN public.suppliers s ON s.id = p.supplier_id
     WHERE p.canteen_id = p_canteen_id AND p.status = 'confirmed' AND p.created_at >= v_since
  ), lines AS (
    SELECT r.id AS purchase_id, r.created_at, r.vendor, pi.*
      FROM recent r JOIN public.purchase_items pi ON pi.purchase_id = r.id
  ), m AS (
    -- the bill's own total does not equal its lines + GST + charges
    SELECT r.created_at AS at, 'total_mismatch' AS kind, r.id AS purchase_id, coalesce(r.vendor, 'Vendor nahi dala') AS vendor,
           NULL::text AS item,
           format('Bill par total ₹%s, items + GST ₹%s — ₹%s ka farak',
             to_char(round(r.stated_total), 'FM99,99,990'),
             to_char(round(t.lines + coalesce(r.tax_amount, 0) + coalesce(r.other_charges, 0)), 'FM99,99,990'),
             to_char(round(abs(r.stated_total - (t.lines + coalesce(r.tax_amount, 0) + coalesce(r.other_charges, 0)))), 'FM99,99,990')) AS detail,
           abs(r.stated_total - (t.lines + coalesce(r.tax_amount, 0) + coalesce(r.other_charges, 0))) AS impact
      FROM recent r
      CROSS JOIN LATERAL (SELECT coalesce(sum(total), 0) AS lines FROM public.purchase_items WHERE purchase_id = r.id) t
     WHERE r.stated_total IS NOT NULL
       AND abs(r.stated_total - (t.lines + coalesce(r.tax_amount, 0) + coalesce(r.other_charges, 0))) > 1
    UNION ALL
    -- an admin had to correct one of the store keeper's lines
    SELECT c.created_at, 'corrected', c.purchase_id, coalesce(s.name, 'Vendor nahi dala'),
           coalesce(c.new_values->>'item_name', c.old_values->>'item_name', pi.item_name),
           format('Admin ne sudhaara: %s → %s. Wajah: %s',
             concat_ws(' × ₹', c.old_values->>'quantity', c.old_values->>'rate'),
             concat_ws(' × ₹', c.new_values->>'quantity', c.new_values->>'rate'), c.reason),
           NULL::numeric
      FROM public.purchase_line_corrections c
      JOIN public.purchases p ON p.id = c.purchase_id
      LEFT JOIN public.suppliers s ON s.id = p.supplier_id
      LEFT JOIN public.purchase_items pi ON pi.id = c.purchase_item_id
     WHERE c.canteen_id = p_canteen_id AND c.created_at >= v_since
    UNION ALL
    -- a rate 20%+ above the item's previous billed rate
    SELECT l.created_at, 'rate_jump', l.purchase_id, coalesce(l.vendor, 'Vendor nahi dala'), l.item_name,
           format('Rate ₹%s/%s, pichhla bill ₹%s — %s%% zyada', round(l.rate, 2), l.unit, round(prev.rate, 2),
                  round((l.rate / prev.rate - 1) * 100)),
           (l.rate - prev.rate) * l.quantity
      FROM lines l
      CROSS JOIN LATERAL (
        SELECT pi.rate FROM public.purchase_items pi JOIN public.purchases p ON p.id = pi.purchase_id
         WHERE pi.ingredient_id = l.ingredient_id AND p.status = 'confirmed' AND pi.rate > 0
           AND p.created_at < l.created_at
         ORDER BY p.created_at DESC LIMIT 1) prev
     WHERE l.ingredient_id IS NOT NULL AND l.rate > prev.rate * 1.2
    UNION ALL
    -- a line the app could not tie to a store item
    SELECT l.created_at, 'unmatched', l.purchase_id, coalesce(l.vendor, 'Vendor nahi dala'), l.item_name,
           'Ye line kisi store item se nahi judi — sahi item chuno', l.total
      FROM lines l WHERE l.ingredient_id IS NULL OR l.matched IS FALSE
    UNION ALL
    -- no vendor on the bill
    SELECT r.created_at, 'no_vendor', r.id, 'Vendor nahi dala', NULL,
           format('₹%s ka bill bina vendor ke chadha — vendor chuno', to_char(round(coalesce(r.total_amount, 0)), 'FM99,99,990')),
           r.total_amount
      FROM recent r WHERE r.supplier_id IS NULL
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'at', m.at, 'date', (m.at AT TIME ZONE 'Asia/Kolkata')::date, 'kind', m.kind,
           'purchase_id', m.purchase_id, 'vendor', m.vendor, 'item', m.item, 'detail', m.detail,
           'impact', round(coalesce(m.impact, 0), 2)) ORDER BY m.at DESC), '[]'::jsonb)
    INTO v_mistakes FROM m;

  RETURN jsonb_build_object(
    'pending', v_pending,
    'pending_count', jsonb_array_length(v_pending),
    'pending_value', (SELECT coalesce(round(sum((x->>'value')::numeric), 2), 0) FROM jsonb_array_elements(v_pending) x),
    'pending_oldest_days', (SELECT max((x->>'days')::int) FROM jsonb_array_elements(v_pending) x),
    'pending_over_3_days', (SELECT count(*) FROM jsonb_array_elements(v_pending) x WHERE (x->>'days')::int > 3),
    'unfinal', v_unfinal,
    'mistakes', v_mistakes);
END;
$$;
REVOKE ALL ON FUNCTION public.store_bill_desk(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_bill_desk(uuid) TO authenticated;
