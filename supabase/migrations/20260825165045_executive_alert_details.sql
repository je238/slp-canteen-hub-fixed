-- Decision-ready exception detail for Owner / GM.
-- The existing dashboard counts remain fast; this RPC is opened only on the
-- Executive Alerts screen and returns the exact rows behind those counts.

DROP FUNCTION IF EXISTS public.executive_alert_details(DATE);
CREATE FUNCTION public.executive_alert_details(p_date DATE)
RETURNS TABLE (
  kind TEXT,
  severity TEXT,
  canteen_id UUID,
  site_name TEXT,
  entity_id UUID,
  item_name TEXT,
  event_date DATE,
  event_at TIMESTAMPTZ,
  details JSONB
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH accessible AS (
    SELECT c.id, c.name
    FROM public.canteens c
    WHERE public.can_access_canteen(c.id)
  ), book AS (
    SELECT l.ingredient_id, sum(l.change_qty) AS qty
    FROM public.stock_ledger l
    JOIN accessible a ON a.id = l.canteen_id
    GROUP BY l.ingredient_id
  ), ledger_rows AS (
    SELECT
      'ledger_mismatch'::text kind,
      'critical'::text severity,
      i.canteen_id,
      a.name site_name,
      i.id entity_id,
      i.name item_name,
      p_date event_date,
      now() event_at,
      jsonb_build_object(
        'unit', i.unit,
        'shelf_qty', i.current_stock,
        'ledger_qty', coalesce(b.qty, 0),
        'difference', i.current_stock - coalesce(b.qty, 0),
        'rate', coalesce(ir.stock_rate, ir.latest_rate, i.cost_per_unit, 0),
        'rupee_difference', abs(i.current_stock - coalesce(b.qty, 0)) * coalesce(ir.stock_rate, ir.latest_rate, i.cost_per_unit, 0)
      ) details
    FROM public.ingredients i
    JOIN accessible a ON a.id = i.canteen_id
    LEFT JOIN book b ON b.ingredient_id = i.id
    LEFT JOIN public.ingredient_rates ir ON ir.ingredient_id = i.id
    WHERE abs(i.current_stock - coalesce(b.qty, 0)) > 0.000001
  ), pending_rows AS (
    SELECT
      'issue_pending'::text kind,
      CASE WHEN greatest(coalesce(ri.approved_qty,ri.requested_qty)-coalesce(ri.issued_qty,0)-coalesce(ri.cancelled_qty,0),0) > coalesce(i.current_stock,0)
           THEN 'critical' ELSE 'warning' END::text severity,
      r.canteen_id,
      a.name site_name,
      ri.id entity_id,
      i.name item_name,
      r.req_date event_date,
      ri.created_at event_at,
      jsonb_build_object(
        'req_no', r.req_no,
        'meal_period', r.meal_period,
        'status', r.status,
        'unit', coalesce(ri.unit,i.unit),
        'requested_qty', ri.requested_qty,
        'approved_qty', coalesce(ri.approved_qty,ri.requested_qty),
        'issued_qty', coalesce(ri.issued_qty,0),
        'cancelled_qty', coalesce(ri.cancelled_qty,0),
        'pending_qty', greatest(coalesce(ri.approved_qty,ri.requested_qty)-coalesce(ri.issued_qty,0)-coalesce(ri.cancelled_qty,0),0),
        'current_stock', i.current_stock,
        'requested_by', r.requested_by,
        'extra_order', coalesce(r.is_extra,false),
        'extra_reason', r.extra_reason
      ) details
    FROM public.requisitions r
    JOIN accessible a ON a.id = r.canteen_id
    JOIN public.requisition_items ri ON ri.requisition_id = r.id
    JOIN public.ingredients i ON i.id = ri.ingredient_id
    WHERE r.req_date = p_date
      AND r.status IN ('approved','partially_issued')
      AND greatest(coalesce(ri.approved_qty,ri.requested_qty)-coalesce(ri.issued_qty,0)-coalesce(ri.cancelled_qty,0),0) > 0
  ), return_rows AS (
    SELECT
      'return_pending'::text kind,
      'warning'::text severity,
      k.canteen_id,
      a.name site_name,
      k.id entity_id,
      i.name item_name,
      (k.created_at AT TIME ZONE 'Asia/Kolkata')::date event_date,
      k.created_at event_at,
      jsonb_build_object(
        'qty', k.qty,
        'unit', coalesce(k.unit,i.unit),
        'reason', k.reason,
        'status', k.status,
        'returned_by', k.returned_by,
        'req_no', r.req_no,
        'meal_period', r.meal_period,
        'service_date', r.req_date
      ) details
    FROM public.kitchen_returns k
    JOIN accessible a ON a.id = k.canteen_id
    JOIN public.ingredients i ON i.id = k.ingredient_id
    LEFT JOIN public.requisitions r ON r.id = k.requisition_id
    WHERE (k.created_at AT TIME ZONE 'Asia/Kolkata')::date = p_date
      AND k.status <> 'accepted'
  ), order_rows AS (
    SELECT
      'over_order'::text kind,
      CASE WHEN ri.requested_qty > ph.avg_qty * 2 THEN 'critical' ELSE 'warning' END::text severity,
      r.canteen_id,
      a.name site_name,
      ri.id entity_id,
      i.name item_name,
      r.req_date event_date,
      ri.created_at event_at,
      jsonb_build_object(
        'req_no', r.req_no,
        'meal_period', r.meal_period,
        'unit', coalesce(ri.unit,i.unit),
        'requested_qty', ri.requested_qty,
        'approved_qty', coalesce(ri.approved_qty,ri.requested_qty),
        'issued_qty', coalesce(ri.issued_qty,0),
        'current_stock', i.current_stock,
        'previous_issued_avg', round(ph.avg_qty,3),
        'times_normal', round(ri.requested_qty/nullif(ph.avg_qty,0),2),
        'requested_by', r.requested_by,
        'history', ph.history
      ) details
    FROM public.requisitions r
    JOIN accessible a ON a.id = r.canteen_id
    JOIN public.requisition_items ri ON ri.requisition_id = r.id
    JOIN public.ingredients i ON i.id = ri.ingredient_id
    CROSS JOIN LATERAL (
      SELECT avg(h.issued_qty) avg_qty,
             jsonb_agg(jsonb_build_object(
               'date', h.req_date,
               'meal', h.meal_period,
               'req_no', h.req_no,
               'issued_qty', h.issued_qty
             ) ORDER BY h.req_date DESC, h.created_at DESC) history
      FROM (
        SELECT r2.req_date,r2.meal_period,r2.req_no,ri2.issued_qty,ri2.created_at
        FROM public.requisition_items ri2
        JOIN public.requisitions r2 ON r2.id=ri2.requisition_id
        WHERE ri2.ingredient_id=ri.ingredient_id
          AND ri2.created_at < ri.created_at
          AND coalesce(ri2.issued_qty,0)>0
          AND r2.req_date >= p_date-30
        ORDER BY ri2.created_at DESC
        LIMIT 5
      ) h
    ) ph
    WHERE r.req_date = p_date
      AND ph.avg_qty > 0
      AND ri.requested_qty > ph.avg_qty * 1.5
  )
  SELECT * FROM ledger_rows
  UNION ALL SELECT * FROM pending_rows
  UNION ALL SELECT * FROM return_rows
  UNION ALL SELECT * FROM order_rows
  ORDER BY severity, event_at DESC, item_name;
$$;

REVOKE ALL ON FUNCTION public.executive_alert_details(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.executive_alert_details(DATE) TO authenticated;

COMMENT ON FUNCTION public.executive_alert_details(DATE) IS
  'RLS-scoped item-level detail behind Owner/GM operational exception counts.';
