-- The store keeper's "Low stock" tile counted the rows in a list that was
-- capped at 20, so it read 20 while the manager's tile — counting properly —
-- read 114. The list stays capped for the screen; the count is now its own
-- number. Safe to re-run.

CREATE OR REPLACE FUNCTION public.store_keeper_dashboard(p_canteen_id UUID, p_date DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_t0 TIMESTAMPTZ := (p_date::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_t1 TIMESTAMPTZ := ((p_date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_pending INT; v_purchase NUMERIC; v_issue NUMERIC; v_bills INT;
  v_low JSONB; v_low_count INT; v_unpaid NUMERIC;
BEGIN
  SELECT count(*) INTO v_pending FROM public.requisitions
  WHERE canteen_id = p_canteen_id AND status = 'approved';

  SELECT coalesce(sum(total_amount), 0), count(*) INTO v_purchase, v_bills
  FROM public.purchases WHERE canteen_id = p_canteen_id AND status = 'confirmed'
    AND created_at >= v_t0 AND created_at < v_t1;

  SELECT coalesce(-sum(l.change_qty * r.latest_rate), 0) INTO v_issue
  FROM public.stock_ledger l JOIN public.ingredient_rates r ON r.ingredient_id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('issue','recipe')
    AND l.change_qty < 0 AND l.created_at >= v_t0 AND l.created_at < v_t1;

  SELECT coalesce(sum(total_amount), 0) INTO v_unpaid
  FROM public.purchases WHERE canteen_id = p_canteen_id AND status = 'confirmed'
    AND payment_status <> 'paid';

  SELECT count(*) INTO v_low_count
  FROM public.ingredients i
  WHERE i.canteen_id = p_canteen_id
    AND coalesce(i.reorder_level, i.minimum_stock, 0) > 0
    AND i.current_stock <= coalesce(i.reorder_level, i.minimum_stock, 0);

  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO v_low FROM (
    SELECT jsonb_build_object('name', i.name, 'stock', i.current_stock, 'unit', i.unit,
                              'reorder', coalesce(i.reorder_level, i.minimum_stock, 0)) AS x
    FROM public.ingredients i
    WHERE i.canteen_id = p_canteen_id
      AND coalesce(i.reorder_level, i.minimum_stock, 0) > 0
      AND i.current_stock <= coalesce(i.reorder_level, i.minimum_stock, 0)
    ORDER BY i.current_stock ASC LIMIT 20
  ) t;

  RETURN jsonb_build_object(
    'date', p_date,
    'pending_requests', v_pending,
    'todays_purchase', round(v_purchase, 2),
    'todays_bills', v_bills,
    'todays_issue_value', round(v_issue, 2),
    'unpaid_purchases', round(v_unpaid, 2),
    'low_stock_count', v_low_count,
    'low_stock', v_low
  );
END;
$$;
REVOKE ALL ON FUNCTION public.store_keeper_dashboard(UUID,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_keeper_dashboard(UUID,DATE) TO authenticated;
