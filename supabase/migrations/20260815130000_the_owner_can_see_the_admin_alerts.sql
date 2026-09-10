-- ============================================================
-- THE OWNER CAN SEE THE ALERTS ADDRESSED TO THE ADMIN
--
-- Found while testing the store keeper's new permission to correct the count.
-- The safeguard on that permission is that the admin is told, item by item,
-- as it happens. The notification was being written correctly. Nobody could
-- read it.
--
-- The select policy matched the role string exactly:
--
--     EXISTS (SELECT 1 FROM user_roles ur
--              WHERE ur.user_id = auth.uid() AND ur.role = target_role)
--
-- A row addressed to 'admin' therefore reached users whose role is literally
-- 'admin', and nobody else. The owner's role is 'super_admin', which is not
-- the string 'admin', so the owner has never seen one — 154 of them at the
-- time of writing, going back to the beginning: bill-photo alerts, purchase
-- notices, and every stock correction the store keeper has ever made.
--
-- This is the exact failure mode the whole design is meant to avoid: a
-- control that reports clean because the report never arrives. The permission
-- granted an hour ago was justified to the owner on the strength of an alert
-- that would have gone into a drawer nobody can open.
--
-- Seniority is not a string match. An alert addressed to the admin is meant
-- for whoever stands above the site, and the owner stands above the admin.
--
-- Safe to re-run.
-- ============================================================

DROP POLICY IF EXISTS "notifications_select" ON public.notifications;
CREATE POLICY "notifications_select" ON public.notifications FOR SELECT TO authenticated
  USING (
    target_user = auth.uid()
    OR (
      target_role IS NOT NULL
      AND (canteen_id IS NULL OR public.can_access_canteen(canteen_id))
      AND (
        EXISTS (SELECT 1 FROM public.user_roles ur
                 WHERE ur.user_id = auth.uid()
                   AND ur.role::text = public.notifications.target_role)
        -- Addressed to the admin, so it is the owner's business too.
        OR (public.notifications.target_role = 'admin' AND public.is_admin_editor())
        -- And the same courtesy one rung down, for anything aimed at the
        -- manager: an admin and an owner may both read it.
        OR (public.notifications.target_role = 'manager' AND public.is_manager_or_above())
      )
    )
  );

-- Marking one as read follows exactly the same reach — otherwise the owner
-- would see an alert and be unable to clear it, which is its own small
-- version of the same bug.
DROP POLICY IF EXISTS "notifications_update_own" ON public.notifications;
CREATE POLICY "notifications_update_own" ON public.notifications FOR UPDATE TO authenticated
  USING (
    target_user = auth.uid()
    OR (
      target_role IS NOT NULL
      AND (
        EXISTS (SELECT 1 FROM public.user_roles ur
                 WHERE ur.user_id = auth.uid()
                   AND ur.role::text = public.notifications.target_role)
        OR (public.notifications.target_role = 'admin' AND public.is_admin_editor())
        OR (public.notifications.target_role = 'manager' AND public.is_manager_or_above())
      )
    )
  );
