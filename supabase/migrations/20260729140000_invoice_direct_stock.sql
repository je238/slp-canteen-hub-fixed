-- ============================================================
-- INVOICE → STOCK IN ONE STEP
--
-- Suppliers here hand over handwritten bills, mostly with the item names
-- in Hindi. No OCR reads that reliably, so forcing the store keeper to
-- match every scanned line to an existing ingredient was busy-work that
-- also blocked the stock going in.
--
-- Now: whatever name the scan produced (after the store keeper edits it)
-- becomes the item. If that name already exists at the site we top it up;
-- if not, we create it. Stock, ledger and batch all move in one
-- transaction, and the rate on the bill becomes the item's cost.
--
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.add_stock_from_invoice(
  p_canteen_id  UUID,
  p_supplier_id UUID,
  p_items       JSONB,          -- [{name, quantity, unit, rate, total, category}]
  p_notes       TEXT DEFAULT NULL,
  p_image_path  TEXT DEFAULT NULL,
  p_total       NUMERIC DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_purchase UUID;
  v_line RECORD;
  v_ing UUID;
  v_new NUMERIC;
  v_created INT := 0;
  v_topped  INT := 0;
  v_sum NUMERIC := 0;
BEGIN
  IF NOT public.is_store_keeper_or_above() THEN
    RAISE EXCEPTION 'Only the store keeper can take stock in';
  END IF;

  SELECT coalesce(sum((e->>'total')::numeric), 0) INTO v_sum
  FROM jsonb_array_elements(p_items) e;

  INSERT INTO public.purchases
    (canteen_id, supplier_id, total_amount, notes, invoice_image_url, status, approved_at)
  VALUES
    (p_canteen_id, p_supplier_id, coalesce(p_total, v_sum), p_notes, p_image_path,
     'confirmed', now())
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

    -- same item, however it was spelled last time
    SELECT id INTO v_ing FROM public.ingredients
    WHERE canteen_id = p_canteen_id AND lower(btrim(name)) = lower(v_line.name)
    LIMIT 1;

    IF v_ing IS NULL THEN
      INSERT INTO public.ingredients
        (canteen_id, name, category, unit, current_stock, minimum_stock, cost_per_unit)
      VALUES (p_canteen_id, v_line.name, v_line.category, v_line.unit,
              0, 0, v_line.rate)
      RETURNING id INTO v_ing;
      v_created := v_created + 1;
    ELSE
      v_topped := v_topped + 1;
    END IF;

    UPDATE public.ingredients
      SET current_stock = current_stock + v_line.qty,
          -- the bill is the source of truth for what this costs now
          cost_per_unit = CASE WHEN v_line.rate > 0 THEN v_line.rate ELSE cost_per_unit END
      WHERE id = v_ing
      RETURNING current_stock INTO v_new;

    INSERT INTO public.purchase_items
      (purchase_id, item_name, quantity, unit, rate, total, ingredient_id)
    VALUES (v_purchase, v_line.name, v_line.qty, v_line.unit, v_line.rate, v_line.total, v_ing);

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, reference_id)
    VALUES (v_ing, p_canteen_id, v_line.qty, v_new,
            'Invoice stock-in — ' || v_line.name, 'purchase', v_purchase);

    INSERT INTO public.ingredient_batches
      (ingredient_id, canteen_id, supplier_id, purchase_id, qty_received, qty_remaining, rate)
    VALUES (v_ing, p_canteen_id, p_supplier_id, v_purchase, v_line.qty, v_line.qty, v_line.rate);
  END LOOP;

  RETURN jsonb_build_object(
    'purchase_id', v_purchase,
    'new_items', v_created,
    'existing_items', v_topped,
    'total', coalesce(p_total, v_sum)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.add_stock_from_invoice(UUID, UUID, JSONB, TEXT, TEXT, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_stock_from_invoice(UUID, UUID, JSONB, TEXT, TEXT, NUMERIC) TO authenticated;

-- ---------- Vendor delivery evidence reaches the people who watch it ----------
CREATE OR REPLACE FUNCTION public.notify_delivery_photo()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_site TEXT;
BEGIN
  IF NEW.photo_type NOT IN ('receipt','vendor_delivery') THEN RETURN NEW; END IF;
  SELECT name INTO v_site FROM public.canteens WHERE id = NEW.canteen_id;

  INSERT INTO public.notifications (canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES (NEW.canteen_id, 'unit_manager',
          'Stock received at ' || coalesce(v_site, 'site'),
          coalesce(NEW.note, 'Delivery recorded') ||
          CASE WHEN NEW.latitude IS NOT NULL THEN ' · location captured' ELSE ' · no location' END,
          '/purchases', 'stock_photo', NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_delivery_photo ON public.stock_photos;
CREATE TRIGGER trg_notify_delivery_photo
  AFTER INSERT ON public.stock_photos
  FOR EACH ROW EXECUTE FUNCTION public.notify_delivery_photo();
