-- The SRS role migration taught role_rank() seven roles but left the old
-- CHECK on user_roles.role, which still only allowed owner/manager/cashier.
-- Any attempt to create an ops_manager, chef, store_keeper or vendor failed
-- with a constraint violation. Widen it to the full set, legacy names kept.
-- Safe to re-run.

ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role = ANY (ARRAY[
    'super_admin', 'admin', 'ops_manager', 'unit_manager',
    'chef', 'store_keeper', 'vendor',
    'owner', 'manager', 'cashier'          -- legacy, still valid
  ]::text[]));
