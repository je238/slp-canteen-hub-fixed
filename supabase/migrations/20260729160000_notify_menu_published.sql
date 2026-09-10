-- Publishing a menu is what tells the kitchen what to cook, so the chef
-- shouldn't have to go looking for it. Fires only on the transition into
-- 'published', so correcting a menu that is already out doesn't spam.
-- Safe to re-run.

CREATE OR REPLACE FUNCTION public.notify_menu_published()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_label TEXT; v_when TEXT;
BEGIN
  IF NEW.status <> 'published' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'published' THEN RETURN NEW; END IF;

  v_label := initcap(replace(NEW.meal_period, '_', ' '));
  v_when := to_char(NEW.menu_date, 'Dy DD Mon');

  INSERT INTO public.notifications
    (canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES (
    NEW.canteen_id, 'chef',
    v_label || ' menu for ' || v_when,
    'Menu published' ||
    CASE WHEN coalesce(NEW.expected_headcount, 0) > 0
         THEN ' for ' || NEW.expected_headcount || ' people' ELSE '' END ||
    '. Raise the raw-material requisition against it.',
    '/menu-planning', 'menu_plan', NEW.id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_menu_published_ins ON public.menu_plans;
DROP TRIGGER IF EXISTS trg_notify_menu_published_upd ON public.menu_plans;
CREATE TRIGGER trg_notify_menu_published_ins
  AFTER INSERT ON public.menu_plans
  FOR EACH ROW EXECUTE FUNCTION public.notify_menu_published();
CREATE TRIGGER trg_notify_menu_published_upd
  AFTER UPDATE ON public.menu_plans
  FOR EACH ROW EXECUTE FUNCTION public.notify_menu_published();
