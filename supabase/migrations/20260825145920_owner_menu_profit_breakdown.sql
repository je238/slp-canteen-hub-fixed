-- Owner / GM profitability drill-down. Purchases remain separate from menu
-- cost: buying stock is not consumption until the store issues it. Menu cost
-- is FIFO issue value less accepted kitchen returns for that service date.

CREATE OR REPLACE FUNCTION public.owner_menu_profit_breakdown(
  p_canteen_id UUID,
  p_start DATE,
  p_end DATE
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_start > p_end THEN
    RAISE EXCEPTION 'Invalid report period';
  END IF;
  IF public.my_rank() < 50 OR NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'Only Operations Manager, Owner or Super Admin can view this report';
  END IF;

  WITH
  resolved_requisitions AS (
    SELECT r.id,
           coalesce(r.menu_plan_id, (
             SELECT m.id FROM public.menu_plans m
              WHERE m.canteen_id = r.canteen_id
                AND m.menu_date = r.req_date
                AND m.meal_period = r.meal_period
                AND m.status <> 'draft'
              ORDER BY m.created_at LIMIT 1
           )) AS menu_plan_id
      FROM public.requisitions r
     WHERE r.canteen_id = p_canteen_id
  ),
  menu_issue_lines AS (
    SELECT r.menu_plan_id,
           l.ingredient_id,
           i.name AS item_name,
           i.unit,
           round(sum(-l.change_qty), 3) AS qty,
           round(sum(CASE
             WHEN l.reference_type = 'issue' AND l.change_qty < 0
               THEN abs(coalesce(l.value, -l.change_qty * coalesce(i.cost_per_unit, 0)))
             WHEN l.reference_type = 'return' AND l.change_qty > 0
               THEN -abs(coalesce(l.value, l.change_qty * coalesce(i.cost_per_unit, 0)))
             ELSE 0 END), 2) AS value
      FROM public.stock_ledger l
      JOIN resolved_requisitions r ON r.id = l.reference_id
      JOIN public.ingredients i ON i.id = l.ingredient_id
     WHERE l.canteen_id = p_canteen_id
       AND r.menu_plan_id IS NOT NULL
       AND l.reference_type IN ('issue','return')
       AND ((l.reference_type = 'issue' AND l.change_qty < 0)
         OR (l.reference_type = 'return' AND l.change_qty > 0))
     GROUP BY r.menu_plan_id, l.ingredient_id, i.name, i.unit
  ),
  menu_costs AS (
    SELECT menu_plan_id, round(sum(value), 2) AS issued_cost
      FROM menu_issue_lines GROUP BY menu_plan_id
  ),
  menu_rows AS (
    SELECT m.id AS menu_plan_id,
           m.menu_date,
           m.meal_period,
           coalesce(m.actual_headcount, m.expected_headcount, 0) AS headcount,
           m.actual_headcount IS NULL AS provisional,
           coalesce(mr.rate, 0) AS rate,
           round(coalesce(m.actual_headcount, m.expected_headcount, 0) * coalesce(mr.rate, 0), 2) AS revenue,
           round(coalesce(mc.issued_cost, 0), 2) AS issued_cost,
           round(coalesce(m.actual_headcount, m.expected_headcount, 0) * coalesce(mr.rate, 0)
                 - coalesce(mc.issued_cost, 0), 2) AS margin,
           CASE WHEN coalesce(m.actual_headcount, m.expected_headcount, 0) * coalesce(mr.rate, 0) > 0
             THEN round(coalesce(mc.issued_cost, 0) * 100 /
               (coalesce(m.actual_headcount, m.expected_headcount, 0) * coalesce(mr.rate, 0)), 2)
           END AS food_cost_pct,
           coalesce((SELECT jsonb_agg(mi.dish_name ORDER BY mi.id)
                       FROM public.menu_plan_items mi WHERE mi.menu_plan_id = m.id), '[]'::jsonb) AS dishes,
           coalesce((SELECT jsonb_agg(jsonb_build_object(
                      'ingredient_id', x.ingredient_id, 'item', x.item_name,
                      'qty', x.qty, 'unit', x.unit, 'value', x.value
                    ) ORDER BY x.value DESC)
                       FROM menu_issue_lines x
                      WHERE x.menu_plan_id = m.id AND (abs(x.qty) > 0.000000001 OR abs(x.value) > 0.005)),
                    '[]'::jsonb) AS issued_items
      FROM public.menu_plans m
      LEFT JOIN public.meal_rates mr
        ON mr.canteen_id = m.canteen_id AND mr.meal_period = m.meal_period
      LEFT JOIN menu_costs mc ON mc.menu_plan_id = m.id
     WHERE m.canteen_id = p_canteen_id
       AND m.menu_date BETWEEN p_start AND p_end
       AND m.status <> 'draft'
  ),
  purchase_range AS (
    SELECT pi.ingredient_id,
           coalesce(i.name, pi.item_name) AS item_name,
           coalesce(pi.stock_unit, pi.unit, i.unit) AS unit,
           round(sum(coalesce(pi.stock_quantity, pi.quantity)), 3) AS qty,
           round(sum(pi.total), 2) AS value,
           count(DISTINCT p.id) AS bills
      FROM public.purchases p
      JOIN public.purchase_items pi ON pi.purchase_id = p.id
      LEFT JOIN public.ingredients i ON i.id = pi.ingredient_id
     WHERE p.canteen_id = p_canteen_id AND p.status = 'confirmed' AND NOT p.is_opening
       AND p.created_at >= (p_start::timestamp AT TIME ZONE 'Asia/Kolkata')
       AND p.created_at < ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
     GROUP BY pi.ingredient_id, coalesce(i.name, pi.item_name), coalesce(pi.stock_unit, pi.unit, i.unit)
  ),
  issue_range AS (
    SELECT ingredient_id, item_name, unit,
           round(sum(qty), 3) AS qty, round(sum(value), 2) AS value
      FROM public.net_consumption_lines(p_canteen_id, p_start, p_end)
     GROUP BY ingredient_id, item_name, unit
  ),
  purchase_today AS (
    SELECT pi.ingredient_id,
           coalesce(i.name, pi.item_name) AS item_name,
           coalesce(pi.stock_unit, pi.unit, i.unit) AS unit,
           round(sum(coalesce(pi.stock_quantity, pi.quantity)), 3) AS qty,
           round(sum(pi.total), 2) AS value,
           count(DISTINCT p.id) AS bills
      FROM public.purchases p
      JOIN public.purchase_items pi ON pi.purchase_id = p.id
      LEFT JOIN public.ingredients i ON i.id = pi.ingredient_id
     WHERE p.canteen_id = p_canteen_id AND p.status = 'confirmed' AND NOT p.is_opening
       AND (p.created_at AT TIME ZONE 'Asia/Kolkata')::date = current_date
     GROUP BY pi.ingredient_id, coalesce(i.name, pi.item_name), coalesce(pi.stock_unit, pi.unit, i.unit)
  ),
  issue_today AS (
    SELECT ingredient_id, item_name, unit,
           round(sum(qty), 3) AS qty, round(sum(value), 2) AS value
      FROM public.net_consumption_lines(p_canteen_id, current_date, current_date)
     GROUP BY ingredient_id, item_name, unit
  )
  SELECT jsonb_build_object(
    'period', jsonb_build_object('start', p_start, 'end', p_end),
    'summary', jsonb_build_object(
      'menu_revenue', coalesce((SELECT round(sum(revenue), 2) FROM menu_rows), 0),
      'allocated_menu_cost', coalesce((SELECT round(sum(issued_cost), 2) FROM menu_rows), 0),
      'all_issued_cost', coalesce((SELECT round(sum(value), 2) FROM issue_range), 0),
      'unallocated_issued_cost', coalesce((SELECT round(sum(value), 2) FROM issue_range), 0)
        - coalesce((SELECT round(sum(issued_cost), 2) FROM menu_rows), 0),
      'purchase_total', coalesce((SELECT round(sum(value), 2) FROM purchase_range), 0)
    ),
    'menus', coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.menu_date DESC,
       CASE m.meal_period WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2
         WHEN 'evening_snacks' THEN 3 WHEN 'dinner' THEN 4 WHEN 'night_snacks' THEN 5 ELSE 6 END)
       FROM menu_rows m), '[]'::jsonb),
    'purchase_items', coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.value DESC) FROM purchase_range p), '[]'::jsonb),
    'issued_items', coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.value DESC) FROM issue_range i
       WHERE abs(i.qty) > 0.000000001 OR abs(i.value) > 0.005), '[]'::jsonb),
    'today', jsonb_build_object(
      'date', current_date,
      'purchase_total', coalesce((SELECT round(sum(value), 2) FROM purchase_today), 0),
      'issued_total', coalesce((SELECT round(sum(value), 2) FROM issue_today), 0),
      'purchases', coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.value DESC) FROM purchase_today p), '[]'::jsonb),
      'issued', coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.value DESC) FROM issue_today i
        WHERE abs(i.qty) > 0.000000001 OR abs(i.value) > 0.005), '[]'::jsonb)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.owner_menu_profit_breakdown(UUID,DATE,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_menu_profit_breakdown(UUID,DATE,DATE) TO authenticated;

COMMENT ON FUNCTION public.owner_menu_profit_breakdown(UUID,DATE,DATE) IS
  'Owner/GM menu profitability plus separate purchase and net-issued item breakdown.';
