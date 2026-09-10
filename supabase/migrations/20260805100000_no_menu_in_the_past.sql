-- ============================================================
-- A MENU CANNOT BE PLANNED FOR A DAY THAT HAS ALREADY PASSED
--
-- The date box accepted any date at all, so a menu could be published for
-- a day a month ago. That is not a thing the kitchen can act on, and a
-- back-dated menu quietly changes what the reports say was cooked and how
-- many plates the company is billed for on a day already settled.
--
-- Reading a past day stays open — the manager has to open it to record the
-- plates that were served. Only writing INTO the past is refused.
--
-- Admin and super admin may still back-date, because correcting a genuine
-- mistake is their job and every other guard here works the same way.
--
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_menu_date()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today DATE := timezone('Asia/Kolkata', now())::date;
BEGIN
  IF public.is_admin_editor() THEN RETURN NEW; END IF;

  -- only when the date is being set or moved, so recording plates against
  -- yesterday's menu is untouched
  IF TG_OP = 'INSERT' OR NEW.menu_date IS DISTINCT FROM OLD.menu_date THEN
    IF NEW.menu_date < v_today THEN
      RAISE EXCEPTION
        'A menu cannot be planned for % — that day has already passed. Plan for % or later.',
        to_char(NEW.menu_date, 'DD/MM/YYYY'), to_char(v_today, 'DD/MM/YYYY');
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_menu_date ON public.menu_plans;
CREATE TRIGGER trg_guard_menu_date
  BEFORE INSERT OR UPDATE ON public.menu_plans
  FOR EACH ROW EXECUTE FUNCTION public.guard_menu_date();
