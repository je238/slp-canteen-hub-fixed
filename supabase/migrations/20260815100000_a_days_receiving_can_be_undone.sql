-- ============================================================
-- A DAY'S RECEIVING CAN BE UNDONE
--
-- On 15/08 the store keeper booked nine bills in, and the units were wrong
-- throughout: crates typed as kilos (Banana 6 "kg" at ₹630, Tomato 2 "kg" at
-- ₹500), bags and tins typed as pieces (Aata 10 "pcs" at ₹1580). ₹1,68,263
-- of goods, every line describing a quantity nobody can cook from — the chef
-- orders in kilos and the shelf is counted in crates.
--
-- There was no way to take a booked-in bill back out. Correcting the lines
-- one by one leaves the lots and the ledger behind, and correcting the ledger
-- by hand is how the shelf and the book stopped agreeing the first time. So
-- the whole receipt comes out in one piece: the stock it added, the lots it
-- opened, the ledger rows it wrote, its lines, and the receipt itself.
--
-- Two things this deliberately does NOT do:
--
--   * It does not refuse when the goods have already been eaten. Tomato's two
--     units went to the kitchen at two o'clock, so there are no two units to
--     put back. The shelf cannot hold minus two — the database forbids it,
--     rightly — so the reversal stops at zero and the part that could not
--     come back is written to the ledger in its own row, saying exactly that:
--     the goods moved, the bill did not. Shelf and ledger stay equal, which
--     is the one property this whole system rests on, and the shortfall is
--     visible instead of buried. It is reported back to the caller too, so
--     nobody meets it by surprise.
--
--   * It does not touch the requisition that consumed the goods. What the
--     kitchen was given is a separate fact from what the store booked in.
--
-- Admin only. Every deletion is logged with the items and the money.
--
-- Safe to re-run.
-- ============================================================
CREATE OR REPLACE FUNCTION public.delete_purchase(p_purchase_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_p public.purchases%ROWTYPE;
  v_lines JSONB; v_negatives JSONB; v_lots INT; v_ledger INT; v_n INT;
BEGIN
  SELECT * INTO v_p FROM public.purchases WHERE id = p_purchase_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown receipt'; END IF;
  IF NOT public.is_admin_editor() THEN
    RAISE EXCEPTION 'Only an admin can remove a booked-in receipt';
  END IF;
  IF NOT public.can_access_canteen(v_p.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  -- What is about to be undone, recorded before it stops being visible.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'item', coalesce(i.name, pi.item_name), 'qty', pi.quantity,
           'unit', coalesce(pi.unit, i.unit), 'rate', pi.rate, 'total', pi.total)), '[]'::jsonb)
    INTO v_lines
    FROM public.purchase_items pi
    LEFT JOIN public.ingredients i ON i.id = pi.ingredient_id;

  PERFORM public.allow_stock_move();

  -- How much of this receipt is still on the shelf to take back, and how much
  -- has already been cooked. Worked out before anything moves.
  CREATE TEMP TABLE _undo ON COMMIT DROP AS
  SELECT x.ingredient_id,
         x.qty                                            AS booked,
         least(x.qty, greatest(ing.current_stock, 0))      AS can_reverse,
         x.qty - least(x.qty, greatest(ing.current_stock, 0)) AS short,
         ing.current_stock, ing.name, ing.unit, ing.canteen_id
    FROM (SELECT ingredient_id, sum(quantity) AS qty
            FROM public.purchase_items
           WHERE purchase_id = p_purchase_id AND ingredient_id IS NOT NULL
           GROUP BY ingredient_id) x
    JOIN public.ingredients ing ON ing.id = x.ingredient_id;

  UPDATE public.ingredients ing
     SET current_stock = ing.current_stock - u.can_reverse
    FROM _undo u WHERE ing.id = u.ingredient_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'item', name, 'booked', booked, 'could_not_come_back', short, 'unit', unit)), '[]'::jsonb)
    INTO v_negatives
    FROM _undo WHERE short > 0;

  DELETE FROM public.ingredient_batches WHERE purchase_id = p_purchase_id;
  GET DIAGNOSTICS v_lots = ROW_COUNT;

  DELETE FROM public.stock_ledger
   WHERE reference_type = 'purchase' AND reference_id = p_purchase_id;
  GET DIAGNOSTICS v_ledger = ROW_COUNT;

  -- The part already cooked leaves its own row, so the ledger still adds up
  -- to the shelf and the gap has a sentence attached to it.
  INSERT INTO public.stock_ledger
    (ingredient_id, canteen_id, change_qty, balance_after, reason,
     reference_type, created_by, service_date, value)
  SELECT u.ingredient_id, u.canteen_id, u.short, u.current_stock - u.can_reverse,
         format('%s %s of this reached the kitchen before the receipt was removed — the goods moved, the bill did not',
                u.short, u.unit),
         'manual', auth.uid(), (now() AT TIME ZONE 'Asia/Kolkata')::date, 0
    FROM _undo u WHERE u.short > 0;

  DELETE FROM public.purchase_items WHERE purchase_id = p_purchase_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  DELETE FROM public.purchases WHERE id = p_purchase_id;

  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'purchase_deleted', 'purchase', p_purchase_id, v_p.canteen_id,
          jsonb_build_object('total', v_p.total_amount, 'booked_at', v_p.created_at,
                             'booked_by', v_p.created_by, 'lines', v_lines,
                             'lots_removed', v_lots, 'ledger_rows_removed', v_ledger,
                             'went_negative', v_negatives));

  RETURN jsonb_build_object('deleted', true, 'total', v_p.total_amount,
                            'lines_removed', v_n, 'lots_removed', v_lots,
                            'ledger_rows_removed', v_ledger,
                            'went_negative', v_negatives);
END;
$$;
REVOKE ALL ON FUNCTION public.delete_purchase(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_purchase(UUID) TO authenticated;
