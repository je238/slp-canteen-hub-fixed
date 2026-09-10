-- ============================================================
-- THIRTY WORKING DAYS AHEAD, ONE HEADCOUNT AT A TIME
--
-- The company sends the menu as a hard copy covering a fortnight or more, so
-- the manager wants to sit once and enter the lot. Nothing stopped that
-- before — the only guard was against the past — but there was no way to see
-- which of the coming days were done and which were still empty, so it was
-- never really possible either.
--
-- Two things stay daily on purpose, and both are the manager's own words:
--
--   * the headcount is typed per day, never carried over. It is the number
--     the company is billed on and the number every per-head check divides
--     by. A figure copied forward from a fortnight ago is a guess wearing the
--     clothes of a count, and once it is in the system nobody can tell which
--     it was. So a menu cannot be published without one.
--
--   * the chef's order is still approved one day at a time. Planning the food
--     ahead is not the same as agreeing to release the stock, and the whole
--     point of the approval step is that a person looks at the quantities
--     against that day's real headcount.
--
-- Which days count as working days is a fact about the site, not about the
-- app, so the site holds it. Monday to Saturday by default.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.canteens
  ADD COLUMN IF NOT EXISTS working_days INT[] NOT NULL DEFAULT '{1,2,3,4,5,6}';

COMMENT ON COLUMN public.canteens.working_days IS
  'Weekdays this canteen serves, 0 = Sunday through 6 = Saturday. Drives how '
  'far ahead "30 working days" reaches.';

-- ---------- The next N working days from today ----------
-- One definition, used by the planning screen and by the guard below, so the
-- screen can never offer a day the database will then refuse.
CREATE OR REPLACE FUNCTION public.working_days_ahead(p_canteen_id UUID, p_n INT DEFAULT 30)
RETURNS TABLE (work_date DATE) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH cfg AS (
    SELECT coalesce(working_days, '{1,2,3,4,5,6}') AS wd
    FROM public.canteens WHERE id = p_canteen_id
  ),
  days AS (
    SELECT d::date AS work_date
    FROM cfg, generate_series(
           timezone('Asia/Kolkata', now())::date,
           timezone('Asia/Kolkata', now())::date + 120,
           interval '1 day') d
    WHERE extract(dow FROM d)::int = ANY (cfg.wd)
  )
  SELECT work_date FROM days ORDER BY work_date LIMIT greatest(p_n, 1);
$$;
REVOKE ALL ON FUNCTION public.working_days_ahead(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.working_days_ahead(UUID, INT) TO authenticated;

-- ---------- The window, and the headcount ----------
CREATE OR REPLACE FUNCTION public.guard_menu_date()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today DATE := timezone('Asia/Kolkata', now())::date;
  v_last  DATE;
BEGIN
  IF public.is_admin_editor() THEN RETURN NEW; END IF;

  -- Only when the date is being set or moved, so recording plates against
  -- yesterday's menu is untouched.
  IF TG_OP = 'INSERT' OR NEW.menu_date IS DISTINCT FROM OLD.menu_date THEN
    IF NEW.menu_date < v_today THEN
      RAISE EXCEPTION
        'A menu cannot be planned for % — that day has already passed. Plan for % or later.',
        to_char(NEW.menu_date, 'DD/MM/YYYY'), to_char(v_today, 'DD/MM/YYYY');
    END IF;

    SELECT max(work_date) INTO v_last
    FROM public.working_days_ahead(NEW.canteen_id, 30);

    IF v_last IS NOT NULL AND NEW.menu_date > v_last THEN
      RAISE EXCEPTION
        'A menu can be planned up to 30 days ahead — that is % at this site. % is beyond it.',
        to_char(v_last, 'DD/MM/YYYY'), to_char(NEW.menu_date, 'DD/MM/YYYY');
    END IF;
  END IF;

  -- Publishing is what sends the day to the kitchen and puts it into the
  -- billing. A published menu without a headcount costs nothing per head,
  -- bills nothing, and quietly drags every average it touches towards zero.
  IF NEW.status = 'published'
     AND coalesce(NEW.expected_headcount, 0) <= 0 THEN
    RAISE EXCEPTION
      'Enter the expected headcount for % before publishing it — it is what the day is costed and billed on.',
      to_char(NEW.menu_date, 'DD/MM/YYYY');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_menu_date ON public.menu_plans;
CREATE TRIGGER trg_guard_menu_date
  BEFORE INSERT OR UPDATE ON public.menu_plans
  FOR EACH ROW EXECUTE FUNCTION public.guard_menu_date();

-- ---------- What is planned across the window ----------
-- One row per working day: how many meals carry dishes, and how many are
-- still missing their headcount. This is what turns "you may plan ahead" into
-- something a manager can actually work through.
CREATE OR REPLACE FUNCTION public.planning_window(p_canteen_id UUID, p_n INT DEFAULT 30)
RETURNS TABLE (
  work_date DATE, meals_planned INT, meals_published INT,
  dishes INT, missing_headcount INT, heads INT
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT w.work_date,
         count(m.id)::int,
         count(m.id) FILTER (WHERE m.status = 'published')::int,
         coalesce(sum((SELECT count(*) FROM public.menu_plan_items i
                        WHERE i.menu_plan_id = m.id)), 0)::int,
         count(m.id) FILTER (WHERE coalesce(m.expected_headcount, 0) <= 0)::int,
         coalesce(sum(coalesce(m.actual_headcount, m.expected_headcount, 0)), 0)::int
  FROM public.working_days_ahead(p_canteen_id, p_n) w
  LEFT JOIN public.menu_plans m
    ON m.canteen_id = p_canteen_id AND m.menu_date = w.work_date
  WHERE public.can_access_canteen(p_canteen_id)
  GROUP BY w.work_date
  ORDER BY w.work_date;
$$;
REVOKE ALL ON FUNCTION public.planning_window(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.planning_window(UUID, INT) TO authenticated;
