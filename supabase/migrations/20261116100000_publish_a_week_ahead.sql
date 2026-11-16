-- ============================================================
-- PUBLISH UP TO A WEEK AHEAD
--
-- 16 Nov 2026, asked by the owner: the HS fills the week's menu (often by
-- scanning the chart) but only tomorrow's went to the chef; every other day
-- stayed a draft and had to be published again, one evening at a time.
--
-- Now a menu can be published up to 7 days ahead, so the chef sees the
-- coming week and can raise orders for it early (see below), but each order
-- is still approved only the day before, so a week of stock cannot be
-- pulled in at once.
--
-- Drafts still go up to 30 working days ahead. Everything else in the guard
-- is as it was. Safe to re-run (whole file).
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
    IF coalesce(NEW.expected_headcount, 0) <= 0 THEN
      RAISE EXCEPTION
        'Enter the expected headcount for % before publishing it — it is what the day is costed and billed on.',
        to_char(NEW.menu_date, 'DD/MM/YYYY');
    END IF;

    -- A week at a time to the kitchen.
    IF NEW.menu_date > v_today + 7 THEN
      RAISE EXCEPTION
        'Chef ko 7 din aage tak ka menu (% tak) hi bheja ja sakta hai. % ko draft rakho, % ko publish hoga.',
        to_char(v_today + 7, 'DD/MM/YYYY'),
        to_char(NEW.menu_date, 'DD/MM/YYYY'),
        to_char(NEW.menu_date - 7, 'DD/MM/YYYY');
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ============================================================
-- CHEF ORDERS IN ADVANCE, APPROVED THE DAY BEFORE
--
-- Same day, the owner: with the week published, the chef may raise orders
-- for those days early. They wait as pending. The manager can approve an
-- order only from the day before the food is cooked, so stock still leaves
-- the store one day at a time. Admin and super admin are exempt, as in
-- every guard here.
-- ============================================================
CREATE OR REPLACE FUNCTION public.guard_advance_approval()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today DATE := timezone('Asia/Kolkata', now())::date;
  v_day   DATE;
BEGIN
  IF NEW.status <> 'approved' OR OLD.status IS NOT DISTINCT FROM NEW.status
     OR NEW.menu_plan_id IS NULL OR public.is_admin_editor() THEN
    RETURN NEW;
  END IF;
  SELECT menu_date INTO v_day FROM public.menu_plans WHERE id = NEW.menu_plan_id;
  IF v_day > v_today + 1 THEN
    RAISE EXCEPTION 'Ye % ke khane ka advance order hai. Ise % ko (ek din pehle) approve kar sakte ho.',
      to_char(v_day, 'DD/MM/YYYY'), to_char(v_day - 1, 'DD/MM/YYYY');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_advance_approval ON public.requisitions;
CREATE TRIGGER trg_guard_advance_approval
  BEFORE UPDATE OF status ON public.requisitions
  FOR EACH ROW EXECUTE FUNCTION public.guard_advance_approval();

-- The 6 PM email lists only orders that could be approved today:
-- advance orders for later days are not late.
CREATE OR REPLACE FUNCTION public.email_pending_orders()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'site', x->>'for_date', x->>'req_no'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'site', c.name,
      'req_no', r.req_no,
      'meal', coalesce(m.meal_period, r.meal_period, 'extra'),
      'for_date', coalesce(m.menu_date, r.req_date),
      'raised_at', r.created_at,
      'is_extra', r.is_extra,
      'items', (SELECT count(*) FROM public.requisition_items ri WHERE ri.requisition_id = r.id),
      'waiting_with', CASE WHEN r.head_chef_required AND coalesce(r.head_chef_status, '') <> 'approved'
                           THEN 'Head Chef' ELSE 'Manager' END,
      'raised_by', coalesce(u.raw_user_meta_data->>'full_name', u.email)
    ) x
    FROM public.requisitions r
    JOIN public.canteens c ON c.id = r.canteen_id
    LEFT JOIN public.menu_plans m ON m.id = r.menu_plan_id
    LEFT JOIN auth.users u ON u.id = r.requested_by
    WHERE r.status = 'pending'
      AND coalesce(m.menu_date, r.req_date, (r.created_at AT TIME ZONE 'Asia/Kolkata')::date)
          BETWEEN (now() AT TIME ZONE 'Asia/Kolkata')::date - 2
              AND (now() AT TIME ZONE 'Asia/Kolkata')::date + 1
  ) s;
$$;
REVOKE ALL ON FUNCTION public.email_pending_orders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_pending_orders() TO service_role;
