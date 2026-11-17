-- ============================================================
-- UNIT SUPERVISORS, AND THE HS MAY STILL CHANGE A PUBLISHED MENU
--
-- 17 Nov 2026, asked by the owner:
--
-- 1. Eicher has three units. Each gets a Unit Supervisor with their own
--    login, who records only their unit: plates (actual and Eicher punch)
--    and dish-wise wastage, and marks their own attendance from that login.
--    New role 'unit_supervisor' (rank 15: below the store keeper, so it opens
--    nothing else) and user_roles.unit_no (1-3). A saved figure is still
--    corrected only by the manager, with a reason, as before.
--
-- 2. Menus now go to the chef a week ahead, so the HS needs to be able to
--    change one after publishing. Allowed while the menu is open: its day has
--    not passed and no order against it has been approved or issued. After
--    that the manager corrects it, as before. The chef is told it changed.
--
-- Safe to re-run.
-- ============================================================

-- ---------- The role ----------
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role = ANY (ARRAY[
    'super_admin', 'admin', 'ops_manager', 'unit_manager',
    'head_supervisor', 'head_chef', 'chef', 'store_keeper', 'unit_supervisor', 'vendor',
    'owner', 'manager', 'cashier'
  ]::text[]));

ALTER TABLE public.user_roles ADD COLUMN IF NOT EXISTS unit_no SMALLINT;
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_unit_no_check;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_unit_no_check
  CHECK ((role = 'unit_supervisor') = (unit_no IS NOT NULL) AND (unit_no IS NULL OR unit_no BETWEEN 1 AND 3));

CREATE OR REPLACE FUNCTION public.role_rank(p_role text)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE lower(coalesce(p_role, ''))
    WHEN 'super_admin'     THEN 70
    WHEN 'owner'           THEN 70
    WHEN 'admin'           THEN 60
    WHEN 'ops_manager'     THEN 50
    WHEN 'unit_manager'    THEN 40
    WHEN 'manager'         THEN 40
    WHEN 'head_supervisor' THEN 38
    WHEN 'head_chef'       THEN 35
    WHEN 'chef'            THEN 30
    WHEN 'cashier'         THEN 30
    WHEN 'store_keeper'    THEN 20
    WHEN 'unit_supervisor' THEN 15
    WHEN 'vendor'          THEN 10
    ELSE 0
  END;
$$;

-- 'Unit 2' for the Unit 2 supervisor (the key used in menu_plans.unit_counts), else NULL.
CREATE OR REPLACE FUNCTION public.my_supervised_unit()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 'Unit ' || unit_no FROM public.user_roles
   WHERE user_id = auth.uid() AND role = 'unit_supervisor' AND unit_no IS NOT NULL
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.my_supervised_unit() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_supervised_unit() TO authenticated;

-- ---------- A Unit Supervisor sees their menus and nothing else ----------
-- Every other table is read by site (can_access_canteen / my_canteen_ids).
-- A Unit Supervisor is shut out of those, as a vendor is, and given back only
-- the menus, dishes, wastage and site name they work with.
CREATE OR REPLACE FUNCTION public.is_unit_supervisor()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'unit_supervisor');
$$;
REVOKE ALL ON FUNCTION public.is_unit_supervisor() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_unit_supervisor() TO authenticated;

CREATE OR REPLACE FUNCTION public.unit_supervisor_site(cid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles
                  WHERE user_id = auth.uid() AND role = 'unit_supervisor' AND canteen_id = cid);
