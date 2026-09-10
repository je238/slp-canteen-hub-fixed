-- Actual kitchen hand-over and historical consumption reconciliation.
--
-- 20-29 August was operated with the old one-click issue flow: the database
-- recorded everything available, even when the store physically handed over
-- less.  The physical shelf has since been counted, so historical repair must
-- correct consumption/cost only.  It must not move today's shelf again.

create table if not exists public.requisition_issue_reconciliations (
  id uuid primary key default gen_random_uuid(),
  requisition_item_id uuid not null unique references public.requisition_items(id) on delete restrict,
  requisition_id uuid not null references public.requisitions(id) on delete restrict,
  canteen_id uuid not null references public.canteens(id) on delete restrict,
  service_date date not null,
  recorded_qty numeric not null check (recorded_qty >= 0),
  actual_qty numeric not null check (actual_qty >= 0 and actual_qty <= recorded_qty),
  recorded_value numeric not null default 0 check (recorded_value >= 0),
  actual_value numeric not null default 0 check (actual_value >= 0),
  reason text,
  status text not null default 'pending' check (status in ('pending','verified','rejected')),
  submitted_by uuid not null references auth.users(id),
  submitted_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_reason text,
  constraint issue_reconciliation_difference_reason check (
    abs(actual_qty-recorded_qty) < 0.000000001 or length(btrim(coalesce(reason,''))) >= 3
  )
);

create index if not exists idx_issue_reconciliation_site_date_status
  on public.requisition_issue_reconciliations(canteen_id,service_date,status);
create index if not exists idx_issue_reconciliation_requisition
  on public.requisition_issue_reconciliations(requisition_id,status);

alter table public.requisition_issue_reconciliations enable row level security;
revoke all on table public.requisition_issue_reconciliations from public, anon;
grant select on table public.requisition_issue_reconciliations to authenticated;

drop policy if exists "issue_reconciliation_internal_select" on public.requisition_issue_reconciliations;
create policy "issue_reconciliation_internal_select"
  on public.requisition_issue_reconciliations for select to authenticated
  using (public.can_issue_stock() and public.can_access_canteen(canteen_id));

create or replace function public.historical_issue_reconciliation_lines(
  p_canteen_id uuid, p_date date
) returns table(
  requisition_id uuid, req_no bigint, meal_period text, service_date date,
  requisition_item_id uuid, ingredient_id uuid, item_name text, unit text,
  requested_qty numeric, approved_qty numeric, recorded_qty numeric,
  recorded_value numeric, actual_qty numeric, actual_value numeric,
  reconciliation_status text, reason text, submitted_by uuid, submitted_at timestamptz,
  reviewed_by uuid, reviewed_at timestamptz, review_reason text
) language sql stable security definer set search_path=public as $$
  select r.id,r.req_no,coalesce(m.meal_period,r.meal_period,'extra'),
         coalesce(m.menu_date,r.req_date,(r.created_at at time zone 'Asia/Kolkata')::date),
         ri.id,ri.ingredient_id,i.name,coalesce(ri.unit,i.unit),
         coalesce(ri.requested_qty,0),coalesce(ri.approved_qty,0),coalesce(ri.issued_qty,0),
         coalesce(ri.issued_value,0),x.actual_qty,x.actual_value,x.status,x.reason,
         x.submitted_by,x.submitted_at,x.reviewed_by,x.reviewed_at,x.review_reason
    from public.requisitions r
    left join public.menu_plans m on m.id=r.menu_plan_id
    join public.requisition_items ri on ri.requisition_id=r.id
    join public.ingredients i on i.id=ri.ingredient_id
    left join public.requisition_issue_reconciliations x on x.requisition_item_id=ri.id
   where r.canteen_id=p_canteen_id
     and public.can_issue_stock()
     and public.can_access_canteen(p_canteen_id)
     and coalesce(m.menu_date,r.req_date,(r.created_at at time zone 'Asia/Kolkata')::date)=p_date
     and coalesce(ri.issued_qty,0)>0
   order by case coalesce(m.meal_period,r.meal_period,'extra')
              when 'breakfast' then 1 when 'lunch' then 2 when 'evening_snacks' then 3
              when 'dinner' then 4 when 'night_snacks' then 5 else 6 end,
            r.req_no,i.name;
