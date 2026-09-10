-- A merge already moves every historical ledger row from the duplicate item
-- to the retained item. The old function then also inserted the duplicate's
-- full shelf quantity as a second movement, so that quantity was counted
-- twice in the ledger. Keep the shelf addition, transfer the history, and add
-- only the exact gap needed to make the combined ledger equal the combined
-- shelf. A zero-quantity row still records a clean merge audit event.

CREATE OR REPLACE FUNCTION public.merge_ingredients(p_from UUID, p_into UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_from public.ingredients%ROWTYPE;
  v_into public.ingredients%ROWTYPE;
  v_new NUMERIC;
  v_book NUMERIC;
  v_reconciliation NUMERIC;
  v_ledger INT;
  v_batches INT;
  v_bills INT;
  v_reqs INT;
  v_recipes INT;
BEGIN
  IF p_from = p_into THEN RAISE EXCEPTION 'Those are the same item'; END IF;

  SELECT * INTO v_from FROM public.ingredients WHERE id = p_from;
  IF NOT FOUND THEN RAISE EXCEPTION 'The item being merged away does not exist'; END IF;
  SELECT * INTO v_into FROM public.ingredients WHERE id = p_into;
  IF NOT FOUND THEN RAISE EXCEPTION 'The item being merged into does not exist'; END IF;

  IF NOT (public.is_admin_editor() OR public.is_store_keeper()) THEN
    RAISE EXCEPTION 'Only an admin or Store Keeper can merge two items into one';
  END IF;
  IF v_from.canteen_id IS DISTINCT FROM v_into.canteen_id THEN
    RAISE EXCEPTION 'Those items belong to different sites';
  END IF;
  IF NOT public.can_access_canteen(v_into.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  -- Lock both stock masters in a stable order before moving dependent rows.
  PERFORM i.id
    FROM public.ingredients i
   WHERE i.id IN (p_from, p_into)
   ORDER BY i.id
   FOR UPDATE;

  -- Refresh the values after obtaining the locks so a simultaneous stock
  -- movement cannot make the merge use an older shelf balance.
  SELECT * INTO v_from FROM public.ingredients WHERE id = p_from;
  SELECT * INTO v_into FROM public.ingredients WHERE id = p_into;

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
     AND EXISTS (
       SELECT 1 FROM public.recipe_ingredients b
        WHERE b.recipe_id = a.recipe_id AND b.ingredient_id = p_into
     );
  UPDATE public.recipe_ingredients SET ingredient_id = p_into WHERE ingredient_id = p_from;
  GET DIAGNOSTICS v_recipes = ROW_COUNT;

  DELETE FROM public.kitchen_returns WHERE ingredient_id = p_from;

  UPDATE public.ingredients
     SET current_stock = current_stock + coalesce(v_from.current_stock, 0)
   WHERE id = p_into
  RETURNING current_stock INTO v_new;

  SELECT coalesce(sum(l.change_qty), 0)
    INTO v_book
    FROM public.stock_ledger l
   WHERE l.ingredient_id = p_into;

  v_reconciliation := v_new - v_book;

  INSERT INTO public.stock_ledger
    (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type,
     created_by, service_date, value)
  VALUES
    (p_into, v_into.canteen_id, v_reconciliation, v_new,
     format(
       'Item merge — "%s" into "%s"; %s %s shelf moved; ledger reconciliation %s %s',
       v_from.name, v_into.name, coalesce(v_from.current_stock, 0), v_into.unit,
       v_reconciliation, v_into.unit
     ),
     'merge_reconciliation', auth.uid(),
     (now() AT TIME ZONE 'Asia/Kolkata')::date,
     round(v_reconciliation * coalesce(v_from.cost_per_unit, v_into.cost_per_unit, 0), 2));

  -- Rebuild display balances without changing any movement quantity.
  WITH ordered AS (
    SELECT id,
           sum(change_qty) OVER (ORDER BY created_at, id)
             - sum(change_qty) OVER () + v_new AS running
      FROM public.stock_ledger
     WHERE ingredient_id = p_into
  )
  UPDATE public.stock_ledger l
     SET balance_after = o.running
    FROM ordered o
   WHERE l.id = o.id
     AND l.balance_after IS DISTINCT FROM o.running;

  ALTER TABLE public.stock_ledger ENABLE TRIGGER trg_guard_stock_ledger_update;

  DELETE FROM public.ingredients WHERE id = p_from;

  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (
    auth.uid(), 'ingredients_merged', 'ingredient', p_into, v_into.canteen_id,
    jsonb_build_object(
      'from', v_from.name, 'into', v_into.name,
      'stock_moved', v_from.current_stock,
      'ledger_reconciliation', v_reconciliation,
      'ledger_rows', v_ledger, 'bill_lines', v_bills,
      'orders', v_reqs, 'batches', v_batches, 'recipes', v_recipes,
      'merged_by_role', CASE WHEN public.is_store_keeper() THEN 'store_keeper' ELSE 'admin' END
    )
  );

  RETURN jsonb_build_object(
    'merged', v_from.name, 'into', v_into.name, 'new_balance', v_new,
    'ledger_reconciliation', v_reconciliation,
    'ledger_rows', v_ledger, 'bill_lines', v_bills, 'orders', v_reqs
  );
END;
$$;

REVOKE ALL ON FUNCTION public.merge_ingredients(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_ingredients(UUID, UUID) TO authenticated;

-- Repair only live items that both contain a historical merge movement and
-- are currently mismatched. The shelf/current_stock is the physical count and
-- remains unchanged. Old rows remain immutable evidence; a new, explicit
-- reconciliation movement closes the book and explains why.
DO $$
DECLARE
  v_item RECORD;
  v_book NUMERIC;
  v_gap NUMERIC;
BEGIN
  ALTER TABLE public.stock_ledger DISABLE TRIGGER trg_guard_stock_ledger_update;

  FOR v_item IN
    SELECT i.id, i.canteen_id, i.name, i.unit, i.current_stock, i.cost_per_unit
      FROM public.ingredients i
     WHERE EXISTS (
       SELECT 1
         FROM public.stock_ledger ml
        WHERE ml.ingredient_id = i.id
          AND ml.reference_type = 'merge'
     )
  LOOP
    SELECT coalesce(sum(l.change_qty), 0)
      INTO v_book
      FROM public.stock_ledger l
     WHERE l.ingredient_id = v_item.id;

    v_gap := v_item.current_stock - v_book;
    IF abs(v_gap) > 0.000001 THEN
      INSERT INTO public.stock_ledger
        (ingredient_id, canteen_id, change_qty, balance_after, reason,
         reference_type, created_by, service_date, value)
      VALUES
        (v_item.id, v_item.canteen_id, v_gap, v_item.current_stock,
         format(
           'Merge bug reconciliation — ledger %s %s aligned to physical shelf %s %s; shelf unchanged',
           v_book, v_item.unit, v_item.current_stock, v_item.unit
         ),
         'merge_bug_reconciliation', NULL,
         (now() AT TIME ZONE 'Asia/Kolkata')::date,
         round(v_gap * coalesce(v_item.cost_per_unit, 0), 2));

      WITH ordered AS (
        SELECT id,
               sum(change_qty) OVER (ORDER BY created_at, id)
                 - sum(change_qty) OVER () + v_item.current_stock AS running
          FROM public.stock_ledger
         WHERE ingredient_id = v_item.id
      )
      UPDATE public.stock_ledger l
         SET balance_after = o.running
        FROM ordered o
       WHERE l.id = o.id
         AND l.balance_after IS DISTINCT FROM o.running;

      INSERT INTO public.action_logs
        (user_id, action, entity_type, entity_id, canteen_id, details)
      VALUES
        (NULL, 'merge_bug_reconciled', 'ingredient', v_item.id, v_item.canteen_id,
         jsonb_build_object(
           'item', v_item.name,
           'ledger_before', v_book,
           'physical_shelf', v_item.current_stock,
           'ledger_correction', v_gap,
           'physical_stock_changed', false
         ));
    END IF;
  END LOOP;

  ALTER TABLE public.stock_ledger ENABLE TRIGGER trg_guard_stock_ledger_update;
END;
$$;

COMMENT ON FUNCTION public.merge_ingredients(UUID, UUID) IS
  'Merges duplicate items once: combines shelf stock, transfers dependent history, and records only the ledger gap required for an auditable closing balance.';
