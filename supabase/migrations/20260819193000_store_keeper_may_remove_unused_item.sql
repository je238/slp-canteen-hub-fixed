-- Store keepers may remove a scanner-created/accidental ingredient only when
-- doing so cannot erase stock, kitchen, purchase, order, or recipe history.
CREATE OR REPLACE FUNCTION public.delete_ingredient(p_ingredient_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ing public.ingredients%ROWTYPE;
  v_moved INT; v_orders INT; v_recipes INT; v_lots INT; v_lines INT;
BEGIN
  SELECT * INTO v_ing FROM public.ingredients WHERE id = p_ingredient_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown item'; END IF;

  IF NOT (public.is_admin_editor() OR public.is_store_keeper()) THEN
    RAISE EXCEPTION 'Only an admin or store keeper can remove an item from the list';
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

  PERFORM public.allow_stock_move();
  DELETE FROM public.ingredient_batches WHERE ingredient_id = p_ingredient_id;
  GET DIAGNOSTICS v_lots = ROW_COUNT;

  DELETE FROM public.purchase_items WHERE ingredient_id = p_ingredient_id;
  GET DIAGNOSTICS v_lines = ROW_COUNT;

  DELETE FROM public.ingredients WHERE id = p_ingredient_id;

  DELETE FROM public.purchases p
   WHERE p.canteen_id = v_ing.canteen_id
     AND NOT EXISTS (SELECT 1 FROM public.purchase_items i WHERE i.purchase_id = p.id);

  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'ingredient_removed', 'ingredient', p_ingredient_id, v_ing.canteen_id,
          jsonb_build_object('name', v_ing.name, 'unit', v_ing.unit,
                             'removed_by_role', CASE WHEN public.is_store_keeper() THEN 'store_keeper' ELSE 'admin' END,
                             'empty_lots_cleared', v_lots, 'empty_bill_lines_cleared', v_lines));

  RETURN jsonb_build_object('removed', v_ing.name,
                            'empty_lots_cleared', v_lots,
                            'empty_bill_lines_cleared', v_lines);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_ingredient(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_ingredient(UUID) TO authenticated;
