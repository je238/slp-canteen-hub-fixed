-- ============================================================
-- "IT COMES TOMORROW" — SAID BESIDE THE ITEM THAT IS SHORT
--
-- Telling the chef that paneer is short is only half a sentence. The half
-- that matters is when it arrives, because that is what decides whether he
-- has a problem or not. Milk and curd come every morning; vegetables come
-- every other day. A shortfall covered by tomorrow's van is not a shortage.
-- A shortfall that lands after the meal is cooked is.
--
-- So the flag becomes a cycle:
--
--   1     = every day        (milk, curd, paneer, mawa)
--   2     = every other day  (vegetables and fruit)
--   NULL  = a store item, comes on a bill when it is bought
--
-- And the anchor for the cycle is not typed by anybody. It is read off the
-- purchase history — the last date this item was actually received. That
-- makes it self-correcting: when the van comes, the anchor moves on its own,
-- and nobody has to remember to update a schedule. A schedule kept by hand
-- is a schedule that is wrong by the second week.
--
-- If the computed date has already passed, the item is overdue rather than
-- scheduled, and the honest answer is "expected today" rather than a date in
-- the past. So it is clamped forward.
--
-- Safe to re-run. It does not overwrite a cycle somebody has already set.
-- ============================================================

ALTER TABLE public.ingredients
  ADD COLUMN IF NOT EXISTS delivery_every_days INT;

COMMENT ON COLUMN public.ingredients.delivery_every_days IS
  'How often this arrives: 1 = daily (milk, curd), 2 = alternate days '
  '(vegetables), NULL = a store item bought on a bill. The NEXT arrival is '
  'worked out from the last receipt, not from a schedule anyone maintains.';

-- Milk, curd and the rest of the fresh dairy: every morning.
UPDATE public.ingredients SET delivery_every_days = 1
WHERE delivery_every_days IS NULL
  AND btrim(name) ILIKE ANY (ARRAY[
    'Paneer','Amul Gold','amul curd','curd','CHHACH','mawa','Milk','Doodh','Dahi'
  ]);

-- Vegetables and fruit: every other day.
UPDATE public.ingredients SET delivery_every_days = 2
WHERE delivery_every_days IS NULL
  AND btrim(name) ILIKE ANY (ARRAY[
    'Onion','Potato','Tomato','Tomato Karate','Banana Karate','Beetroot',
    'Cabbage','Capsicum','Carrot','GAJAR','Cucumber','Ginger','Garlic',
    'Garlic Pleed','G Chili','Chili','Green Pease','Lemon','Mint',
    'Mint leaves','MIX VEG','MIX  VEG','Corrinder','Corriander leaves',
    'Pomegranate','sponge gourd','Bottle Groud','Locky','Coliflower Potli'
  ]);

-- arrives_daily stays as the plain "do not warn about this" answer, derived
-- from the cycle so the two can never drift apart.
UPDATE public.ingredients
   SET arrives_daily = (delivery_every_days IS NOT NULL),
       daily_decided_at = coalesce(daily_decided_at, now())
 WHERE arrives_daily IS DISTINCT FROM (delivery_every_days IS NOT NULL);

-- ---------- Free to order, and when the rest is coming ----------
-- Dropped rather than replaced: new columns land in the middle, and Postgres
-- will not rename a view's columns under CREATE OR REPLACE.
DROP VIEW IF EXISTS public.ingredient_availability;
CREATE VIEW public.ingredient_availability AS
SELECT i.id                AS ingredient_id,
       i.canteen_id,
       i.name,
       i.unit,
       i.current_stock,
       coalesce(i.arrives_daily, false)           AS arrives_daily,
       i.delivery_every_days,
       coalesce(c.committed, 0)                   AS committed,
       i.current_stock - coalesce(c.committed, 0) AS free_qty,
       coalesce(c.on_orders, '[]'::jsonb)         AS on_orders,
       li.last_received_on,
       -- Never a date in the past: an item that is overdue is expected today,
       -- not last Tuesday.
       CASE WHEN i.delivery_every_days IS NULL THEN NULL
            ELSE greatest(
                   coalesce(li.last_received_on, timezone('Asia/Kolkata', now())::date)
                     + i.delivery_every_days,
                   timezone('Asia/Kolkata', now())::date)
       END AS next_arrival
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
) c ON TRUE
LEFT JOIN LATERAL (
  SELECT (p.created_at AT TIME ZONE 'Asia/Kolkata')::date AS last_received_on
  FROM public.purchase_items pi
  JOIN public.purchases p ON p.id = pi.purchase_id
  WHERE pi.ingredient_id = i.id AND p.status = 'confirmed' AND pi.quantity > 0
  ORDER BY p.created_at DESC
  LIMIT 1
) li ON TRUE;

ALTER VIEW public.ingredient_availability SET (security_invoker = on);
GRANT SELECT ON public.ingredient_availability TO authenticated;
