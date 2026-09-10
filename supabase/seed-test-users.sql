-- Test logins for all seven roles. Idempotent: re-running only fixes
-- passwords/roles, it never duplicates a user.
set search_path = public, extensions;

do $$
declare
  v_site   uuid;
  v_supp   uuid;
  v_pass   text := 'SlpTest@2026';
  v_uid    uuid;
  r        record;
begin
  -- site the staff roles belong to
  select id into v_site from canteens where name ilike '%sun pharma%' limit 1;
  if v_site is null then select id into v_site from canteens limit 1; end if;

  -- a supplier for the vendor login
  select id into v_supp from suppliers where name = 'Test Vendor Supplies' limit 1;
  if v_supp is null then
    insert into suppliers (name, contact_person, phone, canteen_id)
    values ('Test Vendor Supplies', 'Test Vendor', '9000000000', v_site)
    returning id into v_supp;
  end if;

  for r in
    select * from (values
      ('superadmin@slptest.com', 'super_admin',  false),
      ('admin@slptest.com',      'admin',        false),
      ('ops@slptest.com',        'ops_manager',  true ),
      ('manager@slptest.com',    'unit_manager', true ),
      ('chef@slptest.com',       'chef',         true ),
      ('store@slptest.com',      'store_keeper', true ),
      ('vendor@slptest.com',     'vendor',       false)
    ) as t(email, role, site_scoped)
  loop
    select id into v_uid from auth.users where email = r.email;

    if v_uid is null then
      v_uid := gen_random_uuid();
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data, is_super_admin
      ) values (
        '00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated',
        r.email, crypt(v_pass, gen_salt('bf')),
        now(), now(), now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('test_account', true), false
      );

      insert into auth.identities (
        id, user_id, identity_data, provider, provider_id,
        last_sign_in_at, created_at, updated_at
      ) values (
        gen_random_uuid(), v_uid,
        jsonb_build_object('sub', v_uid::text, 'email', r.email, 'email_verified', true),
        'email', r.email, now(), now(), now()
      );
    else
      -- keep the password predictable for testing
      update auth.users
        set encrypted_password = crypt(v_pass, gen_salt('bf')),
            email_confirmed_at = coalesce(email_confirmed_at, now()),
            updated_at = now()
        where id = v_uid;
    end if;

    delete from public.user_roles where user_id = v_uid;
    insert into public.user_roles (user_id, role, canteen_id, supplier_id)
    values (
      v_uid, r.role,
      case when r.site_scoped then v_site end,
      case when r.role = 'vendor' then v_supp end
    );
  end loop;

  -- the ops manager covers every site, not just their home one
  select id into v_uid from auth.users where email = 'ops@slptest.com';
  delete from public.user_sites where user_id = v_uid;
  insert into public.user_sites (user_id, canteen_id)
  select v_uid, id from canteens
  on conflict do nothing;
end $$;

select u.email, ur.role,
       coalesce(c.name, '—') as site,
       coalesce(s.name, '—') as vendor_company
from auth.users u
join public.user_roles ur on ur.user_id = u.id
left join public.canteens c on c.id = ur.canteen_id
left join public.suppliers s on s.id = ur.supplier_id
where u.email like '%@slptest.com'
order by public.role_rank(ur.role) desc;
