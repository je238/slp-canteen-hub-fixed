-- ============================================================
-- AT SUN PHARMA THE MANAGER DOES THE HEAD SUPERVISOR'S WORK
--
-- Sun Pharma has no Head Supervisor (7 Oct 2026). The first entry of a
-- meal's plates, Eicher punch and unit wastage was reserved for the Head
-- Supervisor (or an admin); the manager could only correct an entry that
-- already existed — so at Sun Pharma nobody could enter them at all.
--
-- canteens.manager_does_hs (off by default, on for Sun Pharma) lets the
-- site's manager make those first entries too. can_do_hs_work(site) is the
-- one test: Head Supervisor, admin, or a manager where the site allows it.
-- Corrections are unchanged (manager, with a reason). Eicher is unchanged.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.canteens ADD COLUMN IF NOT EXISTS manager_does_hs boolean NOT NULL DEFAULT false;
UPDATE public.canteens SET manager_does_hs = true WHERE id = '98fb85b0-4943-4da7-9b45-a663463d7f05';

CREATE OR REPLACE FUNCTION public.can_do_hs_work(p_canteen_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_head_supervisor() OR public.is_admin_editor()
      OR (public.is_manager_or_above()
          AND coalesce((SELECT manager_does_hs FROM public.canteens WHERE id = p_canteen_id), false));
$$;
REVOKE ALL ON FUNCTION public.can_do_hs_work(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_do_hs_work(uuid) TO authenticated;

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
          IF NOT (public.can_do_hs_work(NEW.canteen_id)) THEN
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
    IF OLD.status<>'draft' AND public.is_head_supervisor() AND NOT public.is_manager_or_above() THEN
      RAISE EXCEPTION 'Published expected headcount correction Manager karega';
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
  IF NOT (public.is_head_supervisor() OR public.is_manager_or_above()) THEN
    RAISE EXCEPTION 'Wastage Head Supervisor record karega';
  END IF;
  SELECT * INTO v_item FROM public.menu_plan_items WHERE id=p_menu_plan_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Menu item not found'; END IF;
  SELECT * INTO v_plan FROM public.menu_plans WHERE id=v_item.menu_plan_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_canteen(v_plan.canteen_id) THEN
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
    IF NOT (public.can_do_hs_work(v_plan.canteen_id)) THEN
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
