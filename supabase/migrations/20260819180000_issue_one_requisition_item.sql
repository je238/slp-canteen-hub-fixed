-- The short pending-items list has one button per row. That button must move
-- only that row; the separate order-level button continues to issue every
-- available row through issue_requisition().
create or replace function public.issue_requisition_item(p_requisition_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_req_id uuid;
  v_req public.requisitions%rowtype;
  v_line record;
  v_service_date date;
  v_approved numeric;
  v_previously_issued numeric;
  v_remaining numeric;
  v_issue_now numeric;
  v_stock_after numeric;
  v_cost numeric;
  v_pending_lines integer;
begin
  if p_requisition_item_id is null then
    raise exception 'Item is required';
  end if;

  select ri.requisition_id into v_req_id
  from public.requisition_items ri
  where ri.id = p_requisition_item_id;

  if v_req_id is null then
    raise exception 'Requisition item not found';
  end if;

  select r.* into v_req
  from public.requisitions r
  where r.id = v_req_id
  for update;

  if not public.can_issue_stock() then
    raise exception 'Only the store keeper can issue stock';
  end if;
  if not public.can_access_canteen(v_req.canteen_id) then
    raise exception 'You do not have access to this site';
  end if;
  if v_req.status not in ('approved','issued') then
    raise exception 'Only an approved requisition can be issued (current status: %)', v_req.status;
  end if;

  select ri.id as requisition_item_id, ri.ingredient_id, ri.approved_qty,
         ri.issued_qty, ri.issued_value, ri.unit, i.name ingredient_name,
         i.current_stock
  into v_line
  from public.requisition_items ri
  join public.ingredients i on i.id = ri.ingredient_id
  where ri.id = p_requisition_item_id and ri.requisition_id = v_req.id
  for update of ri, i;

  if v_line.requisition_item_id is null then
    raise exception 'Requisition item not found';
  end if;

  v_approved := greatest(coalesce(v_line.approved_qty, 0), 0);
  v_previously_issued := greatest(coalesce(v_line.issued_qty, 0), 0);
  v_remaining := greatest(v_approved - v_previously_issued, 0);

  if v_remaining = 0 then
    return jsonb_build_object(
      'already', true, 'item', v_line.ingredient_name,
      'issued_now', 0, 'pending_qty', 0
    );
  end if;

  v_issue_now := least(v_remaining, greatest(v_line.current_stock, 0));
  if v_issue_now = 0 then
    return jsonb_build_object(
      'already', false, 'item', v_line.ingredient_name,
      'issued_now', 0, 'pending_qty', v_remaining, 'status', 'pending_stock'
    );
  end if;

  perform public.allow_stock_move();

  select m.menu_date into v_service_date
  from public.menu_plans m where m.id = v_req.menu_plan_id;
  v_service_date := coalesce(v_service_date, v_req.req_date,
    (now() at time zone 'Asia/Kolkata')::date);

  update public.ingredients i
  set current_stock = i.current_stock - v_issue_now
  where i.id = v_line.ingredient_id
    and i.canteen_id = v_req.canteen_id
    and i.current_stock >= v_issue_now
  returning i.current_stock into v_stock_after;

  if not found then
    raise exception 'Stock changed while issuing %. Please try again.', v_line.ingredient_name;
  end if;

  v_cost := public.consume_batches_fifo(
    v_line.ingredient_id, v_req.canteen_id, v_issue_now
  );

  update public.requisition_items ri
  set issued_qty = v_previously_issued + v_issue_now,
      issued_value = round(coalesce(v_line.issued_value, 0) + v_cost, 2)
  where ri.id = v_line.requisition_item_id;

  insert into public.stock_ledger(
    ingredient_id, canteen_id, change_qty, balance_after, reason,
    reference_type, reference_id, created_by, service_date, value
  ) values (
    v_line.ingredient_id, v_req.canteen_id, -v_issue_now, v_stock_after,
    format('Requisition #%s item issue: %s %s issued, %s %s pending',
      v_req.req_no, v_issue_now, coalesce(v_line.unit,''),
      greatest(v_remaining-v_issue_now,0), coalesce(v_line.unit,'')),
    'issue', v_req.id, auth.uid(), v_service_date, round(v_cost,2)
  );

  select count(*) into v_pending_lines
  from public.requisition_items ri
  where ri.requisition_id = v_req.id
    and greatest(coalesce(ri.approved_qty,0)-coalesce(ri.issued_qty,0),0)>0;

  if v_pending_lines = 0 then
    update public.requisitions
    set status='issued', issued_by=auth.uid(), issued_at=now()
    where id=v_req.id;
  end if;

  return jsonb_build_object(
    'already', false, 'item', v_line.ingredient_name,
    'issued_now', v_issue_now,
    'issued_total_qty', v_previously_issued+v_issue_now,
    'pending_qty', greatest(v_remaining-v_issue_now,0),
    'pending_lines', v_pending_lines,
    'status', case when v_pending_lines=0 then 'issued' else 'partially_issued' end
  );
end;
$function$;

revoke all on function public.issue_requisition_item(uuid) from public;
revoke all on function public.issue_requisition_item(uuid) from anon;
grant execute on function public.issue_requisition_item(uuid) to authenticated;
