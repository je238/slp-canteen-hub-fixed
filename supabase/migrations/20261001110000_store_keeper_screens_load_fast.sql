-- ============================================================
-- THE STORE KEEPER'S SCREENS LOAD FAST
--
-- The store keeper reported buttons that hang and a screen that sometimes
-- only shows "loading". Measured on the live app on 01/10/2026:
--
--   requisition_list_for_site   1.9 s and 4.5 MB — every order since 19 Aug
--                               with every line, on every open of the page
--   ingredient_availability     2.5–3.6 s
--   ingredient_rates            2.3–2.8 s
--   historical_unit_review      2.1 s
--
-- The tables are small (146 items, 740 bill lines, 5,265 order lines). The
-- time went on security checks: the three views ran as the calling user, so
-- row-level security was evaluated on every joined row — the "last received"
-- lookup alone checked site access 740 times per item. The data each user
-- may see is the same at every level (can_access_canteen(site) on items,
-- lots, bills and orders alike), so the check is made once per row the view
-- returns, and the joins underneath run without it.
--
-- The order list now returns every open order plus closed orders from a
-- recent window; the History tab asks for the rest only when opened.
--
-- Safe to re-run.
-- ============================================================

-- ---------- Views: check site access once per returned row ----------
DO $$
DECLARE v text; def text;
BEGIN
  FOREACH v IN ARRAY ARRAY['ingredient_rates', 'ingredient_availability', 'historical_unit_review'] LOOP
    -- Only wrap a view still running as the caller; re-running must not nest.
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relname = v
                  AND coalesce(c.reloptions, '{}') @> ARRAY['security_invoker=on']) THEN
      def := rtrim(btrim(pg_get_viewdef(format('public.%I', v)::regclass)), ';');
      EXECUTE format(
        'CREATE OR REPLACE VIEW public.%I WITH (security_invoker = off) AS '
        'SELECT v.* FROM (%s) v WHERE public.can_access_canteen(v.canteen_id)', v, def);
      EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon', v);
      EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v);
      EXECUTE format('COMMENT ON VIEW public.%I IS %L', v,
        'Runs as its owner and filters by can_access_canteen(canteen_id) once per row, which is the same rule every underlying table applies. Running as the caller re-checked site access on every joined row and took 2–3 seconds.');
    END IF;
  END LOOP;
END $$;

-- "What is already ordered" looks up order lines by item.
CREATE INDEX IF NOT EXISTS idx_requisition_items_ingredient
  ON public.requisition_items (ingredient_id);

-- ---------- The order list: open orders, and recent closed ones ----------
DROP FUNCTION IF EXISTS public.requisition_list_for_site(uuid, date);
CREATE OR REPLACE FUNCTION public.requisition_list_for_site(
  p_canteen_id uuid, p_since date, p_closed_since date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'You cannot view requisitions for this site';
  END IF;

  SELECT coalesce(jsonb_agg(
    to_jsonb(r) || jsonb_build_object(
      'menu_plans', CASE WHEN mp.id IS NULL THEN NULL ELSE
        jsonb_build_object(
          'menu_date', mp.menu_date,
          'meal_period', mp.meal_period,
          'menu_plan_items', coalesce(dishes.items, '[]'::jsonb)
        ) END,
      'requisition_items', coalesce(lines.items, '[]'::jsonb)
    ) ORDER BY r.created_at DESC, r.id DESC
  ), '[]'::jsonb) INTO v_rows
  FROM public.requisitions r
  LEFT JOIN public.menu_plans mp
    ON mp.id = r.menu_plan_id AND mp.canteen_id = p_canteen_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('dish_name', mi.dish_name) ORDER BY mi.id) AS items
    FROM public.menu_plan_items mi WHERE mi.menu_plan_id = mp.id
  ) dishes ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      to_jsonb(ri) || jsonb_build_object(
        'ingredients', CASE WHEN i.id IS NULL THEN NULL ELSE jsonb_build_object(
          'name', i.name, 'unit', i.unit, 'category', i.category,
          'current_stock', i.current_stock, 'cost_per_unit', i.cost_per_unit
        ) END,
        'head_chef_ingredient', CASE WHEN hi.id IS NULL THEN NULL ELSE jsonb_build_object(
          'name', hi.name, 'unit', hi.unit, 'category', hi.category,
          'current_stock', hi.current_stock, 'cost_per_unit', hi.cost_per_unit
        ) END,
        'original_ingredient', CASE WHEN oi.id IS NULL THEN NULL ELSE jsonb_build_object(
          'name', oi.name, 'unit', oi.unit
        ) END
      ) ORDER BY ri.id
    ) AS items
    FROM public.requisition_items ri
    LEFT JOIN public.ingredients i  ON i.id  = ri.ingredient_id           AND i.canteen_id  = p_canteen_id
    LEFT JOIN public.ingredients hi ON hi.id = ri.head_chef_ingredient_id AND hi.canteen_id = p_canteen_id
    LEFT JOIN public.ingredients oi ON oi.id = ri.original_ingredient_id  AND oi.canteen_id = p_canteen_id
    WHERE ri.requisition_id = r.id
  ) lines ON true
  WHERE r.canteen_id = p_canteen_id
    AND r.req_date >= p_since
    -- Work still in flight is always sent; finished orders only from the
    -- window asked for. NULL asks for everything, as before.
    AND (p_closed_since IS NULL
         OR r.status::text NOT IN ('issued', 'rejected', 'cancelled')
         OR r.req_date >= p_closed_since);

  RETURN v_rows;
END;
$$;
REVOKE ALL ON FUNCTION public.requisition_list_for_site(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.requisition_list_for_site(uuid, date, date) TO authenticated;
