-- Head Supervisor owns menu/data entry. Manager keeps final requisition
-- approval and correction rights, without taking over the daily entry job.

ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role = ANY (ARRAY[
    'super_admin', 'admin', 'ops_manager', 'unit_manager',
    'head_supervisor', 'head_chef', 'chef', 'store_keeper', 'vendor',
    'owner', 'manager', 'cashier'
  ]::text[]));

CREATE OR REPLACE FUNCTION public.role_rank(p_role text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE lower(coalesce(p_role, ''))
    WHEN 'super_admin'    THEN 70
    WHEN 'owner'          THEN 70
    WHEN 'admin'          THEN 60
    WHEN 'ops_manager'    THEN 50
    WHEN 'unit_manager'   THEN 40
    WHEN 'manager'        THEN 40
    WHEN 'head_supervisor' THEN 38
    WHEN 'head_chef'      THEN 35
    WHEN 'chef'           THEN 30
    WHEN 'cashier'        THEN 30
    WHEN 'store_keeper'   THEN 20
    WHEN 'vendor'         THEN 10
    ELSE 0
  END;
$$;

CREATE OR REPLACE FUNCTION public.is_head_supervisor()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND lower(role) = 'head_supervisor'
  );
$$;
REVOKE ALL ON FUNCTION public.is_head_supervisor() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_head_supervisor() TO authenticated;

CREATE INDEX IF NOT EXISTS idx_user_roles_head_supervisor_site
  ON public.user_roles (canteen_id)
  WHERE role = 'head_supervisor';

-- Drafts belong to HS. Managers can update an existing menu only to correct it.
DROP POLICY IF EXISTS "menu_plans_select" ON public.menu_plans;
CREATE POLICY "menu_plans_select" ON public.menu_plans FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id)
    AND (status <> 'draft' OR public.is_head_supervisor() OR public.is_manager_or_above()));

DROP POLICY IF EXISTS "menu_plans_manager_write" ON public.menu_plans;
DROP POLICY IF EXISTS "menu_plans_chef_update" ON public.menu_plans;
DROP POLICY IF EXISTS "menu_plans_admin_write" ON public.menu_plans;
DROP POLICY IF EXISTS "menu_plans_manager_update" ON public.menu_plans;
DROP POLICY IF EXISTS "menu_plans_head_supervisor_insert" ON public.menu_plans;
DROP POLICY IF EXISTS "menu_plans_head_supervisor_update" ON public.menu_plans;

CREATE POLICY "menu_plans_admin_write" ON public.menu_plans FOR ALL TO authenticated
  USING (public.is_admin_editor() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_admin_editor() AND public.can_access_canteen(canteen_id));
CREATE POLICY "menu_plans_manager_update" ON public.menu_plans FOR UPDATE TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));
CREATE POLICY "menu_plans_head_supervisor_insert" ON public.menu_plans FOR INSERT TO authenticated
  WITH CHECK (public.is_head_supervisor() AND public.can_access_canteen(canteen_id));
CREATE POLICY "menu_plans_head_supervisor_update" ON public.menu_plans FOR UPDATE TO authenticated
  USING (public.is_head_supervisor() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_head_supervisor() AND public.can_access_canteen(canteen_id));

CREATE OR REPLACE FUNCTION public.guard_menu_plan_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF public.is_admin_editor() OR public.is_manager_or_above() THEN RETURN NEW; END IF;
  IF NOT public.is_head_supervisor() OR NOT public.can_access_canteen(NEW.canteen_id) THEN
    RAISE EXCEPTION 'Only Head Supervisor can enter the menu';
  END IF;
  -- HS may build/publish a draft and may later fill empty operational counts.
  -- Once published, menu/header corrections belong to Manager.
  IF OLD.status<>'draft' AND (
       NEW.canteen_id IS DISTINCT FROM OLD.canteen_id
    OR NEW.menu_date IS DISTINCT FROM OLD.menu_date
    OR NEW.meal_period IS DISTINCT FROM OLD.meal_period
    OR NEW.expected_headcount IS DISTINCT FROM OLD.expected_headcount
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.notes IS DISTINCT FROM OLD.notes
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
  ) THEN
    RAISE EXCEPTION 'Published menu ki galat entry Manager correct karega';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_menu_plan_role() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_menu_plan_role ON public.menu_plans;
CREATE TRIGGER trg_guard_menu_plan_role BEFORE UPDATE ON public.menu_plans
  FOR EACH ROW EXECUTE FUNCTION public.guard_menu_plan_role();

