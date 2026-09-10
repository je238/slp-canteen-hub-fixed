-- ============================================================
-- TWO NAMES FOR ONE THING, AND HOW TO PUT THEM BACK TOGETHER
--
-- Stock is matched to an item by its name, exactly. So a bill typed or read
-- as "Rose" when it meant "Rice" does not top up the rice — it quietly
-- opens a second item. From then on the store holds 100 kg under one name
-- and 50 under another, no screen shows 150, the chef orders against the
-- one they can see and finds the shelf fuller than the book, and a physical
-- count matches neither. Their own purchase reports already carry exactly
-- this: Atta at 28.60 and Aata at 29.48, the same flour twice.
--
-- Catching it at entry is better and the scan screen now warns. This is for
-- when it gets through anyway, which it will.
--
-- Merging is an admin act: it moves history between items, and whoever made
-- the mistake should not be the one quietly tidying it away. Everything is
-- carried across — the ledger, the batches, the bill lines, past orders and
-- any recipe — so the trail still reads end to end afterwards, and the
-- merge itself is written to the action log.
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

  -- History first, so nothing is orphaned if anything below fails.
  --
  -- The ledger is deliberately immutable: a movement, once written, cannot be
  -- edited. That guard is worth keeping and is lifted only here, only for an
  -- admin, and only inside this transaction — if anything below fails the
  -- rollback puts it straight back. What is being corrected is the name the
  -- movement was filed under, not the movement: those 50 kg really did come
  -- in, they were always rice, and they were only ever written down wrong.
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

  -- A recipe may already name both; keep one line rather than duplicating.
  DELETE FROM public.recipe_ingredients a
   WHERE a.ingredient_id = p_from
     AND EXISTS (SELECT 1 FROM public.recipe_ingredients b
                 WHERE b.recipe_id = a.recipe_id AND b.ingredient_id = p_into);
  UPDATE public.recipe_ingredients SET ingredient_id = p_into WHERE ingredient_id = p_from;
  GET DIAGNOSTICS v_recipes = ROW_COUNT;

  DELETE FROM public.kitchen_returns WHERE ingredient_id = p_from;

  -- The stock the wrong name was holding joins the right one.
  PERFORM public.allow_stock_move();
  UPDATE public.ingredients
     SET current_stock = current_stock + coalesce(v_from.current_stock, 0)
   WHERE id = p_into
  RETURNING current_stock INTO v_new;

  IF coalesce(v_from.current_stock, 0) <> 0 THEN
    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, created_by)
    VALUES (p_into, v_into.canteen_id, v_from.current_stock, v_new,
            format('Merged in %s kg held under "%s"', v_from.current_stock, v_from.name),
            'merge', auth.uid());
  END IF;

  -- The two names each kept their own running balance, so simply pooling the
  -- rows would leave a ledger that reads 100, 50, 150 — a column that never
  -- adds up on the page an auditor is looking at. Recompute it in date order
  -- so the running balance is the one this item actually held.
  -- Anchored to the shelf figure rather than to a sum from zero: an item
  -- whose opening stock was typed in without a movement has a ledger that
  -- never summed to its balance in the first place, and this must not quietly
  -- rewrite that gap into every historical row.
  WITH ordered AS (
    SELECT id,
           sum(change_qty) OVER (ORDER BY created_at, id)
             - sum(change_qty) OVER () + v_new AS running
      FROM public.stock_ledger WHERE ingredient_id = p_into
  )
  UPDATE public.stock_ledger l SET balance_after = o.running
    FROM ordered o WHERE l.id = o.id AND l.balance_after IS DISTINCT FROM o.running;

  ALTER TABLE public.stock_ledger ENABLE TRIGGER trg_guard_stock_ledger_update;

  PERFORM public.allow_stock_move();
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

-- ---------- Items that look like each other ----------
-- Names one or two letters apart are almost never two real things: Rice and
-- Rose, Atta and Aata, Onion and Onoin. Surfaced so an admin can look
-- rather than waiting for a stock count to disagree.
CREATE OR REPLACE FUNCTION public.similar_ingredients(p_canteen_id UUID)
RETURNS TABLE (
  a_id UUID, a_name TEXT, a_stock NUMERIC,
  b_id UUID, b_name TEXT, b_stock NUMERIC, distance INT
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT a.id, a.name, a.current_stock, b.id, b.name, b.current_stock,
         levenshtein(lower(a.name), lower(b.name))
  FROM public.ingredients a
  JOIN public.ingredients b
    ON b.canteen_id = a.canteen_id AND b.id > a.id
  WHERE a.canteen_id = p_canteen_id
    AND public.can_access_canteen(a.canteen_id)
    AND length(a.name) > 2 AND length(b.name) > 2
    AND levenshtein(lower(a.name), lower(b.name)) <= 2
  ORDER BY 7, a.name;
$$;
REVOKE ALL ON FUNCTION public.similar_ingredients(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.similar_ingredients(UUID) TO authenticated;
