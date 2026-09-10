-- ============================================================
-- SRS ROLE MODEL — 7 logins
--   super_admin  all authority, weekly reports
--   admin        all locations, user management, approvals
--   ops_manager  budgets + reports review across assigned sites
--   unit_manager food ordering, menu, approvals for one site
--   chef         raw material ordering, production, quality
--   store_keeper purchase in/out, photos, stock issue
--   vendor       uploads own bill photos/items/total only
--
-- Legacy roles stay valid and map onto the new ranks:
--   owner -> super_admin level, manager -> unit_manager, cashier -> chef
--
-- Safe to re-run.
-- ============================================================

-- ---------- 1. Role rank ----------
CREATE OR REPLACE FUNCTION public.role_rank(p_role TEXT)
RETURNS INT LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE lower(coalesce(p_role, ''))
    WHEN 'super_admin'  THEN 70
    WHEN 'owner'        THEN 70   -- legacy
    WHEN 'admin'        THEN 60
    WHEN 'ops_manager'  THEN 50
    WHEN 'unit_manager' THEN 40
    WHEN 'manager'      THEN 40   -- legacy
    WHEN 'chef'         THEN 30
    WHEN 'cashier'      THEN 30   -- legacy
    WHEN 'store_keeper' THEN 20
    WHEN 'vendor'       THEN 10
    ELSE 0
  END;
$$;

-- ---------- 2. user_roles gains a vendor link + multi-site support ----------
ALTER TABLE public.user_roles ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES public.suppliers(id) ON DELETE SET NULL;
ALTER TABLE public.user_roles ADD COLUMN IF NOT EXISTS full_name TEXT;

-- Ops managers cover several sites; one row per (user, site).
CREATE TABLE IF NOT EXISTS public.user_sites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL,
  canteen_id UUID NOT NULL REFERENCES public.canteens(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, canteen_id)
);
ALTER TABLE public.user_sites ENABLE ROW LEVEL SECURITY;

-- ---------- 3. Helper functions (redefined on top of role_rank) ----------
CREATE OR REPLACE FUNCTION public.my_rank()
RETURNS INT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(max(public.role_rank(role)), 0)
  FROM public.user_roles WHERE user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_owner()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.my_rank() >= 60;      -- admin and above
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.my_rank() >= 70;
$$;

-- "manager or above" now also covers ops_manager/admin/super_admin, and
-- deliberately EXCLUDES chef/store_keeper/vendor.
CREATE OR REPLACE FUNCTION public.is_manager_or_above()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.my_rank() >= 40;
$$;

CREATE OR REPLACE FUNCTION public.is_store_keeper_or_above()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.my_rank() >= 20;
$$;

CREATE OR REPLACE FUNCTION public.is_chef()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles
                 WHERE user_id = auth.uid() AND lower(role) IN ('chef','cashier'));
$$;

CREATE OR REPLACE FUNCTION public.is_vendor()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles
                 WHERE user_id = auth.uid() AND lower(role) = 'vendor');
$$;

CREATE OR REPLACE FUNCTION public.my_supplier_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT supplier_id FROM public.user_roles
  WHERE user_id = auth.uid() AND supplier_id IS NOT NULL LIMIT 1;
$$;

-- Site access: rank 60+ sees every site; others see their home site plus any
-- site explicitly assigned in user_sites. Vendors get no site access.
CREATE OR REPLACE FUNCTION public.can_access_canteen(cid UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN public.is_vendor() AND public.my_rank() < 20 THEN false
    WHEN public.my_rank() >= 60 THEN true
    ELSE EXISTS (SELECT 1 FROM public.user_roles
                 WHERE user_id = auth.uid() AND canteen_id = cid)
      OR EXISTS (SELECT 1 FROM public.user_sites
                 WHERE user_id = auth.uid() AND canteen_id = cid)
  END;
$$;

-- ---------- 4. user_sites policies ----------
DROP POLICY IF EXISTS "user_sites_select" ON public.user_sites;
DROP POLICY IF EXISTS "user_sites_admin_write" ON public.user_sites;
CREATE POLICY "user_sites_select" ON public.user_sites FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_owner());
CREATE POLICY "user_sites_admin_write" ON public.user_sites FOR ALL TO authenticated
  USING (public.is_owner()) WITH CHECK (public.is_owner());

-- ---------- 5. Vendors may read the supplier row they belong to ----------
DROP POLICY IF EXISTS "suppliers_vendor_select_own" ON public.suppliers;
CREATE POLICY "suppliers_vendor_select_own" ON public.suppliers FOR SELECT TO authenticated
  USING (id = public.my_supplier_id());
