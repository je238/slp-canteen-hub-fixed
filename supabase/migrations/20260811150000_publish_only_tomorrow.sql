-- ============================================================
-- PLAN A MONTH, SEND ONE DAY
--
-- The whole month's chart is now in the app as drafts. That is planning, and
-- it is the manager's own work.
--
-- Publishing is a different act. It is what puts a day on the chef's screen,
-- and the chef orders against it, and the store issues that evening for the
-- next day's cooking. A chef who can see three weeks ahead can order three
-- weeks of stock into a kitchen that has nowhere to keep it and no one
-- counting it — and the whole point of the daily approval is a person looking
-- at one day's quantities against one day's real headcount.
--
-- So: plan as far ahead as the chart goes, send exactly one day. On the 11th
-- the manager publishes the 12th. Today stays publishable too — a day whose
-- menu never went out still has to be able to go out.
--
-- Admin and super admin are exempt, as everywhere else here: fixing a real
-- mistake is their job.
--
-- Safe to re-run.
-- ============================================================

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

  IF NEW.status = 'published' THEN
    -- A published menu without a headcount costs nothing per head, bills
    -- nothing, and drags every average it touches towards zero.
    IF coalesce(NEW.expected_headcount, 0) <= 0 THEN
      RAISE EXCEPTION
        'Enter the expected headcount for % before publishing it — it is what the day is costed and billed on.',
        to_char(NEW.menu_date, 'DD/MM/YYYY');
    END IF;

    -- One day at a time to the kitchen.
    IF NEW.menu_date > v_today + 1 THEN
      RAISE EXCEPTION
        'Only tomorrow''s menu (%) can be sent to the chef today. % is further out — keep it as a draft until %.',
        to_char(v_today + 1, 'DD/MM/YYYY'),
        to_char(NEW.menu_date, 'DD/MM/YYYY'),
        to_char(NEW.menu_date - 1, 'DD/MM/YYYY');
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_menu_date ON public.menu_plans;
CREATE TRIGGER trg_guard_menu_date
  BEFORE INSERT OR UPDATE ON public.menu_plans
  FOR EACH ROW EXECUTE FUNCTION public.guard_menu_date();

-- ---------- What still has to go out ----------
-- The manager's one job each evening: tomorrow's menu, with its headcount,
-- sent to the chef. This is what tells them whether it has been done.
CREATE OR REPLACE FUNCTION public.due_to_publish(p_canteen_id UUID)
RETURNS TABLE (
  menu_date DATE, meal_period TEXT, dishes INT, heads INT, status TEXT
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT m.menu_date, m.meal_period,
         (SELECT count(*)::int FROM public.menu_plan_items i WHERE i.menu_plan_id = m.id),
         coalesce(m.expected_headcount, 0), m.status
  FROM public.menu_plans m
  WHERE m.canteen_id = p_canteen_id
    AND m.menu_date = timezone('Asia/Kolkata', now())::date + 1
    AND public.can_access_canteen(p_canteen_id)
  ORDER BY m.meal_period;
$$;
REVOKE ALL ON FUNCTION public.due_to_publish(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.due_to_publish(UUID) TO authenticated;
