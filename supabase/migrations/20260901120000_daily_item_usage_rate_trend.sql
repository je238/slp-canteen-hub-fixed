-- Daily item usage and purchase-rate trend for unit managers, Ops Managers and owners.
-- Consumption is net FIFO issue value (accepted kitchen returns are subtracted).
-- Purchase rate is weighted by stock quantity so mixed-rate invoices remain accurate.

create index if not exists idx_purchase_items_ingredient_purchase
  on public.purchase_items (ingredient_id, purchase_id)
  where ingredient_id is not null;

create or replace function public.daily_item_usage_rate_trend(
  p_canteen_id uuid,
  p_date date,
  p_lookback_days integer default 7
)
returns table (
  ingredient_id uuid,
  item_name text,
  unit text,
  report_date date,
  comparison_start date,
  comparison_days integer,
  consumed_qty numeric,
  consumed_value numeric,
  prior_daily_avg_qty numeric,
  usage_change_qty numeric,
  usage_change_pct numeric,
  purchase_qty numeric,
  purchase_value numeric,
  purchase_count bigint,
  day_avg_rate numeric,
  previous_rate numeric,
  rate_change numeric,
  rate_change_pct numeric,
  suppliers text,
  last_purchase_at timestamptz,
  previous_purchase_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_days integer := greatest(least(coalesce(p_lookback_days, 7), 90), 1);
  v_start date;
  v_comparison_days integer;
begin
  if p_canteen_id is null or p_date is null then
    raise exception 'Canteen and report date are required';
  end if;

  if public.my_rank() < 40 or not public.can_access_canteen(p_canteen_id) then
    raise exception 'Not authorised to view item cost trends';
  end if;

  v_start := greatest(p_date - v_days, date '2026-08-19');
  v_comparison_days := greatest(p_date - v_start, 0);

  return query
  with consumption as (
    select
      n.ingredient_id,
      max(n.item_name) as item_name,
      max(n.unit) as unit,
      coalesce(sum(n.qty) filter (where n.service_date = p_date), 0) as day_qty,
      coalesce(sum(n.value) filter (where n.service_date = p_date), 0) as day_value,
      case when v_comparison_days > 0 then
        coalesce(sum(n.qty) filter (where n.service_date < p_date), 0) / v_comparison_days
      end as prior_avg_qty
    from public.net_consumption_lines(p_canteen_id, v_start, p_date) n
    group by n.ingredient_id
  ),
  all_purchases as (
    select
      pi.ingredient_id,
      p.id as purchase_id,
      coalesce(p.approved_at, p.created_at) as purchase_at,
      (coalesce(p.approved_at, p.created_at) at time zone 'Asia/Kolkata')::date as purchase_date,
      coalesce(pi.stock_quantity, pi.quantity, 0)::numeric as stock_qty,
      coalesce(pi.total, pi.quantity * pi.rate, 0)::numeric as line_value,
      case
        when coalesce(pi.stock_quantity, pi.quantity, 0) > 0 then
          coalesce(pi.total, pi.quantity * pi.rate, 0)::numeric
            / coalesce(pi.stock_quantity, pi.quantity)::numeric
      end as effective_rate,
      coalesce(s.name, 'No supplier')::text as supplier_name
    from public.purchases p
    join public.purchase_items pi on pi.purchase_id = p.id
    left join public.suppliers s on s.id = p.supplier_id
    where p.canteen_id = p_canteen_id
      and p.status = 'confirmed'
      and pi.ingredient_id is not null
      and (coalesce(p.approved_at, p.created_at) at time zone 'Asia/Kolkata')::date <= p_date
  ),
  day_purchases as (
    select
      ap.ingredient_id,
      sum(ap.stock_qty) as purchase_qty,
      sum(ap.line_value) as purchase_value,
      count(distinct ap.purchase_id) as purchase_count,
      sum(ap.line_value) / nullif(sum(ap.stock_qty), 0) as day_avg_rate,
      string_agg(distinct ap.supplier_name, ', ' order by ap.supplier_name) as suppliers,
      max(ap.purchase_at) as last_purchase_at
    from all_purchases ap
    where ap.purchase_date = p_date
    group by ap.ingredient_id
  ),
  previous_purchase as (
    select distinct on (ap.ingredient_id)
      ap.ingredient_id,
      ap.effective_rate as previous_rate,
      ap.purchase_at as previous_purchase_at
    from all_purchases ap
    where ap.purchase_date < p_date
      and ap.effective_rate is not null
    order by ap.ingredient_id, ap.purchase_at desc, ap.purchase_id desc
  ),
  active_items as (
    select c.ingredient_id from consumption c
    union
    select dp.ingredient_id from day_purchases dp
  )
  select
    i.id,
    i.name::text,
    i.unit::text,
    p_date,
    v_start,
    v_comparison_days,
    round(coalesce(c.day_qty, 0), 3),
    round(coalesce(c.day_value, 0), 2),
    round(c.prior_avg_qty, 3),
    round(coalesce(c.day_qty, 0) - coalesce(c.prior_avg_qty, 0), 3),
    case when coalesce(c.prior_avg_qty, 0) > 0 then
      round((coalesce(c.day_qty, 0) - c.prior_avg_qty) * 100 / c.prior_avg_qty, 1)
    end,
    round(coalesce(dp.purchase_qty, 0), 3),
    round(coalesce(dp.purchase_value, 0), 2),
    coalesce(dp.purchase_count, 0),
    round(dp.day_avg_rate, 2),
    round(pp.previous_rate, 2),
    round(dp.day_avg_rate - pp.previous_rate, 2),
    case when coalesce(pp.previous_rate, 0) > 0 and dp.day_avg_rate is not null then
      round((dp.day_avg_rate - pp.previous_rate) * 100 / pp.previous_rate, 1)
    end,
    dp.suppliers,
    dp.last_purchase_at,
    pp.previous_purchase_at
  from active_items ai
  join public.ingredients i on i.id = ai.ingredient_id
  left join consumption c on c.ingredient_id = ai.ingredient_id
  left join day_purchases dp on dp.ingredient_id = ai.ingredient_id
  left join previous_purchase pp on pp.ingredient_id = ai.ingredient_id
  where i.canteen_id = p_canteen_id
  order by
    (case when dp.day_avg_rate > pp.previous_rate then 1 else 0 end) desc,
    (coalesce(dp.purchase_value, 0) + coalesce(c.day_value, 0)) desc,
    i.name;
end;
$$;

revoke all on function public.daily_item_usage_rate_trend(uuid, date, integer) from public;
revoke all on function public.daily_item_usage_rate_trend(uuid, date, integer) from anon;
grant execute on function public.daily_item_usage_rate_trend(uuid, date, integer) to authenticated;

