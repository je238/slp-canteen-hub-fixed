-- ============================================================
-- AN ADMIN MAY REMOVE AN ITEM — IF REMOVING IT LOSES NOTHING
--
-- The scanner invents names off a photograph. TOOR DAL beside Dal Toor, Poha
-- beside POHA FRESH, Rice beside Dawat Rice: three ghosts that never held a
-- gram, cluttering the list the chef orders from and the reader matches
-- against. Somebody has to be able to take them out without a database
-- console.
--
-- But "delete" on an item that has actually traded is a different act
-- entirely. Its ledger rows are the record of what the kitchen cooked and
-- what the company was billed for; taking the item away takes that with it.
-- So the line is drawn where it belongs:
--
--   * nothing on the shelf, nothing ever moved -> it goes
--   * stock on the shelf -> count it out first, so the going is recorded
--   * anything ever moved -> refused, and the right answer is named: merge it
--     into the item it is a misspelling of, which carries the history across
--     instead of burning it
--
-- Empty lots and zero-quantity bill lines left behind by a corrected receipt
-- are swept up with it — they are artefacts of the name, not history.
--
-- Safe to re-run.
-- ============================================================
CREATE OR REPLACE FUNCTION public.delete_ingredient(p_ingredient_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ing public.ingredients%ROWTYPE;
  v_moved INT; v_orders INT; v_recipes INT; v_lots INT; v_lines INT;
BEGIN
  SELECT * INTO v_ing FROM public.ingredients WHERE id = p_ingredient_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown item'; END IF;
  IF NOT public.is_admin_editor() THEN
    RAISE EXCEPTION 'Only an admin can remove an item from the list';
  END IF;
  IF NOT public.can_access_canteen(v_ing.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  IF coalesce(v_ing.current_stock, 0) <> 0 THEN
    RAISE EXCEPTION
      '% still has % % on the shelf. Count it out first — an item cannot leave the list holding stock.',
      v_ing.name, v_ing.current_stock, v_ing.unit;
  END IF;

  SELECT count(*) INTO v_moved FROM public.stock_ledger
   WHERE ingredient_id = p_ingredient_id;
  IF v_moved > 0 THEN
    RAISE EXCEPTION
      '% has % movement(s) behind it — deleting it would take the record of what was cooked with it. If it is another name for something you already keep, merge it instead.',
      v_ing.name, v_moved;
  END IF;

  SELECT count(*) INTO v_orders FROM public.requisition_items
   WHERE ingredient_id = p_ingredient_id;
  IF v_orders > 0 THEN
    RAISE EXCEPTION
      '% appears on % order(s). Merge it into the item it belongs with, or remove it from those orders first.',
      v_ing.name, v_orders;
  END IF;

  SELECT count(*) INTO v_recipes FROM public.recipe_ingredients
   WHERE ingredient_id = p_ingredient_id;
  IF v_recipes > 0 THEN
    RAISE EXCEPTION '% is used in % recipe(s). Take it out of those first.',
      v_ing.name, v_recipes;
  END IF;

  -- Empty lots and zero-quantity bill lines are artefacts of the name, not
  -- history. They go with it.
  PERFORM public.allow_stock_move();
  DELETE FROM public.ingredient_batches WHERE ingredient_id = p_ingredient_id;
  GET DIAGNOSTICS v_lots = ROW_COUNT;

  DELETE FROM public.purchase_items WHERE ingredient_id = p_ingredient_id;
  GET DIAGNOSTICS v_lines = ROW_COUNT;

  DELETE FROM public.ingredients WHERE id = p_ingredient_id;

  -- A receipt with nothing left on it was only ever the ghost line.
  DELETE FROM public.purchases p
   WHERE p.canteen_id = v_ing.canteen_id
     AND NOT EXISTS (SELECT 1 FROM public.purchase_items i WHERE i.purchase_id = p.id);

  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'ingredient_removed', 'ingredient', p_ingredient_id, v_ing.canteen_id,
          jsonb_build_object('name', v_ing.name, 'unit', v_ing.unit,
                             'empty_lots_cleared', v_lots, 'empty_bill_lines_cleared', v_lines));

  RETURN jsonb_build_object('removed', v_ing.name,
                            'empty_lots_cleared', v_lots,
                            'empty_bill_lines_cleared', v_lines);
END;
$$;
REVOKE ALL ON FUNCTION public.delete_ingredient(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_ingredient(UUID) TO authenticated;
