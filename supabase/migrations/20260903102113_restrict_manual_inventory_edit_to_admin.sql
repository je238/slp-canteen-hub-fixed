-- Limit the manual Inventory Edit endpoints to existing Admin/Owner roles.
-- Preserve their complete costing/audit logic and all transactional receipt,
-- issue, return, delivery-schedule and stock-verification endpoints.
DO $migration$
DECLARE
  v_signature text;
  v_definition text;
  v_guard text := E'BEGIN\n  -- manual_inventory_admin_only\n  IF auth.uid() IS NULL OR NOT coalesce(public.is_admin_editor(), false) THEN\n    RAISE EXCEPTION USING ERRCODE = ''42501'', MESSAGE = ''Manual inventory edit is restricted to Admin / Owner. Please contact Admin for corrections.'';\n  END IF;';
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.adjust_stock(uuid,numeric,text)',
    'public.save_inventory_item_edit(uuid,numeric,numeric,numeric,numeric,numeric,text,text,boolean,text)',
    'public.set_ingredient_rate(uuid,numeric,text)',
    'public.rename_ingredient(uuid,text,text)'
  ] LOOP
    SELECT pg_get_functiondef(v_signature::regprocedure) INTO v_definition;
    IF position('manual_inventory_admin_only' in v_definition) = 0 THEN
      IF v_definition !~* '\mBEGIN\M' THEN
        RAISE EXCEPTION 'Expected a PL/pgSQL body for %', v_signature;
      END IF;
      -- Only the first BEGIN: guard the public entry point before any writes.
      v_definition := regexp_replace(v_definition, '\mBEGIN\M', v_guard, 'i');
      EXECUTE v_definition;
    END IF;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', v_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_signature);
  END LOOP;
END;
$migration$;
