-- Admins may remove any inventory item without destroying the historical
-- evidence that makes purchase, issue and consumption reports auditable.
-- Unused rows are hard-deleted; traded rows are archived and their remaining
-- shelf quantity is written off through the normal audited stock path.

ALTER TABLE public.ingredients
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid,
  ADD COLUMN IF NOT EXISTS archive_reason text;

CREATE INDEX IF NOT EXISTS ingredients_active_canteen_name_idx
  ON public.ingredients (canteen_id, name)
  WHERE archived_at IS NULL;

DROP FUNCTION IF EXISTS public.delete_ingredient(uuid);

CREATE FUNCTION public.delete_ingredient(
  p_ingredient_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ing public.ingredients%ROWTYPE;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_is_admin boolean := public.is_admin_editor();
  v_has_history boolean;
  v_old_stock numeric;
BEGIN
  SELECT * INTO v_ing
  FROM public.ingredients
  WHERE id = p_ingredient_id
  FOR UPDATE;

  IF NOT FOUND OR v_ing.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Unknown or already removed item';
  END IF;

  IF NOT (v_is_admin OR public.is_store_keeper()) THEN
    RAISE EXCEPTION 'Only an admin or store keeper can remove an inventory item';
  END IF;
  IF NOT public.can_access_canteen(v_ing.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;
  IF v_is_admin AND length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Admin must write a reason before removing an inventory item';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.stock_ledger WHERE ingredient_id = p_ingredient_id
    UNION ALL SELECT 1 FROM public.requisition_items WHERE ingredient_id = p_ingredient_id OR original_ingredient_id = p_ingredient_id
    UNION ALL SELECT 1 FROM public.purchase_items WHERE ingredient_id = p_ingredient_id
    UNION ALL SELECT 1 FROM public.recipe_ingredients WHERE ingredient_id = p_ingredient_id
    UNION ALL SELECT 1 FROM public.kitchen_returns WHERE ingredient_id = p_ingredient_id
    UNION ALL SELECT 1 FROM public.ingredient_usage_log WHERE ingredient_id = p_ingredient_id
    UNION ALL SELECT 1 FROM public.central_kitchen_transfer_items WHERE ingredient_id = p_ingredient_id
    UNION ALL SELECT 1 FROM public.vendor_bill_items WHERE ingredient_id = p_ingredient_id
  ) INTO v_has_history;

  -- Store keepers can still clean only accidental, untouched scanner rows.
  IF NOT v_is_admin AND (coalesce(v_ing.current_stock, 0) <> 0 OR v_has_history) THEN
    RAISE EXCEPTION '% has stock or history. Only an admin can remove it.', v_ing.name;
  END IF;

  v_old_stock := coalesce(v_ing.current_stock, 0);

  -- A truly unused row has nothing to preserve, so remove it completely.
  IF NOT v_has_history AND v_old_stock = 0 THEN
    DELETE FROM public.ingredient_batches WHERE ingredient_id = p_ingredient_id;
    DELETE FROM public.ingredients WHERE id = p_ingredient_id;

    INSERT INTO public.action_logs
      (user_id, action, entity_type, entity_id, canteen_id, details)
    VALUES
      (auth.uid(), 'ingredient_deleted', 'ingredient', p_ingredient_id, v_ing.canteen_id,
       jsonb_build_object('name', v_ing.name, 'unit', v_ing.unit,
         'reason', nullif(v_reason, ''),
         'removed_by_role', CASE WHEN v_is_admin THEN 'admin' ELSE 'store_keeper' END,
         'history_preserved', true));

    RETURN jsonb_build_object('removed', v_ing.name, 'archived', false,
      'stock_written_off', 0, 'history_preserved', true);
  END IF;

  -- Full admin removal: write remaining goods out through the existing
  -- audited stock function, then hide the master row from all active pickers.
  IF v_old_stock <> 0 THEN
    PERFORM public.adjust_stock(
      p_ingredient_id,
      0,
      'Inventory item removed by admin: ' || v_reason
    );
  END IF;

  UPDATE public.ingredients
  SET archived_at = now(),
      archived_by = auth.uid(),
      archive_reason = v_reason,
      minimum_stock = 0,
      reorder_level = 0,
      maximum_stock = NULL,
      avg_daily_usage = NULL
  WHERE id = p_ingredient_id;

  INSERT INTO public.action_logs
    (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES
    (auth.uid(), 'ingredient_archived', 'ingredient', p_ingredient_id, v_ing.canteen_id,
     jsonb_build_object('name', v_ing.name, 'unit', v_ing.unit,
       'stock_was', v_old_stock, 'stock_now', 0, 'reason', v_reason,
       'removed_by_role', 'admin', 'history_preserved', true));

  RETURN jsonb_build_object('removed', v_ing.name, 'archived', true,
    'stock_written_off', v_old_stock, 'history_preserved', true);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_ingredient(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_ingredient(uuid, text) TO authenticated;

-- Archived names must not be suggested as duplicates for new active items.
CREATE OR REPLACE FUNCTION public.similar_ingredients(p_canteen_id uuid)
RETURNS TABLE(a_id uuid, a_name text, a_stock numeric, b_id uuid, b_name text,
              b_stock numeric, distance integer, why text)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
WITH n AS (
 SELECT id,name,current_stock,canteen_id,
        regexp_replace(regexp_replace(lower(name),'(karate|crate|box)','','g'),'[^a-z0-9]','','g') key
 FROM public.ingredients
 WHERE canteen_id=p_canteen_id AND archived_at IS NULL
), pairs AS (
 SELECT a.id a_id,a.name a_name,a.current_stock a_stock,b.id b_id,b.name b_name,b.current_stock b_stock,
        a.key ak,b.key bk,levenshtein(a.key,b.key) d,
        (SELECT count(*)::int FROM generate_series(1,least(length(a.key),length(b.key))) g
          WHERE substr(a.key,g,1)=substr(b.key,g,1) AND substr(a.key,1,g)=substr(b.key,1,g)) shared_start
 FROM n a JOIN n b ON b.id>a.id
)
SELECT a_id,a_name,a_stock,b_id,b_name,b_stock,d,
       CASE WHEN d=0 THEN 'same item after spacing or packaging words are removed'
            ELSE 'one looks like a misspelling of the other' END
FROM pairs
WHERE public.can_access_canteen(p_canteen_id)
  AND (d=0 OR (d<=2 AND least(length(ak),length(bk))>=6 AND shared_start>=4))
ORDER BY d,a_name;
$$;
