-- ============================================================
-- THE STORE KEEPER MAY REMOVE ANY ITEM, WITH ITS HISTORY KEPT
--
-- Until now the store keeper could delete only an untouched row (no stock,
-- no bill, no issue); anything else needed an admin. The owner has given the
-- store keeper the same removal right as an admin (20/10/2026).
--
-- Nothing is erased that has a past. An item with stock or history is
-- archived, not deleted: its bills, issues, counts and consumption stay as
-- they were, remaining stock is written off through adjust_stock (ledger row
-- + its own alert), and the action is logged with the store keeper's reason.
-- A reason is required from anyone removing such an item. The manager,
-- admin and owner get a notification for every item the store keeper
-- removes. A truly unused row is still deleted outright, as before.
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.delete_ingredient(
  p_ingredient_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ing public.ingredients%ROWTYPE;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_is_admin boolean := public.is_admin_editor();
  v_has_history boolean;
  v_old_stock numeric;
BEGIN
  SELECT * INTO v_ing
  FROM public.ingredients
  WHERE id = p_ingredient_id
  FOR UPDATE;

  IF NOT FOUND OR v_ing.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Unknown or already removed item';
  END IF;

  IF NOT (v_is_admin OR public.is_store_keeper()) THEN
    RAISE EXCEPTION 'Only an admin or store keeper can remove an inventory item';
  END IF;
  IF NOT public.can_access_canteen(v_ing.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.stock_ledger WHERE ingredient_id = p_ingredient_id
    UNION ALL SELECT 1 FROM public.requisition_items WHERE ingredient_id = p_ingredient_id OR original_ingredient_id = p_ingredient_id
    UNION ALL SELECT 1 FROM public.purchase_items WHERE ingredient_id = p_ingredient_id
    UNION ALL SELECT 1 FROM public.recipe_ingredients WHERE ingredient_id = p_ingredient_id
    UNION ALL SELECT 1 FROM public.kitchen_returns WHERE ingredient_id = p_ingredient_id
    UNION ALL SELECT 1 FROM public.ingredient_usage_log WHERE ingredient_id = p_ingredient_id
    UNION ALL SELECT 1 FROM public.central_kitchen_transfer_items WHERE ingredient_id = p_ingredient_id
    UNION ALL SELECT 1 FROM public.vendor_bill_items WHERE ingredient_id = p_ingredient_id
  ) INTO v_has_history;

  -- Anything with stock or history needs a reason, from whoever removes it.
  IF (coalesce(v_ing.current_stock, 0) <> 0 OR v_has_history) AND length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Write a reason before removing %: it has stock or history.', v_ing.name;
  END IF;

  v_old_stock := coalesce(v_ing.current_stock, 0);

  -- A truly unused row has nothing to preserve, so remove it completely.
  IF NOT v_has_history AND v_old_stock = 0 THEN
    DELETE FROM public.ingredient_batches WHERE ingredient_id = p_ingredient_id;
    DELETE FROM public.ingredients WHERE id = p_ingredient_id;

    INSERT INTO public.action_logs
      (user_id, action, entity_type, entity_id, canteen_id, details)
    VALUES
      (auth.uid(), 'ingredient_deleted', 'ingredient', p_ingredient_id, v_ing.canteen_id,
       jsonb_build_object('name', v_ing.name, 'unit', v_ing.unit,
         'reason', nullif(v_reason, ''),
         'removed_by_role', CASE WHEN v_is_admin THEN 'admin' ELSE 'store_keeper' END,
         'history_preserved', true));

    RETURN jsonb_build_object('removed', v_ing.name, 'archived', false,
      'stock_written_off', 0, 'history_preserved', true);
  END IF;

  -- Full admin removal: write remaining goods out through the existing
  -- audited stock function, then hide the master row from all active pickers.
  IF v_old_stock <> 0 THEN
    PERFORM public.adjust_stock(
      p_ingredient_id,
      0,
      'Inventory item removed by ' || CASE WHEN v_is_admin THEN 'admin' ELSE 'store keeper' END || ': ' || v_reason
    );
  END IF;

  UPDATE public.ingredients
  SET archived_at = now(),
      archived_by = auth.uid(),
      archive_reason = v_reason,
      minimum_stock = 0,
      reorder_level = 0,
      maximum_stock = NULL,
      avg_daily_usage = NULL
  WHERE id = p_ingredient_id;

  INSERT INTO public.action_logs
    (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES
    (auth.uid(), 'ingredient_archived', 'ingredient', p_ingredient_id, v_ing.canteen_id,
     jsonb_build_object('name', v_ing.name, 'unit', v_ing.unit,
       'stock_was', v_old_stock, 'stock_now', 0, 'reason', v_reason,
       'removed_by_role', CASE WHEN v_is_admin THEN 'admin' ELSE 'store_keeper' END,
       'history_preserved', true));

  -- The owner and the manager hear about every item the store keeper takes
  -- off the shelf. A write-off of remaining stock also raises adjust_stock's
  -- own alert; this one is for the item itself.
  IF NOT v_is_admin THEN
    INSERT INTO public.notifications (canteen_id, target_role, title, body, link, ref_type, ref_id)
    VALUES (v_ing.canteen_id, 'manager',
            format('Store keeper ne item hataya — %s', v_ing.name),
            format('%s inventory se hata diya. Stock tha %s %s (₹%s), ab 0. Reason: "%s". Purani history safe hai.',
                   v_ing.name, v_old_stock, v_ing.unit,
                   round(abs(v_old_stock) * coalesce(v_ing.cost_per_unit, 0), 2), v_reason),
            '/audit-log', 'ingredient', p_ingredient_id);
  END IF;

  RETURN jsonb_build_object('removed', v_ing.name, 'archived', true,
    'stock_written_off', v_old_stock, 'history_preserved', true);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_ingredient(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_ingredient(uuid, text) TO authenticated;
