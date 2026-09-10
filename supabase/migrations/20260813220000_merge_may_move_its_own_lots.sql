-- ============================================================
-- A MERGE MAY MOVE ITS OWN LOTS
--
-- The lot table was locked today so that nobody with a browser could rewrite
-- what the stock is worth. The lock reads a transaction flag that the stock
-- functions raise for themselves — and merge_ingredients moves lots BEFORE it
-- raises that flag, so the guard turned on the one function that was supposed
-- to be allowed through. Folding one misspelt item into another stopped
-- working the moment the lock went on.
--
-- The flag simply has to come first.
--
-- Safe to re-run.
-- ============================================================
CREATE OR REPLACE FUNCTION public.merge_ingredients(p_from UUID, p_into UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_from public.ingredients%ROWTYPE;
  v_into public.ingredients%ROWTYPE;
  v_new NUMERIC; v_ledger INT; v_batches INT; v_bills INT; v_reqs INT; v_recipes INT;
BEGIN
  IF p_from = p_into THEN RAISE EXCEPTION 'Those are the same item'; END IF;

  SELECT * INTO v_from FROM public.ingredients WHERE id = p_from;
  IF NOT FOUND THEN RAISE EXCEPTION 'The item being merged away does not exist'; END IF;
  SELECT * INTO v_into FROM public.ingredients WHERE id = p_into;
  IF NOT FOUND THEN RAISE EXCEPTION 'The item being merged into does not exist'; END IF;

  IF NOT public.is_admin_editor() THEN
    RAISE EXCEPTION 'Only an admin can merge two items into one';
  END IF;
  IF v_from.canteen_id IS DISTINCT FROM v_into.canteen_id THEN
    RAISE EXCEPTION 'Those items belong to different sites';
  END IF;
  IF NOT public.can_access_canteen(v_into.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  -- Raised up front: everything below touches tables that answer to it.
  PERFORM public.allow_stock_move();

  ALTER TABLE public.stock_ledger DISABLE TRIGGER trg_guard_stock_ledger_update;
  UPDATE public.stock_ledger SET ingredient_id = p_into WHERE ingredient_id = p_from;
  GET DIAGNOSTICS v_ledger = ROW_COUNT;

  UPDATE public.ingredient_batches SET ingredient_id = p_into WHERE ingredient_id = p_from;
  GET DIAGNOSTICS v_batches = ROW_COUNT;

  ALTER TABLE public.purchase_items DISABLE TRIGGER trg_guard_purchase_items;
  UPDATE public.purchase_items SET ingredient_id = p_into WHERE ingredient_id = p_from;
  GET DIAGNOSTICS v_bills = ROW_COUNT;
  ALTER TABLE public.purchase_items ENABLE TRIGGER trg_guard_purchase_items;

  UPDATE public.requisition_items SET ingredient_id = p_into WHERE ingredient_id = p_from;
  GET DIAGNOSTICS v_reqs = ROW_COUNT;

  DELETE FROM public.recipe_ingredients a
   WHERE a.ingredient_id = p_from
     AND EXISTS (SELECT 1 FROM public.recipe_ingredients b
                 WHERE b.recipe_id = a.recipe_id AND b.ingredient_id = p_into);
  UPDATE public.recipe_ingredients SET ingredient_id = p_into WHERE ingredient_id = p_from;
  GET DIAGNOSTICS v_recipes = ROW_COUNT;

  DELETE FROM public.kitchen_returns WHERE ingredient_id = p_from;

  UPDATE public.ingredients
     SET current_stock = current_stock + coalesce(v_from.current_stock, 0)
   WHERE id = p_into
  RETURNING current_stock INTO v_new;

  IF coalesce(v_from.current_stock, 0) <> 0 THEN
    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, created_by,
       service_date, value)
    VALUES (p_into, v_into.canteen_id, v_from.current_stock, v_new,
            format('Merged in %s held under "%s"', v_from.current_stock, v_from.name),
            'merge', auth.uid(), (now() AT TIME ZONE 'Asia/Kolkata')::date,
            round(coalesce(v_from.current_stock,0) * coalesce(v_from.cost_per_unit,0), 2));
  END IF;

  -- The two names each kept their own running balance, so pooling the rows
  -- would print a column that never adds up. Re-walk it, anchored to the
  -- shelf so it finishes on what is really there.
  WITH ordered AS (
    SELECT id, sum(change_qty) OVER (ORDER BY created_at, id)
             - sum(change_qty) OVER () + v_new AS running
      FROM public.stock_ledger WHERE ingredient_id = p_into
  )
  UPDATE public.stock_ledger l SET balance_after = o.running
    FROM ordered o WHERE l.id = o.id AND l.balance_after IS DISTINCT FROM o.running;

  ALTER TABLE public.stock_ledger ENABLE TRIGGER trg_guard_stock_ledger_update;

  DELETE FROM public.ingredients WHERE id = p_from;

  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'ingredients_merged', 'ingredient', p_into, v_into.canteen_id,
          jsonb_build_object('from', v_from.name, 'into', v_into.name,
                             'stock_moved', v_from.current_stock,
                             'ledger_rows', v_ledger, 'bill_lines', v_bills,
                             'orders', v_reqs, 'batches', v_batches, 'recipes', v_recipes));

  RETURN jsonb_build_object(
    'merged', v_from.name, 'into', v_into.name, 'new_balance', v_new,
    'ledger_rows', v_ledger, 'bill_lines', v_bills, 'orders', v_reqs);
END;
$$;
REVOKE ALL ON FUNCTION public.merge_ingredients(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_ingredients(UUID, UUID) TO authenticated;
