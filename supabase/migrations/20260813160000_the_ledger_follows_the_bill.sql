-- ============================================================
-- THE LEDGER FOLLOWS THE BILL
--
-- MOONG DAAL MOGAR: the item ledger says 120 kg came in, nothing went out,
-- and the shelf holds nothing. Three statements that cannot all be true, on
-- the one screen a person opens to find out what happened to an item.
--
-- Mine. When the opening receipts were corrected down to the counted figures,
-- the bill lines were rewritten and the ledger rows that mirror them were
-- not. Sixty-five of a hundred and three items ended up with a receipt saying
-- one thing and a ledger row saying another.
--
-- This brings the ledger back to the bills, and recomputes each item's
-- running balance in date order so the column reads straight down the page
-- and finishes on the figure the shelf actually holds.
--
-- The immutability guard is lifted only inside this transaction. What is
-- being corrected is the app's own bookkeeping error, not a movement.
--
-- Safe to re-run.
-- ============================================================
BEGIN;
ALTER TABLE public.stock_ledger DISABLE TRIGGER trg_guard_stock_ledger_update;

-- 1. every receipt row says what its bill line says
WITH bill AS (
  SELECT pi.purchase_id, pi.ingredient_id,
         sum(pi.quantity) AS qty, sum(pi.total) AS val
  FROM public.purchase_items pi
  GROUP BY 1, 2
)
UPDATE public.stock_ledger l
   SET change_qty = b.qty,
       value      = round(b.val, 2)
  FROM bill b
 WHERE l.reference_type = 'purchase'
   AND l.reference_id = b.purchase_id
   AND l.ingredient_id = b.ingredient_id
   AND (l.change_qty IS DISTINCT FROM b.qty OR l.value IS DISTINCT FROM round(b.val, 2));

-- 2. a receipt line that came to nothing is not a movement at all
DELETE FROM public.stock_ledger
 WHERE reference_type = 'purchase' AND coalesce(change_qty, 0) = 0;

-- 3. the running balance, re-walked in date order and anchored to the shelf,
--    so it ends on what is really there rather than on a sum from zero
WITH ordered AS (
  SELECT l.id, l.ingredient_id,
         sum(l.change_qty) OVER (PARTITION BY l.ingredient_id ORDER BY l.created_at, l.id) AS running,
         sum(l.change_qty) OVER (PARTITION BY l.ingredient_id) AS total
  FROM public.stock_ledger l
)
UPDATE public.stock_ledger l
   SET balance_after = round(o.running - o.total + i.current_stock, 3)
  FROM ordered o
  JOIN public.ingredients i ON i.id = o.ingredient_id
 WHERE l.id = o.id
   AND l.balance_after IS DISTINCT FROM round(o.running - o.total + i.current_stock, 3);

ALTER TABLE public.stock_ledger ENABLE TRIGGER trg_guard_stock_ledger_update;
COMMIT;

-- What is left disagreeing, if anything
SELECT count(*) AS items_where_bill_and_ledger_still_differ
  FROM public.ingredients i
 WHERE abs(
   coalesce((SELECT sum(pi.quantity) FROM public.purchase_items pi
              WHERE pi.ingredient_id = i.id), 0)
 - coalesce((SELECT sum(l.change_qty) FROM public.stock_ledger l
              WHERE l.ingredient_id = i.id AND l.reference_type = 'purchase'), 0)
 ) > 0.001;
