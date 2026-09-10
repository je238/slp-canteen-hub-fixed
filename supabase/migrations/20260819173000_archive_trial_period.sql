-- 13-18 August 2026 were the live trial. Preserve every stock movement for
-- audit/opening balance, but close their unfinished commitments and ensure
-- automatic chef suggestions learn only from the clean start.

create temporary table trial_requisitions on commit drop as
select r.id, r.canteen_id, r.req_no, r.status as old_status,
       coalesce(sum(ri.issued_qty), 0) as issued_qty,
       coalesce(sum(greatest(coalesce(ri.approved_qty, ri.requested_qty) - coalesce(ri.issued_qty, 0), 0)), 0) as released_qty
from public.requisitions r
join public.canteens c on c.id = r.canteen_id
left join public.requisition_items ri on ri.requisition_id = r.id
where c.name = 'Eicher, Dewas'
  and r.req_date < date '2026-08-19'
  and r.status in ('pending', 'approved')
group by r.id, r.canteen_id, r.req_no, r.status;

select set_config('app.close_pending', 'on', true);

update public.requisition_items ri
set cancelled_qty = coalesce(ri.cancelled_qty, 0)
                    + greatest(coalesce(ri.approved_qty, ri.requested_qty) - coalesce(ri.issued_qty, 0), 0),
    approved_qty = coalesce(ri.issued_qty, 0),
    cancellation_reason = 'Trial period closed at 19 August clean start',
    cancelled_by = null,
    cancelled_at = now()
from trial_requisitions tr
where ri.requisition_id = tr.id
  and greatest(coalesce(ri.approved_qty, ri.requested_qty) - coalesce(ri.issued_qty, 0), 0) > 0;

-- This is a one-time system cutover, not a manager/store-keeper button press.
-- Suppress workflow triggers only around the status archival; stock triggers
-- and the stock ledger are never disabled or changed.
alter table public.requisitions disable trigger user;

update public.requisitions r
set status = case when tr.issued_qty > 0 then 'issued' else 'cancelled' end,
    review_notes = concat_ws(E'\n', nullif(r.review_notes, ''),
      'Trial period archived on 19 August 2026; unissued balance released.' )
from trial_requisitions tr
where r.id = tr.id;

alter table public.requisitions enable trigger user;

insert into public.action_logs (action, entity_type, entity_id, details, canteen_id)
select 'trial_period_archived', 'requisition', tr.id,
       jsonb_build_object(
         'req_no', tr.req_no,
         'old_status', tr.old_status,
         'new_status', case when tr.issued_qty > 0 then 'issued' else 'cancelled' end,
         'issued_qty_preserved', tr.issued_qty,
         'unissued_qty_released', tr.released_qty,
         'cutover_date', '2026-08-19'
       ), tr.canteen_id
from trial_requisitions tr;

create or replace function public.suggest_requisition(
  p_canteen_id uuid, p_headcount integer, p_days integer default 30
)
returns table(
  ingredient_id uuid, name text, category text, unit text, per_head numeric,
  suggested_qty numeric, current_stock numeric, shortfall numeric,
  latest_rate numeric, est_value numeric, days_of_history integer,
  rate_from_invoice boolean
)
language plpgsql
stable
set search_path to 'public'
as $function$
declare v_heads numeric;
begin
  select coalesce(sum(coalesce(actual_headcount, expected_headcount, 0)), 0)
  into v_heads
  from public.menu_plans
  where canteen_id = p_canteen_id
    and menu_date >= greatest(current_date - p_days, date '2026-08-19')
    and menu_date <= current_date;

  return query
  with used as (
    select l.ingredient_id, -sum(l.change_qty) as qty,
           count(distinct coalesce(l.service_date, l.created_at::date)) as days
    from public.stock_ledger l
    where l.canteen_id = p_canteen_id
      and l.reference_type in ('issue','recipe')
      and l.change_qty < 0
      and coalesce(l.service_date, l.created_at::date) >= greatest(current_date - p_days, date '2026-08-19')
    group by l.ingredient_id
  )
  select r.ingredient_id, r.name, coalesce(r.category, 'Other'), r.unit,
         case when v_heads > 0 then round(u.qty / v_heads, 4) end,
         case when v_heads > 0 and p_headcount > 0 then round(u.qty / v_heads * p_headcount, 2) end,
         r.current_stock,
         case when v_heads > 0 and p_headcount > 0 then greatest(round(u.qty / v_heads * p_headcount, 2) - r.current_stock, 0) end,
         r.latest_rate,
         case when v_heads > 0 and p_headcount > 0 then round(u.qty / v_heads * p_headcount * r.latest_rate, 2) end,
         coalesce(u.days, 0)::int,
         r.rate_from_invoice
  from public.ingredient_rates r
  join used u on u.ingredient_id = r.ingredient_id
  where r.canteen_id = p_canteen_id
  order by 10 desc nulls last, r.name;
end;
$function$;

comment on function public.suggest_requisition(uuid, integer, integer) is
  'Chef suggestion history starts at the 19 Aug 2026 production cutover; trial usage is retained only for audit.';
