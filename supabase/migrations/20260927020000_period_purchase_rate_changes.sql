-- Compare each confirmed purchase with the preceding positive stock-unit rate.
-- Filter by the selected report range only after calculating the baseline, so
-- the first purchase in the range can still be compared with an older one.
create or replace function public.period_purchase_rate_changes(
  p_canteen_id uuid,
  p_from date,
  p_to date
)
returns table (
  purchase_id uuid,
  purchase_at timestamptz,
  ingredient_id uuid,
  item_name text,
  stock_unit text,
  supplier_name text,
  stock_qty numeric,
  line_value numeric,
  current_rate numeric,
  previous_rate numeric,
  rate_change numeric,
  rate_change_pct numeric
)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_canteen_id is null or p_from is null or p_to is null or p_from > p_to then
    raise exception 'Valid canteen and date range are required';
  end if;
  if public.my_rank() < 40 or not public.can_access_canteen(p_canteen_id) then
    raise exception 'Not authorised to view purchase rate changes';
  end if;

  return query
  with positive_purchase_lines as (
    select p.id as purchase_id,
      pi.id as purchase_item_id,
      coalesce(p.approved_at, p.created_at) as purchase_at,
      pi.ingredient_id,
      i.name::text as item_name,
      i.unit::text as stock_unit,
      coalesce(s.name, 'No supplier')::text as supplier_name,
      coalesce(pi.stock_quantity, pi.quantity, 0)::numeric as stock_qty,
      coalesce(pi.total, pi.quantity * pi.rate, 0)::numeric as line_value,
      (coalesce(pi.total, pi.quantity * pi.rate, 0)
        / nullif(coalesce(pi.stock_quantity, pi.quantity, 0), 0))::numeric as effective_rate
    from public.purchases p
    join public.purchase_items pi on pi.purchase_id = p.id
    join public.ingredients i on i.id = pi.ingredient_id
    left join public.suppliers s on s.id = p.supplier_id
    where p.canteen_id = p_canteen_id
      and p.status = 'confirmed'
      and pi.ingredient_id is not null
      and coalesce(pi.stock_quantity, pi.quantity, 0) > 0
      and coalesce(pi.total, pi.quantity * pi.rate, 0) > 0
      and coalesce(p.approved_at, p.created_at) < (p_to + 1)::timestamp at time zone 'Asia/Kolkata'
  ), comparisons as (
    select ppl.*,
      lag(ppl.effective_rate) over (
        partition by ppl.ingredient_id
        order by ppl.purchase_at, ppl.purchase_id, ppl.purchase_item_id
      ) as prior_rate
    from positive_purchase_lines ppl
  )
  select c.purchase_id, c.purchase_at, c.ingredient_id, c.item_name,
    c.stock_unit, c.supplier_name, round(c.stock_qty, 3),
    round(c.line_value, 2), round(c.effective_rate, 2),
    round(c.prior_rate, 2), round(c.effective_rate - c.prior_rate, 2),
    round((c.effective_rate - c.prior_rate) * 100 / nullif(c.prior_rate, 0), 1)
  from comparisons c
  where (c.purchase_at at time zone 'Asia/Kolkata')::date between p_from and p_to
    and c.prior_rate is not null
    and round(c.effective_rate - c.prior_rate, 2) <> 0
  order by c.purchase_at desc, c.purchase_id desc, c.purchase_item_id desc;
end;
$$;

revoke all on function public.period_purchase_rate_changes(uuid, date, date) from public, anon;
grant execute on function public.period_purchase_rate_changes(uuid, date, date) to authenticated;