$$;
REVOKE ALL ON FUNCTION public.unit_supervisor_site(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unit_supervisor_site(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.can_access_canteen(cid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT CASE
    WHEN public.is_vendor() AND public.my_rank() < 20 THEN false
    WHEN public.is_unit_supervisor() THEN false
    WHEN public.my_rank() >= 60 THEN true
    ELSE EXISTS (SELECT 1 FROM public.user_roles
                 WHERE user_id = auth.uid() AND canteen_id = cid)
      OR EXISTS (SELECT 1 FROM public.user_sites
                 WHERE user_id = auth.uid() AND canteen_id = cid)
  END;
$function$;

CREATE OR REPLACE FUNCTION public.my_canteen_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT c.id FROM public.canteens c
   WHERE NOT (public.is_vendor() AND public.my_rank() < 20)
     AND NOT public.is_unit_supervisor()
     AND (public.my_rank() >= 60
          OR EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid() AND ur.canteen_id = c.id)
          OR EXISTS (SELECT 1 FROM public.user_sites us WHERE us.user_id = auth.uid() AND us.canteen_id = c.id));
$function$;

DROP POLICY IF EXISTS "unit supervisor reads own site" ON public.canteens;
CREATE POLICY "unit supervisor reads own site" ON public.canteens FOR SELECT TO authenticated
  USING (public.unit_supervisor_site(id));
DROP POLICY IF EXISTS "unit supervisor reads published menus" ON public.menu_plans;
CREATE POLICY "unit supervisor reads published menus" ON public.menu_plans FOR SELECT TO authenticated
  USING (status <> 'draft' AND public.unit_supervisor_site(canteen_id));
DROP POLICY IF EXISTS "unit supervisor reads dishes" ON public.menu_plan_items;
CREATE POLICY "unit supervisor reads dishes" ON public.menu_plan_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.menu_plans m WHERE m.id = menu_plan_items.menu_plan_id
                  AND m.status <> 'draft' AND public.unit_supervisor_site(m.canteen_id)));
DROP POLICY IF EXISTS "unit supervisor reads unit wastage" ON public.menu_unit_wastage;
CREATE POLICY "unit supervisor reads unit wastage" ON public.menu_unit_wastage FOR SELECT TO authenticated
  USING (public.unit_supervisor_site(canteen_id));
DROP POLICY IF EXISTS "unit supervisor sees wastage photo" ON storage.objects;
CREATE POLICY "unit supervisor sees wastage photo" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'wastage' AND public.unit_supervisor_site(((storage.foldername(name))[1])::uuid));

