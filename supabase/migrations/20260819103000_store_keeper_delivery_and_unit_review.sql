-- Store Keeper delivery calendar and safe historical-unit review.
-- Stock is not changed anywhere in this migration.

ALTER TABLE public.ingredients
  ADD COLUMN IF NOT EXISTS next_delivery_on date;

COMMENT ON COLUMN public.ingredients.next_delivery_on IS
  'Date confirmed by the Store Keeper for the next delivery. When blank, the receipt history plus delivery cycle is used.';

ALTER TABLE public.ingredients DROP CONSTRAINT IF EXISTS ingredients_delivery_every_days_check;
ALTER TABLE public.ingredients
  ADD CONSTRAINT ingredients_delivery_every_days_check
  CHECK (delivery_every_days BETWEEN 1 AND 365);

-- The operating rule agreed for the clean restart:
-- milk/curd daily, vegetables every two days, everything else weekly.
-- Items already recognised as vegetables keep their two-day cycle even when
-- an old scanner put them in the wrong category.
UPDATE public.ingredients
SET delivery_every_days = CASE
  WHEN regexp_replace(lower(btrim(name)), '[^a-z0-9]', '', 'g') = ANY (ARRAY[
    'amulgold','amulcurd','milk','doodh','curd','dahi'
  ]) THEN 1
  WHEN lower(category) = 'vegetables' OR delivery_every_days = 2 THEN 2
  ELSE 7
END,
arrives_daily = CASE
  WHEN regexp_replace(lower(btrim(name)), '[^a-z0-9]', '', 'g') = ANY (ARRAY[
    'amulgold','amulcurd','milk','doodh','curd','dahi'
  ]) THEN true
  ELSE false
END,
daily_decided_at = now();

