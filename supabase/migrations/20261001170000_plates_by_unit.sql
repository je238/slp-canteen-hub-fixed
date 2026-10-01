-- ============================================================
-- PLATES BY UNIT
--
-- From 1 Oct 2026 the Head Supervisor records each meal's plates unit by
-- unit at Eicher — Unit 1, Unit 2 and Unit 3 — each with its own actual
-- served and its own Eicher final punch. Until now a meal had one actual
-- and one punch for the whole site.
--
-- The site total still lives in actual_headcount / company_punch_count, so
-- every report, the billing and the dashboards keep reading what they read
-- today. It is now derived: the sum of the units, filled in only once every
-- unit has its figure. A half-entered meal (Unit 1 and 2 in, Unit 3 not yet)
-- stays pending rather than billing on two units out of three. A unit that
-- did not serve that meal is entered as 0.
--
-- The same rules as the site figure, per unit and per number:
--   · first entry  — Head Supervisor (or an admin)
--   · correction   — Manager or above, with a new reason
-- and every entry and correction goes to the action log with the unit named.
--
-- A site without units, and every meal before the start date, carries on
-- with the single site figure exactly as before.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.canteens
  ADD COLUMN IF NOT EXISTS count_units text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS count_units_from date;

-- {"Unit 1": {"actual": 410, "punch": 402}, "Unit 2": {...}, "Unit 3": {...}}
ALTER TABLE public.menu_plans
  ADD COLUMN IF NOT EXISTS unit_counts jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE public.canteens
   SET count_units = ARRAY['Unit 1', 'Unit 2', 'Unit 3'], count_units_from = DATE '2026-10-01'
 WHERE id = 'd4402630-dec6-44fa-b14c-405b45258f99';

CREATE OR REPLACE FUNCTION public.guard_menu_headcount()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
          IF NOT (public.is_head_supervisor() OR public.is_admin_editor()) THEN
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
        IF NOT (public.is_head_supervisor() OR public.is_admin_editor()) THEN
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
        IF NOT (public.is_head_supervisor() OR public.is_admin_editor()) THEN
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
$$;
