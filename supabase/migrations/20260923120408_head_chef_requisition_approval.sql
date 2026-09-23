-- Chef -> Head Chef (quantity check within +/-10%) -> Manager -> Store Keeper.
-- The Chef request, Head Chef quantity and Manager final quantity are kept
-- separately so every stage remains auditable.

ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role = ANY (ARRAY[
    'super_admin', 'admin', 'ops_manager', 'unit_manager',
    'head_chef', 'chef', 'store_keeper', 'vendor',
    'owner', 'manager', 'cashier'
  ]::text[]));

CREATE OR REPLACE FUNCTION public.role_rank(p_role text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE lower(coalesce(p_role, ''))
    WHEN 'super_admin'  THEN 70
    WHEN 'owner'        THEN 70
    WHEN 'admin'        THEN 60
    WHEN 'ops_manager'  THEN 50
    WHEN 'unit_manager' THEN 40
    WHEN 'manager'      THEN 40
    WHEN 'head_chef'    THEN 35
    WHEN 'chef'         THEN 30
    WHEN 'cashier'      THEN 30
    WHEN 'store_keeper' THEN 20
    WHEN 'vendor'       THEN 10
    ELSE 0
  END;
$$;

CREATE OR REPLACE FUNCTION public.is_head_chef()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND lower(role) = 'head_chef'
  );
$$;
REVOKE ALL ON FUNCTION public.is_head_chef() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_head_chef() TO authenticated;

ALTER TABLE public.requisitions
  ADD COLUMN IF NOT EXISTS head_chef_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS head_chef_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS head_chef_reviewed_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS head_chef_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS head_chef_notes text;

ALTER TABLE public.requisitions
  DROP CONSTRAINT IF EXISTS requisitions_head_chef_status_check;
ALTER TABLE public.requisitions
  ADD CONSTRAINT requisitions_head_chef_status_check
  CHECK (head_chef_status IN ('pending', 'approved', 'rejected'));

ALTER TABLE public.requisition_items
  ADD COLUMN IF NOT EXISTS head_chef_qty numeric;
ALTER TABLE public.requisition_items
  DROP CONSTRAINT IF EXISTS requisition_items_head_chef_qty_check;
ALTER TABLE public.requisition_items
  ADD CONSTRAINT requisition_items_head_chef_qty_check
  CHECK (head_chef_qty IS NULL OR head_chef_qty >= 0);

CREATE INDEX IF NOT EXISTS idx_user_roles_head_chef_site
  ON public.user_roles (canteen_id)
  WHERE role = 'head_chef';

CREATE OR REPLACE FUNCTION public.set_head_chef_requirement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  NEW.head_chef_required := EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.canteen_id = NEW.canteen_id AND lower(ur.role) = 'head_chef'
  );
  NEW.head_chef_status := 'pending';
  NEW.head_chef_reviewed_by := NULL;
  NEW.head_chef_reviewed_at := NULL;
  NEW.head_chef_notes := NULL;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.set_head_chef_requirement() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_set_head_chef_requirement ON public.requisitions;
CREATE TRIGGER trg_set_head_chef_requirement
  BEFORE INSERT ON public.requisitions
  FOR EACH ROW EXECUTE FUNCTION public.set_head_chef_requirement();

CREATE OR REPLACE FUNCTION public.guard_requisition_item_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_req public.requisitions%ROWTYPE;
  v_min numeric;
  v_max numeric;
