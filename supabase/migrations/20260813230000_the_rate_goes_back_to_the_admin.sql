-- ============================================================
-- THE RATE GOES BACK TO THE ADMIN
--
-- The store keeper was given the rate for the setting-up days, alongside the
-- count. The count is his — he is the one holding the sack and walking the
-- shelf, and nobody else can do it. The rate is not: what a kilo cost is a
-- fact off a bill, and the man who receives the goods should not also be the
-- man who decides what they were worth.
--
-- The quantity window stays open until it shuts itself. Only the price comes
-- back to the admin. The item's NAME was never his to change either — that
-- has always been admin-only, and stays that way.
--
-- Safe to re-run.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_ingredient_rate(
  p_ingredient_id UUID, p_rate NUMERIC, p_reason TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ing public.ingredients%ROWTYPE; v_reason TEXT; v_lots INT := 0; v_swing NUMERIC;
BEGIN
  IF p_rate IS NULL OR p_rate < 0 THEN
    RAISE EXCEPTION 'A rate cannot be negative';
  END IF;
  SELECT * INTO v_ing FROM public.ingredients WHERE id = p_ingredient_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown item'; END IF;
  IF NOT public.can_access_canteen(v_ing.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  IF NOT public.is_admin_editor() THEN
    RAISE EXCEPTION
      'A rate can only be corrected by an admin. The store keeper records what arrived and what is on the shelf; what it cost comes off the bill.';
  END IF;

  v_reason := btrim(coalesce(p_reason, ''));
  IF v_reason = '' THEN
    RAISE EXCEPTION 'A reason is required for a rate correction';
  END IF;

  IF coalesce(v_ing.cost_per_unit, 0) = p_rate THEN
    RETURN jsonb_build_object('changed', false);
  END IF;

  v_swing := round(v_ing.current_stock * (p_rate - coalesce(v_ing.cost_per_unit, 0)), 2);

  PERFORM public.allow_stock_move();
  UPDATE public.ingredients SET cost_per_unit = p_rate WHERE id = p_ingredient_id;

  UPDATE public.ingredient_batches SET rate = p_rate
   WHERE ingredient_id = p_ingredient_id AND qty_remaining = qty_received;
  GET DIAGNOSTICS v_lots = ROW_COUNT;

  IF v_swing <> 0 THEN
    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason,
       reference_type, created_by, service_date, value)
    VALUES (p_ingredient_id, v_ing.canteen_id, 0, v_ing.current_stock,
            format('Rate corrected %s to %s per %s: %s',
                   coalesce(v_ing.cost_per_unit, 0), p_rate, v_ing.unit, v_reason),
            'reprice', auth.uid(), (now() AT TIME ZONE 'Asia/Kolkata')::date, v_swing);
  END IF;

  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'rate_corrected', 'ingredient', p_ingredient_id, v_ing.canteen_id,
          jsonb_build_object('item', v_ing.name, 'was', v_ing.cost_per_unit, 'now', p_rate,
                             'lots_repriced', v_lots, 'value_swing', v_swing, 'reason', v_reason));

  RETURN jsonb_build_object('changed', true, 'was', v_ing.cost_per_unit, 'now', p_rate,
                            'lots_repriced', v_lots, 'value_swing', v_swing);
END;
$$;
REVOKE ALL ON FUNCTION public.set_ingredient_rate(UUID, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_ingredient_rate(UUID, NUMERIC, TEXT) TO authenticated;
