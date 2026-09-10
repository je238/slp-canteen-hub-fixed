-- Unit-wise item wastage is required for every served meal period except tea.
-- Weight, photo ownership, manager access and one-entry-per-unit rules remain
-- unchanged; only the former lunch/dinner restriction is widened.

create or replace function public.record_menu_item_unit_wastage(
  p_menu_plan_item_id uuid,
  p_unit_no integer,
  p_quantity numeric,
  p_photo_path text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_item public.menu_plan_items%rowtype;
  v_plan public.menu_plans%rowtype;
  v_row public.menu_unit_wastage%rowtype;
  v_expected_prefix text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if not public.is_manager_or_above() then
    raise exception 'Only the manager can record wastage';
  end if;

  select * into v_item from public.menu_plan_items
   where id = p_menu_plan_item_id for update;
  if not found then raise exception 'Menu item not found'; end if;

  select * into v_plan from public.menu_plans
   where id = v_item.menu_plan_id for update;
  if not found then raise exception 'Menu not found'; end if;
  if not public.can_access_canteen(v_plan.canteen_id) then
    raise exception 'You do not have access to this site';
  end if;
  if v_plan.status = 'draft' then
    raise exception 'Publish the menu before recording wastage';
  end if;
  if v_plan.meal_period not in
     ('breakfast', 'lunch', 'evening_snacks', 'dinner', 'night_snacks') then
    raise exception 'Unit-wise item wastage is not used for this meal period';
  end if;
  if p_unit_no not between 1 and 3 then
    raise exception 'Unit must be 1, 2 or 3';
  end if;
  if coalesce(p_quantity, 0) <= 0 then
    raise exception 'Enter the wastage weight';
  end if;

  v_expected_prefix := v_plan.canteen_id::text || '/' || v_plan.id::text ||
                       '/' || v_item.id::text || '/';
  if coalesce(p_photo_path, '') not like v_expected_prefix || '%' then
    raise exception 'This photo does not belong to this menu item and site';
  end if;
  if not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'wastage' and o.name = p_photo_path
  ) then
    raise exception 'Wastage photo upload nahi hui — dobara photo lagayein';
  end if;

  insert into public.menu_unit_wastage
    (menu_plan_id, menu_plan_item_id, canteen_id, unit_no,
     quantity, photo_path, created_by)
  values
    (v_plan.id, v_item.id, v_plan.canteen_id, p_unit_no,
     p_quantity, p_photo_path, auth.uid())
  returning * into v_row;

  insert into public.action_logs
    (user_id, action, entity_type, entity_id, canteen_id, details)
  values
    (auth.uid(), 'item_unit_wastage_recorded', 'menu_plan_item', v_item.id,
     v_plan.canteen_id,
     jsonb_build_object('dish', v_item.dish_name, 'unit_no', p_unit_no,
                        'quantity_kg', p_quantity, 'photo_path', p_photo_path,
                        'menu_date', v_plan.menu_date,
                        'meal_period', v_plan.meal_period));

  return jsonb_build_object('id', v_row.id, 'dish', v_item.dish_name,
                            'unit_no', v_row.unit_no,
                            'quantity', v_row.quantity, 'unit', v_row.unit,
                            'photo_path', v_row.photo_path);
exception when unique_violation then
  raise exception '% ke Unit % ka wastage pehle hi save ho chuka hai',
    v_item.dish_name, p_unit_no;
end;
$function$;

revoke all on function public.record_menu_item_unit_wastage(uuid, integer, numeric, text)
  from public, anon;
grant execute on function public.record_menu_item_unit_wastage(uuid, integer, numeric, text)
  to authenticated;