$$;
revoke all on function public.historical_issue_reconciliation_lines(uuid,date) from public,anon;
grant execute on function public.historical_issue_reconciliation_lines(uuid,date) to authenticated;

create or replace function public.submit_issue_reconciliation(
  p_requisition_id uuid, p_items jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_req public.requisitions%rowtype;
  v_service_date date;
  v_expected int;
  v_received int;
  v_line record;
  v_actual numeric;
  v_reason text;
  v_returned numeric;
  v_actual_value numeric;
begin
  select * into v_req from public.requisitions where id=p_requisition_id for update;
  if not found then raise exception 'Order nahi mila'; end if;
  select coalesce(m.menu_date,v_req.req_date,(v_req.created_at at time zone 'Asia/Kolkata')::date)
    into v_service_date from public.menu_plans m where m.id=v_req.menu_plan_id;
  v_service_date:=coalesce(v_service_date,v_req.req_date,
    (v_req.created_at at time zone 'Asia/Kolkata')::date);
  if not (public.can_issue_stock() and public.can_access_canteen(v_req.canteen_id)) then
    raise exception 'Sirf Store Keeper ya Manager actual issue check kar sakta hai';
  end if;
  if v_service_date < date '2026-08-20' or v_service_date > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'Actual issue check 20 August se aaj tak ke liye hai';
  end if;
  if jsonb_typeof(p_items)<>'array' then raise exception 'Items required'; end if;

  select count(*) into v_expected from public.requisition_items
   where requisition_id=p_requisition_id and coalesce(issued_qty,0)>0;
  select count(*),count(distinct (e->>'requisition_item_id'))
    into v_received,v_expected
    from jsonb_array_elements(p_items) e;
  if v_received=0 or v_received<>v_expected then
    raise exception 'Is order ki har issued item ki actual quantity bharein';
  end if;
  select count(*) into v_expected from public.requisition_items
   where requisition_id=p_requisition_id and coalesce(issued_qty,0)>0;
  if v_received<>v_expected then
    raise exception 'Is order ki sab % issued lines bhejein (mili %)',v_expected,v_received;
  end if;

  if exists(select 1 from public.requisition_issue_reconciliations
             where requisition_id=p_requisition_id and status='verified') then
    raise exception 'Manager is order ka actual issue verify kar chuka hai';
  end if;

  for v_line in
    select ri.id,ri.ingredient_id,coalesce(ri.issued_qty,0) recorded_qty,
           coalesce(ri.issued_value,0) recorded_value,i.name,
           e.value payload
      from jsonb_array_elements(p_items) e
      join public.requisition_items ri on ri.id=(e->>'requisition_item_id')::uuid
      join public.ingredients i on i.id=ri.ingredient_id
     where ri.requisition_id=p_requisition_id and coalesce(ri.issued_qty,0)>0
     order by ri.id
  loop
    v_actual := (v_line.payload->>'actual_qty')::numeric;
    v_reason := nullif(btrim(v_line.payload->>'reason'),'');
    if v_actual is null or v_actual<0 or v_actual>v_line.recorded_qty then
      raise exception '% actual quantity 0 aur recorded % ke beech honi chahiye',v_line.name,v_line.recorded_qty;
    end if;
    select coalesce(sum(qty),0) into v_returned from public.kitchen_returns
     where requisition_id=p_requisition_id and ingredient_id=v_line.ingredient_id and status='accepted';
    if v_actual<v_returned then
      raise exception '% ka actual issue accepted return % se kam nahi ho sakta',v_line.name,v_returned;
    end if;
    if abs(v_actual-v_line.recorded_qty)>0.000000001 and length(btrim(coalesce(v_reason,'')))<3 then
      raise exception '% kam/zyada hone ka internal reason likhein',v_line.name;
    end if;
    v_actual_value := case when v_line.recorded_qty>0
      then round(v_line.recorded_value*v_actual/v_line.recorded_qty,2) else 0 end;

    insert into public.requisition_issue_reconciliations(
      requisition_item_id,requisition_id,canteen_id,service_date,
      recorded_qty,actual_qty,recorded_value,actual_value,reason,status,submitted_by,submitted_at,
      reviewed_by,reviewed_at,review_reason
    ) values(
      v_line.id,p_requisition_id,v_req.canteen_id,v_service_date,
      v_line.recorded_qty,v_actual,v_line.recorded_value,v_actual_value,v_reason,'pending',auth.uid(),now(),
      null,null,null
    ) on conflict(requisition_item_id) do update set
      recorded_qty=excluded.recorded_qty,actual_qty=excluded.actual_qty,
      recorded_value=excluded.recorded_value,actual_value=excluded.actual_value,
      reason=excluded.reason,status='pending',submitted_by=auth.uid(),submitted_at=now(),
      reviewed_by=null,reviewed_at=null,review_reason=null;
  end loop;

  insert into public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
  values(auth.uid(),'historical_issue_submitted','requisition',p_requisition_id,v_req.canteen_id,
    jsonb_build_object('service_date',v_service_date,'lines',v_received,'stock_moved',false));
  return jsonb_build_object('submitted',true,'lines',v_received,'service_date',v_service_date);
end;
$$;
revoke all on function public.submit_issue_reconciliation(uuid,jsonb) from public,anon;
grant execute on function public.submit_issue_reconciliation(uuid,jsonb) to authenticated;

create or replace function public.review_issue_reconciliation(
  p_requisition_id uuid, p_approve boolean, p_reason text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_req public.requisitions%rowtype; v_submitter uuid; v_lines int; v_difference numeric;
begin
  select * into v_req from public.requisitions where id=p_requisition_id for update;
  if not found then raise exception 'Order nahi mila'; end if;
  if not (public.is_manager_or_above() and public.can_access_canteen(v_req.canteen_id)) then
    raise exception 'Sirf Manager actual issue verify kar sakta hai';
  end if;
  select count(*),sum(recorded_value-actual_value)
    into v_lines,v_difference
    from public.requisition_issue_reconciliations
   where requisition_id=p_requisition_id and status='pending';
  if v_lines=0 then raise exception 'Verification ke liye kuch pending nahi hai'; end if;
  select submitted_by into v_submitter
    from public.requisition_issue_reconciliations
   where requisition_id=p_requisition_id and status='pending' limit 1;
  if v_submitter=auth.uid() and not public.is_super_admin() then
    raise exception 'Actual quantity submit karne wala apni entry verify nahi kar sakta';
  end if;
  if not p_approve and length(btrim(coalesce(p_reason,'')))<3 then
    raise exception 'Reject karne ka reason likhein';
  end if;
  update public.requisition_issue_reconciliations
     set status=case when p_approve then 'verified' else 'rejected' end,
         reviewed_by=auth.uid(),reviewed_at=now(),review_reason=nullif(btrim(p_reason),'')
   where requisition_id=p_requisition_id and status='pending';
  insert into public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
  values(auth.uid(),case when p_approve then 'historical_issue_verified' else 'historical_issue_rejected' end,
    'requisition',p_requisition_id,v_req.canteen_id,
    jsonb_build_object('lines',v_lines,'consumption_value_reduced',round(coalesce(v_difference,0),2),'reason',p_reason,'stock_moved',false));
  return jsonb_build_object('approved',p_approve,'lines',v_lines,
                            'consumption_value_reduced',round(coalesce(v_difference,0),2));
end;
$$;
revoke all on function public.review_issue_reconciliation(uuid,boolean,text) from public,anon;
grant execute on function public.review_issue_reconciliation(uuid,boolean,text) to authenticated;

-- Reports use the verified actual hand-over difference, but the shelf is not
-- touched: the Store Keeper has already entered a fresh physical count.
create or replace function public.net_consumption_lines(
  p_canteen_id uuid,p_start date,p_end date
) returns table(
  ingredient_id uuid,item_name text,unit text,service_date date,qty numeric,value numeric
) language sql stable security definer set search_path=public as $$
  select l.ingredient_id,i.name,i.unit,
         case when l.reference_type='return'
              then coalesce(l.service_date,m.menu_date,r.req_date,(l.created_at at time zone 'Asia/Kolkata')::date)
              else coalesce(l.service_date,(l.created_at at time zone 'Asia/Kolkata')::date) end,
         -l.change_qty,
         case when l.reference_type in ('issue','recipe') and l.change_qty<0
                then abs(coalesce(l.value,-l.change_qty*coalesce(i.cost_per_unit,0)))
              when l.reference_type='return' and l.change_qty>0
                then -abs(coalesce(l.value,l.change_qty*coalesce(ic.unit_cost,i.cost_per_unit,0)))
              else 0 end
    from public.stock_ledger l
    join public.ingredients i on i.id=l.ingredient_id
    left join public.requisitions r on r.id=l.reference_id and l.reference_type='return'
    left join public.menu_plans m on m.id=r.menu_plan_id
    left join lateral(
      select sum(abs(coalesce(x.value,0)))/nullif(sum(-x.change_qty),0) unit_cost
        from public.stock_ledger x where x.reference_id=l.reference_id and x.ingredient_id=l.ingredient_id
         and x.reference_type in ('issue','recipe') and x.change_qty<0
    ) ic on true
   where l.canteen_id=p_canteen_id and public.can_access_canteen(p_canteen_id)
     and ((l.reference_type in ('issue','recipe') and l.change_qty<0)
       or (l.reference_type='return' and l.change_qty>0))
     and (case when l.reference_type='return'
               then coalesce(l.service_date,m.menu_date,r.req_date,(l.created_at at time zone 'Asia/Kolkata')::date)
               else coalesce(l.service_date,(l.created_at at time zone 'Asia/Kolkata')::date) end)
         between p_start and p_end
  union all
  select xri.ingredient_id,i.name,i.unit,x.service_date,
         x.actual_qty-x.recorded_qty,x.actual_value-x.recorded_value
    from public.requisition_issue_reconciliations x
    join public.requisition_items xri on xri.id=x.requisition_item_id
    join public.ingredients i on i.id=xri.ingredient_id
   where x.canteen_id=p_canteen_id and public.can_access_canteen(p_canteen_id)
     and x.status='verified' and x.service_date between p_start and p_end;
$$;
revoke all on function public.net_consumption_lines(uuid,date,date) from public,anon;
grant execute on function public.net_consumption_lines(uuid,date,date) to authenticated;

-- New operational path: the Store Keeper explicitly sends the quantity that
-- physically left the counter.  Unlisted or zero lines do not move.
create or replace function public.issue_requisition_actual(
  p_req_id uuid,p_items jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_req public.requisitions%rowtype; v_line record; v_qty numeric; v_reason text;
  v_pending numeric; v_new numeric; v_cost numeric; v_service_date date;
  v_issued_lines int:=0; v_pending_lines int; v_total numeric:=0;
begin
  select * into v_req from public.requisitions where id=p_req_id for update;
  if not found then raise exception 'Order nahi mila'; end if;
  if not (public.can_issue_stock() and public.can_access_canteen(v_req.canteen_id)) then
    raise exception 'Sirf Store Keeper ya Manager stock issue kar sakta hai';
  end if;
  if v_req.status not in ('approved','issued') then raise exception 'Approved order hi issue ho sakta hai'; end if;
  if jsonb_typeof(p_items)<>'array' then raise exception 'Actual quantities required'; end if;
  if (select count(*) from jsonb_array_elements(p_items)) <>
     (select count(distinct e->>'requisition_item_id') from jsonb_array_elements(p_items)e) then
    raise exception 'Same item do baar nahi bhej sakte';
  end if;
  select m.menu_date into v_service_date from public.menu_plans m where m.id=v_req.menu_plan_id;
  v_service_date:=coalesce(v_service_date,v_req.req_date,(now() at time zone 'Asia/Kolkata')::date);

  for v_line in
    select ri.id,ri.ingredient_id,i.name,i.unit,i.current_stock,
           greatest(coalesce(ri.approved_qty,0)-coalesce(ri.issued_qty,0),0) pending_qty,
           coalesce(ri.issued_qty,0) issued_before,coalesce(ri.issued_value,0) value_before,e.value payload
      from jsonb_array_elements(p_items)e
      join public.requisition_items ri on ri.id=(e->>'requisition_item_id')::uuid
      join public.ingredients i on i.id=ri.ingredient_id
     where ri.requisition_id=p_req_id
     order by ri.ingredient_id for update of ri,i
  loop
    v_qty:=coalesce((v_line.payload->>'actual_qty')::numeric,0);
    v_reason:=nullif(btrim(v_line.payload->>'reason'),'');
    v_pending:=v_line.pending_qty;
    if v_qty<0 or v_qty>v_pending then
      raise exception '% actual issue 0 aur pending % ke beech hona chahiye',v_line.name,v_pending;
    end if;
    if v_qty>v_line.current_stock then
      raise exception '% stock me sirf % % hai',v_line.name,v_line.current_stock,v_line.unit;
    end if;
    if v_qty+0.000000001<least(v_pending,v_line.current_stock)
       and length(btrim(coalesce(v_reason,'')))<3 then
      raise exception '% kam dene ka internal reason likhein',v_line.name;
    end if;
    if v_qty<=0 then continue; end if;

    perform public.allow_stock_move();
    update public.ingredients set current_stock=current_stock-v_qty
     where id=v_line.ingredient_id and canteen_id=v_req.canteen_id and current_stock>=v_qty
     returning current_stock into v_new;
    if not found then raise exception '% stock badal gaya; dobara try karein',v_line.name; end if;
    v_cost:=public.consume_batches_fifo(v_line.ingredient_id,v_req.canteen_id,v_qty);
    update public.requisition_items set issued_qty=v_line.issued_before+v_qty,
      issued_value=round(v_line.value_before+v_cost,2) where id=v_line.id;
    insert into public.stock_ledger(ingredient_id,canteen_id,change_qty,balance_after,reason,
      reference_type,reference_id,created_by,service_date,value)
    values(v_line.ingredient_id,v_req.canteen_id,-v_qty,v_new,
      format('REQ-%s actual hand-over: %s %s%s',v_req.req_no,v_qty,coalesce(v_line.unit,''),
        case when v_reason is not null then ' — internal: '||v_reason else '' end),
      'issue',v_req.id,auth.uid(),v_service_date,round(v_cost,2));
    v_issued_lines:=v_issued_lines+1; v_total:=v_total+v_cost;
  end loop;
  if v_issued_lines=0 then raise exception 'Kam se kam ek item ki actual quantity bharein'; end if;

  select count(*) into v_pending_lines from public.requisition_items
   where requisition_id=p_req_id and greatest(coalesce(approved_qty,0)-coalesce(issued_qty,0),0)>0;
  update public.requisitions set status=case when v_pending_lines=0 then 'issued' else 'approved' end,
    issued_by=auth.uid(),issued_at=now() where id=p_req_id;
  insert into public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
  values(auth.uid(),'actual_kitchen_issue','requisition',p_req_id,v_req.canteen_id,
    jsonb_build_object('issued_lines',v_issued_lines,'pending_lines',v_pending_lines,
                       'fifo_value',round(v_total,2),'service_date',v_service_date));
  return jsonb_build_object('issued_lines',v_issued_lines,'pending_lines',v_pending_lines,
    'status',case when v_pending_lines=0 then 'issued' else 'partially_issued' end,
    'fifo_value',round(v_total,2));
end;
$$;
revoke all on function public.issue_requisition_actual(uuid,jsonb) from public,anon;
grant execute on function public.issue_requisition_actual(uuid,jsonb) to authenticated;

-- Close every old automatic route at database level, not only in the screen.
create or replace function public.issue_requisition(p_req_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  raise exception 'Actual quantity bharkar issue karein';
end;
$$;
create or replace function public.issue_requisition_item(p_requisition_item_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  raise exception 'Actual quantity bharkar issue karein';
end;
$$;
revoke all on function public.issue_requisition(uuid) from public,anon;
revoke all on function public.issue_requisition_item(uuid) from public,anon;
grant execute on function public.issue_requisition(uuid) to authenticated;
grant execute on function public.issue_requisition_item(uuid) to authenticated;
