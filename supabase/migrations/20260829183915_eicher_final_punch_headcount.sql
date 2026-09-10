-- Three headcounts are deliberately kept separate:
--   expected_headcount     manager's planning estimate
--   actual_headcount       canteen's manual served count
--   company_punch_count    Eicher's official, final billing count
-- The shelf/consumption ledger is unaffected by these fields. They only pick
-- the billing denominator and revenue source.

alter table public.menu_plans
  add column if not exists company_punch_count integer,
  add column if not exists company_punch_source text not null default 'manual',
  add column if not exists actual_recorded_by uuid references auth.users(id),
  add column if not exists actual_recorded_at timestamptz,
  add column if not exists punch_recorded_by uuid references auth.users(id),
  add column if not exists punch_recorded_at timestamptz,
  add column if not exists count_change_reason text;

alter table public.menu_plans
  drop constraint if exists menu_plans_company_punch_count_check;
alter table public.menu_plans
  add constraint menu_plans_company_punch_count_check
  check (company_punch_count is null or company_punch_count >= 0);

alter table public.menu_plans
  drop constraint if exists menu_plans_company_punch_source_check;
alter table public.menu_plans
  add constraint menu_plans_company_punch_source_check
  check (company_punch_source in ('manual','csv','api'));

create index if not exists idx_menu_plans_company_punch_pending
  on public.menu_plans (canteen_id, menu_date, meal_period)
  where status <> 'draft' and company_punch_count is null;

create or replace function public.billing_headcount(
  p_company_punch integer,
  p_actual integer,
  p_expected integer
) returns integer
language sql
immutable
set search_path = public
as $$
  select coalesce(p_company_punch, p_actual, p_expected, 0);
$$;

comment on function public.billing_headcount(integer,integer,integer) is
  'Official punch wins; otherwise manual actual, then expected estimate.';

create or replace function public.guard_menu_headcount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := nullif(btrim(new.count_change_reason), '');
begin
  if new.expected_headcount is distinct from old.expected_headcount then
    if not public.is_manager_or_above() then
      raise exception 'Only a unit manager or above can change the expected headcount';
    end if;
    if exists (select 1 from public.requisitions r
               where r.menu_plan_id = new.id and r.status = 'issued') then
      raise exception 'Material has already been issued against this menu — expected headcount cannot be changed';
    end if;
  end if;

  if new.actual_headcount is distinct from old.actual_headcount then
    if not public.is_manager_or_above() then
      raise exception 'Only a unit manager or above can record actual plates served';
    end if;
    if new.actual_headcount is not null and new.actual_headcount < 0 then
      raise exception 'Actual plates served cannot be negative';
    end if;
    if old.actual_headcount is not null then
      if not public.is_admin_editor() then
        raise exception 'Actual served count is already recorded — only Admin can correct it';
      end if;
      if v_reason is null or new.count_change_reason is not distinct from old.count_change_reason then
        raise exception 'Actual served count correction needs a new written reason';
      end if;
    end if;

    new.actual_recorded_by := auth.uid();
    new.actual_recorded_at := now();
    insert into public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
    values (auth.uid(),
            case when old.actual_headcount is null then 'plates_recorded' else 'plates_corrected' end,
            'menu_plan', new.id, new.canteen_id,
            jsonb_build_object('menu_date',new.menu_date,'meal_period',new.meal_period,
              'count_type','manual_actual','expected',new.expected_headcount,
              'was',old.actual_headcount,'now',new.actual_headcount,'reason',v_reason));
  end if;

  if new.company_punch_count is distinct from old.company_punch_count then
    if not public.is_manager_or_above() then
      raise exception 'Only a unit manager or above can record the company punch count';
    end if;
    if new.company_punch_count is not null and new.company_punch_count < 0 then
      raise exception 'Company punch count cannot be negative';
    end if;
    if old.company_punch_count is not null then
      if not public.is_admin_editor() then
        raise exception 'Eicher punch count is final — only Admin can correct it';
      end if;
      if v_reason is null or new.count_change_reason is not distinct from old.count_change_reason then
        raise exception 'Eicher punch correction needs a new written reason';
      end if;
    end if;

    new.punch_recorded_by := auth.uid();
    new.punch_recorded_at := now();
    insert into public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
    values (auth.uid(),
            case when old.company_punch_count is null then 'company_punch_recorded' else 'company_punch_corrected' end,
            'menu_plan', new.id, new.canteen_id,
            jsonb_build_object('menu_date',new.menu_date,'meal_period',new.meal_period,
              'count_type','company_punch','source',new.company_punch_source,
              'expected',new.expected_headcount,'actual',new.actual_headcount,
              'was',old.company_punch_count,'now',new.company_punch_count,'reason',v_reason));
  end if;

  return new;
