-- ============================================================
-- THE PLATE COUNT — the figure the company is billed on
--
-- Every report already reads coalesce(actual_headcount, expected_headcount),
-- but nothing could ever write actual_headcount:
--
--   · no screen offered it, so every report has been costing the day on the
--     manager's morning ESTIMATE rather than the plates that actually went
--     out, and
--   · guard_menu_headcount froze it the moment material was issued — and
--     the plates served are only known after the meal, which is always
--     after issue. The figure was unrecordable by construction.
--
-- Freezing the EXPECTED count after issue is right: nobody should inflate
-- the estimate after drawing stock against it. The ACTUAL count is the
-- opposite — it is the after-the-fact record. A unit manager may enter it
-- once; after that only an admin may correct it, and every correction is
-- written to the action log with the old and new figure.
--
-- Reports Center counted plates from meal_entries, which no screen writes
-- either, so it showed "Headcount served: 0" while the manager's dashboard
-- showed 200 for the same day. Both now read the same source.
--
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_menu_headcount()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- The estimate the kitchen cooked to: frozen once material has moved.
  IF NEW.expected_headcount IS DISTINCT FROM OLD.expected_headcount THEN
    IF NOT public.is_manager_or_above() THEN
      RAISE EXCEPTION 'Only a unit manager or above can change the headcount';
    END IF;
    IF EXISTS (SELECT 1 FROM public.requisitions r
               WHERE r.menu_plan_id = NEW.id AND r.status = 'issued') THEN
      RAISE EXCEPTION
        'Material has already been issued against this menu — the expected headcount can no longer be changed';
    END IF;
  END IF;

  -- The plates that actually went out: entered after service, once.
  IF NEW.actual_headcount IS DISTINCT FROM OLD.actual_headcount THEN
    IF NOT public.is_manager_or_above() THEN
      RAISE EXCEPTION 'Only a unit manager or above can record the plates served';
    END IF;
    IF OLD.actual_headcount IS NOT NULL AND NOT public.is_admin_editor() THEN
      RAISE EXCEPTION
        'The plates served are already recorded — only an admin can correct that figure';
    END IF;
    IF NEW.actual_headcount IS NOT NULL AND NEW.actual_headcount < 0 THEN
      RAISE EXCEPTION 'Plates served cannot be negative';
    END IF;

    INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
    VALUES (auth.uid(),
            CASE WHEN OLD.actual_headcount IS NULL THEN 'plates_recorded' ELSE 'plates_corrected' END,
            'menu_plan', NEW.id, NEW.canteen_id,
            jsonb_build_object('menu_date', NEW.menu_date, 'meal_period', NEW.meal_period,
                               'expected', NEW.expected_headcount,
                               'was', OLD.actual_headcount, 'now', NEW.actual_headcount));
  END IF;

  RETURN NEW;
END;
$$;

-- ---------- Reports Center reads the same headcount as every other screen ----------
-- meal_entries stays in the revenue figures for sites that bill per plate
-- through an invoice; the headcount now comes from the day's menus, which
-- is what the manager actually records.
CREATE OR REPLACE FUNCTION public.operations_summary(p_canteen_id UUID, p_start DATE, p_end DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_heads BIGINT; v_revenue NUMERIC; v_consumption NUMERIC;
  v_purchase NUMERIC; v_meals BIGINT; v_wastage NUMERIC; v_reqs BIGINT;
BEGIN
  SELECT coalesce(sum(amount), 0) INTO v_revenue
  FROM public.meal_entries
  WHERE canteen_id = p_canteen_id AND entry_date BETWEEN p_start AND p_end;

  SELECT coalesce(sum(coalesce(actual_headcount, expected_headcount, 0)), 0), count(*)
  INTO v_heads, v_meals
  FROM public.menu_plans
  WHERE canteen_id = p_canteen_id AND menu_date BETWEEN p_start AND p_end
    AND status <> 'draft';

  SELECT coalesce(-sum(l.change_qty * coalesce(i.cost_per_unit, 0)), 0)
  INTO v_consumption
  FROM public.stock_ledger l JOIN public.ingredients i ON i.id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('recipe','issue')
    AND l.created_at >= (p_start::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND l.created_at <  ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');

  SELECT coalesce(sum(total_amount), 0) INTO v_purchase
  FROM public.purchases
  WHERE canteen_id = p_canteen_id AND status = 'confirmed'
    AND created_at >= (p_start::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND created_at <  ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');

  SELECT coalesce(sum(mi.wastage_qty), 0) INTO v_wastage
  FROM public.menu_plan_items mi JOIN public.menu_plans m ON m.id = mi.menu_plan_id
  WHERE m.canteen_id = p_canteen_id AND m.menu_date BETWEEN p_start AND p_end;

  SELECT count(*) INTO v_reqs FROM public.requisitions
  WHERE canteen_id = p_canteen_id AND req_date BETWEEN p_start AND p_end;

  RETURN jsonb_build_object(
    'headcount', v_heads,
    'meals_served', v_meals,
    'revenue', v_revenue,
    'consumption', v_consumption,
    'purchase', v_purchase,
    'wastage_qty', v_wastage,
    'requisitions', v_reqs,
    'cost_per_person', CASE WHEN v_heads > 0 THEN round(v_consumption / v_heads, 2) END,
    'revenue_per_person', CASE WHEN v_heads > 0 THEN round(v_revenue / v_heads, 2) END,
    'food_cost_pct', CASE WHEN v_revenue > 0 THEN round(v_consumption * 100 / v_revenue, 2) END,
    'margin_per_person', CASE WHEN v_heads > 0
                              THEN round((v_revenue - v_consumption) / v_heads, 2) END
  );
END;
$$;

-- ---------- What is still missing a plate count ----------
-- The manager's screen uses this to chase up meals that were served but
-- never counted; an uncounted meal is one the company is never billed for.
CREATE OR REPLACE FUNCTION public.uncounted_meals(p_canteen_id UUID, p_days INT DEFAULT 7)
RETURNS TABLE (
  id UUID, menu_date DATE, meal_period TEXT,
  expected_headcount INT, issued BOOLEAN
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT m.id, m.menu_date, m.meal_period, m.expected_headcount,
         EXISTS (SELECT 1 FROM public.requisitions r
                 WHERE r.menu_plan_id = m.id AND r.status = 'issued')
  FROM public.menu_plans m
  WHERE m.canteen_id = p_canteen_id
    AND m.status <> 'draft'
    AND m.actual_headcount IS NULL
    AND m.menu_date >= (timezone('Asia/Kolkata', now())::date - p_days)
    AND m.menu_date <= timezone('Asia/Kolkata', now())::date
  ORDER BY m.menu_date DESC, m.meal_period;
$$;
REVOKE ALL ON FUNCTION public.uncounted_meals(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.uncounted_meals(UUID, INT) TO authenticated;
