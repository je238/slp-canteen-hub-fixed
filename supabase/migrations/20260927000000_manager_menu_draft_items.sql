-- A manager may create a new menu, not only correct a published one.
-- Its dish lines are inserted while the new menu is still a draft.
CREATE OR REPLACE FUNCTION public.guard_menu_item_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_plan public.menu_plans%ROWTYPE;
BEGIN
  IF public.is_admin_editor() THEN RETURN NEW; END IF;
  SELECT * INTO v_plan FROM public.menu_plans WHERE id=NEW.menu_plan_id;
  IF NOT FOUND OR NOT public.can_access_canteen(v_plan.canteen_id) THEN
    RAISE EXCEPTION 'Menu is not available at your site';
  END IF;
  IF v_plan.status='draft' AND (public.is_head_supervisor() OR public.is_manager_or_above()) THEN
    RETURN NEW;
  END IF;
  IF v_plan.status<>'draft' AND public.is_manager_or_above() THEN
    INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
    VALUES(auth.uid(),'menu_dish_corrected','menu_plan',v_plan.id,v_plan.canteen_id,
      jsonb_build_object('change','dish_added','dish',NEW.dish_name,'menu_date',v_plan.menu_date,'meal_period',v_plan.meal_period));
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Only HS or Manager can add dishes to a draft menu; only Manager can correct a published menu';
END;
$$;
REVOKE ALL ON FUNCTION public.guard_menu_item_insert() FROM PUBLIC, anon, authenticated;
