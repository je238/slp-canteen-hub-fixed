-- GM may review/close/escalate assigned-site alerts, always with a reason.
-- No role may erase the audit history through this workflow.
ALTER TABLE public.fraud_alerts
  ADD COLUMN IF NOT EXISTS review_note TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.review_operational_alert(
  p_alert_id UUID, p_status TEXT, p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_alert public.fraud_alerts%ROWTYPE;
BEGIN
  IF public.my_rank() < 50 THEN
    RAISE EXCEPTION 'Only Operations Manager, Admin or Owner can review this alert';
  END IF;
  IF p_status NOT IN ('open','reviewed','resolved','escalated') THEN
    RAISE EXCEPTION 'Invalid alert status';
  END IF;
  IF nullif(btrim(coalesce(p_reason,'')),'') IS NULL THEN
    RAISE EXCEPTION 'Written reason is required';
  END IF;

  SELECT * INTO v_alert FROM public.fraud_alerts WHERE id=p_alert_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Alert not found'; END IF;
  IF NOT public.can_access_canteen(v_alert.canteen_id) THEN RAISE EXCEPTION 'Site access denied'; END IF;

  UPDATE public.fraud_alerts SET status=p_status,review_note=btrim(p_reason),
    reviewed_by=auth.uid(),reviewed_at=now() WHERE id=p_alert_id;

  INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
  VALUES(auth.uid(),'operational_alert_reviewed','fraud_alert',p_alert_id,v_alert.canteen_id,
    jsonb_build_object('title',v_alert.title,'was',v_alert.status,'now',p_status,
                       'reason',btrim(p_reason),'rupee_impact',coalesce(v_alert.loss_value,0)));

  IF p_status='escalated' THEN
    INSERT INTO public.notifications(canteen_id,target_role,title,body,link,ref_type,ref_id)
    VALUES(v_alert.canteen_id,'super_admin','Operational alert escalated',
      v_alert.title||' — '||btrim(p_reason),'/executive-alerts','fraud_alert',p_alert_id);
  END IF;
  RETURN jsonb_build_object('id',p_alert_id,'status',p_status);
END;
$$;
REVOKE ALL ON FUNCTION public.review_operational_alert(UUID,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.review_operational_alert(UUID,TEXT,TEXT) TO authenticated;
