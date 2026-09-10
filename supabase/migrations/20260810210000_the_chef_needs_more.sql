-- ============================================================
-- THE CHEF NEEDS MORE, HALFWAY THROUGH COOKING
--
-- 20 kg of poha was ordered, approved and issued. The kadhai is on the fire
-- and it is not going to be enough. This happens in every kitchen and it must
-- not be hard — a chef who cannot get another 5 kg quickly will simply take
-- it, and then the store's book and the store's shelf stop agreeing. The
-- fastest way to break a stock system is to make the honest path slower than
-- the dishonest one.
--
-- So a top-up is allowed, and it still goes through the manager and the store
-- exactly like the first order. Nothing is waived. What is added is that the
-- top-up knows it is a top-up:
--
--   * it names the meal it belongs to, so 20 + 5 shows as 25 against a plan
--     of 20 rather than as two unrelated orders nobody adds up
--   * it carries the chef's reason in their own words
--   * it is marked urgent, because someone is standing at the stove
--
-- That last part is the whole point. One top-up is a kitchen. The same dish
-- needing a top-up every week is either a plan that is wrong or a shelf that
-- is leaking, and neither is visible while the extra draw hides inside a
-- second order that looks like any other.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.requisitions
  ADD COLUMN IF NOT EXISTS is_extra BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS extra_reason TEXT;

COMMENT ON COLUMN public.requisitions.is_extra IS
  'Raised after this meal was already issued — a top-up during cooking.';
COMMENT ON COLUMN public.requisitions.extra_reason IS
  'Why more was needed, in the chef''s own words. Required on a top-up.';

-- ---------- A second draw on the same meal is a top-up, and says so ----------
CREATE OR REPLACE FUNCTION public.guard_extra_requisition()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_already INT;
BEGIN
  IF NEW.menu_plan_id IS NULL THEN RETURN NEW; END IF;

  SELECT count(*) INTO v_already
  FROM public.requisitions r
  WHERE r.menu_plan_id = NEW.menu_plan_id
    AND r.id <> NEW.id
    AND r.status IN ('approved', 'issued');

  IF v_already > 0 THEN
    NEW.is_extra := true;
    -- A top-up with no reason is just a bigger number appearing later. The
    -- reason is the only thing that tells a manager whether to approve it
    -- without walking to the kitchen.
    IF coalesce(btrim(NEW.extra_reason), '') = '' THEN
      RAISE EXCEPTION
        'This meal has already been issued. Say why more is needed — that reason is what the manager approves on.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_extra_requisition ON public.requisitions;
CREATE TRIGGER trg_guard_extra_requisition
  BEFORE INSERT ON public.requisitions
  FOR EACH ROW EXECUTE FUNCTION public.guard_extra_requisition();

-- ---------- Planned against actually drawn, per meal ----------
-- The figure nobody could see before: what the kitchen was given for a meal,
-- against what the meal was planned for, with the top-ups broken out.
CREATE OR REPLACE FUNCTION public.meal_draw(p_canteen_id UUID, p_date DATE)
RETURNS TABLE (
  meal_period TEXT, dishes INT, heads INT,
  orders INT, top_ups INT,
  first_value NUMERIC, extra_value NUMERIC, total_value NUMERIC,
  reasons TEXT
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT m.meal_period,
         (SELECT count(*)::int FROM public.menu_plan_items i WHERE i.menu_plan_id = m.id),
         coalesce(m.actual_headcount, m.expected_headcount, 0),
         count(DISTINCT r.id)::int,
         count(DISTINCT r.id) FILTER (WHERE r.is_extra)::int,
         coalesce(sum(ri.issued_value) FILTER (WHERE NOT r.is_extra), 0),
         coalesce(sum(ri.issued_value) FILTER (WHERE r.is_extra), 0),
         coalesce(sum(ri.issued_value), 0),
         string_agg(DISTINCT r.extra_reason, ' · ') FILTER (WHERE r.is_extra)
  FROM public.menu_plans m
  LEFT JOIN public.requisitions r
    ON r.menu_plan_id = m.id AND r.status = 'issued'
  LEFT JOIN public.requisition_items ri ON ri.requisition_id = r.id
  WHERE m.canteen_id = p_canteen_id AND m.menu_date = p_date
    AND public.can_access_canteen(p_canteen_id)
  GROUP BY m.id, m.meal_period, m.actual_headcount, m.expected_headcount
  ORDER BY m.meal_period;
$$;
REVOKE ALL ON FUNCTION public.meal_draw(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.meal_draw(UUID, DATE) TO authenticated;

-- ---------- Which items keep needing a top-up ----------
-- One top-up is a kitchen having a busy day. The same item, week after week,
-- is a plan that is wrong or a shelf that is leaking — and until now that
-- pattern was spread across ordinary-looking orders where nobody would find
-- it.
CREATE OR REPLACE FUNCTION public.repeat_top_ups(p_canteen_id UUID, p_days INT DEFAULT 30)
RETURNS TABLE (
  ingredient_id UUID, name TEXT, unit TEXT,
  times_topped_up INT, extra_qty NUMERIC, extra_value NUMERIC, last_reason TEXT
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT i.id, i.name, i.unit,
         count(*)::int,
         sum(coalesce(ri.issued_qty, 0)),
         sum(coalesce(ri.issued_value, 0)),
         (array_agg(r.extra_reason ORDER BY r.issued_at DESC))[1]
  FROM public.requisitions r
  JOIN public.requisition_items ri ON ri.requisition_id = r.id
  JOIN public.ingredients i ON i.id = ri.ingredient_id
  WHERE r.canteen_id = p_canteen_id
    AND r.is_extra AND r.status = 'issued'
    AND r.req_date >= (timezone('Asia/Kolkata', now())::date - p_days)
    AND public.can_access_canteen(p_canteen_id)
  GROUP BY i.id, i.name, i.unit
  HAVING count(*) >= 2
  ORDER BY count(*) DESC, sum(coalesce(ri.issued_value, 0)) DESC;
$$;
REVOKE ALL ON FUNCTION public.repeat_top_ups(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.repeat_top_ups(UUID, INT) TO authenticated;
