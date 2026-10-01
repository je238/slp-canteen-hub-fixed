-- ============================================================
-- ONE-OFF: BRING EVERY ITEM'S LOTS IN LINE WITH ITS STOCK
--
-- See 20261001200000. For each live item whose open lots do not add up to
-- current_stock, the lots are made to match it (oldest taken off first, or
-- one COUNT-FOUND lot at the last purchase rate). current_stock itself is
-- not changed. Each item touched is written to action_logs with the before
-- and after figures, so the change can be read back.
--
-- Applied with the owner's go-ahead, 01 Oct 2026. Safe to re-run: a second
-- run finds nothing to change.
-- ============================================================
DO $$
DECLARE r record; v jsonb; n int := 0;
BEGIN
  FOR r IN
    SELECT i.id, i.canteen_id, i.name, i.unit, i.current_stock,
           coalesce((SELECT sum(qty_remaining) FROM public.ingredient_batches b
                      WHERE b.ingredient_id = i.id AND b.canteen_id = i.canteen_id AND b.qty_remaining > 0), 0) AS lots
      FROM public.ingredients i
     WHERE i.archived_at IS NULL AND i.current_stock >= 0
  LOOP
    CONTINUE WHEN abs(r.lots - r.current_stock) < 0.0005;
    v := public.sync_lots_to_count(r.id, r.canteen_id, r.current_stock);
    INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
    VALUES (NULL, 'lots_reconciled', 'ingredient', r.id, r.canteen_id,
            jsonb_build_object('item', r.name, 'unit', r.unit, 'was', round(r.lots, 3), 'now', round(r.current_stock, 3),
                               'reason', 'FIFO lots brought in line with stock (count did not update lots before 01 Oct 2026)') || v);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'lots reconciled for % items', n;
END $$;
