-- The nested PostgREST requisition read timed out on 200 orders / 4,409 lines.
-- Check the caller's site once, then build the same nested response with
-- indexed joins. No stock or order data is changed by this read function.
create or replace function public.requisition_list_for_site(
  p_canteen_id uuid, p_since date
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_rows jsonb;
begin
  if auth.uid() is null or not public.can_access_canteen(p_canteen_id) then
    raise exception using errcode = '42501', message = 'You cannot view requisitions for this site';
  end if;

  select coalesce(jsonb_agg(
    to_jsonb(r) || jsonb_build_object(
      'menu_plans', case when mp.id is null then null else
        jsonb_build_object(
          'menu_date', mp.menu_date,
          'meal_period', mp.meal_period,
          'menu_plan_items', coalesce(dishes.items, '[]'::jsonb)
        ) end,
      'requisition_items', coalesce(lines.items, '[]'::jsonb)
    ) order by r.created_at desc, r.id desc
  ), '[]'::jsonb) into v_rows
  from public.requisitions r
  left join public.menu_plans mp
    on mp.id = r.menu_plan_id and mp.canteen_id = p_canteen_id
  left join lateral (
    select jsonb_agg(jsonb_build_object('dish_name', mi.dish_name) order by mi.id) as items
    from public.menu_plan_items mi where mi.menu_plan_id = mp.id
  ) dishes on true
  left join lateral (
    select jsonb_agg(
      to_jsonb(ri) || jsonb_build_object(
        'ingredients', case when i.id is null then null else jsonb_build_object(
          'name', i.name, 'unit', i.unit, 'category', i.category,
          'current_stock', i.current_stock, 'cost_per_unit', i.cost_per_unit
        ) end,
        'head_chef_ingredient', case when hi.id is null then null else jsonb_build_object(
          'name', hi.name, 'unit', hi.unit, 'category', hi.category,
          'current_stock', hi.current_stock, 'cost_per_unit', hi.cost_per_unit
        ) end,
        'original_ingredient', case when oi.id is null then null else jsonb_build_object(
          'name', oi.name, 'unit', oi.unit
        ) end
      ) order by ri.id
    ) as items
    from public.requisition_items ri
    left join public.ingredients i
      on i.id = ri.ingredient_id and i.canteen_id = p_canteen_id
    left join public.ingredients hi
      on hi.id = ri.head_chef_ingredient_id and hi.canteen_id = p_canteen_id
    left join public.ingredients oi
      on oi.id = ri.original_ingredient_id and oi.canteen_id = p_canteen_id
    where ri.requisition_id = r.id
  ) lines on true
  where r.canteen_id = p_canteen_id and r.req_date >= p_since;

  return v_rows;
end;
$$;

revoke all on function public.requisition_list_for_site(uuid, date) from public, anon;
grant execute on function public.requisition_list_for_site(uuid, date) to authenticated;

-- Managers may correct an item's spelling through the audited rename RPC.
-- The general inventory edit, stock, rate and unit RPCs stay Admin-only.
create or replace function public.rename_ingredient(
  p_ingredient_id uuid, p_name text, p_reason text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ing public.ingredients%rowtype;
  v_name text;
  v_reason text;
  v_clash text;
  v_is_manager boolean;
begin
  v_is_manager := exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role::text in ('unit_manager', 'manager')
  );
  if auth.uid() is null or not (public.is_admin_editor() or v_is_manager) then
    raise exception using errcode = '42501', message = 'Only Manager or Admin can rename an inventory item';
  end if;

  select * into v_ing from public.ingredients where id = p_ingredient_id;
  if not found then raise exception 'Unknown item'; end if;
  if not public.can_access_canteen(v_ing.canteen_id) then
    raise exception using errcode = '42501', message = 'You do not have access to this site';
  end if;

  v_name := btrim(coalesce(p_name, ''));
  if length(v_name) < 2 then raise exception 'Enter at least two characters for the item name'; end if;
  if v_name = v_ing.name then return jsonb_build_object('changed', false); end if;

  select name into v_clash from public.ingredients
  where canteen_id = v_ing.canteen_id and id <> p_ingredient_id
    and lower(btrim(name)) = lower(v_name)
  limit 1;
  if v_clash is not null then
    raise exception '"%" already exists here. Merge the items instead of renaming onto it.', v_clash;
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if v_is_manager and length(v_reason) < 3 then
    raise exception 'Manager must enter a reason for the name correction';
  end if;

  perform public.allow_stock_move();
  update public.ingredients set name = v_name where id = p_ingredient_id;

  insert into public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  values (auth.uid(), 'ingredient_renamed', 'ingredient', p_ingredient_id, v_ing.canteen_id,
    jsonb_build_object('item', v_ing.name, 'was', v_ing.name, 'now', v_name,
      'stock_at_the_time', v_ing.current_stock, 'unit', v_ing.unit,
      'reason', nullif(v_reason, '')));

  return jsonb_build_object('changed', true, 'was', v_ing.name, 'now', v_name);
end;
$$;

revoke all on function public.rename_ingredient(uuid, text, text) from public, anon;
grant execute on function public.rename_ingredient(uuid, text, text) to authenticated;