end;
$$;

-- All revenue functions use the same precedence rule.
create or replace function public.computed_sale(p_canteen_id uuid, p_start date, p_end date)
returns numeric
language sql
stable
set search_path = public
as $$
  select coalesce(sum(public.billing_headcount(
    m.company_punch_count, m.actual_headcount, m.expected_headcount
  ) * r.rate), 0)
  from public.menu_plans m
  join public.meal_rates r
    on r.canteen_id = m.canteen_id and r.meal_period = m.meal_period
  where m.canteen_id = p_canteen_id and m.status <> 'draft'
    and m.menu_date between p_start and p_end;
$$;

-- Preserve the mature stock/purchase/wastage report logic and wrap only the
-- headcount/revenue part. The base RPC is private after the rename.
alter function public.operations_summary(uuid,date,date)
  rename to operations_summary_before_company_punch;

revoke all on function public.operations_summary_before_company_punch(uuid,date,date)
  from public, anon, authenticated;
grant execute on function public.operations_summary_before_company_punch(uuid,date,date)
  to service_role;

create function public.operations_summary(p_canteen_id uuid, p_start date, p_end date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_heads bigint;
  v_expected bigint;
  v_actual bigint;
  v_punch bigint;
  v_final_meals bigint;
  v_actual_only_meals bigint;
  v_expected_only_meals bigint;
  v_sale numeric;
  v_consumption numeric;
begin
  if not public.can_access_canteen(p_canteen_id) then
    raise exception 'You do not have access to this site';
  end if;
  v := public.operations_summary_before_company_punch(p_canteen_id,p_start,p_end);
  select
    coalesce(sum(public.billing_headcount(company_punch_count,actual_headcount,expected_headcount)),0),
    coalesce(sum(expected_headcount),0),
    coalesce(sum(actual_headcount) filter (where actual_headcount is not null),0),
    coalesce(sum(company_punch_count) filter (where company_punch_count is not null),0),
    count(*) filter (where company_punch_count is not null),
    count(*) filter (where company_punch_count is null and actual_headcount is not null),
    count(*) filter (where company_punch_count is null and actual_headcount is null)
  into v_heads,v_expected,v_actual,v_punch,v_final_meals,v_actual_only_meals,v_expected_only_meals
  from public.menu_plans
  where canteen_id=p_canteen_id and menu_date between p_start and p_end and status<>'draft';
  v_sale := public.computed_sale(p_canteen_id,p_start,p_end);
  v_consumption := coalesce((v->>'consumption')::numeric,0);
  return v || jsonb_build_object(
    'headcount',v_heads,'expected_headcount',v_expected,'actual_headcount',v_actual,
    'company_punch_headcount',v_punch,'final_meals',v_final_meals,
    'actual_only_meals',v_actual_only_meals,'expected_only_meals',v_expected_only_meals,
    'revenue',round(v_sale,2),
    'cost_per_person',case when v_heads>0 then round(v_consumption/v_heads,2) end,
    'revenue_per_person',case when v_heads>0 then round(v_sale/v_heads,2) end,
    'food_cost_pct',case when v_sale>0 then round(v_consumption*100/v_sale,2) end,
    'margin_per_person',case when v_heads>0 then round((v_sale-v_consumption)/v_heads,2) end
  );
end;
$$;

alter function public.period_summary(uuid,date,date)
  rename to period_summary_before_company_punch;

revoke all on function public.period_summary_before_company_punch(uuid,date,date)
  from public, anon, authenticated;
grant execute on function public.period_summary_before_company_punch(uuid,date,date)
  to service_role;

create function public.period_summary(p_canteen_id uuid, p_start date, p_end date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_heads bigint; v_expected bigint; v_actual bigint; v_punch bigint;
  v_final_meals bigint; v_actual_only_meals bigint; v_expected_only_meals bigint;
  v_sale numeric; v_consumption numeric;
begin
  if p_start is null or p_end is null or p_start>p_end then raise exception 'Invalid report date range'; end if;
  if not public.can_access_canteen(p_canteen_id) then raise exception 'You do not have access to this site'; end if;
  v := public.period_summary_before_company_punch(p_canteen_id,p_start,p_end);
  select
    coalesce(sum(public.billing_headcount(company_punch_count,actual_headcount,expected_headcount)),0),
    coalesce(sum(expected_headcount),0),
    coalesce(sum(actual_headcount) filter (where actual_headcount is not null),0),
    coalesce(sum(company_punch_count) filter (where company_punch_count is not null),0),
    count(*) filter (where company_punch_count is not null),
    count(*) filter (where company_punch_count is null and actual_headcount is not null),
    count(*) filter (where company_punch_count is null and actual_headcount is null)
  into v_heads,v_expected,v_actual,v_punch,v_final_meals,v_actual_only_meals,v_expected_only_meals
  from public.menu_plans
  where canteen_id=p_canteen_id and menu_date between p_start and p_end and status<>'draft';
  v_sale := public.computed_sale(p_canteen_id,p_start,p_end);
  v_consumption := coalesce((v->>'consumption')::numeric,0);
  return v || jsonb_build_object(
    'headcount',v_heads,'expected_headcount',v_expected,'actual_headcount',v_actual,
    'company_punch_headcount',v_punch,'provisional_headcount',
      coalesce((select sum(public.billing_headcount(company_punch_count,actual_headcount,expected_headcount))
        from public.menu_plans where canteen_id=p_canteen_id and menu_date between p_start and p_end
        and status<>'draft' and company_punch_count is null),0),
    'final_meals',v_final_meals,'actual_only_meals',v_actual_only_meals,
    'expected_only_meals',v_expected_only_meals,'sale',round(v_sale,2),
    'cost_per_plate',case when v_heads>0 then round(v_consumption/v_heads,2) end,
    'cost_per_head',case when v_heads>0 then round(v_consumption/v_heads,2) end,
    'food_cost_pct',case when v_sale>0 then round(v_consumption*100/v_sale,2) end
  );
end;
$$;

create or replace function public.daily_operating_snapshot(p_canteen_id uuid, p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ops jsonb;
  v_pending_punch integer;
begin
  if public.my_rank()<20 or not public.can_access_canteen(p_canteen_id) then
    raise exception 'You do not have access to this site summary';
  end if;
  v_ops := public.operations_summary(p_canteen_id,p_date,p_date);
  select count(*) into v_pending_punch from public.menu_plans
   where canteen_id=p_canteen_id and menu_date=p_date
     and status<>'draft' and company_punch_count is null;
  return jsonb_build_object(
    'date',p_date,
    'consumption',coalesce((v_ops->>'consumption')::numeric,0),
    'revenue',coalesce((v_ops->>'revenue')::numeric,0),
    'food_cost_pct',(v_ops->>'food_cost_pct')::numeric,
    'headcount',coalesce((v_ops->>'headcount')::bigint,0),
    'expected_headcount',coalesce((v_ops->>'expected_headcount')::bigint,0),
    'actual_headcount',coalesce((v_ops->>'actual_headcount')::bigint,0),
    'company_punch_headcount',coalesce((v_ops->>'company_punch_headcount')::bigint,0),
    'provisional',v_pending_punch>0
  );
end;
$$;

alter function public.owner_menu_profit_breakdown(uuid,date,date)
  rename to owner_menu_profit_breakdown_before_company_punch;

revoke all on function public.owner_menu_profit_breakdown_before_company_punch(uuid,date,date)
  from public, anon, authenticated;
grant execute on function public.owner_menu_profit_breakdown_before_company_punch(uuid,date,date)
  to service_role;

create function public.owner_menu_profit_breakdown(p_canteen_id uuid, p_start date, p_end date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_menus jsonb;
  v_menu_revenue numeric;
  v_expected bigint;
  v_actual bigint;
  v_punch bigint;
begin
  if p_start is null or p_end is null or p_start>p_end then raise exception 'Invalid report period'; end if;
  if public.my_rank()<40 or not public.can_access_canteen(p_canteen_id) then
    raise exception 'Only Unit Manager or above can view this report';
  end if;
  v := public.owner_menu_profit_breakdown_before_company_punch(p_canteen_id,p_start,p_end);

  select coalesce(jsonb_agg(x.row_json order by x.menu_date desc, x.meal_order),'[]'::jsonb)
  into v_menus
  from (
    select m.menu_date,
      case m.meal_period when 'breakfast' then 1 when 'lunch' then 2
        when 'evening_snacks' then 3 when 'dinner' then 4 when 'night_snacks' then 5 else 6 end meal_order,
      e || jsonb_build_object(
        'expected_headcount',m.expected_headcount,
        'actual_headcount',m.actual_headcount,
        'company_punch_count',m.company_punch_count,
        'headcount',public.billing_headcount(m.company_punch_count,m.actual_headcount,m.expected_headcount),
        'count_source',case when m.company_punch_count is not null then 'company_punch'
          when m.actual_headcount is not null then 'manual_actual' else 'expected' end,
        'provisional',m.company_punch_count is null,
        'revenue',round(public.billing_headcount(m.company_punch_count,m.actual_headcount,m.expected_headcount)
          * coalesce((e->>'rate')::numeric,0),2),
        'margin',round(public.billing_headcount(m.company_punch_count,m.actual_headcount,m.expected_headcount)
          * coalesce((e->>'rate')::numeric,0)-coalesce((e->>'issued_cost')::numeric,0),2),
        'food_cost_pct',case when public.billing_headcount(m.company_punch_count,m.actual_headcount,m.expected_headcount)
          * coalesce((e->>'rate')::numeric,0)>0 then round(coalesce((e->>'issued_cost')::numeric,0)*100/
          (public.billing_headcount(m.company_punch_count,m.actual_headcount,m.expected_headcount)
          * coalesce((e->>'rate')::numeric,0)),2) end
      ) row_json
    from jsonb_array_elements(coalesce(v->'menus','[]'::jsonb)) e
    join public.menu_plans m on m.id=(e->>'menu_plan_id')::uuid
  ) x;

  select coalesce(sum((e->>'revenue')::numeric),0) into v_menu_revenue
  from jsonb_array_elements(v_menus) e;
  select coalesce(sum(expected_headcount),0),
         coalesce(sum(actual_headcount) filter(where actual_headcount is not null),0),
         coalesce(sum(company_punch_count) filter(where company_punch_count is not null),0)
    into v_expected,v_actual,v_punch
  from public.menu_plans where canteen_id=p_canteen_id
    and menu_date between p_start and p_end and status<>'draft';

  return jsonb_set(
    jsonb_set(v,'{menus}',v_menus,true),
    '{summary}',
    coalesce(v->'summary','{}'::jsonb) || jsonb_build_object(
      'menu_revenue',round(v_menu_revenue,2),'expected_headcount',v_expected,
      'actual_headcount',v_actual,'company_punch_headcount',v_punch,
      'billing_status',case when exists(
        select 1 from public.menu_plans where canteen_id=p_canteen_id
          and menu_date between p_start and p_end and status<>'draft' and company_punch_count is null
      ) then 'provisional' else 'final' end
    ),true
  );
end;
$$;

revoke all on function public.billing_headcount(integer,integer,integer) from public,anon;
grant execute on function public.billing_headcount(integer,integer,integer) to authenticated,service_role;

revoke all on function public.operations_summary(uuid,date,date) from public,anon;
grant execute on function public.operations_summary(uuid,date,date) to authenticated,service_role;
revoke all on function public.period_summary(uuid,date,date) from public,anon;
grant execute on function public.period_summary(uuid,date,date) to authenticated,service_role;
revoke all on function public.owner_menu_profit_breakdown(uuid,date,date) from public,anon;
grant execute on function public.owner_menu_profit_breakdown(uuid,date,date) to authenticated,service_role;
revoke all on function public.daily_operating_snapshot(uuid,date) from public,anon;
grant execute on function public.daily_operating_snapshot(uuid,date) to authenticated,service_role;
