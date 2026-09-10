BEGIN;
DO $test$
DECLARE v_store uuid; v_admin uuid; v_ing public.ingredients%rowtype; v_call text; v_denied int := 0;
BEGIN
 SELECT ur.user_id INTO STRICT v_store FROM public.user_roles ur WHERE ur.role::text='store_keeper' LIMIT 1;
 SELECT ur.user_id INTO STRICT v_admin FROM public.user_roles ur WHERE ur.role::text='admin' LIMIT 1;
 PERFORM set_config('request.jwt.claim.sub',v_store::text,true);
 SELECT * INTO STRICT v_ing FROM public.ingredients WHERE public.can_access_canteen(canteen_id) AND unit='kg' AND archived_at IS NULL LIMIT 1;
 FOREACH v_call IN ARRAY ARRAY[
  format('select public.adjust_stock(%L::uuid,%s,%L)',v_ing.id,v_ing.current_stock+1,'permission regression test'),
  format('select public.set_ingredient_rate(%L::uuid,%s,%L)',v_ing.id,v_ing.cost_per_unit+1,'permission regression test'),
  format('select public.rename_ingredient(%L::uuid,%L,%L)',v_ing.id,v_ing.name||' test','permission regression test'),
  format('select public.save_inventory_item_edit(%L::uuid,%s,null,null,null,null,%L,%L,false,%L)',v_ing.id,v_ing.current_stock,v_ing.name,v_ing.unit,'permission regression test')
 ] LOOP
  BEGIN
   EXECUTE v_call;
   RAISE EXCEPTION 'Permission regression: Store Keeper was allowed: %',v_call;
  EXCEPTION WHEN insufficient_privilege THEN v_denied:=v_denied+1;
  END;
 END LOOP;
 IF v_denied<>4 THEN RAISE EXCEPTION 'Expected four denied RPCs'; END IF;
 IF NOT public.can_receive_stock() OR NOT public.can_issue_stock() THEN RAISE EXCEPTION 'Operational stock permissions were lost'; END IF;
 PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
 PERFORM public.adjust_stock(v_ing.id,v_ing.current_stock,'permission regression test');
 PERFORM public.set_ingredient_rate(v_ing.id,v_ing.cost_per_unit,'permission regression test');
 PERFORM public.rename_ingredient(v_ing.id,v_ing.name,'permission regression test');
 PERFORM public.save_inventory_item_edit(v_ing.id,v_ing.current_stock,v_ing.avg_daily_usage,v_ing.reorder_level,v_ing.maximum_stock,v_ing.cost_per_unit,v_ing.name,v_ing.unit,false,'permission regression test');
END;
$test$;
SELECT 'PASS: four Store Keeper edit RPCs denied; Admin no-op edits allowed; receive/issue permission preserved' as result;
ROLLBACK;