-- ---------- A published menu the HS may still change ----------
CREATE OR REPLACE FUNCTION public.menu_open_for_hs_edit(p_menu_plan_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.menu_date >= timezone('Asia/Kolkata', now())::date
     AND NOT EXISTS (SELECT 1 FROM public.requisitions r
                      WHERE r.menu_plan_id = m.id AND r.status IN ('approved', 'issued'))
    FROM public.menu_plans m WHERE m.id = p_menu_plan_id;
$$;
REVOKE ALL ON FUNCTION public.menu_open_for_hs_edit(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.menu_open_for_hs_edit(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_menu_plan_role()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  -- what recording plates may move (guard_menu_headcount sets the totals)
  v_counts text[] := ARRAY['unit_counts', 'actual_headcount', 'company_punch_count',
    'company_punch_source', 'actual_recorded_by', 'actual_recorded_at',
    'punch_recorded_by', 'punch_recorded_at', 'count_change_reason', 'updated_at'];
BEGIN
  IF public.is_admin_editor() OR public.is_manager_or_above() THEN RETURN NEW; END IF;

  -- Unit Supervisor: their unit's plates and nothing else on the menu.
  IF public.my_supervised_unit() IS NOT NULL AND public.unit_supervisor_site(NEW.canteen_id) THEN
    IF (to_jsonb(NEW) - v_counts) IS DISTINCT FROM (to_jsonb(OLD) - v_counts) THEN
      RAISE EXCEPTION 'Unit Supervisor sirf apni unit ki plates daal sakta hai';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT public.is_head_supervisor() OR NOT public.can_access_canteen(NEW.canteen_id) THEN
    RAISE EXCEPTION 'Only Head Supervisor can enter the menu';
  END IF;
  -- HS builds and publishes. After publishing they may still change the
  -- dishes, headcount and note while the menu is open; the day, meal and
  -- site stay put, and once an order is approved the manager corrects it.
  IF OLD.status <> 'draft' AND (
       NEW.canteen_id IS DISTINCT FROM OLD.canteen_id
    OR NEW.menu_date IS DISTINCT FROM OLD.menu_date
    OR NEW.meal_period IS DISTINCT FROM OLD.meal_period
    OR NEW.status IS DISTINCT FROM OLD.status
  ) THEN
    RAISE EXCEPTION 'Published menu ka din / meal Manager badlega';
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.expected_headcount IS DISTINCT FROM OLD.expected_headcount
    OR NEW.notes IS DISTINCT FROM OLD.notes
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
  ) AND NOT public.menu_open_for_hs_edit(OLD.id) THEN
    RAISE EXCEPTION 'Is menu ka order approve / issue ho chuka hai (ya din nikal gaya) — ab Manager badlega';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_menu_plan_role() FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "menu_plan_items_head_supervisor_write" ON public.menu_plan_items;
CREATE POLICY "menu_plan_items_head_supervisor_write" ON public.menu_plan_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.menu_plans m
    WHERE m.id = menu_plan_items.menu_plan_id
      AND (m.status = 'draft' OR public.menu_open_for_hs_edit(m.id))
      AND public.is_head_supervisor() AND m.canteen_id IN (SELECT public.my_canteen_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.menu_plans m
    WHERE m.id = menu_plan_items.menu_plan_id
      AND (m.status = 'draft' OR public.menu_open_for_hs_edit(m.id))
      AND public.is_head_supervisor() AND m.canteen_id IN (SELECT public.my_canteen_ids())));

-- The chef is told a published menu changed.
CREATE OR REPLACE FUNCTION public.notify_menu_changed(p_menu_plan_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m public.menu_plans%ROWTYPE; v_pending int;
BEGIN
  SELECT * INTO m FROM public.menu_plans WHERE id = p_menu_plan_id;
  IF NOT FOUND OR NOT public.can_access_canteen(m.canteen_id)
     OR NOT (public.is_head_supervisor() OR public.is_manager_or_above()) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;
  IF m.status <> 'published' THEN RETURN; END IF;
  SELECT count(*) INTO v_pending FROM public.requisitions
   WHERE menu_plan_id = m.id AND status = 'pending';
  INSERT INTO public.notifications (canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES (m.canteen_id, 'chef',
    initcap(replace(m.meal_period, '_', ' ')) || ' menu badla · ' || to_char(m.menu_date, 'Dy DD Mon'),
    'Menu badal gaya hai (' || coalesce(m.expected_headcount, 0) || ' log). Naya menu dekh lo.' ||
      CASE WHEN v_pending > 0 THEN ' Is menu ka aapka order abhi pending hai — use bhi check karo.' ELSE '' END,
    '/menu-planning?date=' || to_char(m.menu_date, 'YYYY-MM-DD') || '&site=' || m.canteen_id,
    'menu_plan', m.id);
END;
$$;
REVOKE ALL ON FUNCTION public.notify_menu_changed(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notify_menu_changed(uuid) TO authenticated;

-- ---------- Unit Supervisor: plates ----------
CREATE OR REPLACE FUNCTION public.can_see_menu_as_unit_supervisor(p_canteen_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.my_supervised_unit() IS NOT NULL AND public.unit_supervisor_site(p_canteen_id);
$$;
REVOKE ALL ON FUNCTION public.can_see_menu_as_unit_supervisor(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_see_menu_as_unit_supervisor(uuid) TO authenticated;

DROP POLICY IF EXISTS "menu_plans_unit_supervisor_update" ON public.menu_plans;
CREATE POLICY "menu_plans_unit_supervisor_update" ON public.menu_plans FOR UPDATE TO authenticated
  USING (status <> 'draft' AND public.can_see_menu_as_unit_supervisor(canteen_id))
  WITH CHECK (status <> 'draft' AND public.can_see_menu_as_unit_supervisor(canteen_id));

-- One unit's figure, merged in under the row lock so two supervisors saving
-- at the same moment do not overwrite each other. Runs as the caller, so
-- every guard on menu_plans still applies.
CREATE OR REPLACE FUNCTION public.record_my_unit_plates(
  p_menu_plan_id uuid, p_actual integer DEFAULT NULL, p_punch integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_unit text := public.my_supervised_unit(); v_new jsonb := '{}'::jsonb; v_row public.menu_plans%ROWTYPE;
BEGIN
  IF v_unit IS NULL THEN RAISE EXCEPTION 'Ye sirf Unit Supervisor ke liye hai'; END IF;
  IF p_actual IS NOT NULL THEN v_new := v_new || jsonb_build_object('actual', p_actual); END IF;
  IF p_punch IS NOT NULL THEN v_new := v_new || jsonb_build_object('punch', p_punch); END IF;
  IF v_new = '{}'::jsonb THEN RAISE EXCEPTION 'Plates ki ginti daalo'; END IF;
  UPDATE public.menu_plans
     SET unit_counts = coalesce(unit_counts, '{}'::jsonb)
                       || jsonb_build_object(v_unit, coalesce(unit_counts -> v_unit, '{}'::jsonb) || v_new)
   WHERE id = p_menu_plan_id
   RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Menu nahi mila (ya abhi publish nahi hua)'; END IF;
  RETURN jsonb_build_object('unit', v_unit, 'counts', v_row.unit_counts -> v_unit);
END;
$$;
REVOKE ALL ON FUNCTION public.record_my_unit_plates(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_my_unit_plates(uuid, integer, integer) TO authenticated;

-- ---------- Unit Supervisor: wastage photo ----------
DROP POLICY IF EXISTS "unit supervisor files wastage photo" ON storage.objects;
CREATE POLICY "unit supervisor files wastage photo"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'wastage'
  AND public.my_supervised_unit() IS NOT NULL
  AND public.unit_supervisor_site(((storage.foldername(name))[1])::uuid));

-- ---------- Plates and wastage functions: the supervisor's own unit ----------
CREATE OR REPLACE FUNCTION public.guard_menu_headcount()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := nullif(btrim(NEW.count_change_reason), '');
  v_units text[]; v_from date; v_unit_mode boolean := false;
  v_u text; v_f text; v_old numeric; v_new numeric; v_raw jsonb;
  v_sum_a int; v_sum_p int; v_all_a boolean; v_all_p boolean; v_key text;
BEGIN
  -- ---------- Plates by unit ----------
  SELECT count_units, count_units_from INTO v_units, v_from
    FROM public.canteens WHERE id = NEW.canteen_id;
  v_unit_mode := coalesce(cardinality(v_units), 0) > 0
                 AND (v_from IS NULL OR NEW.menu_date >= v_from);

  IF NEW.unit_counts IS DISTINCT FROM OLD.unit_counts THEN
    IF NOT v_unit_mode THEN
      RAISE EXCEPTION 'Is site / din ke liye unit-wise count nahi hota — total count dalo';
    END IF;
    IF jsonb_typeof(coalesce(NEW.unit_counts, '{}'::jsonb)) <> 'object' THEN
      RAISE EXCEPTION 'Unit counts galat format me hain';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(coalesce(NEW.unit_counts, '{}'::jsonb)) LOOP
      IF NOT v_key = ANY (v_units) THEN
        RAISE EXCEPTION 'Unknown unit: %', v_key;
      END IF;
    END LOOP;

    FOREACH v_u IN ARRAY v_units LOOP
      FOREACH v_f IN ARRAY ARRAY['actual', 'punch'] LOOP
        v_raw := NEW.unit_counts -> v_u -> v_f;
        IF v_raw IS NOT NULL AND jsonb_typeof(v_raw) NOT IN ('number', 'null') THEN
          RAISE EXCEPTION '% ka count number hona chahiye', v_u;
        END IF;
        v_new := nullif(NEW.unit_counts -> v_u ->> v_f, '')::numeric;
        v_old := nullif(OLD.unit_counts -> v_u ->> v_f, '')::numeric;
        CONTINUE WHEN v_new IS NOT DISTINCT FROM v_old;
        IF v_new IS NOT NULL AND (v_new < 0 OR v_new <> trunc(v_new)) THEN
          RAISE EXCEPTION '% ka count 0 ya usse zyada poora number hona chahiye', v_u;
        END IF;
        IF v_old IS NULL THEN
          IF NOT (public.can_do_hs_work(NEW.canteen_id)
                  OR v_u = public.my_supervised_unit()) THEN
            RAISE EXCEPTION '% ka % Head Supervisor record karega', v_u,
              CASE v_f WHEN 'actual' THEN 'actual' ELSE 'Eicher punch' END;
          END IF;
        ELSE
          IF NOT public.is_manager_or_above() THEN
            RAISE EXCEPTION '% ka recorded % sirf Manager correct kar sakta hai', v_u,
              CASE v_f WHEN 'actual' THEN 'actual' ELSE 'Eicher punch' END;
          END IF;
          IF v_reason IS NULL OR NEW.count_change_reason IS NOT DISTINCT FROM OLD.count_change_reason THEN
            RAISE EXCEPTION '% ka count correct karne ka naya reason zaroori hai', v_u;
          END IF;
        END IF;
        INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
        VALUES (auth.uid(),
          CASE WHEN v_old IS NULL THEN 'unit_count_recorded' ELSE 'unit_count_corrected' END,
          'menu_plan', NEW.id, NEW.canteen_id,
          jsonb_build_object('menu_date', NEW.menu_date, 'meal_period', NEW.meal_period,
            'unit', v_u, 'count', CASE v_f WHEN 'actual' THEN 'actual' ELSE 'eicher_punch' END,
            'was', v_old, 'now', v_new, 'reason', CASE WHEN v_old IS NULL THEN NULL ELSE v_reason END));
      END LOOP;
    END LOOP;
  END IF;

  IF v_unit_mode THEN
    -- The site figure is the units added up, and only once all are in. A
    -- direct write of the site figure (an old screen still open) is refused
    -- rather than silently replaced.
    SELECT coalesce(sum((NEW.unit_counts -> u ->> 'actual')::int), 0),
           bool_and(NEW.unit_counts -> u ->> 'actual' IS NOT NULL),
           coalesce(sum((NEW.unit_counts -> u ->> 'punch')::int), 0),
           bool_and(NEW.unit_counts -> u ->> 'punch' IS NOT NULL)
      INTO v_sum_a, v_all_a, v_sum_p, v_all_p
      FROM unnest(v_units) u;
    IF NEW.unit_counts IS NOT DISTINCT FROM OLD.unit_counts
       AND (NEW.actual_headcount IS DISTINCT FROM OLD.actual_headcount
            OR NEW.company_punch_count IS DISTINCT FROM OLD.company_punch_count) THEN
      RAISE EXCEPTION 'Ab Unit 1, 2, 3 ka count alag dalna hai — app refresh karke unit-wise dalo';
    END IF;
    NEW.actual_headcount := CASE WHEN v_all_a THEN v_sum_a END;
    NEW.company_punch_count := CASE WHEN v_all_p THEN v_sum_p END;
    IF NEW.company_punch_count IS DISTINCT FROM OLD.company_punch_count THEN
      NEW.company_punch_source := coalesce(NEW.company_punch_source, 'manual');
    END IF;
  END IF;

  -- ---------- Expected headcount (unchanged) ----------
  IF NEW.expected_headcount IS DISTINCT FROM OLD.expected_headcount THEN
    IF NOT (public.is_head_supervisor() OR public.is_manager_or_above()) THEN
      RAISE EXCEPTION 'Only Head Supervisor can enter expected headcount';
    END IF;
    IF OLD.status<>'draft' AND public.is_head_supervisor() AND NOT public.is_manager_or_above()
       AND NOT public.menu_open_for_hs_edit(NEW.id) THEN
      RAISE EXCEPTION 'Is menu ka order approve / issue ho chuka hai (ya din nikal gaya) — headcount ab Manager badlega';
    END IF;
    IF EXISTS (SELECT 1 FROM public.requisitions r
               WHERE r.menu_plan_id=NEW.id AND r.status='issued') THEN
      RAISE EXCEPTION 'Material has already been issued against this menu — expected headcount cannot be changed';
    END IF;
  END IF;

  -- ---------- Site totals (unchanged rules; in unit mode the per-unit
  -- checks above have already decided who may move them) ----------
  IF NEW.actual_headcount IS DISTINCT FROM OLD.actual_headcount THEN
    IF NOT v_unit_mode THEN
      IF OLD.actual_headcount IS NULL THEN
        IF NOT (public.can_do_hs_work(NEW.canteen_id)) THEN
          RAISE EXCEPTION 'Actual plates Head Supervisor record karega';
        END IF;
      ELSE
        IF NOT public.is_manager_or_above() THEN
          RAISE EXCEPTION 'Recorded actual plates sirf Manager correct kar sakta hai';
        END IF;
        IF v_reason IS NULL OR NEW.count_change_reason IS NOT DISTINCT FROM OLD.count_change_reason THEN
          RAISE EXCEPTION 'Actual plates correction ka naya reason zaroori hai';
        END IF;
      END IF;
    END IF;
    IF NEW.actual_headcount IS NOT NULL AND NEW.actual_headcount<0 THEN
      RAISE EXCEPTION 'Actual plates served cannot be negative';
    END IF;
    NEW.actual_recorded_by:=auth.uid(); NEW.actual_recorded_at:=now();
    INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
    VALUES(auth.uid(),CASE WHEN OLD.actual_headcount IS NULL THEN 'plates_recorded' ELSE 'plates_corrected' END,
      'menu_plan',NEW.id,NEW.canteen_id,jsonb_build_object('menu_date',NEW.menu_date,
      'meal_period',NEW.meal_period,'was',OLD.actual_headcount,'now',NEW.actual_headcount,'reason',v_reason,
      'units', CASE WHEN v_unit_mode THEN NEW.unit_counts END));
  END IF;

  IF NEW.company_punch_count IS DISTINCT FROM OLD.company_punch_count THEN
    IF NOT v_unit_mode THEN
      IF OLD.company_punch_count IS NULL THEN
        IF NOT (public.can_do_hs_work(NEW.canteen_id)) THEN
          RAISE EXCEPTION 'Company punch Head Supervisor record karega';
        END IF;
      ELSE
        IF NOT public.is_manager_or_above() THEN
          RAISE EXCEPTION 'Recorded company punch sirf Manager correct kar sakta hai';
        END IF;
        IF v_reason IS NULL OR NEW.count_change_reason IS NOT DISTINCT FROM OLD.count_change_reason THEN
          RAISE EXCEPTION 'Company punch correction ka naya reason zaroori hai';
        END IF;
      END IF;
    END IF;
    IF NEW.company_punch_count IS NOT NULL AND NEW.company_punch_count<0 THEN
      RAISE EXCEPTION 'Company punch count cannot be negative';
    END IF;
    NEW.punch_recorded_by:=auth.uid(); NEW.punch_recorded_at:=now();
    INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
    VALUES(auth.uid(),CASE WHEN OLD.company_punch_count IS NULL THEN 'company_punch_recorded' ELSE 'company_punch_corrected' END,
      'menu_plan',NEW.id,NEW.canteen_id,jsonb_build_object('menu_date',NEW.menu_date,
      'meal_period',NEW.meal_period,'was',OLD.company_punch_count,'now',NEW.company_punch_count,'reason',v_reason,
      'units', CASE WHEN v_unit_mode THEN NEW.unit_counts END));
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_menu_item_unit_wastage(p_menu_plan_item_id uuid, p_unit_no integer, p_quantity numeric, p_photo_path text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item public.menu_plan_items%ROWTYPE;
  v_plan public.menu_plans%ROWTYPE;
  v_row public.menu_unit_wastage%ROWTYPE;
  v_old public.menu_unit_wastage%ROWTYPE;
  v_expected_prefix text;
  v_reason text:=nullif(btrim(coalesce(p_reason,'')),'');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF NOT (public.is_head_supervisor() OR public.is_manager_or_above()
          OR public.my_supervised_unit() IS NOT NULL) THEN
    RAISE EXCEPTION 'Wastage Head Supervisor record karega';
  END IF;
  IF public.my_supervised_unit() IS NOT NULL
     AND public.my_supervised_unit() <> 'Unit ' || p_unit_no THEN
    RAISE EXCEPTION 'Aap sirf % ka wastage daal sakte ho', public.my_supervised_unit();
  END IF;
  SELECT * INTO v_item FROM public.menu_plan_items WHERE id=p_menu_plan_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Menu item not found'; END IF;
  SELECT * INTO v_plan FROM public.menu_plans WHERE id=v_item.menu_plan_id FOR UPDATE;
  IF NOT FOUND OR NOT (public.can_access_canteen(v_plan.canteen_id)
                       OR public.unit_supervisor_site(v_plan.canteen_id)) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;
  IF v_plan.status='draft' THEN RAISE EXCEPTION 'Publish the menu before recording wastage'; END IF;
  IF v_plan.meal_period NOT IN ('breakfast','lunch','evening_snacks','dinner','night_snacks') THEN
    RAISE EXCEPTION 'Unit-wise item wastage is not used for this meal period';
  END IF;
  IF p_unit_no NOT BETWEEN 1 AND 3 THEN RAISE EXCEPTION 'Unit must be 1, 2 or 3'; END IF;
  IF coalesce(p_quantity,0)<=0 THEN RAISE EXCEPTION 'Enter the wastage weight'; END IF;

  v_expected_prefix:=v_plan.canteen_id::text||'/'||v_plan.id::text||'/'||v_item.id::text||'/';
  IF coalesce(p_photo_path,'') NOT LIKE v_expected_prefix||'%' THEN
    RAISE EXCEPTION 'This photo does not belong to this menu item and site';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o
    WHERE o.bucket_id='wastage' AND o.name=p_photo_path) THEN
    RAISE EXCEPTION 'Wastage photo upload nahi hui — dobara photo lagayein';
  END IF;

  SELECT * INTO v_old FROM public.menu_unit_wastage
   WHERE menu_plan_item_id=v_item.id AND unit_no=p_unit_no FOR UPDATE;
  IF FOUND THEN
    IF NOT public.is_manager_or_above() THEN
      RAISE EXCEPTION 'Saved wastage correction sirf Manager kar sakta hai';
    END IF;
    IF v_reason IS NULL THEN RAISE EXCEPTION 'Wastage correction reason zaroori hai'; END IF;
    UPDATE public.menu_unit_wastage
       SET quantity=p_quantity, photo_path=p_photo_path,
           corrected_by=auth.uid(), corrected_at=now(), correction_reason=v_reason
     WHERE id=v_old.id RETURNING * INTO v_row;
    INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
    VALUES(auth.uid(),'item_unit_wastage_corrected','menu_plan_item',v_item.id,v_plan.canteen_id,
      jsonb_build_object('dish',v_item.dish_name,'unit_no',p_unit_no,
        'was_kg',v_old.quantity,'now_kg',p_quantity,'reason',v_reason,
        'old_photo_path',v_old.photo_path,'new_photo_path',p_photo_path,
        'menu_date',v_plan.menu_date,'meal_period',v_plan.meal_period));
  ELSE
    IF NOT (public.can_do_hs_work(v_plan.canteen_id)
            OR public.my_supervised_unit() = 'Unit ' || p_unit_no) THEN
      RAISE EXCEPTION 'Naya wastage Head Supervisor record karega; Manager saved entry correct karega';
    END IF;
    INSERT INTO public.menu_unit_wastage(menu_plan_id,menu_plan_item_id,canteen_id,unit_no,
      quantity,photo_path,created_by)
    VALUES(v_plan.id,v_item.id,v_plan.canteen_id,p_unit_no,p_quantity,p_photo_path,auth.uid())
    RETURNING * INTO v_row;
    INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
    VALUES(auth.uid(),'item_unit_wastage_recorded','menu_plan_item',v_item.id,v_plan.canteen_id,
      jsonb_build_object('dish',v_item.dish_name,'unit_no',p_unit_no,
        'quantity_kg',p_quantity,'photo_path',p_photo_path,
        'menu_date',v_plan.menu_date,'meal_period',v_plan.meal_period));
  END IF;
  RETURN jsonb_build_object('id',v_row.id,'dish',v_item.dish_name,'unit_no',v_row.unit_no,
    'quantity',v_row.quantity,'unit',v_row.unit,'photo_path',v_row.photo_path,
    'corrected',v_row.corrected_at IS NOT NULL);
END;
$function$;

-- ---------- HS changing a published menu's dishes ----------
CREATE OR REPLACE FUNCTION public.guard_menu_item_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_plan public.menu_plans%ROWTYPE;
BEGIN
  IF public.is_admin_editor() THEN RETURN OLD; END IF;
  SELECT * INTO v_plan FROM public.menu_plans WHERE id=OLD.menu_plan_id;
  IF NOT FOUND THEN RETURN OLD; END IF;
  IF (v_plan.status='draft' OR public.menu_open_for_hs_edit(v_plan.id)) AND public.is_head_supervisor() THEN RETURN OLD; END IF;
  IF public.is_manager_or_above() THEN
    INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
    VALUES(auth.uid(),'menu_dish_removed','menu_plan_item',OLD.id,v_plan.canteen_id,
      jsonb_build_object('dish',OLD.dish_name,'menu_date',v_plan.menu_date,'meal_period',v_plan.meal_period));
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Only Manager can remove a dish after menu publication';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_menu_item_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- HS may change a published menu while no order against it is approved.
  IF v_plan.status<>'draft' AND public.is_head_supervisor() AND public.menu_open_for_hs_edit(v_plan.id) THEN
    INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
    VALUES(auth.uid(),'menu_dish_changed_by_hs','menu_plan',v_plan.id,v_plan.canteen_id,
      jsonb_build_object('change','dish_added','dish',NEW.dish_name,'menu_date',v_plan.menu_date,'meal_period',v_plan.meal_period));
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
$function$
;

CREATE OR REPLACE FUNCTION public.guard_menu_item_edit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_plan public.menu_plans%ROWTYPE;
BEGIN
  IF public.is_admin_editor() THEN RETURN NEW; END IF;
  SELECT * INTO v_plan FROM public.menu_plans WHERE id=NEW.menu_plan_id;
  IF NOT FOUND OR NOT public.can_access_canteen(v_plan.canteen_id) THEN
    RAISE EXCEPTION 'Menu is not available at your site';
  END IF;

  IF v_plan.status='draft' THEN
    IF public.is_head_supervisor() OR public.is_manager_or_above() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Only Head Supervisor can edit a draft menu';
  END IF;

  IF public.is_manager_or_above()
     OR (public.is_head_supervisor() AND public.menu_open_for_hs_edit(v_plan.id)) THEN
    IF NEW.dish_name IS DISTINCT FROM OLD.dish_name
       OR NEW.planned_qty IS DISTINCT FROM OLD.planned_qty
       OR NEW.unit IS DISTINCT FROM OLD.unit
       OR NEW.recipe_id IS DISTINCT FROM OLD.recipe_id THEN
      INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
      VALUES(auth.uid(),'menu_dish_corrected','menu_plan_item',NEW.id,v_plan.canteen_id,
        jsonb_build_object('menu_date',v_plan.menu_date,'meal_period',v_plan.meal_period,
          'old_dish',OLD.dish_name,'new_dish',NEW.dish_name,
          'old_qty',OLD.planned_qty,'new_qty',NEW.planned_qty));
    END IF;
    RETURN NEW;
  END IF;

  IF public.is_chef()
     AND NEW.dish_name IS NOT DISTINCT FROM OLD.dish_name
     AND NEW.planned_qty IS NOT DISTINCT FROM OLD.planned_qty
     AND NEW.unit IS NOT DISTINCT FROM OLD.unit
     AND NEW.recipe_id IS NOT DISTINCT FROM OLD.recipe_id
     AND NEW.wastage_qty IS NOT DISTINCT FROM OLD.wastage_qty
     AND NEW.wastage_photo_url IS NOT DISTINCT FROM OLD.wastage_photo_url
     AND NEW.wastage_by IS NOT DISTINCT FROM OLD.wastage_by
     AND NEW.wastage_at IS NOT DISTINCT FROM OLD.wastage_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Chef can record production only; Manager corrects a published menu';
END;
$function$
;

REVOKE ALL ON FUNCTION public.record_menu_item_unit_wastage(uuid,integer,numeric,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_menu_item_unit_wastage(uuid,integer,numeric,text,text) TO authenticated;

-- ---------- Supervisor's own attendance from their login ----------
-- staff.user_id (an existing column) links a staff row to an app login; the
-- staff-attendance function accepts that login in place of mobile + PIN.
CREATE UNIQUE INDEX IF NOT EXISTS staff_user_uniq ON public.staff (user_id) WHERE user_id IS NOT NULL AND active;