CREATE OR REPLACE FUNCTION public.set_ingredient_delivery_schedule(
  p_ingredient_id uuid,
  p_every_days integer,
  p_next_delivery_on date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_item public.ingredients%ROWTYPE;
  v_old_days integer;
  v_old_date date;
BEGIN
  IF p_every_days IS NULL OR p_every_days NOT BETWEEN 1 AND 365 THEN
    RAISE EXCEPTION 'Delivery cycle must be between 1 and 365 days';
  END IF;

  SELECT * INTO v_item FROM public.ingredients WHERE id = p_ingredient_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item not found'; END IF;
  IF NOT (public.can_receive_stock() AND public.can_access_canteen(v_item.canteen_id)) THEN
    RAISE EXCEPTION 'Only the Store Keeper or manager can update this delivery date';
  END IF;

  v_old_days := v_item.delivery_every_days;
  v_old_date := v_item.next_delivery_on;

  UPDATE public.ingredients
     SET delivery_every_days = p_every_days,
         next_delivery_on = p_next_delivery_on,
         arrives_daily = (p_every_days = 1),
         daily_decided_at = now(),
         updated_at = now()
   WHERE id = p_ingredient_id;

  INSERT INTO public.action_logs
    (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES
    (auth.uid(), 'delivery_schedule_updated', 'ingredient', p_ingredient_id,
     v_item.canteen_id,
     jsonb_build_object('item', v_item.name,
                        'old_every_days', v_old_days, 'new_every_days', p_every_days,
                        'old_next_delivery_on', v_old_date,
                        'new_next_delivery_on', p_next_delivery_on));

  RETURN jsonb_build_object('item', v_item.name,
                            'delivery_every_days', p_every_days,
                            'next_delivery_on', p_next_delivery_on);
END;
$$;

REVOKE ALL ON FUNCTION public.set_ingredient_delivery_schedule(uuid, integer, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_ingredient_delivery_schedule(uuid, integer, date) TO authenticated;

DROP VIEW IF EXISTS public.ingredient_availability;
CREATE VIEW public.ingredient_availability AS
SELECT i.id AS ingredient_id,
       i.canteen_id,
       i.name,
       i.unit,
       i.current_stock,
       coalesce(i.arrives_daily, false) AS arrives_daily,
       i.delivery_every_days,
       i.next_delivery_on,
       coalesce(c.committed, 0) AS committed,
       i.current_stock - coalesce(c.committed, 0) AS free_qty,
       coalesce(c.on_orders, '[]'::jsonb) AS on_orders,
       li.last_received_on,
       greatest(
         coalesce(i.next_delivery_on,
                  coalesce(li.last_received_on, timezone('Asia/Kolkata', now())::date)
                    + i.delivery_every_days),
         timezone('Asia/Kolkata', now())::date
       ) AS next_arrival
FROM public.ingredients i
LEFT JOIN LATERAL (
  SELECT sum(greatest(coalesce(ri.approved_qty, ri.requested_qty)
                      - coalesce(ri.issued_qty, 0), 0)) AS committed,
         jsonb_agg(jsonb_build_object('req_no', r.req_no, 'status', r.status,
                                      'qty', coalesce(ri.approved_qty, ri.requested_qty))
                   ORDER BY r.req_no) AS on_orders
  FROM public.requisition_items ri
  JOIN public.requisitions r ON r.id = ri.requisition_id
  WHERE ri.ingredient_id = i.id
    AND r.status IN ('pending', 'approved')
) c ON true
LEFT JOIN LATERAL (
  SELECT (p.created_at AT TIME ZONE 'Asia/Kolkata')::date AS last_received_on
  FROM public.purchase_items pi
  JOIN public.purchases p ON p.id = pi.purchase_id
  WHERE pi.ingredient_id = i.id AND p.status = 'confirmed' AND pi.quantity > 0
  ORDER BY p.created_at DESC
  LIMIT 1
) li ON true;

ALTER VIEW public.ingredient_availability SET (security_invoker = on);
GRANT SELECT ON public.ingredient_availability TO authenticated;

-- Old bill lines whose unit differs from the ingredient master. This view is
-- deliberately read-only: the Store Keeper verifies the paper bill and then
-- fixes today's shelf through Stock Verification. We never invent a kg/box
-- conversion or rewrite the cost of food already issued in the past.
CREATE OR REPLACE VIEW public.historical_unit_review AS
SELECT pi.id AS purchase_item_id,
       p.id AS purchase_id,
       p.canteen_id,
       p.created_at,
       p.status,
       pi.item_name,
       pi.quantity AS bill_quantity,
       pi.unit AS bill_unit,
       i.id AS ingredient_id,
       i.name AS ingredient_name,
       i.unit AS master_unit,
       pi.stock_quantity,
       pi.stock_unit,
       coalesce(pi.conversion_confirmed, false) AS conversion_confirmed,
       pi.conversion_note
FROM public.purchase_items pi
JOIN public.purchases p ON p.id = pi.purchase_id
JOIN public.ingredients i ON i.id = pi.ingredient_id
WHERE lower(regexp_replace(coalesce(pi.unit,''), '[^a-z]', '', 'g'))
      <> lower(regexp_replace(coalesce(i.unit,''), '[^a-z]', '', 'g'));

ALTER VIEW public.historical_unit_review SET (security_invoker = on);
GRANT SELECT ON public.historical_unit_review TO authenticated;

-- Packaging words should not hide a duplicate: "Tomato Karate" was a box
-- label for Tomato. Exact/near spelling rules remain conservative otherwise.
CREATE OR REPLACE FUNCTION public.similar_ingredients(p_canteen_id uuid)
RETURNS TABLE(a_id uuid, a_name text, a_stock numeric,
              b_id uuid, b_name text, b_stock numeric,
              distance integer, why text)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH n AS (
    SELECT id, name, current_stock, canteen_id,
           regexp_replace(
             regexp_replace(lower(name), '(karate|crate|box)', '', 'g'),
             '[^a-z0-9]', '', 'g') AS key
    FROM public.ingredients
    WHERE canteen_id = p_canteen_id
  ), pairs AS (
    SELECT a.id a_id, a.name a_name, a.current_stock a_stock,
           b.id b_id, b.name b_name, b.current_stock b_stock,
           a.key ak, b.key bk, levenshtein(a.key,b.key) d,
           (SELECT count(*)::int
              FROM generate_series(1,least(length(a.key),length(b.key))) g
             WHERE substr(a.key,g,1)=substr(b.key,g,1)
               AND substr(a.key,1,g)=substr(b.key,1,g)) shared_start
    FROM n a JOIN n b ON b.id > a.id
  )
  SELECT a_id,a_name,a_stock,b_id,b_name,b_stock,d,
         CASE WHEN d=0 THEN 'same item after spacing or packaging words are removed'
              ELSE 'one looks like a misspelling of the other' END
  FROM pairs
  WHERE public.can_access_canteen(p_canteen_id)
    AND (d=0 OR (d<=2 AND least(length(ak),length(bk))>=6 AND shared_start>=4))
  ORDER BY d,a_name;
$$;

GRANT EXECUTE ON FUNCTION public.similar_ingredients(uuid) TO authenticated;