BEGIN
  IF public.is_admin_editor() THEN RETURN NEW; END IF;
  IF coalesce(current_setting('app.stock_move', true), '') = 'on' THEN RETURN NEW; END IF;

  IF coalesce(current_setting('app.head_chef_review', true), '') = 'on' THEN
    SELECT * INTO v_req FROM public.requisitions WHERE id = NEW.requisition_id;
    IF v_req.status <> 'pending'
       OR NOT v_req.head_chef_required
       OR NOT public.is_head_chef()
       OR NOT public.can_access_canteen(v_req.canteen_id) THEN
      RAISE EXCEPTION 'Head Chef may verify only a pending order for their site';
    END IF;
    IF NEW.requested_qty IS DISTINCT FROM OLD.requested_qty
       OR NEW.ingredient_id IS DISTINCT FROM OLD.ingredient_id
       OR NEW.rate IS DISTINCT FROM OLD.rate
       OR NEW.approved_qty IS DISTINCT FROM OLD.approved_qty THEN
      RAISE EXCEPTION 'Head Chef may change only the verification quantity';
    END IF;
    v_min := round(OLD.requested_qty * 0.90, 3);
    v_max := round(OLD.requested_qty * 1.10, 3);
    IF NEW.head_chef_qty IS NULL
       OR NEW.head_chef_qty < v_min
       OR NEW.head_chef_qty > v_max THEN
      RAISE EXCEPTION 'Head Chef quantity must stay within 10%% of Chef quantity (% to %)', v_min, v_max;
    END IF;
    RETURN NEW;
  END IF;

  IF coalesce(current_setting('app.manager_order_review', true), '') = 'on' THEN
    SELECT * INTO v_req FROM public.requisitions WHERE id = NEW.requisition_id;
    IF v_req.status <> 'pending'
       OR NOT public.is_manager_or_above()
       OR NOT public.can_access_canteen(v_req.canteen_id) THEN
      RAISE EXCEPTION 'Manager full edit is allowed only while the order is pending approval';
    END IF;
    IF NEW.requested_qty IS DISTINCT FROM OLD.requested_qty
       OR NEW.head_chef_qty IS DISTINCT FROM OLD.head_chef_qty THEN
      RAISE EXCEPTION 'Chef and Head Chef quantities are audit history and cannot be overwritten';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.requested_qty IS DISTINCT FROM OLD.requested_qty
     OR NEW.head_chef_qty IS DISTINCT FROM OLD.head_chef_qty
     OR NEW.ingredient_id IS DISTINCT FROM OLD.ingredient_id
     OR NEW.rate IS DISTINCT FROM OLD.rate THEN
    RAISE EXCEPTION 'Order history cannot be edited outside its approved review flow';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_head_chef_header()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF public.is_admin_editor() THEN RETURN NEW; END IF;
  IF NEW.head_chef_required IS DISTINCT FROM OLD.head_chef_required THEN
    RAISE EXCEPTION 'Head Chef requirement is system controlled';
  END IF;
  IF NEW.head_chef_status IS DISTINCT FROM OLD.head_chef_status
     OR NEW.head_chef_reviewed_by IS DISTINCT FROM OLD.head_chef_reviewed_by
     OR NEW.head_chef_reviewed_at IS DISTINCT FROM OLD.head_chef_reviewed_at
     OR NEW.head_chef_notes IS DISTINCT FROM OLD.head_chef_notes THEN
    IF coalesce(current_setting('app.head_chef_review', true), '') <> 'on'
       OR NOT public.is_head_chef()
       OR NOT public.can_access_canteen(NEW.canteen_id) THEN
      RAISE EXCEPTION 'Head Chef verification fields are audit controlled';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_head_chef_header() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_head_chef_header ON public.requisitions;
CREATE TRIGGER trg_guard_head_chef_header
  BEFORE UPDATE ON public.requisitions
  FOR EACH ROW EXECUTE FUNCTION public.guard_head_chef_header();

