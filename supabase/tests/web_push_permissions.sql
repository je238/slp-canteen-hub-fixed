begin;
do $$
declare
  chef_id uuid; store_id uuid; site_id uuid; n uuid; s uuid; j uuid; token text; result jsonb;
  endpoint text := 'https://fcm.googleapis.com/slp-rollback-test-'||gen_random_uuid();
  counted int;
begin
 select user_id,canteen_id into chef_id,site_id from public.user_roles where role='chef' and canteen_id is not null limit 1;
 select user_id into store_id from public.user_roles where role='store_keeper' and canteen_id=site_id limit 1;
 if chef_id is null or store_id is null then raise exception 'Missing test roles'; end if;
 if has_table_privilege('anon','public.web_push_jobs','select')
 or has_table_privilege('authenticated','public.web_push_jobs','select')
 or has_function_privilege('authenticated','public.web_push_keys(jsonb)','execute')
 or has_function_privilege('anon','public.save_web_push_subscription(text,text,text)','execute')
 then raise exception 'Push secrets accessible to client'; end if;
 if public.valid_web_push_endpoint('https://fcm.googleapis.com.evil.example/x')
 or public.valid_web_push_endpoint('https://localhost/test')
 or public.valid_web_push_endpoint('http://fcm.googleapis.com/x')
 then raise exception 'Untrusted endpoint allowed'; end if;
 perform set_config('request.jwt.claim.sub',chef_id::text,true);
 s:=public.save_web_push_subscription(endpoint,repeat('A',87),repeat('B',22));
 insert into public.notifications(canteen_id,target_role,title,link)
 values(site_id,'chef','ROLLBACK ONLY push validation','/requisitions') returning id into n;
 if not public.web_push_recipient(chef_id,n) or public.web_push_recipient(store_id,n)
 then raise exception 'Role isolation failed'; end if;
 select id,dispatch_token into j,token from public.web_push_jobs where notification_id=n and subscription_id=s;
 if j is null then raise exception 'Notification not enqueued'; end if;
 if public.claim_web_push_job(j,'wrong-token') is not null then raise exception 'Webhook authentication failed'; end if;
 result:=public.claim_web_push_job(j,token);
 if result is null or result->'notification'->>'title'<>'ROLLBACK ONLY push validation'
 then raise exception 'Authenticated claim failed'; end if;
 if public.claim_web_push_job(j,token) is not null then raise exception 'Duplicate claim allowed'; end if;
 execute 'set local role authenticated';
 select count(*) into counted from public.web_push_subscriptions where id=s;
 if counted<>1 then raise exception 'Own subscription RLS failed'; end if;
 perform set_config('request.jwt.claim.sub',store_id::text,true);
 select count(*) into counted from public.web_push_subscriptions where id=s;
 if counted<>0 then raise exception 'Other user subscription leaked'; end if;
 execute 'reset role';
 -- Shared device changes owner, dropping the previous user's queued messages.
 perform public.save_web_push_subscription(endpoint,repeat('A',87),repeat('B',22));
 if exists(select 1 from public.web_push_jobs where id=j)
 then raise exception 'Previous account retained queued push'; end if;
 if not exists(select 1 from public.web_push_subscriptions where user_id=store_id)
 then raise exception 'Shared device not reassigned'; end if;
end $$;
rollback;
