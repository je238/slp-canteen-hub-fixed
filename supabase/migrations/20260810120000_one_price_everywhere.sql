-- ============================================================
-- ONE PRICE, EVERYWHERE
--
-- Buy 50 kg at 50, then 20 kg at 54, and the store holds 70 kg that cost
-- 3,580. The books already knew that — stock leaves oldest-lot-first and is
-- charged at the rate that lot was bought at. But every screen multiplied the
-- whole shelf by the LAST rate paid, because a purchase overwrote
-- ingredients.cost_per_unit and nothing kept the older figure. So the shelf
-- showed 70 x 54 = 3,780, and a chef ordering 60 kg was quoted 3,240 against
-- a real charge of 3,040.
--
-- Nobody was stealing the 200. But in a system whose whole job is to make
-- theft visible, a number on the screen that does not match the number in the
-- report is worse than useless — the first person to spot the gap will
-- distrust the app, not the shelf.
--
-- The batches were right all along. This makes every screen ask them.
--
-- Safe to re-run.
-- ============================================================

-- ---------- What taking stock out would cost, without taking it ----------
-- Same walk as consume_batches_fifo, but it changes nothing — so a screen can
-- quote a chef the figure the store will actually be charged.
CREATE OR REPLACE FUNCTION public.fifo_cost_preview(p_ingredient_id UUID, p_qty NUMERIC)
RETURNS NUMERIC LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_left NUMERIC := p_qty; v_take NUMERIC; v_cost NUMERIC := 0; v_b RECORD;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN RETURN 0; END IF;
  FOR v_b IN
    SELECT qty_remaining, rate FROM public.ingredient_batches
    WHERE ingredient_id = p_ingredient_id AND qty_remaining > 0
    ORDER BY received_at, id
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := least(v_left, v_b.qty_remaining);
    v_cost := v_cost + v_take * coalesce(v_b.rate, 0);
    v_left := v_left - v_take;
  END LOOP;
  -- Stock with no batch behind it — opening balances, hand adjustments, the
  -- far side of a merge. Valued at the item's standard cost, exactly as
  -- consume_batches_fifo will value it when the goods actually move.
  IF v_left > 0 THEN
    v_cost := v_cost + v_left *
      coalesce((SELECT cost_per_unit FROM public.ingredients WHERE id = p_ingredient_id), 0);
  END IF;
  RETURN v_cost;
