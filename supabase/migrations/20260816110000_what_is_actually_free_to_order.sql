-- ============================================================
-- WHAT IS ACTUALLY FREE TO ORDER
--
-- The chef has been ordering against a number that is not true. The screen
-- shows ingredients.current_stock — what the shelf holds — and the shelf
-- holds plenty of things that are already spoken for.
--
-- The owner's own example: 100 kg of sugar, 12 kg ordered for breakfast. The
-- store keeper hands the 12 kg over but does not click "issue" in the app.
-- The chef comes back for lunch and the screen still says 100 kg. He orders
-- against 100, and 88 is what exists.
--
-- Today that is not one item. Twenty-five are already over-committed:
-- Aata says 635 kg with 790 kg ordered, Onion 369 with 509, Cucumber 105
-- with 240, Paneer 2 with 87.
--
-- The fix is not to nag the store keeper into clicking faster. People forget,
-- and a system that only works when nobody forgets does not work. The fix is
-- that an order should COMMIT the stock the moment it is raised — the sugar
-- stops being available when it is asked for, not when somebody remembers to
-- press a button. Then forgetting costs nothing.
--
--   free = what the shelf holds − what is already asked for and not yet given
--
-- ---- and the things that arrive every morning ----
--
-- Paneer, milk, vegetables come in daily. The chef orders on the 13th for the
-- 14th, and the goods land on the 14th at six in the morning. A near-empty
-- shelf for those at ordering time is CORRECT, not a shortage. Warning about
-- them teaches the chef to ignore warnings, and then he ignores the real one.
--
-- So they are marked, and the screen says "arrives daily" instead of shouting.
-- The list below is a first pass off the names and is meant to be corrected —
-- it is a column on the item, not a rule buried in code.
--
-- Safe to re-run. Re-running does NOT re-tick items someone has since
-- un-ticked; the flag is set once, on items that have never been decided.
-- ============================================================

ALTER TABLE public.ingredients
  ADD COLUMN IF NOT EXISTS arrives_daily BOOLEAN,
  ADD COLUMN IF NOT EXISTS daily_decided_at TIMESTAMPTZ;

COMMENT ON COLUMN public.ingredients.arrives_daily IS
  'Comes in fresh every morning — paneer, milk, vegetables. An empty shelf at '
  'ordering time is normal for these, so the chef is not warned about them. '
  'NULL means nobody has decided yet.';

-- First pass, only where nobody has decided. Names, not categories: the
-- categories on this site have 44 items in "Uncategorised" and soya sauce
-- filed under "Grains & Flours".
UPDATE public.ingredients SET arrives_daily = true, daily_decided_at = now()
WHERE arrives_daily IS NULL
  AND btrim(name) ILIKE ANY (ARRAY[
    'Paneer','Amul Gold','amul curd','curd','CHHACH','mawa',
    'Onion','Potato','Tomato','Tomato Karate','Banana Karate','Beetroot',
    'Cabbage','Capsicum','Carrot','GAJAR','Cucumber','Ginger','Garlic',
    'Garlic Pleed','G Chili','Chili','Green Pease','Lemon','Mint',
    'Mint leaves','MIX VEG','MIX  VEG','Corrinder','Corriander leaves',
    'Pomegranate','sponge gourd','Bottle Groud','Locky','Coliflower Potli'
  ]);

-- Everything else that has never been decided is a store item. Said
-- explicitly rather than left NULL, so "nobody has looked at this" and "this
-- is a store item" stay different facts.
UPDATE public.ingredients SET arrives_daily = false, daily_decided_at = now()
WHERE arrives_daily IS NULL;

-- ---------- What is committed, and what is free ----------
-- Committed = raised and not yet handed over. A rejected or cancelled order
-- holds nothing; an issued one has already left the shelf and been counted.
CREATE OR REPLACE VIEW public.ingredient_availability AS
SELECT i.id                AS ingredient_id,
       i.canteen_id,
       i.name,
       i.unit,
       i.current_stock,
       coalesce(i.arrives_daily, false)          AS arrives_daily,
       coalesce(c.committed, 0)                  AS committed,
       i.current_stock - coalesce(c.committed, 0) AS free_qty,
       coalesce(c.on_orders, '[]'::jsonb)        AS on_orders
FROM public.ingredients i
LEFT JOIN LATERAL (
  SELECT sum(greatest(coalesce(ri.approved_qty, ri.requested_qty)
                      - coalesce(ri.issued_qty, 0), 0))          AS committed,
         jsonb_agg(jsonb_build_object('req_no', r.req_no, 'status', r.status,
                                      'qty', coalesce(ri.approved_qty, ri.requested_qty))
                   ORDER BY r.req_no)                            AS on_orders
  FROM public.requisition_items ri
  JOIN public.requisitions r ON r.id = ri.requisition_id
  WHERE ri.ingredient_id = i.id
    AND r.status IN ('pending', 'approved')
) c ON TRUE;

ALTER VIEW public.ingredient_availability SET (security_invoker = on);
GRANT SELECT ON public.ingredient_availability TO authenticated;

COMMENT ON VIEW public.ingredient_availability IS
  'current_stock minus what is already on an unissued order. This is the '
  'figure the chef should order against — the shelf figure counts goods that '
  'are already promised to another meal.';
