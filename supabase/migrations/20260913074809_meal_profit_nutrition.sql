-- Meal-profit foundation: nutrition belongs to the ingredient master, while
-- actual dish cost is the menu's FIFO net issue value allocated by its saved
-- recipe proportions. The total remains exact; a missing recipe stays visibly
-- unallocated instead of being guessed.

alter table public.ingredients
  add column if not exists nutrition_basis_qty numeric not null default 100,
  add column if not exists nutrition_basis_unit text not null default 'g',
  add column if not exists energy_kcal numeric,
  add column if not exists protein_g numeric,
  add column if not exists carbohydrate_g numeric,
  add column if not exists fat_g numeric,
  add column if not exists fibre_g numeric,
  add column if not exists nutrition_source text,
  add column if not exists nutrition_updated_at timestamptz,
  add column if not exists nutrition_updated_by uuid references auth.users(id) on delete set null;

alter table public.ingredients
  drop constraint if exists ingredients_nutrition_nonnegative,
  add constraint ingredients_nutrition_nonnegative check (
    nutrition_basis_qty > 0
    and coalesce(energy_kcal, 0) >= 0
    and coalesce(protein_g, 0) >= 0
    and coalesce(carbohydrate_g, 0) >= 0
    and coalesce(fat_g, 0) >= 0
    and coalesce(fibre_g, 0) >= 0
  ),
  drop constraint if exists ingredients_nutrition_basis_unit,
  add constraint ingredients_nutrition_basis_unit check (
    lower(nutrition_basis_unit) in ('g', 'ml', 'pc')
  );

create or replace function public.quantity_in_nutrition_base(p_qty numeric, p_unit text)
returns numeric
language sql
immutable
parallel safe
set search_path = public
as $$
  select case lower(btrim(coalesce(p_unit, '')))
    when 'kg' then p_qty * 1000
    when 'kilogram' then p_qty * 1000
    when 'kilograms' then p_qty * 1000
    when 'g' then p_qty
    when 'gm' then p_qty
    when 'gram' then p_qty
    when 'grams' then p_qty
    when 'litre' then p_qty * 1000
    when 'liter' then p_qty * 1000
    when 'l' then p_qty * 1000
    when 'ml' then p_qty
    when 'pc' then p_qty
    when 'pcs' then p_qty
    when 'piece' then p_qty
    when 'pieces' then p_qty
    when 'nos' then p_qty
    when 'unit' then p_qty
    else null
  end
$$;

create or replace function public.set_ingredient_nutrition(
  p_ingredient_id uuid,
  p_basis_qty numeric,
  p_basis_unit text,
  p_energy_kcal numeric,
  p_protein_g numeric,
  p_carbohydrate_g numeric,
  p_fat_g numeric,
  p_fibre_g numeric,
  p_source text default null
)
returns public.ingredients
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.ingredients%rowtype;
  v_basis_unit text := lower(btrim(coalesce(p_basis_unit, '')));
begin
  if auth.uid() is null or public.my_rank() < 40 then
    raise exception using errcode = '42501', message = 'Manager access required';
  end if;

  select * into v_row from public.ingredients where id = p_ingredient_id;
  if not found or not public.can_access_canteen(v_row.canteen_id) then
    raise exception using errcode = '42501', message = 'Ingredient is outside your site access';
  end if;
  if coalesce(p_basis_qty, 0) <= 0 or v_basis_unit not in ('g', 'ml', 'pc') then
    raise exception 'Nutrition basis must be positive and use g, ml or pc';
  end if;
  if least(coalesce(p_energy_kcal, 0), coalesce(p_protein_g, 0),
           coalesce(p_carbohydrate_g, 0), coalesce(p_fat_g, 0),
           coalesce(p_fibre_g, 0)) < 0 then
    raise exception 'Nutrition values cannot be negative';
  end if;

  update public.ingredients
     set nutrition_basis_qty = p_basis_qty,
         nutrition_basis_unit = v_basis_unit,
         energy_kcal = p_energy_kcal,
         protein_g = p_protein_g,
         carbohydrate_g = p_carbohydrate_g,
         fat_g = p_fat_g,
         fibre_g = p_fibre_g,
         nutrition_source = nullif(btrim(coalesce(p_source, '')), ''),
         nutrition_updated_at = now(),
         nutrition_updated_by = auth.uid()
   where id = p_ingredient_id
   returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.quantity_in_nutrition_base(numeric, text) from public, anon;
