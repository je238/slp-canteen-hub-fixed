-- Owner/Super Admin business control and Operations Manager daily control.
-- One row per accessible site keeps the browser fast as the company grows.

CREATE TABLE IF NOT EXISTS public.ocr_scan_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canteen_id UUID NOT NULL REFERENCES public.canteens(id) ON DELETE CASCADE,
  user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  scan_type TEXT NOT NULL DEFAULT 'invoice' CHECK (scan_type IN ('invoice','menu')),
  status TEXT NOT NULL CHECK (status IN ('success','failed')),
  error_code TEXT,
  error_message TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.ocr_scan_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ocr_event_insert_own" ON public.ocr_scan_events;
DROP POLICY IF EXISTS "ocr_event_read_control" ON public.ocr_scan_events;
CREATE POLICY "ocr_event_insert_own" ON public.ocr_scan_events FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND public.can_access_canteen(canteen_id));
CREATE POLICY "ocr_event_read_control" ON public.ocr_scan_events FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id)
         AND (public.my_rank() >= 50 OR user_id = (SELECT auth.uid())));
REVOKE ALL ON public.ocr_scan_events FROM anon;
GRANT SELECT, INSERT ON public.ocr_scan_events TO authenticated;

CREATE INDEX IF NOT EXISTS idx_ocr_scan_events_site_time
  ON public.ocr_scan_events (canteen_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_logs_site_time
  ON public.action_logs (canteen_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_site_time
  ON public.purchases (canteen_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase
  ON public.purchase_items (purchase_id);
CREATE INDEX IF NOT EXISTS idx_menu_plan_items_plan
  ON public.menu_plan_items (menu_plan_id);

DROP FUNCTION IF EXISTS public.executive_site_dashboard(DATE);
CREATE FUNCTION public.executive_site_dashboard(p_date DATE)
RETURNS TABLE (
  canteen_id UUID, site_name TEXT,
  sale NUMERIC, consumption NUMERIC, food_cost_pct NUMERIC,
  expected_headcount BIGINT, plates_served BIGINT, cost_per_plate NUMERIC,
  wastage_qty NUMERIC, wastage_value_estimate NUMERIC,
  purchase_amount NUMERIC, unpaid_amount NUMERIC, no_bill_count BIGINT,
  inventory_value NUMERIC, low_stock_count BIGINT, critical_stock_count BIGINT,
  menu_total BIGINT, menu_published BIGINT,
  orders_total BIGINT, approvals_pending BIGINT, issues_pending BIGINT,
  pending_item_count BIGINT, returned_qty NUMERIC, returns_pending BIGINT,
  open_alerts BIGINT, ledger_mismatch_count BIGINT, invoice_mismatch_count BIGINT,
  scan_failures BIGINT, last_stock_audit_at TIMESTAMPTZ,
  timeline JSONB, operational_score INTEGER, rag_status TEXT
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH accessible AS (
    SELECT c.id, c.name
    FROM public.canteens c
    WHERE public.can_access_canteen(c.id)
  ), menu AS (
    SELECT m.canteen_id,
           count(*) menu_total,
           count(*) FILTER (WHERE m.status = 'published') menu_published,
           coalesce(sum(m.expected_headcount) FILTER (WHERE m.status <> 'draft'),0)::bigint expected_heads,
           coalesce(sum(m.actual_headcount) FILTER (WHERE m.actual_headcount IS NOT NULL),0)::bigint actual_heads,
           min(m.published_at) published_first,
           max(m.published_at) published_last
    FROM public.menu_plans m WHERE m.menu_date = p_date GROUP BY m.canteen_id
  ), dish_waste AS (
    SELECT m.canteen_id,coalesce(sum(mi.wastage_qty),0) qty,
           coalesce(sum(mi.produced_qty),0) produced,max(mi.wastage_at) wastage_at
    FROM public.menu_plans m
    LEFT JOIN public.menu_plan_items mi ON mi.menu_plan_id=m.id
    WHERE m.menu_date=p_date GROUP BY m.canteen_id
  ), unit_waste AS (
    SELECT m.canteen_id,coalesce(sum(uw.quantity),0) qty,max(uw.created_at) wastage_at
    FROM public.menu_plans m JOIN public.menu_unit_wastage uw ON uw.menu_plan_id=m.id
    WHERE m.menu_date=p_date GROUP BY m.canteen_id
  ), waste AS (
    SELECT c.id canteen_id,coalesce(dw.qty,0)+coalesce(uw.qty,0) qty,
           coalesce(dw.produced,0) produced,
           greatest(coalesce(dw.wastage_at,'epoch'::timestamptz),coalesce(uw.wastage_at,'epoch'::timestamptz)) wastage_at
    FROM accessible c LEFT JOIN dish_waste dw ON dw.canteen_id=c.id LEFT JOIN unit_waste uw ON uw.canteen_id=c.id
  ), req AS (
    SELECT r.canteen_id, count(*) orders_total,
           count(*) FILTER (WHERE r.status IN ('pending','submitted')) approvals_pending,
           count(*) FILTER (WHERE r.status IN ('approved','partially_issued')) issues_pending,
           min(r.created_at) submitted_first, max(r.created_at) submitted_last,
           min(r.reviewed_at) approved_first, max(r.reviewed_at) approved_last,
           max(r.issued_at) issue_completed_at
    FROM public.requisitions r WHERE r.req_date=p_date GROUP BY r.canteen_id
  ), pending AS (
    SELECT r.canteen_id, count(*) pending_items
    FROM public.requisitions r JOIN public.requisition_items ri ON ri.requisition_id=r.id
    WHERE r.req_date=p_date
      AND greatest(coalesce(ri.approved_qty,ri.requested_qty)-coalesce(ri.issued_qty,0)-coalesce(ri.cancelled_qty,0),0)>0
    GROUP BY r.canteen_id
  ), issue_time AS (
    SELECT r.canteen_id, min(l.created_at) issue_started_at, max(l.created_at) issue_last_at
    FROM public.requisitions r JOIN public.stock_ledger l ON l.reference_id=r.id AND l.reference_type='issue'
    WHERE r.req_date=p_date GROUP BY r.canteen_id
  ), ret AS (
    SELECT k.canteen_id,
           coalesce(sum(k.qty) FILTER (WHERE k.status='accepted'),0) returned_qty,
           count(*) FILTER (WHERE k.status<>'accepted') returns_pending,
           max(k.created_at) returned_at, max(k.accepted_at) return_accepted_at
    FROM public.kitchen_returns k
    WHERE (k.created_at AT TIME ZONE 'Asia/Kolkata')::date=p_date GROUP BY k.canteen_id
  ), pur AS (
    SELECT p.canteen_id,
           coalesce(sum(p.total_amount) FILTER (WHERE p.status='confirmed' AND NOT coalesce(p.is_opening,false)
             AND p.created_at >= (p_date::timestamp AT TIME ZONE 'Asia/Kolkata')
             AND p.created_at < ((p_date+1)::timestamp AT TIME ZONE 'Asia/Kolkata')),0) purchase_amount,
           coalesce(sum(p.total_amount) FILTER (WHERE p.status='confirmed' AND p.payment_status<>'paid'),0) unpaid_amount,
           count(*) FILTER (WHERE p.status='confirmed' AND p.bill_status='pending') no_bill_count
    FROM public.purchases p GROUP BY p.canteen_id
  ), inv AS (
    SELECT i.canteen_id, coalesce(sum(coalesce(r.stock_value,i.current_stock*coalesce(i.cost_per_unit,0))),0) inventory_value,
           count(*) FILTER (WHERE i.current_stock>0 AND i.current_stock<=coalesce(i.reorder_level,i.minimum_stock,0)) low_count,
           count(*) FILTER (WHERE i.current_stock<=0) critical_count
    FROM public.ingredients i LEFT JOIN public.ingredient_rates r ON r.ingredient_id=i.id
    GROUP BY i.canteen_id
  ), ledger_check AS (
    SELECT i.canteen_id, count(*) FILTER (WHERE abs(i.current_stock-coalesce(x.book_qty,0))>0.000001) mismatches
    FROM public.ingredients i
    LEFT JOIN (SELECT ingredient_id,sum(change_qty) book_qty FROM public.stock_ledger GROUP BY ingredient_id) x
      ON x.ingredient_id=i.id GROUP BY i.canteen_id
  ), invoice_check AS (
    SELECT p.canteen_id, count(*) FILTER (WHERE p.stated_total IS NOT NULL
      AND abs(p.stated_total-coalesce(x.lines_total,0))>1) mismatches
    FROM public.purchases p
    LEFT JOIN (SELECT purchase_id,sum(total) lines_total FROM public.purchase_items GROUP BY purchase_id) x ON x.purchase_id=p.id
    WHERE p.status='confirmed' GROUP BY p.canteen_id
  ), alerts AS (
    SELECT f.canteen_id,count(*) open_alerts FROM public.fraud_alerts f WHERE f.status='open' GROUP BY f.canteen_id
  ), scans AS (
    SELECT e.canteen_id,count(*) FILTER (WHERE e.status='failed') scan_failures
    FROM public.ocr_scan_events e
    WHERE e.created_at>=((p_date-6)::timestamp AT TIME ZONE 'Asia/Kolkata') GROUP BY e.canteen_id
  ), audit AS (
    SELECT l.canteen_id,max(l.created_at) last_audit FROM public.stock_ledger l
    WHERE l.reference_type='audit' GROUP BY l.canteen_id
  ), plates_time AS (
    SELECT a.canteen_id,max(a.created_at) plates_at FROM public.action_logs a
    WHERE a.action IN ('plates_recorded','plates_corrected')
      AND coalesce(a.details->>'menu_date','')=p_date::text GROUP BY a.canteen_id
  )
  SELECT c.id,c.name,
         round(coalesce(sa.value,0),2) sale,
         round(coalesce(nc.value,0),2) consumption,
         CASE WHEN coalesce(sa.value,0)>0
              THEN round(coalesce(nc.value,0)*100/sa.value,2) END food_cost_pct,
         coalesce(m.expected_heads,0),coalesce(m.actual_heads,0),
         CASE WHEN coalesce(m.actual_heads,0)>0 THEN round(coalesce(nc.value,0)/m.actual_heads,2) END cost_per_plate,
         round(coalesce(w.qty,0),3),
         CASE WHEN coalesce(w.produced,0)+coalesce(w.qty,0)>0
              THEN round(coalesce(nc.value,0)*w.qty/(w.produced+w.qty),2) ELSE 0 END,
         round(coalesce(pu.purchase_amount,0),2),round(coalesce(pu.unpaid_amount,0),2),coalesce(pu.no_bill_count,0),
         round(coalesce(i.inventory_value,0),2),coalesce(i.low_count,0),coalesce(i.critical_count,0),
         coalesce(m.menu_total,0),coalesce(m.menu_published,0),coalesce(r.orders_total,0),
         coalesce(r.approvals_pending,0),coalesce(r.issues_pending,0),coalesce(pd.pending_items,0),
         round(coalesce(rt.returned_qty,0),3),coalesce(rt.returns_pending,0),coalesce(al.open_alerts,0),
         coalesce(lc.mismatches,0),coalesce(ic.mismatches,0),coalesce(sc.scan_failures,0),au.last_audit,
         jsonb_build_object(
           'menu_published_first',m.published_first,'menu_published_last',m.published_last,
           'order_submitted_first',r.submitted_first,'order_submitted_last',r.submitted_last,
           'approved_first',r.approved_first,'approved_last',r.approved_last,
           'issue_started',it.issue_started_at,'issue_last',it.issue_last_at,'issue_completed',r.issue_completed_at,
           'plates_entered',pt.plates_at,'wastage_recorded',nullif(w.wastage_at,'epoch'::timestamptz),
           'unused_returned',rt.returned_at,'return_accepted',rt.return_accepted_at
         ),
         greatest(0,100-
           (CASE WHEN coalesce(m.menu_published,0)<5 THEN 15 ELSE 0 END)-
           least(30,coalesce(r.approvals_pending,0)::int*10)-least(30,coalesce(r.issues_pending,0)::int*10)-
           least(20,coalesce(pd.pending_items,0)::int*2)-least(20,coalesce(i.critical_count,0)::int*2)-
           least(20,coalesce(lc.mismatches,0)::int*5)-least(15,coalesce(rt.returns_pending,0)::int*5))::int score,
         CASE WHEN greatest(0,100-
           (CASE WHEN coalesce(m.menu_published,0)<5 THEN 15 ELSE 0 END)-
           least(30,coalesce(r.approvals_pending,0)::int*10)-least(30,coalesce(r.issues_pending,0)::int*10)-
           least(20,coalesce(pd.pending_items,0)::int*2)-least(20,coalesce(i.critical_count,0)::int*2)-
           least(20,coalesce(lc.mismatches,0)::int*5)-least(15,coalesce(rt.returns_pending,0)::int*5))>=90 THEN 'green'
           WHEN greatest(0,100-
           (CASE WHEN coalesce(m.menu_published,0)<5 THEN 15 ELSE 0 END)-
           least(30,coalesce(r.approvals_pending,0)::int*10)-least(30,coalesce(r.issues_pending,0)::int*10)-
           least(20,coalesce(pd.pending_items,0)::int*2)-least(20,coalesce(i.critical_count,0)::int*2)-
           least(20,coalesce(lc.mismatches,0)::int*5)-least(15,coalesce(rt.returns_pending,0)::int*5))>=70 THEN 'amber' ELSE 'red' END
  FROM accessible c
  LEFT JOIN menu m ON m.canteen_id=c.id LEFT JOIN waste w ON w.canteen_id=c.id
  LEFT JOIN req r ON r.canteen_id=c.id LEFT JOIN pending pd ON pd.canteen_id=c.id
  LEFT JOIN issue_time it ON it.canteen_id=c.id LEFT JOIN ret rt ON rt.canteen_id=c.id
  LEFT JOIN pur pu ON pu.canteen_id=c.id LEFT JOIN inv i ON i.canteen_id=c.id
  LEFT JOIN ledger_check lc ON lc.canteen_id=c.id LEFT JOIN invoice_check ic ON ic.canteen_id=c.id
  LEFT JOIN alerts al ON al.canteen_id=c.id LEFT JOIN scans sc ON sc.canteen_id=c.id
  LEFT JOIN audit au ON au.canteen_id=c.id LEFT JOIN plates_time pt ON pt.canteen_id=c.id
  LEFT JOIN LATERAL (SELECT public.computed_sale(c.id,p_date,p_date) value) sa ON true
  LEFT JOIN LATERAL (SELECT coalesce(sum(value),0) value FROM public.net_consumption_lines(c.id,p_date,p_date)) nc ON true
  ORDER BY score ASC,c.name;
$$;

REVOKE ALL ON FUNCTION public.executive_site_dashboard(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.executive_site_dashboard(DATE) TO authenticated;

COMMENT ON FUNCTION public.executive_site_dashboard(DATE) IS
  'RLS-scoped Owner/GM daily site control. Financial settlement remains outside Ops Manager rights.';
