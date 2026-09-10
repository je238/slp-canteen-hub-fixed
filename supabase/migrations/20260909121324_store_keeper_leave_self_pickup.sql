-- When the Store Keeper is absent, the normal issue counter is unavailable.
-- A manager opens an explicit leave period and assigns a named kitchen pickup
-- person to each approved requisition. The Chef/Manager then records the
-- quantity actually taken with an immutable photo. Normal issue stays locked
-- while this mode is active, so there is only one auditable path to stock.

CREATE TABLE IF NOT EXISTS public.store_keeper_leave_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canteen_id UUID NOT NULL REFERENCES public.canteens(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_by UUID NOT NULL REFERENCES auth.users(id),
  ended_at TIMESTAMPTZ,
  ended_by UUID REFERENCES auth.users(id),
  CHECK (length(btrim(reason)) >= 3),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_store_leave_per_site
  ON public.store_keeper_leave_periods(canteen_id)
  WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_store_leave_site_history
  ON public.store_keeper_leave_periods(canteen_id, started_at DESC);

ALTER TABLE public.store_keeper_leave_periods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "site staff read store leave" ON public.store_keeper_leave_periods;
CREATE POLICY "site staff read store leave"
  ON public.store_keeper_leave_periods FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));

REVOKE ALL ON TABLE public.store_keeper_leave_periods FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.store_keeper_leave_periods TO authenticated;

CREATE OR REPLACE FUNCTION public.store_keeper_leave_active(p_canteen_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.store_keeper_leave_periods
    WHERE canteen_id=p_canteen_id AND ended_at IS NULL
  );