DROP POLICY IF EXISTS "menu_plan_items_select" ON public.menu_plan_items;
CREATE POLICY "menu_plan_items_select" ON public.menu_plan_items FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.menu_plans m
    WHERE m.id = menu_plan_items.menu_plan_id
      AND public.can_access_canteen(m.canteen_id)
      AND (m.status <> 'draft' OR public.is_head_supervisor() OR public.is_manager_or_above())
  ));

DROP POLICY IF EXISTS "menu_plan_items_write" ON public.menu_plan_items;
DROP POLICY IF EXISTS "menu_plan_items_admin_write" ON public.menu_plan_items;
DROP POLICY IF EXISTS "menu_plan_items_manager_write" ON public.menu_plan_items;
DROP POLICY IF EXISTS "menu_plan_items_head_supervisor_write" ON public.menu_plan_items;
DROP POLICY IF EXISTS "menu_plan_items_chef_production" ON public.menu_plan_items;

CREATE POLICY "menu_plan_items_admin_write" ON public.menu_plan_items FOR ALL TO authenticated
  USING (public.is_admin_editor()) WITH CHECK (public.is_admin_editor());
CREATE POLICY "menu_plan_items_manager_write" ON public.menu_plan_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.menu_plans m
    WHERE m.id=menu_plan_items.menu_plan_id AND public.is_manager_or_above()
      AND public.can_access_canteen(m.canteen_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.menu_plans m
    WHERE m.id=menu_plan_items.menu_plan_id AND public.is_manager_or_above()
      AND public.can_access_canteen(m.canteen_id)));
CREATE POLICY "menu_plan_items_head_supervisor_write" ON public.menu_plan_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.menu_plans m
    WHERE m.id=menu_plan_items.menu_plan_id AND m.status='draft'
      AND public.is_head_supervisor() AND public.can_access_canteen(m.canteen_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.menu_plans m
    WHERE m.id=menu_plan_items.menu_plan_id AND m.status='draft'
      AND public.is_head_supervisor() AND public.can_access_canteen(m.canteen_id)));
CREATE POLICY "menu_plan_items_chef_production" ON public.menu_plan_items FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.menu_plans m
    WHERE m.id=menu_plan_items.menu_plan_id AND m.status<>'draft'
      AND public.is_chef() AND public.can_access_canteen(m.canteen_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.menu_plans m
    WHERE m.id=menu_plan_items.menu_plan_id AND m.status<>'draft'
      AND public.is_chef() AND public.can_access_canteen(m.canteen_id)));

CREATE OR REPLACE FUNCTION public.guard_menu_item_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_plan public.menu_plans%ROWTYPE;
BEGIN
  IF public.is_admin_editor() THEN RETURN NEW; END IF;
  SELECT * INTO v_plan FROM public.menu_plans WHERE id=NEW.menu_plan_id;
  IF NOT FOUND OR NOT public.can_access_canteen(v_plan.canteen_id) THEN
    RAISE EXCEPTION 'Menu is not available at your site';
  END IF;
  IF v_plan.status='draft' AND public.is_head_supervisor() THEN RETURN NEW; END IF;
  IF v_plan.status<>'draft' AND public.is_manager_or_above() THEN
    INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
    VALUES(auth.uid(),'menu_dish_corrected','menu_plan',v_plan.id,v_plan.canteen_id,
      jsonb_build_object('change','dish_added','dish',NEW.dish_name,'menu_date',v_plan.menu_date,'meal_period',v_plan.meal_period));
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'HS creates the menu; only Manager can correct a published menu';
END;
$$;
REVOKE ALL ON FUNCTION public.guard_menu_item_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_menu_item_insert ON public.menu_plan_items;
CREATE TRIGGER trg_guard_menu_item_insert BEFORE INSERT ON public.menu_plan_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_menu_item_insert();

CREATE OR REPLACE FUNCTION public.guard_menu_item_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

  IF public.is_manager_or_above() THEN
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
$$;

