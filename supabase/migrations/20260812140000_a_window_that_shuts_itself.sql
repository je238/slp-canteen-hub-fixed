-- ============================================================
-- TWO DAYS IN WHICH THE STORE KEEPER MAY CORRECT THE COUNT
--
-- Typing a stock figure is normally an admin act, and for a good reason: the
-- store keeper holds the key to the store, and letting them rewrite the
-- store's own record is how a shortage gets written away as spillage by the
-- person it points at.
--
-- But the opening count is going in this week and the figures need correcting
-- by the man holding the sack, not by someone on a phone in another city. So
-- the door opens — with three things nailed to it:
--
--   * it SHUTS ITSELF. Not a flag someone has to remember to turn off, and
--     not a permission quietly left on for a year. A timestamp: after it
--     passes, the old rule is simply back, with nothing to undo.
--   * every correction needs a reason, in words, as it always did.
--   * every correction is written to the ledger AND told to the admin as it
--     happens, naming the item, the old figure, the new one and who typed it.
--
-- That last part is what makes this survivable. An open door nobody watches
-- is a hole; an open door with someone standing at it is a workflow.
--
-- Safe to re-run. Re-running does NOT extend the window — that takes a
-- deliberate call to open_stock_editing().
-- ============================================================

ALTER TABLE public.canteens
  ADD COLUMN IF NOT EXISTS stock_edit_open_until TIMESTAMPTZ;

COMMENT ON COLUMN public.canteens.stock_edit_open_until IS
  'While this is in the future the store keeper may correct stock figures '
  'directly. It is not cleared when it passes — it simply stops being true.';

CREATE OR REPLACE FUNCTION public.stock_editing_is_open(p_canteen_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(stock_edit_open_until > now(), false)
    FROM public.canteens WHERE id = p_canteen_id;
$$;
GRANT EXECUTE ON FUNCTION public.stock_editing_is_open(UUID) TO authenticated;

-- Opening it is an admin decision and is logged like any other.
CREATE OR REPLACE FUNCTION public.open_stock_editing(p_canteen_id UUID, p_days INT DEFAULT 2)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_until TIMESTAMPTZ;
BEGIN
  IF NOT public.is_admin_editor() THEN
    RAISE EXCEPTION 'Only an admin can open stock editing';
  END IF;
  IF p_days < 0 OR p_days > 7 THEN
    RAISE EXCEPTION 'Stock editing can be opened for at most a week';
  END IF;

  v_until := now() + make_interval(days => p_days);
  UPDATE public.canteens SET stock_edit_open_until = v_until WHERE id = p_canteen_id;

  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'stock_editing_opened', 'canteen', p_canteen_id, p_canteen_id,
          jsonb_build_object('days', p_days, 'until', v_until));

  RETURN jsonb_build_object('open_until', v_until, 'days', p_days);
END;
$$;
REVOKE ALL ON FUNCTION public.open_stock_editing(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_stock_editing(UUID, INT) TO authenticated;

-- ---------- The adjustment itself ----------
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
    NULL;                                   -- always allowed
  -- is_store_keeper(), not can_receive_stock(): that one is rank-based and
  -- lets a manager in too. The manager approves the orders; handing them the
  -- stock figure as well collapses the two people this whole thing keeps
  -- apart. The window was asked for for the store keeper, and it is his alone.
  ELSIF public.is_store_keeper() AND public.stock_editing_is_open(v_ing.canteen_id) THEN
    v_by_store := true;                     -- the window is open
  ELSE
    RAISE EXCEPTION
      'Stock cannot be typed in. Receive it against a bill, issue it against an approved order, or ask an admin to correct it.';
  END IF;

  -- A reason stays compulsory for an admin: someone writing a shortage off
  -- months later has to say why, and that sentence is the whole control.
  -- Inside the setup window the store keeper is correcting an opening count
  -- item by item — ninety of them — and demanding a sentence each time only
  -- teaches him to type "x". Left blank it is filled in honestly instead, so
  -- the ledger still says what kind of change this was.
  v_reason := btrim(coalesce(p_reason, ''));
  IF v_reason = '' THEN
    IF v_by_store THEN
      v_reason := 'Opening count corrected by the store keeper';
    ELSE
      RAISE EXCEPTION 'A reason is required for a manual stock adjustment';
    END IF;
  END IF;

  v_delta := p_new_stock - v_ing.current_stock;
  IF v_delta = 0 THEN RETURN jsonb_build_object('changed', false); END IF;

  PERFORM public.allow_stock_move();
  UPDATE public.ingredients SET current_stock = p_new_stock WHERE id = p_ingredient_id;

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

  -- Told as it happens, not found in a report next month. This is the price
  -- of the door being open.
  IF v_by_store THEN
    INSERT INTO public.notifications
      (canteen_id, target_role, title, body, link, ref_type, ref_id)
    VALUES (v_ing.canteen_id, 'admin',
            format('Stock corrected by the store keeper — %s', v_ing.name),
            format('%s %s → %s %s (%s%s). Reason: "%s". Worth ₹%s at %s/%s.',
                   v_ing.name, v_ing.current_stock, p_new_stock, v_ing.unit,
                   CASE WHEN v_delta > 0 THEN '+' ELSE '' END, v_delta,
                   v_reason,
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

-- ---------- Everything typed in while the door was open ----------
-- One list, so that when the window shuts someone can read what happened in
-- it rather than trusting that nothing did.
CREATE OR REPLACE FUNCTION public.hand_corrections(p_canteen_id UUID, p_days INT DEFAULT 7)
RETURNS TABLE (
  at TIMESTAMPTZ, item TEXT, change_qty NUMERIC, balance_after NUMERIC,
  value NUMERIC, reason TEXT, by_whom TEXT
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT l.created_at, i.name, l.change_qty, l.balance_after, l.value,
         l.reason, coalesce(u.email, '—')
  FROM public.stock_ledger l
  JOIN public.ingredients i ON i.id = l.ingredient_id
  LEFT JOIN public.user_directory u ON u.id = l.created_by
  WHERE l.canteen_id = p_canteen_id
    AND l.reference_type = 'manual'
    AND l.created_at >= now() - make_interval(days => p_days)
    AND public.can_access_canteen(p_canteen_id)
  ORDER BY l.created_at DESC;
$$;
REVOKE ALL ON FUNCTION public.hand_corrections(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hand_corrections(UUID, INT) TO authenticated;
