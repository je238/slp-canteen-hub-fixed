-- Managers can upload a new company menu as well as correct an existing one.
-- Keep the existing Head Supervisor policy and site-level boundary intact.
DROP POLICY IF EXISTS "menu_plans_manager_insert" ON public.menu_plans;
CREATE POLICY "menu_plans_manager_insert" ON public.menu_plans
  FOR INSERT TO authenticated
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));