grant execute on function public.quantity_in_nutrition_base(numeric, text) to authenticated, service_role;
revoke all on function public.set_ingredient_nutrition(uuid,numeric,text,numeric,numeric,numeric,numeric,numeric,text) from public, anon;
grant execute on function public.set_ingredient_nutrition(uuid,numeric,text,numeric,numeric,numeric,numeric,numeric,text) to authenticated, service_role;

create or replace function public.meal_profit_analysis(
  p_canteen_id uuid,
  p_start date,
  p_end date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or public.my_rank() < 40
     or not public.can_access_canteen(p_canteen_id) then
    raise exception using errcode = '42501', message = 'Manager access required for this site';
  end if;
  if p_start is null or p_end is null or p_start > p_end or p_end - p_start > 366 then
    raise exception 'Choose a valid report period of at most 367 days';
  end if;

  with
  resolved_requisitions as (
    select r.id,
           coalesce(r.menu_plan_id, (
             select m.id from public.menu_plans m
              where m.canteen_id = r.canteen_id
                and m.menu_date = r.req_date
                and m.meal_period = r.meal_period
                and m.status <> 'draft'
              order by m.created_at limit 1
           )) as menu_plan_id
      from public.requisitions r
     where r.canteen_id = p_canteen_id
  ),
  issued as (
    select rr.menu_plan_id, l.ingredient_id, i.name as ingredient_name, i.unit,
           round(sum(-l.change_qty), 6) as net_qty,
           round(sum(case
             when l.reference_type = 'issue' and l.change_qty < 0
               then abs(coalesce(l.value, -l.change_qty * coalesce(i.cost_per_unit, 0)))
             when l.reference_type = 'return' and l.change_qty > 0
               then -abs(coalesce(l.value, l.change_qty * coalesce(i.cost_per_unit, 0)))
             else 0 end), 4) as net_value,
           i.nutrition_basis_qty, i.nutrition_basis_unit,
           i.energy_kcal, i.protein_g, i.carbohydrate_g, i.fat_g, i.fibre_g
      from public.stock_ledger l
      join resolved_requisitions rr on rr.id = l.reference_id
      join public.ingredients i on i.id = l.ingredient_id
     where rr.menu_plan_id is not null
       and l.reference_type in ('issue', 'return')
       and ((l.reference_type = 'issue' and l.change_qty < 0)
         or (l.reference_type = 'return' and l.change_qty > 0))
     group by rr.menu_plan_id, l.ingredient_id, i.name, i.unit,
              i.nutrition_basis_qty, i.nutrition_basis_unit,
              i.energy_kcal, i.protein_g, i.carbohydrate_g, i.fat_g, i.fibre_g
  ),
  menu_base as (
    select m.id as menu_plan_id, m.menu_date, m.meal_period,
           m.expected_headcount, m.actual_headcount, m.company_punch_count,
           coalesce(m.actual_headcount, m.expected_headcount, 0)::numeric as diner_count,
           m.actual_headcount is null as provisional,
           coalesce(mr.rate, 0)::numeric as meal_rate
      from public.menu_plans m
      left join public.meal_rates mr
        on mr.canteen_id = m.canteen_id and mr.meal_period = m.meal_period
     where m.canteen_id = p_canteen_id
       and m.menu_date between p_start and p_end
       and m.status <> 'draft'
  ),
  dish_base as (
    select mb.*, mi.id as menu_plan_item_id, mi.dish_name, mi.recipe_id,
           mi.produced_qty, mi.wastage_qty, mi.unit as production_unit,
           r.name as recipe_name, r.yield_qty, r.yield_unit
      from menu_base mb
      join public.menu_plan_items mi on mi.menu_plan_id = mb.menu_plan_id
      left join public.recipes r on r.id = mi.recipe_id
  ),
  requirements as (
    select db.menu_plan_id, db.menu_plan_item_id, ri.ingredient_id,
           public.quantity_in_nutrition_base(
             ri.quantity * db.diner_count / nullif(db.yield_qty, 0), ri.unit
           ) as required_base_qty
      from dish_base db
      join public.recipe_ingredients ri on ri.recipe_id = db.recipe_id
     where ri.ingredient_id is not null and db.diner_count > 0
  ),
  requirement_totals as (
    select menu_plan_id, ingredient_id, sum(required_base_qty) as required_base_qty
      from requirements
     where required_base_qty is not null and required_base_qty > 0
     group by menu_plan_id, ingredient_id
  ),
  allocations as (
    select r.menu_plan_id, r.menu_plan_item_id, r.ingredient_id,
           i.ingredient_name, i.unit,
           i.net_qty * r.required_base_qty / nullif(rt.required_base_qty, 0) as allocated_qty,
           i.net_value * r.required_base_qty / nullif(rt.required_base_qty, 0) as allocated_cost,
           public.quantity_in_nutrition_base(i.net_qty, i.unit)
             * r.required_base_qty / nullif(rt.required_base_qty, 0) as allocated_base_qty,
           i.nutrition_basis_qty, i.nutrition_basis_unit,
           i.energy_kcal, i.protein_g, i.carbohydrate_g, i.fat_g, i.fibre_g
      from requirements r
      join requirement_totals rt using (menu_plan_id, ingredient_id)
      join issued i using (menu_plan_id, ingredient_id)
     where r.required_base_qty is not null and r.required_base_qty > 0
  ),
  dish_rollup as (
    select db.menu_plan_id, db.menu_plan_item_id, db.dish_name, db.recipe_id,
           db.recipe_name, db.yield_qty, db.yield_unit, db.diner_count,
           db.produced_qty, db.wastage_qty, db.production_unit,
           coalesce(round(sum(a.allocated_cost), 2), 0) as allocated_cost,
           case when db.diner_count > 0 then round(coalesce(sum(a.allocated_cost), 0) / db.diner_count, 2) end as cost_per_person,
           case when db.diner_count > 0 then round(coalesce(sum(a.allocated_base_qty / nullif(a.nutrition_basis_qty, 0) * a.energy_kcal), 0) / db.diner_count, 2) end as kcal_per_person,
           case when db.diner_count > 0 then round(coalesce(sum(a.allocated_base_qty / nullif(a.nutrition_basis_qty, 0) * a.protein_g), 0) / db.diner_count, 2) end as protein_g_per_person,
           case when db.diner_count > 0 then round(coalesce(sum(a.allocated_base_qty / nullif(a.nutrition_basis_qty, 0) * a.carbohydrate_g), 0) / db.diner_count, 2) end as carbohydrate_g_per_person,
           case when db.diner_count > 0 then round(coalesce(sum(a.allocated_base_qty / nullif(a.nutrition_basis_qty, 0) * a.fat_g), 0) / db.diner_count, 2) end as fat_g_per_person,
           case when db.diner_count > 0 then round(coalesce(sum(a.allocated_base_qty / nullif(a.nutrition_basis_qty, 0) * a.fibre_g), 0) / db.diner_count, 2) end as fibre_g_per_person,
           count(distinct a.ingredient_id) as allocated_ingredients,
           coalesce((select jsonb_agg(jsonb_build_object(
             'ingredient_id', ax.ingredient_id, 'ingredient', ax.ingredient_name,
             'qty', round(ax.allocated_qty, 3), 'unit', ax.unit,
             'cost', round(ax.allocated_cost, 2)
           ) order by ax.allocated_cost desc)
             from allocations ax where ax.menu_plan_item_id = db.menu_plan_item_id), '[]'::jsonb) as ingredients
      from dish_base db
      left join allocations a on a.menu_plan_item_id = db.menu_plan_item_id
     group by db.menu_plan_id, db.menu_plan_item_id, db.dish_name, db.recipe_id,
              db.recipe_name, db.yield_qty, db.yield_unit, db.diner_count,
              db.produced_qty, db.wastage_qty, db.production_unit
  ),
  menu_rollup as (
    select mb.*,
           round(mb.diner_count * mb.meal_rate, 2) as revenue,
           coalesce((select round(sum(i.net_value), 2) from issued i where i.menu_plan_id = mb.menu_plan_id), 0) as actual_food_cost,
           coalesce((select round(sum(d.allocated_cost), 2) from dish_rollup d where d.menu_plan_id = mb.menu_plan_id), 0) as dish_allocated_cost,
           coalesce((select round(sum(d.kcal_per_person), 2) from dish_rollup d where d.menu_plan_id = mb.menu_plan_id), 0) as kcal_per_person,
           coalesce((select round(sum(d.protein_g_per_person), 2) from dish_rollup d where d.menu_plan_id = mb.menu_plan_id), 0) as protein_g_per_person,
           coalesce((select round(sum(d.carbohydrate_g_per_person), 2) from dish_rollup d where d.menu_plan_id = mb.menu_plan_id), 0) as carbohydrate_g_per_person,
           coalesce((select round(sum(d.fat_g_per_person), 2) from dish_rollup d where d.menu_plan_id = mb.menu_plan_id), 0) as fat_g_per_person,
           coalesce((select round(sum(d.fibre_g_per_person), 2) from dish_rollup d where d.menu_plan_id = mb.menu_plan_id), 0) as fibre_g_per_person,
           coalesce((select jsonb_agg(to_jsonb(d) - 'menu_plan_id' order by d.dish_name)
                       from dish_rollup d where d.menu_plan_id = mb.menu_plan_id), '[]'::jsonb) as dishes
      from menu_base mb
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'revenue', coalesce(round(sum(m.revenue), 2), 0),
      'actual_food_cost', coalesce(round(sum(m.actual_food_cost), 2), 0),
      'dish_allocated_cost', coalesce(round(sum(m.dish_allocated_cost), 2), 0),
      'unallocated_cost', coalesce(round(sum(m.actual_food_cost - m.dish_allocated_cost), 2), 0),
      'menus', count(*)
    ),
    'menus', coalesce(jsonb_agg(jsonb_build_object(
      'menu_plan_id', m.menu_plan_id, 'menu_date', m.menu_date, 'meal_period', m.meal_period,
      'expected_headcount', m.expected_headcount, 'actual_headcount', m.actual_headcount,
      'company_punch_count', m.company_punch_count, 'diner_count', m.diner_count,
      'provisional', m.provisional, 'meal_rate', m.meal_rate, 'revenue', m.revenue,
      'actual_food_cost', m.actual_food_cost, 'dish_allocated_cost', m.dish_allocated_cost,
      'unallocated_cost', round(m.actual_food_cost - m.dish_allocated_cost, 2),
      'gross_margin', round(m.revenue - m.actual_food_cost, 2),
      'cost_per_person', case when m.diner_count > 0 then round(m.actual_food_cost / m.diner_count, 2) end,
      'margin_per_person', case when m.diner_count > 0 then round((m.revenue - m.actual_food_cost) / m.diner_count, 2) end,
      'kcal_per_person', m.kcal_per_person, 'protein_g_per_person', m.protein_g_per_person,
      'carbohydrate_g_per_person', m.carbohydrate_g_per_person,
      'fat_g_per_person', m.fat_g_per_person, 'fibre_g_per_person', m.fibre_g_per_person,
      'allocation_pct', case when abs(m.actual_food_cost) > 0.005 then round(m.dish_allocated_cost * 100 / m.actual_food_cost, 1) else 100 end,
      'dishes', m.dishes
    ) order by m.menu_date desc, m.meal_period), '[]'::jsonb)
  ) into v_result
  from menu_rollup m;

  return v_result;
end;
$$;

revoke all on function public.meal_profit_analysis(uuid,date,date) from public, anon;
grant execute on function public.meal_profit_analysis(uuid,date,date) to authenticated, service_role;

comment on function public.meal_profit_analysis(uuid,date,date) is
  'Actual FIFO meal cost allocated to dishes by saved recipe proportions, with nutrition per unique diner.';
