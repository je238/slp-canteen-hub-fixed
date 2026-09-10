-- ============================================================
-- A NOTIFICATION GOES TO WHO IT NAMES
--
-- The rule was "you see it if it names you, OR your rank is at least the
-- rank it names, OR you are the owner". Both of the last two poured every
-- alert in the business into the owner's bell: every scanned bill, every
-- menu published to a chef, every sack coming back to a store keeper. An
-- owner opening the app to look at the money had to scroll past all of it,
-- and a bell that is always full is a bell nobody reads.
--
-- Addressed to a role now means that role. Bills reach the admin, who is
-- the one meant to check them against the photo; the owner's bell stays for
-- what is actually addressed to them, and the money is on the Purchases and
-- Reports screens where they were going to look anyway.
--
-- Safe to re-run.
-- ============================================================

DROP POLICY IF EXISTS "notifications_select" ON public.notifications;
CREATE POLICY "notifications_select" ON public.notifications FOR SELECT TO authenticated
  USING (
    target_user = auth.uid()
    OR (
      target_role IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = auth.uid() AND ur.role = target_role
      )
      AND (canteen_id IS NULL OR public.can_access_canteen(canteen_id))
    )
  );

-- Marking one read stays with the person it was for; an admin may still
-- clear one addressed to their own role.
DROP POLICY IF EXISTS "notifications_update_own" ON public.notifications;
CREATE POLICY "notifications_update_own" ON public.notifications FOR UPDATE TO authenticated
  USING (
    target_user = auth.uid()
    OR (target_role IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = target_role))
  )
  WITH CHECK (
    target_user = auth.uid()
    OR (target_role IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = target_role))
  );
