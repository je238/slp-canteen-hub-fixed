-- ============================================================
-- THE LOTS MUST FOLLOW THE SHELF
--
-- Kabuli Chana: 160 kg on the shelf, 1270 kg in the lots. Onion: 200 against
-- 1500. Ginger: 3 against 245. Sixty-four items out of ninety-six, and the
-- lots held three and a third lakh more than the store did.
--
-- Mine. adjust_stock changed current_stock and left the lots alone. Every
-- time the store keeper counted an item and typed a smaller figure, the
-- quantity came down and the lots behind it did not — so the shelf said 160
-- and the money still sat against 1270.
--
-- That is why the inventory value read 11.47 lakh: it was adding up lots that
-- were no longer there. And it is why nothing agreed with anything.
--
-- Three parts:
--
--   * adjust_stock now moves the lots with the figure. Counted down, the
--     oldest lots are drawn from, exactly as an issue would. Counted up, a
--     lot is opened for the difference at the item's own rate, so the new
--     goods have a price attached instead of floating.
--   * the sixty-four already out of step are reconciled the same way.
--   * the view is capped, so even if something ever diverges again it can
--     only value what the shelf says is there — never more.
--
-- Safe to re-run.
-- ============================================================

-- ---------- Bring the lots to a given quantity ----------
CREATE OR REPLACE FUNCTION public.reconcile_lots(p_ingredient_id UUID)
RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ing public.ingredients%ROWTYPE; v_lots NUMERIC; v_gap NUMERIC;
  v_take NUMERIC; v_b RECORD;
BEGIN
  SELECT * INTO v_ing FROM public.ingredients WHERE id = p_ingredient_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT coalesce(sum(qty_remaining), 0) INTO v_lots
  FROM public.ingredient_batches WHERE ingredient_id = p_ingredient_id;

  v_gap := v_ing.current_stock - v_lots;
  IF abs(v_gap) < 0.0005 THEN RETURN 0; END IF;

  PERFORM public.allow_stock_move();

  IF v_gap < 0 THEN
    -- the shelf holds less than the lots: draw the difference off, oldest
    -- first, the same order an issue would take it in
    v_gap := -v_gap;
    FOR v_b IN
      SELECT id, qty_remaining FROM public.ingredient_batches
      WHERE ingredient_id = p_ingredient_id AND qty_remaining > 0
      ORDER BY received_at, id
    LOOP
      EXIT WHEN v_gap <= 0;
      v_take := least(v_gap, v_b.qty_remaining);
      UPDATE public.ingredient_batches
         SET qty_remaining = qty_remaining - v_take WHERE id = v_b.id;
      v_gap := v_gap - v_take;
    END LOOP;
  ELSE
    -- the shelf holds more: open a lot for the difference at the item's own
    -- rate, so the extra goods carry a price rather than floating unvalued
    INSERT INTO public.ingredient_batches
      (ingredient_id, canteen_id, qty_received, qty_remaining, rate)
    VALUES (p_ingredient_id, v_ing.canteen_id, v_gap, v_gap,
            coalesce(v_ing.cost_per_unit, 0));
  END IF;

  RETURN v_ing.current_stock - v_lots;
END;
$$;
REVOKE ALL ON FUNCTION public.reconcile_lots(UUID) FROM PUBLIC, anon, authenticated;

