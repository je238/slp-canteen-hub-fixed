-- The storekeeper's Daily Usage entries write stock_ledger rows with
-- reference_type 'issue' (the Excel register's "used" column). The
-- variance report must count them as consumption alongside the
-- automatic recipe deductions. Safe to re-run.

CREATE OR REPLACE FUNCTION public.stock_variance_report(
  p_canteen_id UUID,
  p_start DATE,
  p_end   DATE
)
RETURNS TABLE (
  ingredient_id  UUID,
  name           TEXT,
  unit           TEXT,
  cost_per_unit  NUMERIC,
  current_stock  NUMERIC,
  purchased_qty  NUMERIC,
  consumed_qty   NUMERIC,
  manual_adjust  NUMERIC,
  audit_adjust   NUMERIC,
  audit_loss_value NUMERIC
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  SELECT
    i.id,
    i.name,
    i.unit,
    i.cost_per_unit,
    i.current_stock,
    coalesce(sum(l.change_qty) FILTER (WHERE l.reference_type = 'purchase'), 0),
    coalesce(-sum(l.change_qty) FILTER (WHERE l.reference_type IN ('recipe','issue') AND l.change_qty < 0), 0),
    coalesce(sum(l.change_qty) FILTER (WHERE l.reference_type = 'manual'), 0),
    coalesce(sum(l.change_qty) FILTER (WHERE l.reference_type = 'audit'), 0),
    coalesce(-sum(l.change_qty * i.cost_per_unit) FILTER (WHERE l.reference_type = 'audit' AND l.change_qty < 0), 0)
  FROM public.ingredients i
  LEFT JOIN public.stock_ledger l
    ON l.ingredient_id = i.id
   AND l.created_at >= p_start
   AND l.created_at < p_end + 1
  WHERE i.canteen_id = p_canteen_id
  GROUP BY i.id, i.name, i.unit, i.cost_per_unit, i.current_stock
  ORDER BY 10 DESC, i.name;
$$;

GRANT EXECUTE ON FUNCTION public.stock_variance_report(UUID, DATE, DATE) TO authenticated;
