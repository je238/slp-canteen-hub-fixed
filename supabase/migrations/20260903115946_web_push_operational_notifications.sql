-- Browser/Home Screen Web Push. No stock, prices or historical orders change.
-- Outbox secrets and subscription keys are never readable by another user.
create table public.web_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index web_push_subscriptions_user_idx on public.web_push_subscriptions(user_id);
alter table public.web_push_subscriptions enable row level security;
revoke all on public.web_push_subscriptions from anon, authenticated;
grant select on public.web_push_subscriptions to authenticated;
grant all on public.web_push_subscriptions to service_role;
create policy push_own_select on public.web_push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

create table public.web_push_jobs (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  subscription_id uuid not null references public.web_push_subscriptions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  dispatch_token text not null default (gen_random_uuid()::text || gen_random_uuid()::text),
  state text not null default 'pending' check (state in ('pending','dispatched','sending','sent','failed','cancelled')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text,
  unique(notification_id, subscription_id)
);
create index web_push_jobs_due_idx on public.web_push_jobs(next_attempt_at)
  where state in ('pending','dispatched','sending');
create index web_push_jobs_subscription_idx on public.web_push_jobs(subscription_id);
create index web_push_jobs_user_idx on public.web_push_jobs(user_id);
alter table public.web_push_jobs enable row level security;
revoke all on public.web_push_jobs from public, anon, authenticated;
grant all on public.web_push_jobs to service_role;

-- Fixed trusted destinations only: never turn the sender into an arbitrary HTTP proxy.
create function public.valid_web_push_endpoint(p_endpoint text)
returns boolean language sql immutable set search_path = '' as $$
 select length(p_endpoint) between 30 and 4096 and
 p_endpoint ~ '^https://(fcm[.]googleapis[.]com|([a-z0-9-]+[.])*push[.]services[.]mozilla[.]com|web[.]push[.]apple[.]com)/[^[:space:]#]+$';
$$;

create function public.save_web_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_id uuid;
begin
 if v_uid is null or not exists (
   select 1 from public.user_roles where user_id=v_uid and role in
   ('chef','cashier','store_keeper','manager','unit_manager','ops_manager','admin','super_admin','owner')
 ) then raise exception 'Sign in with a staff account first'; end if;
 if not public.valid_web_push_endpoint(p_endpoint)
    or p_p256dh !~ '^[A-Za-z0-9_-]{87}=?$'
    or p_auth !~ '^[A-Za-z0-9_-]{22}={0,2}$' then
   raise exception 'Invalid browser subscription';
 end if;
 -- Serialize a shared browser endpoint and a user's device limit.
 perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
 perform pg_advisory_xact_lock(hashtextextended(p_endpoint, 1));
 if not exists(select 1 from public.web_push_subscriptions where endpoint=p_endpoint and user_id=v_uid)
 and (select count(*) from public.web_push_subscriptions where user_id=v_uid) >= 10 then
   raise exception '10 devices already enabled. Disable notifications on an old device first.';
 end if;
 -- Changing accounts cannot retain queued messages for the previous account.
 delete from public.web_push_subscriptions where endpoint=p_endpoint and user_id<>v_uid;
 insert into public.web_push_subscriptions(user_id,endpoint,p256dh,auth_key)
 values(v_uid,p_endpoint,p_p256dh,p_auth)
 on conflict(endpoint) do update set p256dh=excluded.p256dh, auth_key=excluded.auth_key, updated_at=now()
 returning id into v_id;
 return v_id;
end; $$;
revoke all on function public.save_web_push_subscription(text,text,text) from public, anon;
grant execute on function public.save_web_push_subscription(text,text,text) to authenticated;

create function public.remove_web_push_subscription(p_endpoint text)
returns void language sql security definer set search_path = '' as $$
 delete from public.web_push_subscriptions where endpoint=p_endpoint and user_id=auth.uid();
$$;
revoke all on function public.remove_web_push_subscription(text) from public, anon;
grant execute on function public.remove_web_push_subscription(text) to authenticated;

-- Same role/site addressing as the notification bell, rechecked at delivery.
create function public.web_push_recipient(p_user uuid, p_notification uuid)
returns boolean language sql stable security definer set search_path = '' as $$
 select exists (
  select 1 from public.notifications n
  join public.user_roles ur on ur.user_id=p_user
  join auth.users u on u.id=ur.user_id
  where n.id=p_notification and (u.banned_until is null or u.banned_until<=now())
  and ur.role in ('chef','cashier','store_keeper','manager','unit_manager','ops_manager','admin','super_admin','owner')
  and (n.canteen_id is null or ur.role in ('admin','super_admin','owner')
       or ur.canteen_id=n.canteen_id or exists(
         select 1 from public.user_sites us where us.user_id=p_user and us.canteen_id=n.canteen_id))
  and (n.target_user=p_user or n.target_role=ur.role
       or (n.target_role='admin' and ur.role in ('admin','super_admin','owner'))
       or (n.target_role='manager' and ur.role in ('manager','unit_manager','ops_manager','admin','super_admin','owner')))
 );
$$;
revoke all on function public.web_push_recipient(uuid,uuid) from public, anon, authenticated;
grant execute on function public.web_push_recipient(uuid,uuid) to service_role;

-- VAPID private key stays in Vault, accessible only inside the Edge Function.
create function public.web_push_keys(p_candidate jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_keys jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('slp-web-push-vapid',0));
 select decrypted_secret::jsonb into v_keys from vault.decrypted_secrets where name='slp_web_push_vapid' limit 1;
 if v_keys is null and p_candidate is not null then
   if p_candidate->>'publicKey' !~ '^[A-Za-z0-9_-]{87}$'
      or p_candidate->>'privateKey' !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'Invalid VAPID keys'; end if;
   perform vault.create_secret(p_candidate::text,'slp_web_push_vapid','Web Push signing keys - do not rotate without resubscribing devices');
   v_keys := p_candidate;
 end if;
 return v_keys;
end; $$;
revoke all on function public.web_push_keys(jsonb) from public, anon, authenticated;
grant execute on function public.web_push_keys(jsonb) to service_role;

-- Every dispatch has an unguessable per-job webhook credential, not a public sender.
create function public.dispatch_web_push_jobs()
returns int language plpgsql security definer set search_path = '' as $$
declare j record; v_count int := 0;
begin
 update public.web_push_jobs set state='failed',last_error='Delivery expired or retry limit reached'
 where state in ('pending','dispatched','sending') and next_attempt_at<=now()
 and (attempts>=5 or created_at<now()-interval '24 hours');
 for j in select * from public.web_push_jobs
   where state in ('pending','dispatched','sending') and next_attempt_at<=now()
   and attempts<5 and created_at>=now()-interval '24 hours'
   order by next_attempt_at limit 50 for update skip locked
 loop
   begin
     update public.web_push_jobs set state='dispatched', attempts=attempts+1,
       next_attempt_at=now()+interval '2 minutes' * greatest(1,attempts+1) where id=j.id;
     perform net.http_post(
       url := 'https://djexqeisvrybemkftbxm.supabase.co/functions/v1/web-push',
       headers := '{"Content-Type":"application/json"}'::jsonb,
       body := jsonb_build_object('job_id',j.id,'token',j.dispatch_token),
       timeout_milliseconds := 10000
     );
     v_count := v_count+1;
   exception when others then
     update public.web_push_jobs set state='pending', attempts=attempts+1,
       next_attempt_at=now()+interval '2 minutes',last_error='Dispatch temporarily unavailable' where id=j.id;
   end;
 end loop;
 -- Retain bounded delivery diagnostics, not a second permanent audit history.
 delete from public.web_push_jobs where created_at<now()-interval '30 days';
 return v_count;
end; $$;
revoke all on function public.dispatch_web_push_jobs() from public, anon, authenticated;
grant execute on function public.dispatch_web_push_jobs() to service_role;

create function public.enqueue_web_push()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 insert into public.web_push_jobs(notification_id,subscription_id,user_id)
 select new.id,s.id,s.user_id from public.web_push_subscriptions s
 where public.web_push_recipient(s.user_id,new.id)
 on conflict do nothing;
 perform public.dispatch_web_push_jobs();
 return new;
end; $$;
revoke all on function public.enqueue_web_push() from public, anon, authenticated;
create trigger notifications_web_push after insert on public.notifications
 for each row execute function public.enqueue_web_push();

create function public.claim_web_push_job(p_job uuid,p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.web_push_jobs; s public.web_push_subscriptions; n public.notifications;
begin
 select * into j from public.web_push_jobs where id=p_job and dispatch_token=p_token
   and state='dispatched' and created_at>now()-interval '24 hours' for update;
 if not found then return null; end if;
 select * into s from public.web_push_subscriptions where id=j.subscription_id and user_id=j.user_id;
 if not found or not public.web_push_recipient(j.user_id,j.notification_id) then
   update public.web_push_jobs set state='cancelled' where id=j.id; return null;
 end if;
 select * into n from public.notifications where id=j.notification_id;
 update public.web_push_jobs set state='sending' where id=j.id;
 return jsonb_build_object(
   'notification',jsonb_build_object('id',n.id,'title',n.title,'body',n.body,'link',n.link),
   'subscription',jsonb_build_object('endpoint',s.endpoint,'keys',jsonb_build_object('p256dh',s.p256dh,'auth',s.auth_key)),
   'subscription_id',s.id,'user_id',s.user_id);
end; $$;
revoke all on function public.claim_web_push_job(uuid,text) from public, anon, authenticated;
grant execute on function public.claim_web_push_job(uuid,text) to service_role;

-- Permission/test action only sends to the signed-in user; never arbitrary recipients.
create function public.test_my_web_push()
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
 if auth.uid() is null or not exists(select 1 from public.web_push_subscriptions where user_id=auth.uid())
 then raise exception 'Enable phone notifications first'; end if;
 if exists(select 1 from public.notifications where target_user=auth.uid()
   and ref_type='push_test' and created_at>now()-interval '1 minute')
 then raise exception 'Please wait one minute before another test'; end if;
 insert into public.notifications(target_user,title,body,link,ref_type)
 values(auth.uid(),'SLP notification test','Test alert. Phone sound/silent settings check kar lein.','/dashboard','push_test')
 returning id into v_id;
 return v_id;
end; $$;
revoke all on function public.test_my_web_push() from public, anon;
grant execute on function public.test_my_web_push() to authenticated;

-- Preserve existing Admin/Chef messages and add the missing operational recipients.
create function public.notify_requisition_operations()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_site text;
begin
 select name into v_site from public.canteens where id=new.canteen_id;
 if tg_op='INSERT' then
   insert into public.notifications(canteen_id,target_role,title,body,link,ref_type,ref_id)
   values(new.canteen_id,'manager','Naya order REQ-'||new.req_no,
     coalesce(v_site,'Site')||' · '||coalesce(new.meal_period,'Meal')||' — approval chahiye.',
     '/requisitions','requisition',new.id);
 elsif new.status is distinct from old.status and new.status='approved' then
   insert into public.notifications(canteen_id,target_role,title,body,link,ref_type,ref_id)
   values(new.canteen_id,'store_keeper','Order approved REQ-'||new.req_no,
     coalesce(v_site,'Site')||' · '||coalesce(new.meal_period,'Meal')||' — actual quantity confirm karke issue karein.',
     '/requisitions','requisition',new.id);
 end if;
 return new;
end; $$;
revoke all on function public.notify_requisition_operations() from public, anon, authenticated;
create trigger requisition_operations_push after insert or update on public.requisitions
 for each row execute function public.notify_requisition_operations();

select cron.schedule('slp-web-push-retry','* * * * *','select public.dispatch_web_push_jobs()');
