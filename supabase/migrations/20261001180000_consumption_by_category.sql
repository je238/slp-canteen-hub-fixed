-- ============================================================
-- CONSUMPTION BY CATEGORY
--
-- What the kitchen used, split the same way purchases are: Grocery,
-- Vegetables & Fruits, Dairy, Masala, Namkeen & Ready Mix, Housekeeping.
-- Built on net_consumption_lines() — the same issue + recipe − returns +
-- late-bill repricing that every food-cost figure reads — so the category
-- totals add up to the "Food consumed" figure already on the reports.
--
-- Added up in the database: the line-level function returns several
-- thousand rows a month, more than one API call hands back.
--
-- Returns {groups:[{group, value, qty_lines, items, top:[...all items]}], total}
-- with every item per group (item, unit, qty, value, avg_rate, days).
--
-- Safe to re-run.
-- ============================================================
CREATE OR REPLACE FUNCTION public.consumption_by_category(p_canteen_id uuid, p_start date, p_end date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF NOT public.can_access_canteen(p_canteen_id) THEN RAISE EXCEPTION 'You do not have access to this site'; END IF;
  WITH lines AS (
    SELECT n.*, coalesce(i.category, 'Unknown — check') AS grp
      FROM public.net_consumption_lines(p_canteen_id, p_start, p_end) n
      JOIN public.ingredients i ON i.id = n.ingredient_id
  ), items AS (
    SELECT grp, item_name AS item, max(unit) AS unit, round(sum(qty), 3) AS qty, round(sum(value), 2) AS value,
           count(DISTINCT service_date) AS days
      FROM lines GROUP BY grp, ingredient_id, item_name
    HAVING abs(sum(qty)) > 1e-9 OR abs(sum(value)) > 0.005
  ), g AS (
    SELECT grp, round(sum(value), 2) AS value, count(*) AS items,
           jsonb_agg(jsonb_build_object('item', item, 'unit', unit, 'qty', qty, 'value', value,
             'avg_rate', CASE WHEN qty > 0 THEN round(value / qty, 2) END, 'days', days)
             ORDER BY value DESC, item) AS list
      FROM items GROUP BY grp
  )
  SELECT jsonb_build_object(
    'groups', coalesce((SELECT jsonb_agg(jsonb_build_object('group', grp, 'value', value, 'items', items, 'list', list)
                                ORDER BY value DESC) FROM g), '[]'::jsonb),
    'total', coalesce((SELECT round(sum(value), 2) FROM items), 0)
  ) INTO v;
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.consumption_by_category(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consumption_by_category(uuid, date, date) TO authenticated;
