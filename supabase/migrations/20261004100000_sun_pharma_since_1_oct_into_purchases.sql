-- ============================================================
-- ONE-OFF: SUN PHARMA GOODS SINCE 1 OCT INTO EICHER'S PURCHASES
--
-- The owner asked (4 Oct 2026) that everything borrowed from Sun Pharma from
-- 1 Oct on be an Eicher purchase, as the rule of 20261003100000 makes it for
-- new transfers. These transfers are already in stock — each has its
-- central_kitchen_in ledger row and its CK-<n> lot — so stock is not touched;
-- only the purchase is written, on the day the goods came, for what Eicher
-- kept (received less already given back). A transfer given back in full
-- gets no purchase, exactly as a give-back now shrinks one.
--
-- Safe to re-run: a transfer that already has its purchase is skipped.
-- ============================================================
DO $$
DECLARE t record; l record; v_purchase uuid; v_total numeric; v_at timestamptz; n int := 0;
BEGIN
  PERFORM public.allow_stock_move();
  FOR t IN
    SELECT ct.* FROM public.central_kitchen_transfers ct
     WHERE ct.direction = 'in' AND ct.purchase_id IS NULL AND ct.transfer_date >= DATE '2026-10-01'
       AND ct.canteen_id <> coalesce(public.sun_pharma_site(), '00000000-0000-0000-0000-000000000000'::uuid)
     ORDER BY ct.transfer_no
  LOOP
    SELECT coalesce(sum(round((i.qty_received - i.qty_returned) * i.rate, 2)), 0) INTO v_total
      FROM public.central_kitchen_transfer_items i WHERE i.transfer_id = t.id AND i.qty_received - i.qty_returned > 0.0005;
    CONTINUE WHEN v_total <= 0;

    SELECT min(created_at) INTO v_at FROM public.stock_ledger
     WHERE reference_id = t.id AND reference_type = 'central_kitchen_in';
    v_at := coalesce(v_at, t.created_at);

    INSERT INTO public.purchases
      (canteen_id, supplier_id, total_amount, notes, status, approved_at, created_at, created_by, bill_status, source)
    VALUES
      (t.canteen_id, public.sun_pharma_supplier(t.canteen_id), v_total,
       format('SUN PHARMA se aaya — transfer #%s (1 Oct se purchase mein joda)', t.transfer_no),
       'confirmed', v_at, v_at, t.received_by, 'received', 'sun_pharma_in')
    RETURNING id INTO v_purchase;

    FOR l IN
      SELECT i.*, g.name, g.unit AS ing_unit FROM public.central_kitchen_transfer_items i
        JOIN public.ingredients g ON g.id = i.ingredient_id
       WHERE i.transfer_id = t.id AND i.qty_received - i.qty_returned > 0.0005
    LOOP
      INSERT INTO public.purchase_items (purchase_id, item_name, quantity, unit, rate, total, ingredient_id, matched)
      VALUES (v_purchase, l.name, l.qty_received - l.qty_returned, l.ing_unit, l.rate,
              round((l.qty_received - l.qty_returned) * l.rate, 2), l.ingredient_id, true);
    END LOOP;

    UPDATE public.central_kitchen_transfers SET purchase_id = v_purchase WHERE id = t.id;
    UPDATE public.ingredient_batches SET purchase_id = v_purchase
     WHERE canteen_id = t.canteen_id AND batch_no = 'CK-' || t.transfer_no::text AND purchase_id IS NULL;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'Sun Pharma purchases written: %', n;
END $$;

-- A Sun Pharma transfer rate is typed by the store keeper, not billed by a
-- vendor: the no-bill rate looks only at real vendor bills.
CREATE OR REPLACE FUNCTION public.provisional_rate(p_ingredient_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(
    (SELECT pi.rate FROM public.purchase_items pi
       JOIN public.purchases p ON p.id = pi.purchase_id
      WHERE pi.ingredient_id = p_ingredient_id AND p.status = 'confirmed' AND pi.rate > 0
        AND coalesce(p.bill_status, 'received') <> 'pending'
        AND coalesce(p.source, 'vendor') = 'vendor'
        AND (p.notes IS NULL OR p.notes NOT ILIKE 'NO BILL%' OR p.bill_finalized_at IS NOT NULL)
      ORDER BY p.created_at DESC LIMIT 1),
    nullif(public.item_replacement_rate(p_ingredient_id), 0),
    0);
$$;

CREATE OR REPLACE FUNCTION public.no_bill_rate_preview(p_canteen_id uuid, p_ingredient_ids uuid[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(jsonb_object_agg(i.id, jsonb_build_object(
           'rate', round(public.provisional_rate(i.id), 2),
           'from', (SELECT (p.created_at AT TIME ZONE 'Asia/Kolkata')::date
                      FROM public.purchase_items pi JOIN public.purchases p ON p.id = pi.purchase_id
                     WHERE pi.ingredient_id = i.id AND p.status = 'confirmed' AND pi.rate > 0
                       AND coalesce(p.bill_status, 'received') <> 'pending'
                       AND coalesce(p.source, 'vendor') = 'vendor'
                       AND (p.notes IS NULL OR p.notes NOT ILIKE 'NO BILL%' OR p.bill_finalized_at IS NOT NULL)
                     ORDER BY p.created_at DESC LIMIT 1))), '{}'::jsonb)
    FROM public.ingredients i
   WHERE i.canteen_id = p_canteen_id AND i.id = ANY (p_ingredient_ids)
     AND public.can_access_canteen(p_canteen_id);
$$;

