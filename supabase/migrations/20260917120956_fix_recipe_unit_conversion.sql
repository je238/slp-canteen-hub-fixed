-- Recipe lines used to keep the number entered by the chef but later replace
-- the line unit with the inventory item's unit.  Thus 100 gram of chilli for
-- 100 people became 650 kg for 650 people.  Keep every recipe in the
-- inventory item's canonical unit and perform the conversion in the database
-- (the only place shared by every client).

create or replace function public.recipe_qty_in_inventory_unit(
  p_quantity numeric,
  p_recipe_unit text,
  p_inventory_unit text
)
returns numeric
language sql
immutable
strict
set search_path = public
as $$
  select case
    when lower(btrim(p_recipe_unit)) = lower(btrim(p_inventory_unit))
      then p_quantity

    when lower(btrim(p_inventory_unit)) in ('kg', 'kilogram', 'kilograms')
     and lower(btrim(p_recipe_unit)) in ('g', 'gm', 'gram', 'grams')
      then p_quantity / 1000
    when lower(btrim(p_inventory_unit)) in ('g', 'gm', 'gram', 'grams')
     and lower(btrim(p_recipe_unit)) in ('kg', 'kilogram', 'kilograms')
      then p_quantity * 1000

    when lower(btrim(p_inventory_unit)) in ('litre', 'litres', 'liter', 'liters', 'l')
     and lower(btrim(p_recipe_unit)) in ('ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters')
      then p_quantity / 1000
    -- Existing kitchen recipes used "gram" for small oil quantities.  In the
    -- order screen oil is held in litres, so preserve the intended 600 ->
    -- 0.6 operational conversion instead of ever producing 600 litres.
    when lower(btrim(p_inventory_unit)) in ('litre', 'litres', 'liter', 'liters', 'l')
     and lower(btrim(p_recipe_unit)) in ('g', 'gm', 'gram', 'grams')
      then p_quantity / 1000
    when lower(btrim(p_inventory_unit)) in ('ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters')
     and lower(btrim(p_recipe_unit)) in ('litre', 'litres', 'liter', 'liters', 'l')
      then p_quantity * 1000

    when lower(btrim(p_inventory_unit)) in ('pc', 'pcs', 'piece', 'pieces')
     and lower(btrim(p_recipe_unit)) in ('pc', 'pcs', 'piece', 'pieces')
      then p_quantity
    when lower(btrim(p_inventory_unit)) in ('packet', 'packets', 'pkt', 'pack')
     and lower(btrim(p_recipe_unit)) in ('packet', 'packets', 'pkt', 'pack')
      then p_quantity
    when lower(btrim(p_inventory_unit)) in ('box', 'boxes')
     and lower(btrim(p_recipe_unit)) in ('box', 'boxes')
      then p_quantity
    else null
  end;
$$;

revoke all on function public.recipe_qty_in_inventory_unit(numeric,text,text) from public, anon;
grant execute on function public.recipe_qty_in_inventory_unit(numeric,text,text) to authenticated, service_role;

-- Leave a trace of every historical recipe line corrected by this migration.
insert into public.action_logs (action, entity_type, entity_id, canteen_id, details)
select
  'recipe_unit_normalized',
  'recipe',
  ri.recipe_id,
  r.canteen_id,
  jsonb_build_object(
    'ingredient_id', ri.ingredient_id,
    'ingredient', i.name,
    'old_quantity', ri.quantity,
    'old_unit', ri.unit,
    'new_quantity', public.recipe_qty_in_inventory_unit(ri.quantity, ri.unit, i.unit),
    'new_unit', i.unit,
    'reason', 'Recipe unit converted to inventory base unit'
  )
from public.recipe_ingredients ri
join public.ingredients i on i.id = ri.ingredient_id
join public.recipes r on r.id = ri.recipe_id
where public.recipe_qty_in_inventory_unit(ri.quantity, ri.unit, i.unit) is not null
  and (
    ri.quantity is distinct from public.recipe_qty_in_inventory_unit(ri.quantity, ri.unit, i.unit)
    or btrim(ri.unit) is distinct from btrim(i.unit)
  );

update public.recipe_ingredients ri
set quantity = public.recipe_qty_in_inventory_unit(ri.quantity, ri.unit, i.unit),
    unit = i.unit
from public.ingredients i
where i.id = ri.ingredient_id
  and public.recipe_qty_in_inventory_unit(ri.quantity, ri.unit, i.unit) is not null
  and (
    ri.quantity is distinct from public.recipe_qty_in_inventory_unit(ri.quantity, ri.unit, i.unit)
    or btrim(ri.unit) is distinct from btrim(i.unit)
  );

