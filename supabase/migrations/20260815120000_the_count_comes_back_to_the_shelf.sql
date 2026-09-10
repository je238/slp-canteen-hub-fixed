-- ============================================================
-- THE COUNT COMES BACK TO THE SHELF — PERMANENTLY, AND IN THE OPEN
--
-- The two-day window shut itself as designed, and the owner has now asked for
-- the count to be the store keeper's for good, alongside the rate and the
-- name. So the window stops being the thing that decides, and the role does.
--
-- This is the heaviest of the three and it should be said plainly rather than
-- buried. A name and a rate can be checked against a bill; somebody else can
-- pick up the same piece of paper and see whether the number is right. A
-- quantity cannot. There is no document behind "there are 40 kg on the
-- shelf" except the shelf, and the person who can now type that figure is the
-- person holding the key to it. If ten kilos go missing, the same hand can
-- make the book agree with the emptier shelf, and nothing in the paperwork
-- will look wrong.
--
-- That risk is not removed by refusing — it was already there the moment one
-- man had both the key and the count, and refusing only moved the correction
-- to a phone in another city a day later, which is how the opening figures
-- got into the state they did. What actually helps is that the act cannot be
-- quiet. So, permanently now:
--
--   * a REASON IS ALWAYS REQUIRED. The setup window used to fill in "Opening
--     count corrected by the store keeper" when the box was left blank,
--     because ninety figures were going in at once and asking for a sentence
--     on each only teaches a man to type "x". That was a concession to one
--     week's work. It has no place in a standing permission: from here every
--     correction carries a sentence its author chose.
--   * the ADMIN IS TOLD, item by item, with the old figure, the new figure,
--     the difference, the reason and what it is worth in rupees.
--   * it lands in the LEDGER and in action_logs, so the shelf and the book
--     still reconcile and the correction is reviewable months later.
--
-- An open door nobody watches is a hole. An open door with someone standing
-- at it is a workflow. This keeps the someone.
--
-- The window machinery is left in place and untouched — open_stock_editing()
-- still works and still expires. It simply no longer gates the store keeper,
-- and remains available if the count is ever narrowed back to a window.
--
-- Safe to re-run.
-- ============================================================
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
  ELSIF public.is_store_keeper() THEN
    v_by_store := true;
  ELSE
    -- Still closed to everyone else, and to the manager above all: he approves
    -- the orders that draw this stock down.
    RAISE EXCEPTION
      'Stock cannot be typed in. Receive it against a bill, issue it against an approved order, or ask the store keeper or an admin to correct it.';
  END IF;

  -- No blank reasons any more, for anybody. See the note above.
  v_reason := btrim(coalesce(p_reason, ''));
  IF v_reason = '' THEN
    RAISE EXCEPTION
      'Say why the figure is changing — a count with no reason is the one correction nobody can check later.';
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

-- ---------- What the owner should actually look at ----------
-- Not every correction — most are honest, and a list nobody can finish is a
-- list nobody reads. These are the ones worth a question: stock going DOWN
-- by hand, which is the shape a shortage takes when it is written away.
CREATE OR REPLACE FUNCTION public.hand_reductions(p_canteen_id UUID, p_days INT DEFAULT 30)
RETURNS TABLE (
  at TIMESTAMPTZ, who TEXT, item TEXT, was NUMERIC, now_is NUMERIC,
  gone NUMERIC, unit TEXT, worth NUMERIC, why TEXT
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT l.created_at,
         coalesce(u.email, '—'),
         l.details->>'item',
         (l.details->>'was')::numeric,
         (l.details->>'now')::numeric,
         -((l.details->>'delta')::numeric),
         i.unit,
         round(abs((l.details->>'delta')::numeric) * coalesce(i.cost_per_unit, 0), 2),
         l.details->>'reason'
  FROM public.action_logs l
  LEFT JOIN public.user_directory u ON u.id = l.user_id
  LEFT JOIN public.ingredients i ON i.id = l.entity_id
  WHERE l.canteen_id = p_canteen_id
    AND l.action = 'stock_adjusted'
    AND (l.details->>'delta')::numeric < 0
    AND l.created_at >= (timezone('Asia/Kolkata', now())::date - p_days)
    AND public.can_access_canteen(p_canteen_id)
  ORDER BY abs((l.details->>'delta')::numeric) * coalesce(i.cost_per_unit, 0) DESC;
$$;
REVOKE ALL ON FUNCTION public.hand_reductions(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hand_reductions(UUID, INT) TO authenticated;
