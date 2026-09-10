-- Chef Recipe Book uses the existing dish-recipe engine, but closes the
-- privileged RPC to store/vendor roles and validates every ingredient
-- against the selected site before a SECURITY DEFINER write.

create or replace function public.save_dish_recipe(
  p_canteen_id uuid,
  p_dish_name text,
  p_items jsonb,
  p_yield_qty numeric default 1,
  p_yield_unit text default 'plate'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipe uuid;
  v_name text := btrim(p_dish_name);
  v_linked integer;
  v_it jsonb;
  v_ingredient uuid;
  v_quantity numeric;
begin
  if (select auth.uid()) is null or public.my_rank() < 30 then
    raise exception 'Only Chef or Manager can change recipes';
  end if;
  if not public.can_access_canteen(p_canteen_id) then
    raise exception 'You cannot change recipes for this site';
  end if;
  if v_name = '' then raise exception 'The dish needs a name'; end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'Add at least one ingredient';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'A recipe cannot contain more than 100 items';
  end if;
  if coalesce(p_yield_qty, 0) <= 0 then
    raise exception 'How much this makes must be more than zero';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    where coalesce((item->>'quantity')::numeric, 0) <= 0
       or coalesce(btrim(item->>'unit'), '') = ''
       or not exists (
         select 1 from public.ingredients i
         where i.id = (item->>'ingredient_id')::uuid
           and i.canteen_id = p_canteen_id
       )
  ) then
    raise exception 'Every item needs a positive quantity and must belong to this site';
  end if;
  if (
    select count(*) <> count(distinct item->>'ingredient_id')
    from jsonb_array_elements(p_items) item
  ) then
    raise exception 'The same item cannot appear twice in one recipe';
  end if;

  select id into v_recipe
  from public.recipes
  where canteen_id = p_canteen_id
    and lower(btrim(name)) = lower(v_name)
  order by created_at
  limit 1
  for update;

  if v_recipe is null then
    insert into public.recipes (canteen_id, name, yield_qty, yield_unit)
    values (p_canteen_id, v_name, p_yield_qty, coalesce(nullif(btrim(p_yield_unit), ''), 'plate'))
    returning id into v_recipe;
  else
    update public.recipes
    set yield_qty = p_yield_qty,
        yield_unit = coalesce(nullif(btrim(p_yield_unit), ''), 'plate'),
        updated_at = now()
    where id = v_recipe;
    delete from public.recipe_ingredients where recipe_id = v_recipe;
  end if;

  for v_it in select * from jsonb_array_elements(p_items)
  loop
    v_ingredient := (v_it->>'ingredient_id')::uuid;
    v_quantity := (v_it->>'quantity')::numeric;
    insert into public.recipe_ingredients (recipe_id, ingredient_id, quantity, unit)
    values (v_recipe, v_ingredient, v_quantity, btrim(v_it->>'unit'));
  end loop;

  update public.menu_plan_items mi
  set recipe_id = v_recipe
  from public.menu_plans m
  where mi.menu_plan_id = m.id
    and m.canteen_id = p_canteen_id
    and mi.recipe_id is null
    and lower(btrim(mi.dish_name)) = lower(v_name)
    and m.menu_date >= timezone('Asia/Kolkata', now())::date;
  get diagnostics v_linked = row_count;

  return jsonb_build_object('recipe_id', v_recipe, 'menu_lines_linked', v_linked);
end;
$$;

revoke all on function public.save_dish_recipe(uuid, text, jsonb, numeric, text) from public;
revoke all on function public.save_dish_recipe(uuid, text, jsonb, numeric, text) from anon;
grant execute on function public.save_dish_recipe(uuid, text, jsonb, numeric, text) to authenticated;
