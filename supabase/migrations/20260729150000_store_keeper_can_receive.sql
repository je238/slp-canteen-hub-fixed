-- ============================================================
-- THE STORE KEEPER MUST BE ABLE TO TAKE STOCK IN
--
-- add_stock_from_invoice ran as the caller, and `purchases` /
-- `ingredients` are manager-write only — so the one role whose whole job
-- is receiving goods got "row violates row-level security policy".
--
-- Rather than handing store keepers blanket write access to those tables,
-- the RPC becomes the sanctioned path: it runs as definer and checks the
-- caller itself. The check is duty-based (store keeper OR manager+), not
-- rank-based, so the chef still cannot receive stock.
--
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.can_receive_stock()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_store_keeper() OR public.is_manager_or_above();
$$;
REVOKE ALL ON FUNCTION public.can_receive_stock() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_receive_stock() TO authenticated;

CREATE OR REPLACE FUNCTION public.add_stock_from_invoice(
  p_canteen_id  UUID,
  p_supplier_id UUID,
  p_items       JSONB,
  p_notes       TEXT DEFAULT NULL,
  p_image_path  TEXT DEFAULT NULL,
  p_total       NUMERIC DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_purchase UUID; v_line RECORD; v_ing UUID; v_new NUMERIC;
  v_created INT := 0; v_topped INT := 0; v_sum NUMERIC := 0;
BEGIN
  -- definer rights, so the gate lives here
  IF NOT public.can_receive_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can take stock in';
  END IF;
  IF NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  SELECT coalesce(sum((e->>'total')::numeric), 0) INTO v_sum
  FROM jsonb_array_elements(p_items) e;

  INSERT INTO public.purchases
    (canteen_id, supplier_id, total_amount, notes, invoice_image_url, status, approved_at, created_by)
  VALUES
    (p_canteen_id, p_supplier_id, coalesce(p_total, v_sum), p_notes, p_image_path,
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
    WHERE canteen_id = p_canteen_id AND lower(btrim(name)) = lower(v_line.name)
    LIMIT 1;

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
      WHERE id = v_ing
      RETURNING current_stock INTO v_new;

    INSERT INTO public.purchase_items
      (purchase_id, item_name, quantity, unit, rate, total, ingredient_id)
    VALUES (v_purchase, v_line.name, v_line.qty, v_line.unit, v_line.rate, v_line.total, v_ing);

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, reference_id, created_by)
    VALUES (v_ing, p_canteen_id, v_line.qty, v_new,
            'Invoice stock-in — ' || v_line.name, 'purchase', v_purchase, auth.uid());

    INSERT INTO public.ingredient_batches
      (ingredient_id, canteen_id, supplier_id, purchase_id, qty_received, qty_remaining, rate)
    VALUES (v_ing, p_canteen_id, p_supplier_id, v_purchase, v_line.qty, v_line.qty, v_line.rate);
  END LOOP;

  RETURN jsonb_build_object(
    'purchase_id', v_purchase, 'new_items', v_created,
    'existing_items', v_topped, 'total', coalesce(p_total, v_sum)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.add_stock_from_invoice(UUID, UUID, JSONB, TEXT, TEXT, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_stock_from_invoice(UUID, UUID, JSONB, TEXT, TEXT, NUMERIC) TO authenticated;

-- The manual purchase screen and the confirm step are the store keeper's
-- job too — let them write purchases for their own site.
DROP POLICY IF EXISTS "purchases_manager_write" ON public.purchases;
DROP POLICY IF EXISTS "purchases_store_write" ON public.purchases;
CREATE POLICY "purchases_store_write" ON public.purchases FOR ALL TO authenticated
  USING (public.can_receive_stock() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.can_receive_stock() AND public.can_access_canteen(canteen_id));

DROP POLICY IF EXISTS "purchase_items_manager_write" ON public.purchase_items;
DROP POLICY IF EXISTS "purchase_items_store_write" ON public.purchase_items;
CREATE POLICY "purchase_items_store_write" ON public.purchase_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.purchases p WHERE p.id = purchase_id
                 AND public.can_receive_stock() AND public.can_access_canteen(p.canteen_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.purchases p WHERE p.id = purchase_id
                 AND public.can_receive_stock() AND public.can_access_canteen(p.canteen_id)));

-- Receiving goods changes stock levels, so the store keeper needs to write
-- ingredients as well. The chef still cannot.
DROP POLICY IF EXISTS "ingredients_manager_write" ON public.ingredients;
DROP POLICY IF EXISTS "ingredients_store_write" ON public.ingredients;
CREATE POLICY "ingredients_store_write" ON public.ingredients FOR ALL TO authenticated
  USING (public.can_receive_stock() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.can_receive_stock() AND public.can_access_canteen(canteen_id));

-- confirm_purchase runs as the caller too; same duty gate.
CREATE OR REPLACE FUNCTION public.confirm_purchase(p_purchase_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_canteen UUID; v_status TEXT; v_supplier UUID; v_row RECORD; v_new NUMERIC;
BEGIN
  IF NOT public.can_receive_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can confirm a purchase';
  END IF;

  SELECT canteen_id, status, supplier_id INTO v_canteen, v_status, v_supplier
  FROM public.purchases WHERE id = p_purchase_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown purchase'; END IF;
  IF NOT public.can_access_canteen(v_canteen) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;
  IF v_status = 'confirmed' THEN RETURN jsonb_build_object('already', true); END IF;

  FOR v_row IN
    SELECT ingredient_id, sum(quantity) AS qty,
           CASE WHEN sum(quantity) > 0 THEN sum(total) / sum(quantity) ELSE 0 END AS rate,
           max(shelf) AS shelf
    FROM (
      SELECT pi.ingredient_id, pi.quantity, pi.total, i.shelf_life_days AS shelf
      FROM public.purchase_items pi
      JOIN public.ingredients i ON i.id = pi.ingredient_id
      WHERE pi.purchase_id = p_purchase_id AND pi.ingredient_id IS NOT NULL
    ) x
    GROUP BY ingredient_id
  LOOP
    UPDATE public.ingredients
      SET current_stock = current_stock + v_row.qty
      WHERE id = v_row.ingredient_id
      RETURNING current_stock INTO v_new;
    IF NOT FOUND THEN CONTINUE; END IF;

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, reference_id, created_by)
    VALUES (v_row.ingredient_id, v_canteen, v_row.qty, v_new,
            'Purchase confirmed #' || left(p_purchase_id::text, 8), 'purchase', p_purchase_id, auth.uid());

    INSERT INTO public.ingredient_batches
      (ingredient_id, canteen_id, supplier_id, purchase_id, qty_received, qty_remaining, rate, expiry_date)
    VALUES (v_row.ingredient_id, v_canteen, v_supplier, p_purchase_id,
            v_row.qty, v_row.qty, v_row.rate,
            CASE WHEN v_row.shelf IS NOT NULL
                 THEN (current_date + (v_row.shelf || ' days')::interval)::date END);
  END LOOP;

  UPDATE public.purchases SET status = 'confirmed', approved_at = now() WHERE id = p_purchase_id;
  RETURN jsonb_build_object('confirmed', true);
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_purchase(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_purchase(UUID) TO authenticated;