CREATE OR REPLACE FUNCTION public.enforce_requisition_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status IN ('approved','rejected')
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NOT public.is_manager_or_above()
     AND NOT (
       NEW.status = 'rejected'
       AND coalesce(current_setting('app.head_chef_review', true), '') = 'on'
       AND public.is_head_chef()
     ) THEN
    RAISE EXCEPTION 'Only a unit manager or above can approve or reject a requisition';
  END IF;

  IF NEW.status = 'issued' AND OLD.status IS DISTINCT FROM NEW.status
     AND NOT public.can_issue_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can issue stock';
  END IF;

  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.requested_by IS NOT NULL AND NEW.requested_by = auth.uid()
     AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'You cannot approve a requisition you raised yourself';
  END IF;

  IF NEW.status IN ('approved','rejected') AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.reviewed_by := auth.uid();
    NEW.reviewed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.head_chef_review_requisition(
  p_req_id uuid,
  p_lines jsonb,
  p_approve boolean,
  p_review_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_req public.requisitions%ROWTYPE;
  v_line public.requisition_items%ROWTYPE;
  v_input jsonb;
  v_qty numeric;
  v_min numeric;
  v_max numeric;
  v_total integer;
  v_changed integer := 0;
  v_changes jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.is_head_chef() THEN
    RAISE EXCEPTION 'Only the Head Chef can verify this order';
  END IF;

  SELECT * INTO v_req FROM public.requisitions WHERE id = p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_req.status <> 'pending' OR v_req.head_chef_status <> 'pending' THEN
    RAISE EXCEPTION 'This order is no longer waiting for Head Chef verification';
  END IF;
  IF NOT v_req.head_chef_required THEN
    RAISE EXCEPTION 'This order does not require Head Chef verification';
  END IF;
  IF NOT public.can_access_canteen(v_req.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  PERFORM set_config('app.head_chef_review', 'on', true);

  IF NOT p_approve THEN
    IF nullif(btrim(coalesce(p_review_notes, '')), '') IS NULL THEN
      RAISE EXCEPTION 'Reject karne ka reason zaroori hai';
    END IF;
    UPDATE public.requisitions
       SET status = 'rejected', head_chef_status = 'rejected',
           head_chef_reviewed_by = auth.uid(), head_chef_reviewed_at = now(),
           head_chef_notes = btrim(p_review_notes), review_notes = btrim(p_review_notes)
     WHERE id = p_req_id;
    INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
    VALUES(auth.uid(), 'head_chef_rejected_requisition', 'requisition', p_req_id, v_req.canteen_id,
           jsonb_build_object('req_no', v_req.req_no, 'reason', p_review_notes));
    RETURN jsonb_build_object('status', 'rejected');
  END IF;

  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Verified order lines are required';
  END IF;
  SELECT count(*) INTO v_total FROM public.requisition_items WHERE requisition_id = p_req_id;
  IF jsonb_array_length(p_lines) <> v_total
     OR (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_lines)) <> v_total THEN
    RAISE EXCEPTION 'Every order line must be verified exactly once';
  END IF;

  FOR v_input IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    SELECT * INTO v_line
      FROM public.requisition_items
     WHERE id = (v_input->>'id')::uuid AND requisition_id = p_req_id
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'An order item was not found'; END IF;

    v_qty := round(coalesce((v_input->>'head_chef_qty')::numeric, -1), 3);
    v_min := round(v_line.requested_qty * 0.90, 3);
    v_max := round(v_line.requested_qty * 1.10, 3);
    IF v_qty < v_min OR v_qty > v_max THEN
      RAISE EXCEPTION '% quantity must stay between % and %', v_line.id, v_min, v_max;
    END IF;
    IF abs(v_qty - v_line.requested_qty) > 0.000000001 THEN
      v_changed := v_changed + 1;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'line_id', v_line.id, 'chef_qty', v_line.requested_qty, 'head_chef_qty', v_qty
      ));
    END IF;
    UPDATE public.requisition_items SET head_chef_qty = v_qty WHERE id = v_line.id;
  END LOOP;

  IF v_changed > 0 AND nullif(btrim(coalesce(p_review_notes, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Quantity change ki hai, isliye reason zaroori hai';
  END IF;

  UPDATE public.requisitions
     SET head_chef_status = 'approved',
         head_chef_reviewed_by = auth.uid(), head_chef_reviewed_at = now(),
         head_chef_notes = nullif(btrim(coalesce(p_review_notes, '')), '')
   WHERE id = p_req_id;

  INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES(auth.uid(), 'head_chef_reviewed_requisition', 'requisition', p_req_id, v_req.canteen_id,
         jsonb_build_object('req_no', v_req.req_no, 'reason', p_review_notes,
                            'changed_lines', v_changed, 'changes', v_changes));

  RETURN jsonb_build_object('status', 'forwarded_to_manager',
                            'changed_lines', v_changed, 'changes', v_changes);
END;
$$;
REVOKE ALL ON FUNCTION public.head_chef_review_requisition(uuid,jsonb,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.head_chef_review_requisition(uuid,jsonb,boolean,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.manager_review_requisition(
  p_req_id uuid,
  p_lines jsonb,
  p_approve boolean,
  p_review_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_req public.requisitions%ROWTYPE;
  v_line public.requisition_items%ROWTYPE;
  v_input jsonb;
  v_new_qty numeric;
  v_base_qty numeric;
  v_new_ingredient uuid;
  v_new_name text;
  v_new_unit text;
  v_new_rate numeric;
  v_old_name text;
  v_total integer;
  v_changed integer := 0;
  v_active integer := 0;
  v_status text;
  v_changes jsonb := '[]'::jsonb;
BEGIN
  IF NOT (public.is_admin_editor() OR public.is_manager_or_above()) THEN
    RAISE EXCEPTION 'Only a manager or admin can review an order';
  END IF;

  SELECT * INTO v_req FROM public.requisitions WHERE id = p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'This order is no longer waiting for approval';
  END IF;
  IF NOT public.can_access_canteen(v_req.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;
  IF v_req.head_chef_required AND v_req.head_chef_status <> 'approved' THEN
    RAISE EXCEPTION 'Head Chef verification is required before Manager approval';
  END IF;

  IF NOT p_approve THEN
    UPDATE public.requisitions
       SET status = 'rejected', review_notes = nullif(btrim(coalesce(p_review_notes, '')), '')
     WHERE id = p_req_id;
    INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
    VALUES(auth.uid(), 'requisition_rejected', 'requisition', p_req_id, v_req.canteen_id,
           jsonb_build_object('req_no', v_req.req_no, 'reason', p_review_notes));
    RETURN jsonb_build_object('status', 'rejected');
  END IF;

  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Final order lines are required';
  END IF;
  SELECT count(*) INTO v_total FROM public.requisition_items WHERE requisition_id = p_req_id;
  IF jsonb_array_length(p_lines) <> v_total
     OR (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_lines)) <> v_total THEN
    RAISE EXCEPTION 'Every order line must be reviewed exactly once';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) x
     WHERE coalesce((x->>'approved_qty')::numeric, -1) > 0
     GROUP BY (x->>'ingredient_id') HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'The same item cannot appear on two active order lines';
  END IF;

  PERFORM set_config('app.manager_order_review', 'on', true);

  FOR v_input IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    SELECT * INTO v_line FROM public.requisition_items
     WHERE id = (v_input->>'id')::uuid AND requisition_id = p_req_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'An order item was not found'; END IF;

    v_new_qty := round(coalesce((v_input->>'approved_qty')::numeric, -1), 3);
    v_new_ingredient := nullif(v_input->>'ingredient_id', '')::uuid;
    v_base_qty := coalesce(v_line.head_chef_qty, v_line.requested_qty);
    IF v_new_qty < 0 THEN RAISE EXCEPTION 'Final quantity must be zero or more'; END IF;
    IF v_new_ingredient IS NULL THEN RAISE EXCEPTION 'Final item is required'; END IF;

    SELECT name, unit, cost_per_unit INTO v_new_name, v_new_unit, v_new_rate
      FROM public.ingredients
     WHERE id = v_new_ingredient AND canteen_id = v_req.canteen_id AND archived_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Selected item is not available at this site'; END IF;
    SELECT name INTO v_old_name FROM public.ingredients WHERE id = v_line.ingredient_id;

    IF v_new_qty > 0 THEN v_active := v_active + 1; END IF;
    IF v_new_ingredient IS DISTINCT FROM v_line.ingredient_id
       OR abs(v_new_qty - v_base_qty) > 0.000000001 THEN
      v_changed := v_changed + 1;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'line_id', v_line.id,
        'chef_item_id', v_line.ingredient_id, 'chef_item', v_old_name,
        'final_item_id', v_new_ingredient, 'final_item', v_new_name,
        'chef_qty', v_line.requested_qty, 'head_chef_qty', v_line.head_chef_qty,
        'manager_base_qty', v_base_qty, 'final_qty', v_new_qty
      ));
    END IF;

    UPDATE public.requisition_items
       SET approved_qty = v_new_qty,
           ingredient_id = v_new_ingredient,
           unit = v_new_unit,
           rate = CASE WHEN v_new_ingredient IS DISTINCT FROM v_line.ingredient_id
                       THEN coalesce(v_new_rate, 0) ELSE v_line.rate END,
           original_ingredient_id = CASE
             WHEN v_new_ingredient IS DISTINCT FROM v_line.ingredient_id
               THEN coalesce(v_line.original_ingredient_id, v_line.ingredient_id)
             ELSE v_line.original_ingredient_id END,
           cancelled_qty = greatest(v_line.requested_qty - v_new_qty, 0),
           cancellation_reason = CASE WHEN v_new_qty < v_line.requested_qty
             THEN nullif(btrim(coalesce(p_review_notes, '')), '') ELSE NULL END,
           cancelled_by = CASE WHEN v_new_qty < v_line.requested_qty THEN auth.uid() ELSE NULL END,
           cancelled_at = CASE WHEN v_new_qty < v_line.requested_qty THEN now() ELSE NULL END
     WHERE id = v_line.id;
  END LOOP;

  IF v_changed > 0 AND nullif(btrim(coalesce(p_review_notes, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Reason is required when the manager changes the Head Chef verified order';
  END IF;

  v_status := CASE WHEN v_active = 0 THEN 'cancelled' ELSE 'approved' END;
  UPDATE public.requisitions
     SET status = v_status, review_notes = nullif(btrim(coalesce(p_review_notes, '')), ''),
         reviewed_by = auth.uid(), reviewed_at = now()
   WHERE id = p_req_id;

  INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES(auth.uid(), 'manager_reviewed_requisition', 'requisition', p_req_id, v_req.canteen_id,
         jsonb_build_object('req_no', v_req.req_no, 'status', v_status,
                            'reason', p_review_notes, 'changes', v_changes));

  RETURN jsonb_build_object('status', v_status, 'active_lines', v_active,
                            'changed_lines', v_changed, 'changes', v_changes);
END;
$$;
REVOKE ALL ON FUNCTION public.manager_review_requisition(uuid,jsonb,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manager_review_requisition(uuid,jsonb,boolean,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.notify_requisition_operations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE v_site text;
BEGIN
  SELECT name INTO v_site FROM public.canteens WHERE id = NEW.canteen_id;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.notifications(canteen_id,target_role,title,body,link,ref_type,ref_id)
    VALUES(
      NEW.canteen_id,
      CASE WHEN NEW.head_chef_required THEN 'head_chef' ELSE 'manager' END,
      CASE WHEN NEW.head_chef_required
        THEN 'Head Chef verification REQ-'||NEW.req_no
        ELSE 'Naya order REQ-'||NEW.req_no END,
      coalesce(v_site,'Site')||' · '||coalesce(NEW.meal_period,'Meal')||
        CASE WHEN NEW.head_chef_required
          THEN ' - quantity verify karke Manager ko bhejein.'
          ELSE ' - approval chahiye.' END,
      '/requisitions','requisition',NEW.id
    );
  ELSIF NEW.head_chef_status IS DISTINCT FROM OLD.head_chef_status
        AND NEW.head_chef_status = 'approved' THEN
    INSERT INTO public.notifications(canteen_id,target_role,title,body,link,ref_type,ref_id)
    VALUES(NEW.canteen_id,'manager','Head Chef verified REQ-'||NEW.req_no,
      coalesce(v_site,'Site')||' · '||coalesce(NEW.meal_period,'Meal')||' - final approval chahiye.',
      '/requisitions','requisition',NEW.id);
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'approved' THEN
    INSERT INTO public.notifications(canteen_id,target_role,title,body,link,ref_type,ref_id)
    VALUES(NEW.canteen_id,'store_keeper','Order approved REQ-'||NEW.req_no,
      coalesce(v_site,'Site')||' · '||coalesce(NEW.meal_period,'Meal')||' - actual quantity confirm karke issue karein.',
      '/requisitions','requisition',NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_requisition_operations() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.web_push_recipient(p_user uuid, p_notification uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.notifications n
    JOIN public.user_roles ur ON ur.user_id = p_user
    JOIN auth.users u ON u.id = ur.user_id
    WHERE n.id = p_notification AND (u.banned_until IS NULL OR u.banned_until <= now())
      AND ur.role IN ('chef','cashier','head_chef','store_keeper','manager','unit_manager',
                      'ops_manager','admin','super_admin','owner')
      AND (n.canteen_id IS NULL OR ur.role IN ('admin','super_admin','owner')
           OR ur.canteen_id = n.canteen_id OR EXISTS (
             SELECT 1 FROM public.user_sites us
             WHERE us.user_id = p_user AND us.canteen_id = n.canteen_id))
      AND (n.target_user = p_user OR n.target_role = ur.role
           OR (n.target_role = 'admin' AND ur.role IN ('admin','super_admin','owner'))
           OR (n.target_role = 'manager' AND ur.role IN ('manager','unit_manager','ops_manager','admin','super_admin','owner')))
  );
$$;
REVOKE ALL ON FUNCTION public.web_push_recipient(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_push_recipient(uuid,uuid) TO service_role;

COMMENT ON FUNCTION public.head_chef_review_requisition(uuid,jsonb,boolean,text) IS
  'Verifies every Chef quantity within +/-10% and forwards the pending requisition to Manager.';
COMMENT ON FUNCTION public.manager_review_requisition(uuid,jsonb,boolean,text) IS
  'Final Manager approval after required Head Chef verification; preserves all three quantities.';

NOTIFY pgrst, 'reload schema';
