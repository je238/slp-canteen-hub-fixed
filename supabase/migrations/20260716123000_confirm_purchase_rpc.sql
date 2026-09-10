-- Atomic purchase confirmation: adds each matched line to stock and writes
-- the ledger in one transaction, aggregating by ingredient so two lines that
-- map to the SAME ingredient (e.g. "Basmati Rice" + "Rice") don't both compute
-- from the same base and lose stock. Replaces the browser read-modify-write.
-- Idempotent via the confirmed-status guard. Safe to re-run.

CREATE OR REPLACE FUNCTION public.confirm_purchase(p_purchase_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_canteen UUID; v_status TEXT; v_row RECORD; v_new NUMERIC;
BEGIN
  SELECT canteen_id, status INTO v_canteen, v_status
  FROM public.purchases WHERE id = p_purchase_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown purchase'; END IF;
  IF v_status = 'confirmed' THEN
    RETURN jsonb_build_object('already', true);   -- never double-add stock
  END IF;

  -- Aggregate quantity per ingredient so duplicate matches sum correctly
  FOR v_row IN
    SELECT ingredient_id, sum(quantity) AS qty
    FROM public.purchase_items
    WHERE purchase_id = p_purchase_id AND ingredient_id IS NOT NULL
    GROUP BY ingredient_id
  LOOP
    UPDATE public.ingredients
      SET current_stock = current_stock + v_row.qty
      WHERE id = v_row.ingredient_id
      RETURNING current_stock INTO v_new;
    IF NOT FOUND THEN CONTINUE; END IF;
    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, reference_id)
    VALUES (v_row.ingredient_id, v_canteen, v_row.qty, v_new,
            'Purchase confirmed #' || left(p_purchase_id::text, 8), 'purchase', p_purchase_id);
  END LOOP;

  UPDATE public.purchases
    SET status = 'confirmed', approved_at = now()
    WHERE id = p_purchase_id;

  RETURN jsonb_build_object('confirmed', true);
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_purchase(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_purchase(UUID) TO authenticated;
