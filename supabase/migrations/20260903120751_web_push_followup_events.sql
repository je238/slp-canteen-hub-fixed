-- Batch operational alerts: one issue/return summary per requisition per transaction,
-- not one phone sound for every ingredient row. Actual stock operations are unchanged.
create function public.notify_partial_issue_push()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r public.requisitions;
begin
 if coalesce(new.issued_qty,0)<=coalesce(old.issued_qty,0) then return new; end if;
 select * into r from public.requisitions where id=new.requisition_id;
 -- The existing requisition status trigger already notifies Chef when fully issued.
 if r.status<>'issued' and r.requested_by is not null and not exists(
   select 1 from public.notifications where ref_type='partial_issue_push'
   and ref_id=r.id and created_at=transaction_timestamp()
 ) then
   insert into public.notifications(canteen_id,target_user,title,body,link,ref_type,ref_id)
   values(r.canteen_id,r.requested_by,'Saman issue hua · REQ-'||r.req_no,
    'Kuch saman issue hua hai. Kitna mila aur kitna baaki hai, order mein dekhein.',
    '/requisitions','partial_issue_push',r.id);
 end if;
 if not exists(select 1 from public.notifications where ref_type='manager_issue_push'
   and ref_id=r.id and created_at=transaction_timestamp()) then
   insert into public.notifications(canteen_id,target_user,title,body,link,ref_type,ref_id)
   select r.canteen_id,ur.user_id,'Kitchen ko saman issue hua · REQ-'||r.req_no,
     'Store Keeper ne actual quantity confirm ki. Order mein details dekhein.',
     '/requisitions','manager_issue_push',r.id
   from public.user_roles ur where ur.role in ('manager','unit_manager','ops_manager')
   and (ur.canteen_id=r.canteen_id or exists(select 1 from public.user_sites us
     where us.user_id=ur.user_id and us.canteen_id=r.canteen_id));
 end if;
 return new;
end; $$;
revoke all on function public.notify_partial_issue_push() from public,anon,authenticated;
create constraint trigger partial_issue_phone_alert
 after update on public.requisition_items deferrable initially deferred
 for each row execute function public.notify_partial_issue_push();

create function public.notify_accepted_return_push()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if new.status='accepted' and old.status is distinct from new.status
 and new.returned_by is not null and not exists(
   select 1 from public.notifications where ref_type='accepted_return_push'
   and ref_id=new.requisition_id and target_user=new.returned_by and created_at=transaction_timestamp()
 ) then
   insert into public.notifications(canteen_id,target_user,title,body,link,ref_type,ref_id)
   values(new.canteen_id,new.returned_by,'Wapas bheja saman Store Keeper ne le liya',
     'Return accept ho gaya. Order mein accepted return ki quantity dekhein.',
     '/requisitions','accepted_return_push',new.requisition_id);
 end if;
 return new;
end; $$;
revoke all on function public.notify_accepted_return_push() from public,anon,authenticated;
create trigger accepted_return_phone_alert after update on public.kitchen_returns
 for each row execute function public.notify_accepted_return_push();