END;
$$;
REVOKE ALL ON FUNCTION public.fifo_cost_preview(UUID, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fifo_cost_preview(UUID, NUMERIC) TO authenticated;

-- ---------- What the shelf is worth, and therefore what a kg is worth ------
-- stock_value is the money actually tied up in the goods on hand.
-- stock_rate is that divided by the quantity — the one per-kg figure a screen
-- should ever show, because it is what the next kg out will be charged at on
-- average. latest_rate stays: it answers a different question (what the next
-- delivery is likely to cost), and the two are labelled apart on screen.
DROP VIEW IF EXISTS public.ingredient_rates CASCADE;
CREATE VIEW public.ingredient_rates AS
SELECT i.id AS ingredient_id,
       i.canteen_id,
       i.name,
       i.category,
       i.unit,
       i.current_stock,
       coalesce(lp.rate, i.cost_per_unit, 0) AS latest_rate,
       lp.purchased_at AS rate_from,
       (lp.rate IS NOT NULL)                AS rate_from_invoice,
       round(bt.value + greatest(i.current_stock - bt.qty, 0)
                        * coalesce(i.cost_per_unit, 0), 2)      AS stock_value,
       CASE WHEN i.current_stock > 0
            THEN round((bt.value + greatest(i.current_stock - bt.qty, 0)
                        * coalesce(i.cost_per_unit, 0)) / i.current_stock, 4)
            ELSE coalesce(lp.rate, i.cost_per_unit, 0)
       END                                                       AS stock_rate
FROM public.ingredients i
LEFT JOIN LATERAL (
  SELECT pi.rate, p.created_at AS purchased_at
  FROM public.purchase_items pi
  JOIN public.purchases p ON p.id = pi.purchase_id
  WHERE pi.ingredient_id = i.id
    AND p.status = 'confirmed'
    AND pi.rate > 0
  ORDER BY p.created_at DESC
  LIMIT 1
) lp ON TRUE
CROSS JOIN LATERAL (
  SELECT coalesce(sum(b.qty_remaining), 0)                AS qty,
         coalesce(sum(b.qty_remaining * b.rate), 0)        AS value
  FROM public.ingredient_batches b
  WHERE b.ingredient_id = i.id AND b.qty_remaining > 0
) bt;

ALTER VIEW public.ingredient_rates SET (security_invoker = on);
GRANT SELECT ON public.ingredient_rates TO authenticated;

-- ---------- Keep the figure that was actually charged ----------
-- issue_requisition already works out the FIFO cost of every line and then
-- throws it away, returning only the total. So after issue there was no
-- record of what the kitchen was charged for a given item, and the screen
-- fell back to the estimate frozen at order time. Store it.
ALTER TABLE public.requisition_items
  ADD COLUMN IF NOT EXISTS issued_value NUMERIC;
COMMENT ON COLUMN public.requisition_items.issued_value IS
  'What this line actually cost the store, oldest lot first, at issue time.';

CREATE OR REPLACE FUNCTION public.issue_requisition(p_req_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.requisitions%ROWTYPE; v_line RECORD; v_new NUMERIC;
        v_n INT := 0; v_cost NUMERIC; v_total NUMERIC := 0; v_short TEXT := '';
BEGIN
  SELECT * INTO v_req FROM public.requisitions WHERE id = p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown requisition'; END IF;
  IF v_req.status = 'issued' THEN RETURN jsonb_build_object('already', true); END IF;
  IF v_req.status <> 'approved' THEN
    RAISE EXCEPTION 'Only an approved requisition can be issued (current status: %)', v_req.status;
  END IF;
  IF NOT public.can_issue_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can issue stock';
  END IF;
  IF NOT public.can_access_canteen(v_req.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  -- Check the whole order before moving any of it, so a short line does not
  -- leave half a requisition issued.
  SELECT string_agg(format('%s: asked %s, only %s on the shelf',
                           i.name, ri.approved_qty, i.current_stock), '; ')
  INTO v_short
  FROM public.requisition_items ri
  JOIN public.ingredients i ON i.id = ri.ingredient_id
  WHERE ri.requisition_id = p_req_id
    AND coalesce(ri.approved_qty, 0) > 0
    AND i.current_stock < ri.approved_qty;

  IF coalesce(v_short, '') <> '' THEN
    RAISE EXCEPTION
      'Not enough stock to issue this order — %. Record the delivery first, then issue.', v_short;
  END IF;

  PERFORM public.allow_stock_move();

  FOR v_line IN
    SELECT ri.id, ri.ingredient_id, coalesce(ri.approved_qty, 0) AS qty, i.name
    FROM public.requisition_items ri JOIN public.ingredients i ON i.id = ri.ingredient_id
    WHERE ri.requisition_id = p_req_id AND coalesce(ri.approved_qty, 0) > 0
    ORDER BY ri.ingredient_id
  LOOP
    UPDATE public.ingredients SET current_stock = current_stock - v_line.qty
      WHERE id = v_line.ingredient_id AND canteen_id = v_req.canteen_id
      RETURNING current_stock INTO v_new;
    IF NOT FOUND THEN RAISE EXCEPTION 'Ingredient % does not belong to this site', v_line.name; END IF;

    v_cost := public.consume_batches_fifo(v_line.ingredient_id, v_req.canteen_id, v_line.qty);
    v_total := v_total + v_cost;

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, reference_id, created_by)
    VALUES (v_line.ingredient_id, v_req.canteen_id, -v_line.qty, v_new,
            'Requisition #' || v_req.req_no || ' issued to kitchen', 'issue', p_req_id, auth.uid());

    -- The rate here is what was charged, not what was quoted. Both are kept:
    -- the difference between them is the price moving, and that is worth
    -- being able to see rather than quietly smoothing over.
    UPDATE public.requisition_items
       SET issued_qty = v_line.qty,
           issued_value = round(v_cost, 2)
     WHERE id = v_line.id;
    v_n := v_n + 1;
  END LOOP;

  UPDATE public.requisitions SET status = 'issued', issued_by = auth.uid(), issued_at = now()
  WHERE id = p_req_id;
  RETURN jsonb_build_object('issued_lines', v_n, 'fifo_value', round(v_total, 2));
END;
$$;

-- ---------- The lots themselves, so a screen can be exact ----------
-- stock_rate blends the whole shelf, which is right for valuing it but not
-- for quoting a specific quantity: 60 kg off 50@50 + 20@54 blends to 3,069
-- when the store will really be charged 3,040. Handing the screen the lots
-- lets it walk them the same way the issue will, without a round trip per
-- keystroke. Oldest first — the order they will actually be consumed in.
DROP VIEW IF EXISTS public.ingredient_rates CASCADE;
CREATE VIEW public.ingredient_rates AS
SELECT i.id AS ingredient_id,
       i.canteen_id,
       i.name,
       i.category,
       i.unit,
       i.current_stock,
       coalesce(lp.rate, i.cost_per_unit, 0) AS latest_rate,
       lp.purchased_at AS rate_from,
       (lp.rate IS NOT NULL)                AS rate_from_invoice,
       round(bt.value + greatest(i.current_stock - bt.qty, 0)
                        * coalesce(i.cost_per_unit, 0), 2)      AS stock_value,
       CASE WHEN i.current_stock > 0
            THEN round((bt.value + greatest(i.current_stock - bt.qty, 0)
                        * coalesce(i.cost_per_unit, 0)) / i.current_stock, 4)
            ELSE coalesce(lp.rate, i.cost_per_unit, 0)
       END                                                       AS stock_rate,
       bt.lots                                                   AS lots,
       -- Stock with no lot behind it: opening balances, hand adjustments, the
       -- far side of a merge. Priced at the item's standard cost, exactly as
       -- consume_batches_fifo prices it when the goods move.
       greatest(i.current_stock - bt.qty, 0)                     AS unlotted_qty,
       coalesce(i.cost_per_unit, 0)                              AS unlotted_rate
FROM public.ingredients i
LEFT JOIN LATERAL (
  SELECT pi.rate, p.created_at AS purchased_at
  FROM public.purchase_items pi
  JOIN public.purchases p ON p.id = pi.purchase_id
  WHERE pi.ingredient_id = i.id
    AND p.status = 'confirmed'
    AND pi.rate > 0
  ORDER BY p.created_at DESC
  LIMIT 1
) lp ON TRUE
CROSS JOIN LATERAL (
  SELECT coalesce(sum(b.qty_remaining), 0)              AS qty,
         coalesce(sum(b.qty_remaining * b.rate), 0)      AS value,
         coalesce(jsonb_agg(jsonb_build_object('qty', b.qty_remaining, 'rate', b.rate)
                            ORDER BY b.received_at, b.id), '[]'::jsonb) AS lots
  FROM public.ingredient_batches b
  WHERE b.ingredient_id = i.id AND b.qty_remaining > 0
) bt;

ALTER VIEW public.ingredient_rates SET (security_invoker = on);
GRANT SELECT ON public.ingredient_rates TO authenticated;
