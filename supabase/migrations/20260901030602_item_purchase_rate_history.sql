-- Every confirmed purchase rate for one item, newest first. The invoice rate
-- and the effective stock-unit rate are both returned because packet/box to kg
-- conversions otherwise make an honest rate look wrong.
CREATE OR REPLACE FUNCTION public.item_purchase_rate_history(
  p_canteen_id uuid,
  p_ingredient_id uuid,
  p_before_date date DEFAULT NULL
)
RETURNS TABLE (
  purchase_id uuid,
  purchase_at timestamptz,
  supplier_name text,
  invoice_qty numeric,
  invoice_unit text,
  invoice_rate numeric,
  stock_qty numeric,
  stock_unit text,
  effective_stock_rate numeric,
  line_total numeric,
  bill_status text
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_canteen_id IS NULL OR p_ingredient_id IS NULL THEN
    RAISE EXCEPTION 'Canteen and item are required';
  END IF;
  IF public.my_rank() < 40 OR NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'Not authorised to view purchase rate history';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    coalesce(p.approved_at, p.created_at),
    coalesce(s.name, 'No supplier')::text,
    round(coalesce(pi.quantity, 0), 3),
    coalesce(pi.unit, i.unit)::text,
    round(coalesce(pi.rate, 0), 2),
    round(coalesce(pi.stock_quantity, pi.quantity, 0), 3),
    coalesce(pi.stock_unit, i.unit)::text,
    round(
      coalesce(pi.total, pi.quantity * pi.rate, 0)
      / nullif(coalesce(pi.stock_quantity, pi.quantity, 0), 0),
      2
    ),
    round(coalesce(pi.total, pi.quantity * pi.rate, 0), 2),
    coalesce(p.bill_status, 'received')::text
  FROM public.purchases p
  JOIN public.purchase_items pi ON pi.purchase_id = p.id
  JOIN public.ingredients i ON i.id = pi.ingredient_id
  LEFT JOIN public.suppliers s ON s.id = p.supplier_id
  WHERE p.canteen_id = p_canteen_id
    AND pi.ingredient_id = p_ingredient_id
    AND p.status = 'confirmed'
    AND (
      p_before_date IS NULL
      OR (coalesce(p.approved_at, p.created_at) AT TIME ZONE 'Asia/Kolkata')::date <= p_before_date
    )
  ORDER BY coalesce(p.approved_at, p.created_at) DESC, p.id DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.item_purchase_rate_history(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.item_purchase_rate_history(uuid, uuid, date) TO authenticated;
