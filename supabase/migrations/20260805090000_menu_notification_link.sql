-- ============================================================
-- The menu notification pointed at a screen that could not show the menu
--
-- Publishing a lunch menu on Eicher Unit 2 for tomorrow sent the chef a
-- notification linking to '/menu-planning'. That screen opens on TODAY and
-- on whichever site the chef is pinned to — so the chef was sent to an
-- empty day on the wrong unit and saw nothing at all. The alert arrived,
-- the menu never did.
--
-- The link now carries the date and the site it belongs to, so tapping it
-- lands on the exact menu that was published.
--
-- Safe to re-run.
-- ============================================================

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
    '/menu-planning?date=' || to_char(NEW.menu_date, 'YYYY-MM-DD')
                           || '&site=' || NEW.canteen_id,
    'menu_plan', NEW.id
  );
  RETURN NEW;
END;
$$;
