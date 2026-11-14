-- ============================================================
-- SITE ACCESS IS CHECKED ONCE PER QUERY, NOT ONCE PER ROW
--
-- Reports stopped loading on 13 Nov 2026 ("statement timeout"): every row-
-- level policy called can_access_canteen(canteen_id) for each row, and that
-- function looks the user's role up again every time. 13,431 stock_ledger
-- rows took 5.8 s to count as the unit manager; stock_ageing took 6.1 s and
-- the 8 s API limit cut the bigger reports off. Notifications (0.4 s),
-- ingredient rates (1.1 s) and the order list (5 s) were slow the same way.
--
-- Now the user's sites are listed once (my_canteen_ids(), an InitPlan) and
-- each row is matched against that list. Same answer, same people see the
-- same rows: tested 5.8 s -> 5 ms and 6.1 s -> 0.26 s. The no-argument role
-- helpers (is_admin_editor(), can_receive_stock() ...) are wrapped in a
-- SELECT so they too run once per query.
--
-- can_access_canteen(x) is rewritten as
--   x IN (my sites) OR (x IS NULL AND can_access_canteen(NULL))
-- which is exactly the old answer for every x, including a NULL site.
--
-- Safe to re-run: policies already rewritten are left alone.
-- ============================================================

CREATE OR REPLACE FUNCTION public.my_canteen_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT c.id FROM public.canteens c
   WHERE NOT (public.is_vendor() AND public.my_rank() < 20)
     AND (public.my_rank() >= 60
          OR EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid() AND ur.canteen_id = c.id)
          OR EXISTS (SELECT 1 FROM public.user_sites us WHERE us.user_id = auth.uid() AND us.canteen_id = c.id));
$$;
REVOKE ALL ON FUNCTION public.my_canteen_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_canteen_ids() TO authenticated;

DO $$
DECLARE
  p record;
  v_qual text;
  v_check text;
  v_sql text;
  site_rx constant text := 'can_access_canteen\(([a-z_]+\.)?([a-z_]+)\)';
  site_to constant text := '((\1\2) IN (SELECT public.my_canteen_ids()) OR ((\1\2) IS NULL AND (SELECT public.can_access_canteen(NULL::uuid))))';
  -- no-argument helpers not already inside a SELECT
  role_rx constant text := '(?<!SELECT public\.)\m(is_admin_editor|is_manager_or_above|is_store_keeper_or_above|is_store_keeper|is_super_admin|can_receive_stock|is_vendor|my_rank)\(\)';
  role_to constant text := '(SELECT public.\1())';
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (coalesce(qual, '') ~ 'can_access_canteen\(|(is_admin_editor|is_manager_or_above|is_store_keeper_or_above|is_store_keeper|is_super_admin|can_receive_stock|is_vendor|my_rank)\(\)'
         OR coalesce(with_check, '') ~ 'can_access_canteen\(|(is_admin_editor|is_manager_or_above|is_store_keeper_or_above|is_store_keeper|is_super_admin|can_receive_stock|is_vendor|my_rank)\(\)')
  LOOP
    v_qual := p.qual;
    v_check := p.with_check;
    IF v_qual IS NOT NULL THEN
      v_qual := regexp_replace(v_qual, site_rx, site_to, 'g');
      v_qual := regexp_replace(v_qual, role_rx, role_to, 'g');
    END IF;
    IF v_check IS NOT NULL THEN
      v_check := regexp_replace(v_check, site_rx, site_to, 'g');
      v_check := regexp_replace(v_check, role_rx, role_to, 'g');
    END IF;
    IF v_qual IS NOT DISTINCT FROM p.qual AND v_check IS NOT DISTINCT FROM p.with_check THEN
      CONTINUE;
    END IF;
    v_sql := format('ALTER POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
    IF v_qual IS NOT NULL THEN v_sql := v_sql || ' USING (' || v_qual || ')'; END IF;
    IF v_check IS NOT NULL THEN v_sql := v_sql || ' WITH CHECK (' || v_check || ')'; END IF;
    EXECUTE v_sql;
  END LOOP;
END;
$$;