$$;
REVOKE ALL ON FUNCTION public.store_keeper_leave_active(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_keeper_leave_active(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.can_confirm_leave_pickup(p_canteen_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT public.can_access_canteen(p_canteen_id)
    AND (
      public.is_manager_or_above()
      OR EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id=auth.uid() AND lower(role) IN ('chef','cashier')
      )
    )
    AND public.store_keeper_leave_active(p_canteen_id);
$$;
REVOKE ALL ON FUNCTION public.can_confirm_leave_pickup(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_confirm_leave_pickup(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_store_keeper_leave_mode(
  p_canteen_id UUID, p_on_leave BOOLEAN, p_reason TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_row public.store_keeper_leave_periods%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_access_canteen(p_canteen_id)
     OR NOT (public.is_manager_or_above() OR public.is_store_keeper()) THEN
    RAISE EXCEPTION 'Sirf Manager ya Store Keeper leave mode badal sakta hai';
  END IF;

  IF p_on_leave THEN
    IF length(btrim(coalesce(p_reason,''))) < 3 THEN
      RAISE EXCEPTION 'Chhutti ka reason likhein';
    END IF;
    SELECT * INTO v_row FROM public.store_keeper_leave_periods
     WHERE canteen_id=p_canteen_id AND ended_at IS NULL;
    IF FOUND THEN RETURN jsonb_build_object('on_leave',true,'id',v_row.id); END IF;

    INSERT INTO public.store_keeper_leave_periods(canteen_id,reason,started_by)
    VALUES(p_canteen_id,btrim(p_reason),auth.uid()) RETURNING * INTO v_row;

    INSERT INTO public.notifications(canteen_id,target_role,title,body,link,ref_type,ref_id)
    VALUES
      (p_canteen_id,'unit_manager','Store Keeper leave mode ON',
       'Approved orders ab named self-pickup aur photo ke saath issue honge.',
       '/requisitions','store_leave',v_row.id),
      (p_canteen_id,'chef','Store Keeper chhutti par hai',
       'Manager ke assigned naam se actual quantity aur pickup photo confirm karein.',
       '/requisitions','store_leave',v_row.id);
  ELSE
    UPDATE public.store_keeper_leave_periods
       SET ended_at=now(),ended_by=auth.uid()
     WHERE canteen_id=p_canteen_id AND ended_at IS NULL
     RETURNING * INTO v_row;
    IF NOT FOUND THEN RETURN jsonb_build_object('on_leave',false); END IF;

    INSERT INTO public.notifications(canteen_id,target_role,title,body,link,ref_type,ref_id)
    VALUES
      (p_canteen_id,'unit_manager','Store Keeper normal duty par',
       'Normal Store Keeper issue flow dobara chalu hai.','/requisitions','store_leave',v_row.id),
      (p_canteen_id,'chef','Normal store issue chalu',
       'Ab approved saman Store Keeper issue karega.','/requisitions','store_leave',v_row.id);
  END IF;

  INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
  VALUES(auth.uid(),CASE WHEN p_on_leave THEN 'store_keeper_leave_started' ELSE 'store_keeper_leave_ended' END,
         'store_leave',v_row.id,p_canteen_id,
         jsonb_build_object('on_leave',p_on_leave,'reason',v_row.reason));
  RETURN jsonb_build_object('on_leave',p_on_leave,'id',v_row.id);
END;
$$;
REVOKE ALL ON FUNCTION public.set_store_keeper_leave_mode(UUID,BOOLEAN,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_store_keeper_leave_mode(UUID,BOOLEAN,TEXT) TO authenticated;

ALTER TABLE public.requisitions
  ADD COLUMN IF NOT EXISTS pickup_person_name TEXT,
  ADD COLUMN IF NOT EXISTS pickup_assigned_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS pickup_assigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pickup_proof_path TEXT,
  ADD COLUMN IF NOT EXISTS pickup_confirmed_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS pickup_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS issue_mode TEXT NOT NULL DEFAULT 'normal';

CREATE OR REPLACE FUNCTION public.assign_leave_pickup(p_req_id UUID,p_pickup_name TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_req public.requisitions%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM public.requisitions WHERE id=p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order nahi mila'; END IF;
  IF auth.uid() IS NULL OR NOT public.is_manager_or_above()
     OR NOT public.can_access_canteen(v_req.canteen_id) THEN
    RAISE EXCEPTION 'Sirf Manager pickup person assign kar sakta hai';
  END IF;
  IF NOT public.store_keeper_leave_active(v_req.canteen_id) THEN
    RAISE EXCEPTION 'Store Keeper leave mode ON nahi hai';
  END IF;
  IF v_req.status NOT IN ('pending','approved') THEN
    RAISE EXCEPTION 'Is order par pickup person ab change nahi ho sakta';
  END IF;
  IF length(btrim(coalesce(p_pickup_name,''))) < 2 THEN
    RAISE EXCEPTION 'Saman lene wale ka poora naam likhein';
  END IF;

  UPDATE public.requisitions
     SET pickup_person_name=btrim(p_pickup_name),pickup_assigned_by=auth.uid(),
         pickup_assigned_at=now()
   WHERE id=p_req_id;
  INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
  VALUES(auth.uid(),'leave_pickup_assigned','requisition',p_req_id,v_req.canteen_id,
         jsonb_build_object('pickup_person',btrim(p_pickup_name),'req_no',v_req.req_no));
  RETURN jsonb_build_object('assigned',true,'pickup_person',btrim(p_pickup_name));
END;
$$;
REVOKE ALL ON FUNCTION public.assign_leave_pickup(UUID,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_leave_pickup(UUID,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_leave_pickup_approval()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.status='approved' AND OLD.status IS DISTINCT FROM NEW.status
     AND public.store_keeper_leave_active(NEW.canteen_id)
     AND (length(btrim(coalesce(NEW.pickup_person_name,''))) < 2
          OR NEW.pickup_assigned_by IS NULL) THEN
    RAISE EXCEPTION 'Store Keeper chhutti par hai — pickup person assign karein';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_leave_pickup_approval() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_leave_pickup_approval ON public.requisitions;
CREATE TRIGGER trg_guard_leave_pickup_approval
  BEFORE UPDATE OF status ON public.requisitions
  FOR EACH ROW EXECUTE FUNCTION public.guard_leave_pickup_approval();

-- A Chef may upload only into their accessible site's folder, and only while
-- the explicit leave period is active. Existing Store Keeper/manager access
-- remains unchanged.
DROP POLICY IF EXISTS "stock_photos_write" ON storage.objects;
CREATE POLICY "stock_photos_write" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id='stock-photos'
    AND public.can_access_canteen(NULLIF((storage.foldername(name))[1],'')::uuid)
    AND (
      public.is_store_keeper_or_above()
      OR public.can_confirm_leave_pickup(NULLIF((storage.foldername(name))[1],'')::uuid)
    )
  );

CREATE OR REPLACE FUNCTION public.issue_requisition_leave_pickup(
  p_req_id UUID,p_items JSONB,p_proof_path TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_req public.requisitions%ROWTYPE; v_line RECORD; v_qty NUMERIC; v_reason TEXT;
  v_pending NUMERIC; v_new NUMERIC; v_cost NUMERIC; v_service_date DATE;
  v_issued_lines INT:=0; v_pending_lines INT; v_total NUMERIC:=0;
BEGIN
  SELECT * INTO v_req FROM public.requisitions WHERE id=p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order nahi mila'; END IF;
  IF auth.uid() IS NULL OR NOT public.can_confirm_leave_pickup(v_req.canteen_id) THEN
    RAISE EXCEPTION 'Self-pickup sirf Store Keeper leave mode mein Chef ya Manager confirm kar sakta hai';
  END IF;
  IF v_req.status NOT IN ('approved','issued') THEN
    RAISE EXCEPTION 'Approved order hi pickup ho sakta hai';
  END IF;
  IF length(btrim(coalesce(v_req.pickup_person_name,''))) < 2 OR v_req.pickup_assigned_by IS NULL THEN
    RAISE EXCEPTION 'Manager ne pickup person assign nahi kiya';
  END IF;
  IF jsonb_typeof(p_items)<>'array' THEN RAISE EXCEPTION 'Actual quantities required'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_items)) <>
     (SELECT count(DISTINCT e->>'requisition_item_id') FROM jsonb_array_elements(p_items)e) THEN
    RAISE EXCEPTION 'Same item do baar nahi bhej sakte';
  END IF;
  IF coalesce(p_proof_path,'') NOT LIKE v_req.canteen_id::text||'/%'
     OR NOT EXISTS (
       SELECT 1 FROM storage.objects o
       WHERE o.bucket_id='stock-photos' AND o.name=p_proof_path AND o.owner_id=auth.uid()::text
     ) THEN
    RAISE EXCEPTION 'Pickup ki photo upload karein';
  END IF;

  SELECT m.menu_date INTO v_service_date FROM public.menu_plans m WHERE m.id=v_req.menu_plan_id;
  v_service_date:=coalesce(v_service_date,v_req.req_date,(now() AT TIME ZONE 'Asia/Kolkata')::date);

  FOR v_line IN
    SELECT ri.id,ri.ingredient_id,i.name,i.unit,i.current_stock,
           greatest(coalesce(ri.approved_qty,0)-coalesce(ri.issued_qty,0),0) pending_qty,
           coalesce(ri.issued_qty,0) issued_before,coalesce(ri.issued_value,0) value_before,e.value payload
      FROM jsonb_array_elements(p_items)e
      JOIN public.requisition_items ri ON ri.id=(e->>'requisition_item_id')::uuid
      JOIN public.ingredients i ON i.id=ri.ingredient_id
     WHERE ri.requisition_id=p_req_id
     ORDER BY ri.ingredient_id FOR UPDATE OF ri,i
  LOOP
    v_qty:=coalesce((v_line.payload->>'actual_qty')::numeric,0);
    v_reason:=nullif(btrim(v_line.payload->>'reason'),'');
    v_pending:=v_line.pending_qty;
    IF v_qty<0 OR v_qty>v_pending THEN
      RAISE EXCEPTION '% actual pickup 0 aur pending % ke beech hona chahiye',v_line.name,v_pending;
    END IF;
    IF v_qty>v_line.current_stock THEN
      RAISE EXCEPTION '% stock me sirf % % hai',v_line.name,v_line.current_stock,v_line.unit;
    END IF;
    IF v_qty+0.000000001<least(v_pending,v_line.current_stock)
       AND length(btrim(coalesce(v_reason,'')))<3 THEN
      RAISE EXCEPTION '% kam lene ka reason likhein',v_line.name;
    END IF;
    IF v_qty<=0 THEN CONTINUE; END IF;

    PERFORM public.allow_stock_move();
    UPDATE public.ingredients SET current_stock=current_stock-v_qty
     WHERE id=v_line.ingredient_id AND canteen_id=v_req.canteen_id AND current_stock>=v_qty
     RETURNING current_stock INTO v_new;
    IF NOT FOUND THEN RAISE EXCEPTION '% stock badal gaya; dobara try karein',v_line.name; END IF;
    v_cost:=public.consume_batches_fifo(v_line.ingredient_id,v_req.canteen_id,v_qty);
    UPDATE public.requisition_items SET issued_qty=v_line.issued_before+v_qty,
      issued_value=round(v_line.value_before+v_cost,2) WHERE id=v_line.id;
    INSERT INTO public.stock_ledger(ingredient_id,canteen_id,change_qty,balance_after,reason,
      reference_type,reference_id,created_by,service_date,value)
    VALUES(v_line.ingredient_id,v_req.canteen_id,-v_qty,v_new,
      format('REQ-%s leave self-pickup by %s: %s %s%s',v_req.req_no,v_req.pickup_person_name,
        v_qty,coalesce(v_line.unit,''),CASE WHEN v_reason IS NOT NULL THEN ' — internal: '||v_reason ELSE '' END),
      'issue',v_req.id,auth.uid(),v_service_date,round(v_cost,2));
    v_issued_lines:=v_issued_lines+1; v_total:=v_total+v_cost;
  END LOOP;
  IF v_issued_lines=0 THEN RAISE EXCEPTION 'Kam se kam ek item ki actual quantity bharein'; END IF;

  SELECT count(*) INTO v_pending_lines FROM public.requisition_items
   WHERE requisition_id=p_req_id AND greatest(coalesce(approved_qty,0)-coalesce(issued_qty,0),0)>0;
  UPDATE public.requisitions SET status=CASE WHEN v_pending_lines=0 THEN 'issued' ELSE 'approved' END,
    issued_by=auth.uid(),issued_at=now(),issue_mode='leave_self_pickup',
    pickup_proof_path=p_proof_path,pickup_confirmed_by=auth.uid(),pickup_confirmed_at=now()
   WHERE id=p_req_id;

  INSERT INTO public.stock_photos(canteen_id,photo_type,reference_id,image_path,note,created_by,captured_at)
  VALUES(v_req.canteen_id,'issue',p_req_id,p_proof_path,
         'Store Keeper leave self-pickup — '||v_req.pickup_person_name,auth.uid(),now());
  INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
  VALUES(auth.uid(),'leave_self_pickup_issued','requisition',p_req_id,v_req.canteen_id,
    jsonb_build_object('pickup_person',v_req.pickup_person_name,'proof_path',p_proof_path,
      'issued_lines',v_issued_lines,'pending_lines',v_pending_lines,'fifo_value',round(v_total,2),
      'service_date',v_service_date));
  INSERT INTO public.notifications(canteen_id,target_role,title,body,link,ref_type,ref_id)
  VALUES(v_req.canteen_id,'unit_manager','REQ-'||v_req.req_no||' self-pickup complete',
         v_req.pickup_person_name||' ne actual quantity photo ke saath confirm ki.',
         '/requisitions','requisition',v_req.id);

  RETURN jsonb_build_object('issued_lines',v_issued_lines,'pending_lines',v_pending_lines,
    'status',CASE WHEN v_pending_lines=0 THEN 'issued' ELSE 'partially_issued' END,
    'fifo_value',round(v_total,2),'pickup_person',v_req.pickup_person_name);
END;
$$;
REVOKE ALL ON FUNCTION public.issue_requisition_leave_pickup(UUID,JSONB,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_requisition_leave_pickup(UUID,JSONB,TEXT) TO authenticated;

-- Close the ordinary counter route while leave mode is active. This retains
-- its normal behavior at all other times.
CREATE OR REPLACE FUNCTION public.issue_requisition_actual(
  p_req_id UUID,p_items JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_req public.requisitions%ROWTYPE; v_line RECORD; v_qty NUMERIC; v_reason TEXT;
  v_pending NUMERIC; v_new NUMERIC; v_cost NUMERIC; v_service_date DATE;
  v_issued_lines INT:=0; v_pending_lines INT; v_total NUMERIC:=0;
BEGIN
  SELECT * INTO v_req FROM public.requisitions WHERE id=p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order nahi mila'; END IF;
  IF public.store_keeper_leave_active(v_req.canteen_id) THEN
    RAISE EXCEPTION 'Store Keeper leave mode ON hai — assigned self-pickup aur photo se issue karein';
  END IF;
  IF NOT (public.can_issue_stock() AND public.can_access_canteen(v_req.canteen_id)) THEN
    RAISE EXCEPTION 'Sirf Store Keeper ya Manager stock issue kar sakta hai';
  END IF;
  IF v_req.status NOT IN ('approved','issued') THEN RAISE EXCEPTION 'Approved order hi issue ho sakta hai'; END IF;
  IF jsonb_typeof(p_items)<>'array' THEN RAISE EXCEPTION 'Actual quantities required'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_items)) <>
     (SELECT count(DISTINCT e->>'requisition_item_id') FROM jsonb_array_elements(p_items)e) THEN
    RAISE EXCEPTION 'Same item do baar nahi bhej sakte';
  END IF;
  SELECT m.menu_date INTO v_service_date FROM public.menu_plans m WHERE m.id=v_req.menu_plan_id;
  v_service_date:=coalesce(v_service_date,v_req.req_date,(now() AT TIME ZONE 'Asia/Kolkata')::date);

  FOR v_line IN
    SELECT ri.id,ri.ingredient_id,i.name,i.unit,i.current_stock,
           greatest(coalesce(ri.approved_qty,0)-coalesce(ri.issued_qty,0),0) pending_qty,
           coalesce(ri.issued_qty,0) issued_before,coalesce(ri.issued_value,0) value_before,e.value payload
      FROM jsonb_array_elements(p_items)e
      JOIN public.requisition_items ri ON ri.id=(e->>'requisition_item_id')::uuid
      JOIN public.ingredients i ON i.id=ri.ingredient_id
     WHERE ri.requisition_id=p_req_id
     ORDER BY ri.ingredient_id FOR UPDATE OF ri,i
  LOOP
    v_qty:=coalesce((v_line.payload->>'actual_qty')::numeric,0);
    v_reason:=nullif(btrim(v_line.payload->>'reason'),'');
    v_pending:=v_line.pending_qty;
    IF v_qty<0 OR v_qty>v_pending THEN RAISE EXCEPTION '% actual issue 0 aur pending % ke beech hona chahiye',v_line.name,v_pending; END IF;
    IF v_qty>v_line.current_stock THEN RAISE EXCEPTION '% stock me sirf % % hai',v_line.name,v_line.current_stock,v_line.unit; END IF;
    IF v_qty+0.000000001<least(v_pending,v_line.current_stock)
       AND length(btrim(coalesce(v_reason,'')))<3 THEN
      RAISE EXCEPTION '% kam dene ka internal reason likhein',v_line.name;
    END IF;
    IF v_qty<=0 THEN CONTINUE; END IF;

    PERFORM public.allow_stock_move();
    UPDATE public.ingredients SET current_stock=current_stock-v_qty
     WHERE id=v_line.ingredient_id AND canteen_id=v_req.canteen_id AND current_stock>=v_qty
     RETURNING current_stock INTO v_new;
    IF NOT FOUND THEN RAISE EXCEPTION '% stock badal gaya; dobara try karein',v_line.name; END IF;
    v_cost:=public.consume_batches_fifo(v_line.ingredient_id,v_req.canteen_id,v_qty);
    UPDATE public.requisition_items SET issued_qty=v_line.issued_before+v_qty,
      issued_value=round(v_line.value_before+v_cost,2) WHERE id=v_line.id;
    INSERT INTO public.stock_ledger(ingredient_id,canteen_id,change_qty,balance_after,reason,
      reference_type,reference_id,created_by,service_date,value)
    VALUES(v_line.ingredient_id,v_req.canteen_id,-v_qty,v_new,
      format('REQ-%s actual hand-over: %s %s%s',v_req.req_no,v_qty,coalesce(v_line.unit,''),
        CASE WHEN v_reason IS NOT NULL THEN ' — internal: '||v_reason ELSE '' END),
      'issue',v_req.id,auth.uid(),v_service_date,round(v_cost,2));
    v_issued_lines:=v_issued_lines+1; v_total:=v_total+v_cost;
  END LOOP;
  IF v_issued_lines=0 THEN RAISE EXCEPTION 'Kam se kam ek item ki actual quantity bharein'; END IF;

  SELECT count(*) INTO v_pending_lines FROM public.requisition_items
   WHERE requisition_id=p_req_id AND greatest(coalesce(approved_qty,0)-coalesce(issued_qty,0),0)>0;
  UPDATE public.requisitions SET status=CASE WHEN v_pending_lines=0 THEN 'issued' ELSE 'approved' END,
    issued_by=auth.uid(),issued_at=now(),issue_mode='normal' WHERE id=p_req_id;
  INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
  VALUES(auth.uid(),'actual_kitchen_issue','requisition',p_req_id,v_req.canteen_id,
    jsonb_build_object('issued_lines',v_issued_lines,'pending_lines',v_pending_lines,
                       'fifo_value',round(v_total,2),'service_date',v_service_date));
  RETURN jsonb_build_object('issued_lines',v_issued_lines,'pending_lines',v_pending_lines,
    'status',CASE WHEN v_pending_lines=0 THEN 'issued' ELSE 'partially_issued' END,
    'fifo_value',round(v_total,2));
END;
$$;
REVOKE ALL ON FUNCTION public.issue_requisition_actual(UUID,JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_requisition_actual(UUID,JSONB) TO authenticated;

COMMENT ON TABLE public.store_keeper_leave_periods IS
  'Auditable site periods when the Store Keeper is absent and named, photographed kitchen self-pickup is mandatory.';