CREATE OR REPLACE FUNCTION public.guard_menu_item_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_plan public.menu_plans%ROWTYPE;
BEGIN
  IF public.is_admin_editor() THEN RETURN OLD; END IF;
  SELECT * INTO v_plan FROM public.menu_plans WHERE id=OLD.menu_plan_id;
  IF NOT FOUND THEN RETURN OLD; END IF;
  IF v_plan.status='draft' AND public.is_head_supervisor() THEN RETURN OLD; END IF;
  IF public.is_manager_or_above() THEN
    INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
    VALUES(auth.uid(),'menu_dish_removed','menu_plan_item',OLD.id,v_plan.canteen_id,
      jsonb_build_object('dish',OLD.dish_name,'menu_date',v_plan.menu_date,'meal_period',v_plan.meal_period));
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Only Manager can remove a dish after menu publication';
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_menu_headcount()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_reason text := nullif(btrim(NEW.count_change_reason), '');
BEGIN
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

  IF NEW.actual_headcount IS DISTINCT FROM OLD.actual_headcount THEN
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
    IF NEW.actual_headcount IS NOT NULL AND NEW.actual_headcount<0 THEN
      RAISE EXCEPTION 'Actual plates served cannot be negative';
    END IF;
    NEW.actual_recorded_by:=auth.uid(); NEW.actual_recorded_at:=now();
    INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
    VALUES(auth.uid(),CASE WHEN OLD.actual_headcount IS NULL THEN 'plates_recorded' ELSE 'plates_corrected' END,
      'menu_plan',NEW.id,NEW.canteen_id,jsonb_build_object('menu_date',NEW.menu_date,
      'meal_period',NEW.meal_period,'was',OLD.actual_headcount,'now',NEW.actual_headcount,'reason',v_reason));
  END IF;

  IF NEW.company_punch_count IS DISTINCT FROM OLD.company_punch_count THEN
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
    IF NEW.company_punch_count IS NOT NULL AND NEW.company_punch_count<0 THEN
      RAISE EXCEPTION 'Company punch count cannot be negative';
    END IF;
    NEW.punch_recorded_by:=auth.uid(); NEW.punch_recorded_at:=now();
    INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
    VALUES(auth.uid(),CASE WHEN OLD.company_punch_count IS NULL THEN 'company_punch_recorded' ELSE 'company_punch_corrected' END,
      'menu_plan',NEW.id,NEW.canteen_id,jsonb_build_object('menu_date',NEW.menu_date,
      'meal_period',NEW.meal_period,'was',OLD.company_punch_count,'now',NEW.company_punch_count,'reason',v_reason));
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE public.menu_unit_wastage
  ADD COLUMN IF NOT EXISTS corrected_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS corrected_at timestamptz,
  ADD COLUMN IF NOT EXISTS correction_reason text;
CREATE INDEX IF NOT EXISTS idx_menu_unit_wastage_corrected_by
  ON public.menu_unit_wastage(corrected_by) WHERE corrected_by IS NOT NULL;

DROP FUNCTION IF EXISTS public.record_menu_item_unit_wastage(uuid,integer,numeric,text);
CREATE FUNCTION public.record_menu_item_unit_wastage(
  p_menu_plan_item_id uuid,
  p_unit_no integer,
  p_quantity numeric,
  p_photo_path text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
    IF NOT (public.is_head_supervisor() OR public.is_admin_editor()) THEN
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
$$;
REVOKE ALL ON FUNCTION public.record_menu_item_unit_wastage(uuid,integer,numeric,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_menu_item_unit_wastage(uuid,integer,numeric,text,text)
  TO authenticated;

DROP POLICY IF EXISTS "the manager files a wastage photo" ON storage.objects;
CREATE POLICY "head supervisor or manager files wastage photo"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id='wastage'
  AND (public.is_head_supervisor() OR public.is_manager_or_above())
  AND public.can_access_canteen(((storage.foldername(name))[1])::uuid));

-- Include HS in browser push recipient validation for future menu/data reminders.
CREATE OR REPLACE FUNCTION public.web_push_recipient(p_user uuid, p_notification uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.notifications n
    JOIN public.user_roles ur ON ur.user_id=p_user
    JOIN auth.users u ON u.id=ur.user_id
    WHERE n.id=p_notification AND (u.banned_until IS NULL OR u.banned_until<=now())
      AND ur.role IN ('chef','cashier','head_chef','head_supervisor','store_keeper','manager',
                      'unit_manager','ops_manager','admin','super_admin','owner')
      AND (n.canteen_id IS NULL OR ur.role IN ('admin','super_admin','owner')
        OR ur.canteen_id=n.canteen_id OR EXISTS (
          SELECT 1 FROM public.user_sites us WHERE us.user_id=p_user AND us.canteen_id=n.canteen_id))
      AND (n.target_user=p_user OR n.target_role=ur.role
        OR (n.target_role='admin' AND ur.role IN ('admin','super_admin','owner'))
        OR (n.target_role='manager' AND ur.role IN ('manager','unit_manager','ops_manager','admin','super_admin','owner')))
  );
$$;
REVOKE ALL ON FUNCTION public.web_push_recipient(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_push_recipient(uuid,uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
