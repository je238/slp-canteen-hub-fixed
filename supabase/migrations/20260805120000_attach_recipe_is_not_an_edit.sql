-- ============================================================
-- Attaching a recipe for the first time is not editing the menu
--
-- guard_menu_item_edit froze dish_name, planned_qty AND recipe_id once a
-- menu was published. That is right for the first two — the kitchen cooks
-- what the manager published — and right for SWAPPING one recipe for
-- another, which silently changes what gets drawn from the store.
--
-- But it also blocked NULL -> a recipe, which is the chef saying, for the
-- first time, what a dish takes. The menus arrive from a scan with no
-- recipe attached, so the one action that makes the kitchen screen useful
-- was refused on every published menu.
--
-- Filling in a blank is allowed. Replacing an answer already given is not.
--
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_menu_item_edit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status TEXT;
BEGIN
  IF public.is_admin_editor() THEN RETURN NEW; END IF;
  SELECT status INTO v_status FROM public.menu_plans WHERE id = NEW.menu_plan_id;

  IF v_status IS DISTINCT FROM 'draft' THEN
    IF NEW.dish_name IS DISTINCT FROM OLD.dish_name
       OR NEW.planned_qty IS DISTINCT FROM OLD.planned_qty THEN
      RAISE EXCEPTION 'This menu is already published — only an admin can change the dishes';
    END IF;

    -- recipe_id: blank may be filled in, an existing one may not be swapped
    IF NEW.recipe_id IS DISTINCT FROM OLD.recipe_id AND OLD.recipe_id IS NOT NULL THEN
      RAISE EXCEPTION
        'This dish already has its ingredients set — only an admin can point it at a different recipe';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