-- All future recipe writes are normalized before they reach the table.  This
-- protects every client, including an older app still open on another device.
create or replace function public.normalize_recipe_ingredient_unit()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_inventory_unit text;
  v_quantity numeric;
begin
  select unit into strict v_inventory_unit
  from public.ingredients
  where id = new.ingredient_id;

  v_quantity := public.recipe_qty_in_inventory_unit(
    new.quantity, new.unit, v_inventory_unit
  );
  if v_quantity is null then
    raise exception 'Recipe unit % inventory unit % se match nahi karti',
      new.unit, v_inventory_unit;
  end if;

  new.quantity := v_quantity;
  new.unit := v_inventory_unit;
  return new;
end;
$$;

revoke all on function public.normalize_recipe_ingredient_unit() from public, anon;
grant execute on function public.normalize_recipe_ingredient_unit() to authenticated, service_role;

drop trigger if exists trg_normalize_recipe_ingredient_unit on public.recipe_ingredients;
create trigger trg_normalize_recipe_ingredient_unit
before insert or update of ingredient_id, quantity, unit
on public.recipe_ingredients
for each row execute function public.normalize_recipe_ingredient_unit();

-- Scale only after converting the saved recipe amount to the inventory unit.
-- The unit returned beside qty is the same unit the requisition will store.
create or replace function public.day_kitchen_plan(p_canteen_id uuid, p_date date)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with ord as (
    select * from (values
      ('tea', 1), ('breakfast', 2), ('lunch', 3),
      ('evening_snacks', 4), ('dinner', 5), ('night_snacks', 6)
    ) as t(period, seq)
  ),
  dish as (
    select
      m.id as plan_id, m.meal_period, m.status,
      coalesce(m.actual_headcount, m.expected_headcount, 0) as heads,
      mi.id as item_id, mi.dish_name, mi.planned_qty, mi.unit, mi.recipe_id,
      r.yield_qty, r.yield_unit,
      case
        when r.id is null then null
        when lower(coalesce(r.yield_unit, '')) in ('plate', 'plates', 'pax')
          then coalesce(m.actual_headcount, m.expected_headcount, 0)::numeric
               / nullif(r.yield_qty, 0)
        else coalesce(mi.planned_qty, r.yield_qty) / nullif(r.yield_qty, 0)
      end as scale
    from public.menu_plans m
    join public.menu_plan_items mi on mi.menu_plan_id = m.id
    left join public.recipes r on r.id = mi.recipe_id
    where m.canteen_id = p_canteen_id and m.menu_date = p_date
      and m.status <> 'draft'
  )
  select coalesce(jsonb_agg(meal order by seq), '[]'::jsonb) from (
    select o.seq, jsonb_build_object(
      'meal_period', d.meal_period,
      'plan_id', min(d.plan_id::text),
      'headcount', max(d.heads),
      'dishes', jsonb_agg(jsonb_build_object(
        'item_id', d.item_id,
        'dish_name', d.dish_name,
        'planned_qty', d.planned_qty,
        'unit', d.unit,
        'has_recipe', d.recipe_id is not null,
        'ingredients', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'ingredient_id', ri.ingredient_id,
                   'name', i.name,
                   'unit', i.unit,
                   'qty', round(
                     public.recipe_qty_in_inventory_unit(ri.quantity, ri.unit, i.unit)
                     * coalesce(d.scale, 1), 3
                   ),
                   'in_stock', i.current_stock,
                   'rate', i.cost_per_unit
                 ) order by i.name)
          from public.recipe_ingredients ri
          join public.ingredients i on i.id = ri.ingredient_id
          where ri.recipe_id = d.recipe_id
            and public.recipe_qty_in_inventory_unit(ri.quantity, ri.unit, i.unit) is not null
        ), '[]'::jsonb)
      ) order by d.dish_name)
    ) as meal
    from dish d join ord o on o.period = d.meal_period
    group by o.seq, d.meal_period
  ) x;
$$;

revoke all on function public.day_kitchen_plan(uuid,date) from public, anon;
grant execute on function public.day_kitchen_plan(uuid,date) to authenticated;

comment on function public.recipe_qty_in_inventory_unit(numeric,text,text) is
  'Converts recipe entry units to the inventory item unit; incompatible units return NULL.';
comment on function public.day_kitchen_plan(uuid,date) is
  'Returns recipe quantities scaled for the meal headcount in each ingredient inventory unit.';
