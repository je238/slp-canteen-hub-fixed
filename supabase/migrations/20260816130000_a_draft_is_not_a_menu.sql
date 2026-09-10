-- ============================================================
-- A DRAFT IS NOT A MENU
--
-- The owner's rule is that the manager sends the 17th's menu on the 16th, and
-- publishing is what sends it. Publishing was enforced everywhere it moved
-- money: the requisition screen offers published plans only, the chef cannot
-- raise an order against a draft, and no order in the system is on one.
--
-- Reading was never enforced at all. The select policy said:
--
--     menu_plans_select  USING (can_access_canteen(canteen_id))
--
-- — no mention of status. So the chef could open Menu Planning and read every
-- draft on the calendar, thirty days out, dishes and all. The manager thinks
-- he is scribbling; the kitchen has already read it and started planning
-- around dishes that may still change.
--
-- That is not a money bug and nothing has gone wrong because of it. It is a
-- discipline bug, which is worse in a slower way: a rule the system announces
-- and does not keep teaches everyone that the rules are decorative.
--
-- So a draft becomes what the word means — the manager's own working copy.
-- Managers and above see everything, as they must, because somebody has to
-- write the thing. Everyone else sees a menu when it is a menu.
--
-- Safe to re-run.
-- ============================================================

DROP POLICY IF EXISTS "menu_plans_select" ON public.menu_plans;
CREATE POLICY "menu_plans_select" ON public.menu_plans FOR SELECT TO authenticated
  USING (
    public.can_access_canteen(canteen_id)
    AND (status <> 'draft' OR public.is_manager_or_above())
  );

-- The dishes follow the plan they belong to. Hiding the plan while leaving
-- its lines readable would be a door locked with the window open.
DROP POLICY IF EXISTS "menu_plan_items_select" ON public.menu_plan_items;
CREATE POLICY "menu_plan_items_select" ON public.menu_plan_items FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.menu_plans m
    WHERE m.id = menu_plan_items.menu_plan_id
      AND public.can_access_canteen(m.canteen_id)
      AND (m.status <> 'draft' OR public.is_manager_or_above())
  ));

-- The chef writes production and the manager writes wastage, both on plans
-- that have been published. Left as it was apart from the same status test,
-- so a chef cannot record output against a draft nobody has committed to.
DROP POLICY IF EXISTS "menu_plan_items_write" ON public.menu_plan_items;
CREATE POLICY "menu_plan_items_write" ON public.menu_plan_items FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.menu_plans m
    WHERE m.id = menu_plan_items.menu_plan_id
      AND public.can_access_canteen(m.canteen_id)
      AND (public.is_manager_or_above()
           OR (public.is_chef() AND m.status <> 'draft'))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.menu_plans m
    WHERE m.id = menu_plan_items.menu_plan_id
      AND public.can_access_canteen(m.canteen_id)
      AND (public.is_manager_or_above()
           OR (public.is_chef() AND m.status <> 'draft'))
  ));
