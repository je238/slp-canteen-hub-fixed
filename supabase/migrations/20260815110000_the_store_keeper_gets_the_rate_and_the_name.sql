-- ============================================================
-- THE STORE KEEPER GETS THE RATE AND THE NAME BACK
--
-- Both were taken away on 13/08 and the owner has asked for them back. The
-- reasoning that removed them has not stopped being true: the man who
-- receives the goods deciding what they were worth is a bad shape, and a name
-- is how two piles of the same thing become one pile on paper.
--
-- But he is also the only person holding the bill at seven in the evening,
-- and the only one who knows that "G Chilly" and "G Chilli" came out of the
-- same sack. Today proved the cost of making him wait: nine bills went in
-- with crates typed as kilos, and every one of them had to be destroyed
-- because nobody at the shelf could fix a line.
--
-- So the door opens and a light is left on over it. Every rate change and
-- every rename lands in action_logs with who did it, what it was and what it
-- became, readable through item_edit_log(). Neither act is silent.
--
-- What does NOT come back: the stock figure. Rewriting the quantity is how a
-- shortage gets written off as spillage by the very person it points at, and
-- that is a different act from copying a price off a bill.
--
-- Safe to re-run.
-- ============================================================

-- ---------- 1. The rate, off the bill in his hand ----------
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

  IF NOT (public.is_admin_editor() OR public.is_store_keeper()) THEN
    RAISE EXCEPTION
      'A rate is corrected by the store keeper off the bill, or by an admin.';
  END IF;

  -- The reason is the whole safeguard now that two roles can do this. It is
  -- what an owner reads six weeks later when the shelf value moved and nobody
  -- remembers why.
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

  -- Only lots nothing has been drawn from. A lot already eaten out of was
  -- costed at the rate it was eaten at, and rewriting that rewrites history.
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

-- ---------- 2. The name, off the sack in his hand ----------
-- Renaming goes through its own function rather than by loosening the edit
-- trigger, for two reasons. That trigger also guards the unit, the category
-- and the reorder levels, and none of those were asked for — the unit least
-- of all, on the day crates typed as kilos cost a whole afternoon. And a
-- rename that goes through a function can be logged; a bare UPDATE cannot.
CREATE OR REPLACE FUNCTION public.rename_ingredient(
  p_ingredient_id UUID, p_name TEXT, p_reason TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ing public.ingredients%ROWTYPE; v_name TEXT; v_reason TEXT; v_clash TEXT;
BEGIN
  SELECT * INTO v_ing FROM public.ingredients WHERE id = p_ingredient_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown item'; END IF;
  IF NOT public.can_access_canteen(v_ing.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;
  IF NOT (public.is_admin_editor() OR public.is_store_keeper()) THEN
    RAISE EXCEPTION 'Only the store keeper or an admin can rename an item';
  END IF;

  v_name := btrim(coalesce(p_name, ''));
  IF v_name = '' THEN RAISE EXCEPTION 'A name cannot be blank'; END IF;
  IF length(v_name) < 2 THEN RAISE EXCEPTION 'That name is too short to find later'; END IF;
  IF v_name = v_ing.name THEN RETURN jsonb_build_object('changed', false); END IF;

  -- Renaming ONTO an existing name is the thing that must not happen quietly.
  -- Two rows both called "Sev Moti" holding 30 kg and 25 kg is worse than the
  -- typo was: the list shows one word twice and neither figure is the stock.
  -- That job is a merge, which carries the history and the lots across, and
  -- it is a different button.
  SELECT name INTO v_clash FROM public.ingredients
   WHERE canteen_id = v_ing.canteen_id AND id <> p_ingredient_id
     AND lower(btrim(name)) = lower(v_name)
   LIMIT 1;
  IF v_clash IS NOT NULL THEN
    RAISE EXCEPTION
      '"%" already exists here. Renaming onto it would leave two items with one name and neither total correct — merge % into it instead.',
      v_clash, v_ing.name;
  END IF;

  v_reason := btrim(coalesce(p_reason, ''));

  PERFORM public.allow_stock_move();
  UPDATE public.ingredients SET name = v_name WHERE id = p_ingredient_id;

  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'ingredient_renamed', 'ingredient', p_ingredient_id, v_ing.canteen_id,
          jsonb_build_object('item', v_ing.name, 'was', v_ing.name, 'now', v_name,
                             'stock_at_the_time', v_ing.current_stock,
                             'unit', v_ing.unit, 'reason', nullif(v_reason, '')));

  RETURN jsonb_build_object('changed', true, 'was', v_ing.name, 'now', v_name);
END;
$$;
REVOKE ALL ON FUNCTION public.rename_ingredient(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rename_ingredient(UUID, TEXT, TEXT) TO authenticated;

-- ---------- 3. So the owner can see it was done ----------
-- Both acts already land in action_logs. This reads them back as one plain
-- list, so "who changed that price" is a question with an answer rather than
-- an argument.
CREATE OR REPLACE FUNCTION public.item_edit_log(p_canteen_id UUID, p_days INT DEFAULT 30)
RETURNS TABLE (
  at TIMESTAMPTZ, who TEXT, what TEXT, item TEXT, was TEXT, now_is TEXT, why TEXT
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT l.created_at,
         coalesce(u.email, '—'),
         CASE l.action WHEN 'rate_corrected' THEN 'rate' ELSE 'name' END,
         l.details->>'item',
         l.details->>'was',
         l.details->>'now',
         l.details->>'reason'
  FROM public.action_logs l
  LEFT JOIN public.user_directory u ON u.id = l.user_id
  WHERE l.canteen_id = p_canteen_id
    AND l.action IN ('rate_corrected', 'ingredient_renamed')
    AND l.created_at >= (timezone('Asia/Kolkata', now())::date - p_days)
    AND public.can_access_canteen(p_canteen_id)
  ORDER BY l.created_at DESC;
$$;
REVOKE ALL ON FUNCTION public.item_edit_log(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.item_edit_log(UUID, INT) TO authenticated;
