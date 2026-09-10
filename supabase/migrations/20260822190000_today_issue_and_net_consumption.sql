-- Accepted kitchen returns are negative consumption for the same service day.
-- They also go back into a costed FIFO lot, so shelf quantity and lot quantity
-- continue to describe the same stock.

CREATE OR REPLACE FUNCTION public.net_consumption_lines(
  p_canteen_id UUID, p_start DATE, p_end DATE
) RETURNS TABLE(
  ingredient_id UUID, item_name TEXT, unit TEXT, service_date DATE,
  qty NUMERIC, value NUMERIC
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.ingredient_id, i.name, i.unit,
         CASE WHEN l.reference_type='return'
              THEN coalesce(l.service_date,m.menu_date,r.req_date,
                            (l.created_at AT TIME ZONE 'Asia/Kolkata')::date)
              ELSE coalesce(l.service_date,(l.created_at AT TIME ZONE 'Asia/Kolkata')::date) END,
         -l.change_qty,
         CASE
           WHEN l.reference_type IN ('issue','recipe') AND l.change_qty < 0
             THEN abs(coalesce(l.value, -l.change_qty * coalesce(i.cost_per_unit, 0)))
           WHEN l.reference_type = 'return' AND l.change_qty > 0
             THEN -abs(coalesce(l.value,l.change_qty*coalesce(ic.unit_cost,i.cost_per_unit,0)))
           ELSE 0
         END
    FROM public.stock_ledger l
    JOIN public.ingredients i ON i.id = l.ingredient_id
    LEFT JOIN public.requisitions r ON r.id=l.reference_id AND l.reference_type='return'
    LEFT JOIN public.menu_plans m ON m.id=r.menu_plan_id
    LEFT JOIN LATERAL (
      SELECT sum(abs(coalesce(x.value,0)))/nullif(sum(-x.change_qty),0) unit_cost
        FROM public.stock_ledger x
       WHERE x.reference_id=l.reference_id AND x.ingredient_id=l.ingredient_id
         AND x.reference_type IN ('issue','recipe') AND x.change_qty<0
    ) ic ON true
   WHERE l.canteen_id = p_canteen_id
     AND public.can_access_canteen(p_canteen_id)
     AND ((l.reference_type IN ('issue','recipe') AND l.change_qty < 0)
       OR (l.reference_type = 'return' AND l.change_qty > 0))
     AND (CASE WHEN l.reference_type='return'
               THEN coalesce(l.service_date,m.menu_date,r.req_date,
                             (l.created_at AT TIME ZONE 'Asia/Kolkata')::date)
               ELSE coalesce(l.service_date,(l.created_at AT TIME ZONE 'Asia/Kolkata')::date) END)
         BETWEEN p_start AND p_end;
$$;
REVOKE ALL ON FUNCTION public.net_consumption_lines(UUID,DATE,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.net_consumption_lines(UUID,DATE,DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_return(p_return_id UUID, p_accept BOOLEAN DEFAULT true)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r public.kitchen_returns%ROWTYPE; v_new NUMERIC; v_service_date DATE;
  v_unit_cost NUMERIC; v_req_no INT;
BEGIN
  SELECT * INTO v_r FROM public.kitchen_returns WHERE id = p_return_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown return'; END IF;
  IF v_r.status <> 'pending' THEN RAISE EXCEPTION 'This return has already been dealt with'; END IF;
  IF NOT (public.can_receive_stock() AND public.can_access_canteen(v_r.canteen_id)) THEN
    RAISE EXCEPTION 'Only the store keeper can take stock back onto the shelf';
  END IF;

  IF NOT p_accept THEN
    UPDATE public.kitchen_returns SET status='rejected', accepted_by=auth.uid(), accepted_at=now()
     WHERE id=p_return_id;
    RETURN jsonb_build_object('accepted', false);
  END IF;

  SELECT coalesce(m.menu_date, r.req_date, (r.created_at AT TIME ZONE 'Asia/Kolkata')::date), r.req_no
    INTO v_service_date, v_req_no
    FROM public.requisitions r LEFT JOIN public.menu_plans m ON m.id=r.menu_plan_id
   WHERE r.id=v_r.requisition_id;

  SELECT coalesce(sum(abs(coalesce(l.value,0))) / nullif(sum(-l.change_qty),0),
                  (SELECT cost_per_unit FROM public.ingredients WHERE id=v_r.ingredient_id), 0)
    INTO v_unit_cost
    FROM public.stock_ledger l
   WHERE l.reference_id=v_r.requisition_id AND l.ingredient_id=v_r.ingredient_id
     AND l.reference_type IN ('issue','recipe') AND l.change_qty<0;

  PERFORM public.allow_stock_move();
  UPDATE public.ingredients SET current_stock=current_stock+v_r.qty
   WHERE id=v_r.ingredient_id RETURNING current_stock INTO v_new;

  INSERT INTO public.ingredient_batches
    (ingredient_id,canteen_id,batch_no,qty_received,qty_remaining,rate,received_at)
  VALUES (v_r.ingredient_id,v_r.canteen_id,'RETURN-REQ-'||coalesce(v_req_no::text,'?'),
          v_r.qty,v_r.qty,v_unit_cost,now());

  INSERT INTO public.stock_ledger
    (ingredient_id,canteen_id,change_qty,balance_after,reason,reference_type,
     reference_id,created_by,service_date,value)
  VALUES (v_r.ingredient_id,v_r.canteen_id,v_r.qty,v_new,
          'Returned unused by the kitchen'||CASE WHEN coalesce(v_r.reason,'')<>'' THEN ' — '||v_r.reason ELSE '' END,
          'return',v_r.requisition_id,auth.uid(),v_service_date,round(v_r.qty*v_unit_cost,2));

  UPDATE public.kitchen_returns SET status='accepted',accepted_by=auth.uid(),accepted_at=now()
   WHERE id=p_return_id;
  RETURN jsonb_build_object('accepted',true,'qty',v_r.qty,'balance',v_new,
                            'service_date',v_service_date,'returned_value',round(v_r.qty*v_unit_cost,2));
END;
$$;
REVOKE ALL ON FUNCTION public.accept_return(UUID,BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_return(UUID,BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION public.today_issue_detail(p_canteen_id UUID, p_date DATE)
RETURNS TABLE(
  requisition_id UUID, req_no INT, requisition_status TEXT, meal_period TEXT,
  item_id UUID, ingredient_id UUID, item_name TEXT, unit TEXT,
  requested_qty NUMERIC, approved_qty NUMERIC, issued_qty NUMERIC,
  returned_qty NUMERIC, used_qty NUMERIC, pending_qty NUMERIC, line_status TEXT
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.req_no, r.status, coalesce(m.meal_period,r.meal_period,'extra'),
         ri.id,ri.ingredient_id,i.name,coalesce(ri.unit,i.unit),
         coalesce(ri.requested_qty,0),coalesce(ri.approved_qty,0),coalesce(ri.issued_qty,0),
         coalesce(kr.qty,0),greatest(coalesce(ri.issued_qty,0)-coalesce(kr.qty,0),0),
         greatest(coalesce(ri.approved_qty,0)-coalesce(ri.issued_qty,0),0),
         CASE
           WHEN coalesce(ri.issued_qty,0)<=0 THEN 'pending'
           WHEN coalesce(ri.issued_qty,0)+1e-9<coalesce(ri.approved_qty,0) THEN 'partial'
           ELSE 'complete'
         END
    FROM public.requisitions r
    LEFT JOIN public.menu_plans m ON m.id=r.menu_plan_id
    JOIN public.requisition_items ri ON ri.requisition_id=r.id
    JOIN public.ingredients i ON i.id=ri.ingredient_id
    LEFT JOIN (
      SELECT requisition_id,ingredient_id,sum(qty) qty
        FROM public.kitchen_returns WHERE status='accepted'
       GROUP BY requisition_id,ingredient_id
    ) kr ON kr.requisition_id=r.id AND kr.ingredient_id=ri.ingredient_id
   WHERE r.canteen_id=p_canteen_id AND public.can_access_canteen(p_canteen_id)
     AND coalesce(m.menu_date,r.req_date,(r.created_at AT TIME ZONE 'Asia/Kolkata')::date)=p_date
     AND r.status IN ('approved','issued')
   ORDER BY CASE coalesce(m.meal_period,r.meal_period,'extra')
              WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 WHEN 'evening_snacks' THEN 3
              WHEN 'dinner' THEN 4 WHEN 'night_snacks' THEN 5 ELSE 6 END,
            r.req_no,i.name;
$$;
REVOKE ALL ON FUNCTION public.today_issue_detail(UUID,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.today_issue_detail(UUID,DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.consumption_report(p_canteen_id UUID,p_start DATE,p_end DATE)
RETURNS TABLE(scope TEXT,label TEXT,qty NUMERIC,value NUMERIC,unit TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  WITH win AS (SELECT * FROM public.net_consumption_lines(p_canteen_id,p_start,p_end))
  SELECT 'item',item_name,round(sum(qty),3),round(sum(value),2),max(unit) FROM win
   GROUP BY item_name HAVING abs(sum(qty))>1e-9 OR abs(sum(value))>0.005
  UNION ALL
  SELECT 'day',to_char(service_date,'YYYY-MM-DD'),NULL::numeric,round(sum(value),2),NULL::text
    FROM win GROUP BY service_date
  ORDER BY 1,4 DESC NULLS LAST;
$$;
REVOKE ALL ON FUNCTION public.consumption_report(UUID,DATE,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consumption_report(UUID,DATE,DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.store_keeper_dashboard(p_canteen_id UUID,p_date DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_t0 TIMESTAMPTZ := (p_date::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_t1 TIMESTAMPTZ := ((p_date+1)::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_pending INT; v_purchase NUMERIC; v_issue NUMERIC; v_bills INT;
  v_low JSONB; v_low_count INT; v_unpaid NUMERIC;
BEGIN
  IF NOT public.can_access_canteen(p_canteen_id) THEN RAISE EXCEPTION 'You do not have access to this site'; END IF;
  SELECT count(*) INTO v_pending FROM public.requisitions r LEFT JOIN public.menu_plans m ON m.id=r.menu_plan_id
   WHERE r.canteen_id=p_canteen_id AND r.status='approved'
     AND coalesce(m.menu_date,r.req_date,(r.created_at AT TIME ZONE 'Asia/Kolkata')::date)<=p_date;
  SELECT coalesce(sum(total_amount),0),count(*) INTO v_purchase,v_bills FROM public.purchases
   WHERE canteen_id=p_canteen_id AND status='confirmed' AND created_at>=v_t0 AND created_at<v_t1;
  SELECT coalesce(sum(value),0) INTO v_issue FROM public.net_consumption_lines(p_canteen_id,p_date,p_date);
  SELECT coalesce(sum(total_amount),0) INTO v_unpaid FROM public.purchases
   WHERE canteen_id=p_canteen_id AND status='confirmed' AND payment_status<>'paid';
  SELECT count(*) INTO v_low_count FROM public.ingredients i WHERE i.canteen_id=p_canteen_id
   AND coalesce(i.reorder_level,i.minimum_stock,0)>0
   AND i.current_stock<=coalesce(i.reorder_level,i.minimum_stock,0);
  SELECT coalesce(jsonb_agg(x),'[]'::jsonb) INTO v_low FROM (
    SELECT jsonb_build_object('name',i.name,'stock',i.current_stock,'unit',i.unit,
                              'reorder',coalesce(i.reorder_level,i.minimum_stock,0)) x
      FROM public.ingredients i WHERE i.canteen_id=p_canteen_id
       AND coalesce(i.reorder_level,i.minimum_stock,0)>0
       AND i.current_stock<=coalesce(i.reorder_level,i.minimum_stock,0)
     ORDER BY i.current_stock LIMIT 20) s;
  RETURN jsonb_build_object('date',p_date,'pending_requests',v_pending,
    'todays_purchase',round(v_purchase,2),'todays_bills',v_bills,
    'todays_issue_value',round(v_issue,2),'unpaid_purchases',round(v_unpaid,2),
    'low_stock_count',v_low_count,'low_stock',v_low);
END;
$$;
REVOKE ALL ON FUNCTION public.store_keeper_dashboard(UUID,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_keeper_dashboard(UUID,DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.manager_dashboard(p_canteen_id UUID,p_date DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_t0 TIMESTAMPTZ := (p_date::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_t1 TIMESTAMPTZ := ((p_date+1)::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_m0 DATE := date_trunc('month',p_date)::date;
  v_purchase NUMERIC; v_consumption NUMERIC; v_inv NUMERIC; v_low INT;
  v_month_cons NUMERIC; v_budget NUMERIC; v_pending INT; v_heads INT; v_menu JSONB;
BEGIN
  IF NOT public.can_access_canteen(p_canteen_id) THEN RAISE EXCEPTION 'You do not have access to this site'; END IF;
  SELECT coalesce(sum(total_amount),0) INTO v_purchase FROM public.purchases
   WHERE canteen_id=p_canteen_id AND status='confirmed' AND NOT is_opening
     AND created_at>=v_t0 AND created_at<v_t1;
  SELECT coalesce(sum(value),0) INTO v_consumption FROM public.net_consumption_lines(p_canteen_id,p_date,p_date);
  SELECT coalesce(sum(r.stock_value),0),count(*) FILTER(WHERE i.current_stock<=coalesce(i.reorder_level,i.minimum_stock,0)
    AND coalesce(i.reorder_level,i.minimum_stock,0)>0) INTO v_inv,v_low
    FROM public.ingredient_rates r JOIN public.ingredients i ON i.id=r.ingredient_id WHERE r.canteen_id=p_canteen_id;
  SELECT coalesce(sum(value),0) INTO v_month_cons FROM public.net_consumption_lines(p_canteen_id,v_m0,p_date);
  SELECT food_budget INTO v_budget FROM public.site_budgets WHERE canteen_id=p_canteen_id AND budget_month=v_m0;
  SELECT count(*) INTO v_pending FROM public.requisitions WHERE canteen_id=p_canteen_id AND status='pending';
  SELECT coalesce(sum(coalesce(actual_headcount,expected_headcount,0)),0) INTO v_heads FROM public.menu_plans
   WHERE canteen_id=p_canteen_id AND menu_date=p_date;
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'meal_period'),'[]'::jsonb) INTO v_menu FROM (
    SELECT jsonb_build_object('meal_period',m.meal_period,'status',m.status,
      'expected_headcount',m.expected_headcount,'actual_headcount',m.actual_headcount,
      'dishes',coalesce((SELECT jsonb_agg(i.dish_name ORDER BY i.id) FROM public.menu_plan_items i WHERE i.menu_plan_id=m.id),'[]'::jsonb)) x
      FROM public.menu_plans m WHERE m.canteen_id=p_canteen_id AND m.menu_date=p_date) s;
  RETURN jsonb_build_object('todays_purchase',round(v_purchase,2),'todays_consumption',round(v_consumption,2),
    'inventory_value',round(v_inv,2),'low_stock_items',coalesce(v_low,0),'month_consumption',round(v_month_cons,2),
    'food_budget',v_budget,'pending_requisitions',coalesce(v_pending,0),'todays_headcount',coalesce(v_heads,0),
    'cost_per_head',CASE WHEN v_heads>0 THEN round(v_consumption/v_heads,2) END,'todays_menu',v_menu);
END;
$$;
REVOKE ALL ON FUNCTION public.manager_dashboard(UUID,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manager_dashboard(UUID,DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.operations_summary(p_canteen_id UUID,p_start DATE,p_end DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_heads BIGINT; v_revenue NUMERIC; v_consumption NUMERIC; v_purchase NUMERIC;
        v_meals BIGINT; v_wastage NUMERIC; v_reqs BIGINT;
BEGIN
  IF NOT public.can_access_canteen(p_canteen_id) THEN RAISE EXCEPTION 'You do not have access to this site'; END IF;
  v_revenue:=public.computed_sale(p_canteen_id,p_start,p_end);
  IF v_revenue=0 THEN SELECT coalesce(sum(amount),0) INTO v_revenue FROM public.meal_entries
    WHERE canteen_id=p_canteen_id AND entry_date BETWEEN p_start AND p_end; END IF;
  SELECT coalesce(sum(coalesce(actual_headcount,expected_headcount,0)),0),count(*) INTO v_heads,v_meals
    FROM public.menu_plans WHERE canteen_id=p_canteen_id AND menu_date BETWEEN p_start AND p_end AND status<>'draft';
  SELECT coalesce(sum(value),0) INTO v_consumption FROM public.net_consumption_lines(p_canteen_id,p_start,p_end);
  SELECT coalesce(sum(total_amount),0) INTO v_purchase FROM public.purchases WHERE canteen_id=p_canteen_id
    AND status='confirmed' AND NOT is_opening AND created_at >= (p_start::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND created_at < ((p_end+1)::timestamp AT TIME ZONE 'Asia/Kolkata');
  SELECT coalesce(sum(x.wasted),0) INTO v_wastage FROM public.menu_plans m CROSS JOIN LATERAL(
    SELECT coalesce((SELECT sum(mi.wastage_qty) FROM public.menu_plan_items mi WHERE mi.menu_plan_id=m.id),0)
      +coalesce((SELECT sum(uw.quantity) FROM public.menu_unit_wastage uw WHERE uw.menu_plan_id=m.id),0) wasted) x
    WHERE m.canteen_id=p_canteen_id AND m.menu_date BETWEEN p_start AND p_end;
  SELECT count(*) INTO v_reqs FROM public.requisitions WHERE canteen_id=p_canteen_id AND req_date BETWEEN p_start AND p_end;
  RETURN jsonb_build_object('headcount',v_heads,'meals_served',v_meals,'revenue',v_revenue,
    'consumption',round(v_consumption,2),'purchase',v_purchase,'wastage_qty',v_wastage,'requisitions',v_reqs,
    'cost_per_person',CASE WHEN v_heads>0 THEN round(v_consumption/v_heads,2) END,
    'revenue_per_person',CASE WHEN v_heads>0 THEN round(v_revenue/v_heads,2) END,
    'food_cost_pct',CASE WHEN v_revenue>0 THEN round(v_consumption*100/v_revenue,2) END,
    'margin_per_person',CASE WHEN v_heads>0 THEN round((v_revenue-v_consumption)/v_heads,2) END);
END;
$$;
REVOKE ALL ON FUNCTION public.operations_summary(UUID,DATE,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.operations_summary(UUID,DATE,DATE) TO authenticated;

-- Keep the full period-summary contract used by Reports and Comparison,
-- changing only issue-only totals to net consumption.
CREATE OR REPLACE FUNCTION public.period_summary(p_canteen_id UUID,p_start DATE,p_end DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_t0 TIMESTAMPTZ := (p_start::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_t1 TIMESTAMPTZ := ((p_end+1)::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_purchase NUMERIC; v_consumption NUMERIC; v_heads BIGINT; v_sale NUMERIC;
  v_actual_heads BIGINT; v_provisional_heads BIGINT; v_meals BIGINT;
  v_expense NUMERIC; v_closing NUMERIC; v_wastage NUMERIC; v_opening_in NUMERIC;
  v_adjust NUMERIC; v_reqs BIGINT; v_alerts BIGINT; v_budget NUMERIC;
  v_top JSONB; v_vendors JSONB;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_start>p_end THEN RAISE EXCEPTION 'Invalid report date range'; END IF;
  IF NOT public.can_access_canteen(p_canteen_id) THEN RAISE EXCEPTION 'You do not have access to this site'; END IF;
  SELECT coalesce(sum(total_amount) FILTER(WHERE NOT is_opening),0),coalesce(sum(total_amount) FILTER(WHERE is_opening),0)
    INTO v_purchase,v_opening_in FROM public.purchases WHERE canteen_id=p_canteen_id AND status='confirmed'
    AND created_at>=v_t0 AND created_at<v_t1;
  SELECT coalesce(sum(value),0) INTO v_consumption FROM public.net_consumption_lines(p_canteen_id,p_start,p_end);
  SELECT coalesce(sum(CASE WHEN l.reference_type='reprice' THEN coalesce(l.value,0)
    ELSE sign(l.change_qty)*abs(coalesce(l.value,l.change_qty*coalesce(i.cost_per_unit,0))) END),0) INTO v_adjust
    FROM public.stock_ledger l JOIN public.ingredients i ON i.id=l.ingredient_id WHERE l.canteen_id=p_canteen_id
    AND l.reference_type IN ('manual','audit','reprice')
    AND coalesce(l.service_date,(l.created_at AT TIME ZONE 'Asia/Kolkata')::date) BETWEEN p_start AND p_end;
  SELECT coalesce(sum(coalesce(actual_headcount,expected_headcount,0)),0),
    coalesce(sum(actual_headcount) FILTER(WHERE actual_headcount IS NOT NULL),0),
    coalesce(sum(expected_headcount) FILTER(WHERE actual_headcount IS NULL),0),count(*)
    INTO v_heads,v_actual_heads,v_provisional_heads,v_meals FROM public.menu_plans
    WHERE canteen_id=p_canteen_id AND menu_date BETWEEN p_start AND p_end AND status<>'draft';
  v_sale:=public.computed_sale(p_canteen_id,p_start,p_end);
  SELECT coalesce(sum(amount),0) INTO v_expense FROM public.expenses WHERE canteen_id=p_canteen_id AND expense_date BETWEEN p_start AND p_end;
  SELECT coalesce(sum(r.stock_value),0)-coalesce((SELECT sum(CASE WHEN l.reference_type='reprice' THEN coalesce(l.value,0)
    WHEN l.change_qty>0 THEN abs(coalesce(l.value,l.change_qty*coalesce(i2.cost_per_unit,0)))
    WHEN l.change_qty<0 THEN -abs(coalesce(l.value,l.change_qty*coalesce(i2.cost_per_unit,0))) ELSE 0 END)
    FROM public.stock_ledger l JOIN public.ingredients i2 ON i2.id=l.ingredient_id WHERE l.canteen_id=p_canteen_id
    AND coalesce(l.service_date,(l.created_at AT TIME ZONE 'Asia/Kolkata')::date)>p_end),0)
    INTO v_closing FROM public.ingredient_rates r WHERE r.canteen_id=p_canteen_id;
  v_closing:=greatest(v_closing,0);
  SELECT coalesce(sum(x.wasted),0) INTO v_wastage FROM public.menu_plans m CROSS JOIN LATERAL(
    SELECT coalesce((SELECT sum(mi.wastage_qty) FROM public.menu_plan_items mi WHERE mi.menu_plan_id=m.id),0)
      +coalesce((SELECT sum(uw.quantity) FROM public.menu_unit_wastage uw WHERE uw.menu_plan_id=m.id),0) wasted) x
    WHERE m.canteen_id=p_canteen_id AND m.menu_date BETWEEN p_start AND p_end;
  SELECT count(*) INTO v_reqs FROM public.requisitions WHERE canteen_id=p_canteen_id AND req_date BETWEEN p_start AND p_end;
  SELECT count(*) INTO v_alerts FROM public.fraud_alerts WHERE canteen_id=p_canteen_id AND status='open';
  SELECT food_budget INTO v_budget FROM public.site_budgets WHERE canteen_id=p_canteen_id AND budget_month=date_trunc('month',p_start)::date;
  SELECT coalesce(jsonb_agg(t),'[]'::jsonb) INTO v_top FROM(
    SELECT item_name name,round(sum(qty),2) qty,max(unit) unit,round(sum(value),2) value
      FROM public.net_consumption_lines(p_canteen_id,p_start,p_end) GROUP BY item_name
      HAVING abs(sum(qty))>1e-9 OR abs(sum(value))>0.005 ORDER BY 4 DESC LIMIT 10) t;
  SELECT coalesce(jsonb_agg(v),'[]'::jsonb) INTO v_vendors FROM(
    SELECT coalesce(s.name,'Unknown') vendor,count(*) bills,round(sum(p.total_amount),2) amount
      FROM public.purchases p LEFT JOIN public.suppliers s ON s.id=p.supplier_id WHERE p.canteen_id=p_canteen_id
      AND p.status='confirmed' AND NOT p.is_opening AND p.created_at>=v_t0 AND p.created_at<v_t1
      GROUP BY s.name ORDER BY 3 DESC LIMIT 10) v;
  RETURN jsonb_build_object('start',p_start,'end',p_end,'days',(p_end-p_start)+1,'purchase',round(v_purchase,2),
    'opening_stock_in',round(v_opening_in,2),'consumption',round(v_consumption,2),'adjustments',round(v_adjust,2),
    'headcount',v_heads,'actual_headcount',v_actual_heads,'provisional_headcount',v_provisional_heads,'meals_planned',v_meals,
    'sale',round(v_sale,2),'expenses',round(v_expense,2),'closing_stock',round(v_closing,2),'wastage',v_wastage,
    'wastage_qty',v_wastage,'cost_per_plate',CASE WHEN v_heads>0 THEN round(v_consumption/v_heads,2) END,
    'cost_per_head',CASE WHEN v_heads>0 THEN round(v_consumption/v_heads,2) END,
    'food_cost_pct',CASE WHEN v_sale>0 THEN round(v_consumption*100/v_sale,2) END,'requisitions',v_reqs,
    'open_alerts',v_alerts,'food_budget_month',v_budget,'budget_used_pct',CASE WHEN coalesce(v_budget,0)>0 THEN round(v_consumption*100/v_budget,2) END,
    'top_items',v_top,'vendors',v_vendors);
END;
$$;
REVOKE ALL ON FUNCTION public.period_summary(UUID,DATE,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.period_summary(UUID,DATE,DATE) TO authenticated;
