-- ============================================================
-- The site list was readable by anyone, and staff could only ever see one site
--
-- canteens_anon_select let the key that ships inside the browser bundle read
-- every canteen row without signing in. That was put there when a customer
-- had to pick a site before logging in; there is no such screen any more, so
-- it was only publishing site names and locations to anyone who opened the
-- bundle and read the key out of it.
--
-- canteens_staff_select still used "id = get_my_canteen()", which predates
-- user_sites. A manager assigned to a second site could work in it — every
-- other table goes through can_access_canteen() — but could not read that
-- site's own row, so it showed up nameless in the site picker.
--
-- Safe to re-run.
-- ============================================================

DROP POLICY IF EXISTS "canteens_anon_select" ON public.canteens;
DROP POLICY IF EXISTS "Allow anon full access to canteens" ON public.canteens;

DROP POLICY IF EXISTS "canteens_staff_select" ON public.canteens;
CREATE POLICY "canteens_staff_select" ON public.canteens FOR SELECT TO authenticated
  USING (public.can_access_canteen(id));