-- ---------- Adjusting stock now moves the lots too ----------
CREATE OR REPLACE FUNCTION public.adjust_stock(
  p_ingredient_id UUID, p_new_stock NUMERIC, p_reason TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ing public.ingredients%ROWTYPE; v_delta NUMERIC; v_by_store BOOLEAN := false;
        v_reason TEXT;
BEGIN
  IF p_new_stock < 0 THEN
    RAISE EXCEPTION 'Stock cannot be negative';
  END IF;
  SELECT * INTO v_ing FROM public.ingredients WHERE id = p_ingredient_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown item'; END IF;
  IF NOT public.can_access_canteen(v_ing.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  IF public.is_admin_editor() THEN
    NULL;
  ELSIF public.is_store_keeper() AND public.stock_editing_is_open(v_ing.canteen_id) THEN
    v_by_store := true;
  ELSE
    RAISE EXCEPTION
      'Stock cannot be typed in. Receive it against a bill, issue it against an approved order, or ask an admin to correct it.';
  END IF;

  v_reason := btrim(coalesce(p_reason, ''));
  IF v_reason = '' THEN
    IF v_by_store THEN v_reason := 'Opening count corrected by the store keeper';
    ELSE RAISE EXCEPTION 'A reason is required for a manual stock adjustment';
    END IF;
  END IF;

  v_delta := p_new_stock - v_ing.current_stock;
  IF v_delta = 0 THEN RETURN jsonb_build_object('changed', false); END IF;

  PERFORM public.allow_stock_move();
  UPDATE public.ingredients SET current_stock = p_new_stock WHERE id = p_ingredient_id;

  -- The money follows the goods. Without this the quantity came down and the
  -- lots stayed, and the shelf went on being valued at stock it did not hold.
  PERFORM public.reconcile_lots(p_ingredient_id);

  INSERT INTO public.stock_ledger
    (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type,
     created_by, service_date, value)
  VALUES (p_ingredient_id, v_ing.canteen_id, v_delta, p_new_stock,
          'Manual adjustment: ' || v_reason, 'manual', auth.uid(),
          (now() AT TIME ZONE 'Asia/Kolkata')::date,
          round(abs(v_delta) * coalesce(v_ing.cost_per_unit, 0), 2));

  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'stock_adjusted', 'ingredient', p_ingredient_id, v_ing.canteen_id,
          jsonb_build_object('item', v_ing.name, 'was', v_ing.current_stock,
                             'now', p_new_stock, 'delta', v_delta,
                             'reason', v_reason, 'by_store_keeper', v_by_store));

  IF v_by_store THEN
    INSERT INTO public.notifications
      (canteen_id, target_role, title, body, link, ref_type, ref_id)
    VALUES (v_ing.canteen_id, 'admin',
            format('Stock corrected by the store keeper — %s', v_ing.name),
            format('%s %s → %s %s (%s%s). Reason: "%s". Worth ₹%s at %s/%s.',
                   v_ing.name, v_ing.current_stock, p_new_stock, v_ing.unit,
                   CASE WHEN v_delta > 0 THEN '+' ELSE '' END, v_delta, v_reason,
                   round(abs(v_delta) * coalesce(v_ing.cost_per_unit, 0), 2),
                   coalesce(v_ing.cost_per_unit, 0), v_ing.unit),
            '/inventory', 'ingredient', p_ingredient_id);
  END IF;

  RETURN jsonb_build_object('changed', true, 'delta', v_delta, 'balance', p_new_stock,
                            'by_store_keeper', v_by_store);
END;
$$;
REVOKE ALL ON FUNCTION public.adjust_stock(UUID, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adjust_stock(UUID, NUMERIC, TEXT) TO authenticated;

-- ---------- The sixty-four already out of step ----------
DO $$
DECLARE r RECORD; v_fixed INT := 0;
BEGIN
  FOR r IN
    SELECT i.id FROM public.ingredients i
    WHERE abs(i.current_stock -
              coalesce((SELECT sum(b.qty_remaining) FROM public.ingredient_batches b
                        WHERE b.ingredient_id = i.id), 0)) > 0.0005
  LOOP
    PERFORM public.reconcile_lots(r.id);
    v_fixed := v_fixed + 1;
  END LOOP;
  RAISE NOTICE 'reconciled % items', v_fixed;
END $$;

-- ---------- And a cap, so it can never overstate again ----------
DROP VIEW IF EXISTS public.ingredient_rates CASCADE;
CREATE VIEW public.ingredient_rates AS
SELECT i.id AS ingredient_id, i.canteen_id, i.name, i.category, i.unit,
       i.current_stock,
       coalesce(lp.rate, i.cost_per_unit, 0) AS latest_rate,
       lp.purchased_at AS rate_from,
       (lp.rate IS NOT NULL) AS rate_from_invoice,
       -- never value more than the shelf says is there
       round(least(bt.qty, i.current_stock) * CASE WHEN bt.qty > 0 THEN bt.value / bt.qty ELSE 0 END
             + greatest(i.current_stock - bt.qty, 0) * coalesce(i.cost_per_unit, 0), 2) AS stock_value,
       CASE WHEN i.current_stock > 0
            THEN round((least(bt.qty, i.current_stock) * CASE WHEN bt.qty > 0 THEN bt.value / bt.qty ELSE 0 END
                        + greatest(i.current_stock - bt.qty, 0) * coalesce(i.cost_per_unit, 0))
                       / i.current_stock, 4)
            ELSE coalesce(lp.rate, i.cost_per_unit, 0)
       END AS stock_rate,
       bt.lots AS lots,
       greatest(i.current_stock - bt.qty, 0) AS unlotted_qty,
       coalesce(i.cost_per_unit, 0) AS unlotted_rate
FROM public.ingredients i
LEFT JOIN LATERAL (
  SELECT pi.rate, p.created_at AS purchased_at
  FROM public.purchase_items pi JOIN public.purchases p ON p.id = pi.purchase_id
  WHERE pi.ingredient_id = i.id AND p.status = 'confirmed' AND pi.rate > 0
  ORDER BY p.created_at DESC LIMIT 1
) lp ON TRUE
CROSS JOIN LATERAL (
  SELECT coalesce(sum(b.qty_remaining), 0) AS qty,
         coalesce(sum(b.qty_remaining * b.rate), 0) AS value,
         coalesce(jsonb_agg(jsonb_build_object('qty', b.qty_remaining, 'rate', b.rate)
                            ORDER BY b.received_at, b.id), '[]'::jsonb) AS lots
  FROM public.ingredient_batches b
  WHERE b.ingredient_id = i.id AND b.qty_remaining > 0
) bt;

ALTER VIEW public.ingredient_rates SET (security_invoker = on);
GRANT SELECT ON public.ingredient_rates TO authenticated;
