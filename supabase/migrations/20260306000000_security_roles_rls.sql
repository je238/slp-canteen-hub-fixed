-- ============================================================
-- SECURITY MIGRATION: Roles, RLS, API key protection
-- ============================================================

-- 1. USER ROLES TABLE
-- Links auth.users to a role and optionally a canteen
CREATE TABLE IF NOT EXISTS public.user_roles (
  id          UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'cashier')),
  canteen_id  UUID REFERENCES public.canteens(id) ON DELETE CASCADE,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);
COMMENT ON TABLE public.user_roles IS
  'owner = full access all canteens; manager = full access one canteen; cashier = POS only for one canteen';

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Users can read their own role
CREATE POLICY "user_roles_select_own"
  ON public.user_roles FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Only owners can manage roles
CREATE POLICY "user_roles_owner_manage"
  ON public.user_roles FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'owner'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'owner'
    )
  );

-- ============================================================
-- 2. HELPER FUNCTIONS (used inside RLS policies)
-- ============================================================

-- Returns the role of the calling user
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.user_roles WHERE user_id = auth.uid() LIMIT 1;
$$;

-- Returns the canteen_id assigned to the calling user (null for owners)
CREATE OR REPLACE FUNCTION public.get_my_canteen()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT canteen_id FROM public.user_roles WHERE user_id = auth.uid() LIMIT 1;
$$;

-- Returns true if caller is owner
CREATE OR REPLACE FUNCTION public.is_owner()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'owner'
  );
$$;

-- Returns true if caller is owner OR manager
CREATE OR REPLACE FUNCTION public.is_manager_or_above()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role IN ('owner', 'manager')
  );
$$;

-- Returns true if caller can access a given canteen_id
CREATE OR REPLACE FUNCTION public.can_access_canteen(cid UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND (role = 'owner' OR canteen_id = cid)
  );
$$;

-- ============================================================
-- 3. DROP OLD PERMISSIVE POLICIES & REPLACE WITH ROLE-SCOPED RLS
-- ============================================================

-- CANTEENS
DROP POLICY IF EXISTS "Authenticated users can view canteens" ON public.canteens;
DROP POLICY IF EXISTS "Authenticated users can manage canteens" ON public.canteens;

CREATE POLICY "canteens_select"
  ON public.canteens FOR SELECT TO authenticated
  USING (
    public.is_owner()
    OR id = public.get_my_canteen()
  );

CREATE POLICY "canteens_insert_owner"
  ON public.canteens FOR INSERT TO authenticated
  WITH CHECK (public.is_owner());

CREATE POLICY "canteens_update_owner"
  ON public.canteens FOR UPDATE TO authenticated
  USING (public.is_owner());

CREATE POLICY "canteens_delete_owner"
  ON public.canteens FOR DELETE TO authenticated
  USING (public.is_owner());

-- INGREDIENTS
DROP POLICY IF EXISTS "Authenticated users can manage ingredients" ON public.ingredients;

CREATE POLICY "ingredients_select"
  ON public.ingredients FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));

CREATE POLICY "ingredients_insert"
  ON public.ingredients FOR INSERT TO authenticated
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

CREATE POLICY "ingredients_update"
  ON public.ingredients FOR UPDATE TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

CREATE POLICY "ingredients_delete"
  ON public.ingredients FOR DELETE TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

-- STOCK LEDGER
DROP POLICY IF EXISTS "Authenticated users can manage stock_ledger" ON public.stock_ledger;

CREATE POLICY "stock_ledger_select"
  ON public.stock_ledger FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));

CREATE POLICY "stock_ledger_insert"
  ON public.stock_ledger FOR INSERT TO authenticated
  WITH CHECK (public.can_access_canteen(canteen_id));

-- No UPDATE/DELETE on ledger — it's an immutable audit trail

-- MENU ITEMS
DROP POLICY IF EXISTS "Authenticated users can manage menu_items" ON public.menu_items;

CREATE POLICY "menu_items_select"
  ON public.menu_items FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));

CREATE POLICY "menu_items_write"
  ON public.menu_items FOR ALL TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

-- ORDERS (cashiers can INSERT, managers/owners can SELECT all)
DROP POLICY IF EXISTS "Authenticated users can manage orders" ON public.orders;

CREATE POLICY "orders_select"
  ON public.orders FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));

CREATE POLICY "orders_insert"
  ON public.orders FOR INSERT TO authenticated
  WITH CHECK (public.can_access_canteen(canteen_id));

CREATE POLICY "orders_update_manager"
  ON public.orders FOR UPDATE TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

-- ORDER ITEMS
DROP POLICY IF EXISTS "Authenticated users can manage order_items" ON public.order_items;

CREATE POLICY "order_items_select"
  ON public.order_items FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_id AND public.can_access_canteen(o.canteen_id)
    )
  );

CREATE POLICY "order_items_insert"
  ON public.order_items FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_id AND public.can_access_canteen(o.canteen_id)
    )
  );

-- SUPPLIERS
DROP POLICY IF EXISTS "Authenticated users can manage suppliers" ON public.suppliers;

CREATE POLICY "suppliers_select"
  ON public.suppliers FOR SELECT TO authenticated
  USING (canteen_id IS NULL OR public.can_access_canteen(canteen_id));

CREATE POLICY "suppliers_write"
  ON public.suppliers FOR ALL TO authenticated
  USING (public.is_manager_or_above())
  WITH CHECK (public.is_manager_or_above());

-- PURCHASES
DROP POLICY IF EXISTS "Authenticated users can manage purchases" ON public.purchases;

CREATE POLICY "purchases_select"
  ON public.purchases FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));

CREATE POLICY "purchases_insert"
  ON public.purchases FOR INSERT TO authenticated
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

CREATE POLICY "purchases_update"
  ON public.purchases FOR UPDATE TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

-- PURCHASE ITEMS
DROP POLICY IF EXISTS "Authenticated users can manage purchase_items" ON public.purchase_items;

CREATE POLICY "purchase_items_select"
  ON public.purchase_items FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.purchases p
      WHERE p.id = purchase_id AND public.can_access_canteen(p.canteen_id)
    )
  );

CREATE POLICY "purchase_items_insert"
  ON public.purchase_items FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.purchases p
      WHERE p.id = purchase_id AND public.is_manager_or_above() AND public.can_access_canteen(p.canteen_id)
    )
  );

-- EXPENSES
DROP POLICY IF EXISTS "Authenticated users can manage expenses" ON public.expenses;

CREATE POLICY "expenses_select"
  ON public.expenses FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));

CREATE POLICY "expenses_insert"
  ON public.expenses FOR INSERT TO authenticated
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

CREATE POLICY "expenses_update_delete"
  ON public.expenses FOR DELETE TO authenticated
  USING (public.is_owner());

-- RECIPES
DROP POLICY IF EXISTS "Authenticated users can manage recipes" ON public.recipes;

CREATE POLICY "recipes_select"
  ON public.recipes FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));

CREATE POLICY "recipes_write"
  ON public.recipes FOR ALL TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

-- RECIPE INGREDIENTS
DROP POLICY IF EXISTS "Authenticated users can manage recipe_ingredients" ON public.recipe_ingredients;

CREATE POLICY "recipe_ingredients_select"
  ON public.recipe_ingredients FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.recipes r
      WHERE r.id = recipe_id AND public.can_access_canteen(r.canteen_id)
    )
  );

CREATE POLICY "recipe_ingredients_write"
  ON public.recipe_ingredients FOR ALL TO authenticated
  USING (public.is_manager_or_above())
  WITH CHECK (public.is_manager_or_above());

-- STAFF
DROP POLICY IF EXISTS "Authenticated users can manage staff" ON public.staff;

CREATE POLICY "staff_select"
  ON public.staff FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));

CREATE POLICY "staff_write"
  ON public.staff FOR ALL TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

-- ATTENDANCE
DROP POLICY IF EXISTS "Authenticated users can manage attendance" ON public.attendance;

CREATE POLICY "attendance_select"
  ON public.attendance FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));

CREATE POLICY "attendance_write"
  ON public.attendance FOR ALL TO authenticated
  USING (public.can_access_canteen(canteen_id))
  WITH CHECK (public.can_access_canteen(canteen_id));

-- ACTION LOGS (audit trail — insert only, owners can read all)
DROP POLICY IF EXISTS "Authenticated users can manage action_logs" ON public.action_logs;

CREATE POLICY "action_logs_select"
  ON public.action_logs FOR SELECT TO authenticated
  USING (
    public.is_owner()
    OR (canteen_id IS NOT NULL AND public.can_access_canteen(canteen_id))
  );

CREATE POLICY "action_logs_insert"
  ON public.action_logs FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ============================================================
-- 4. API KEY PROTECTION — Supabase Edge Function secret
-- Store a secret key that Edge Functions verify before processing
-- ============================================================
-- In Supabase Dashboard → Settings → Edge Functions → Secrets:
-- Add: INTERNAL_API_SECRET = <generate with: openssl rand -hex 32>
-- Edge functions already use service_role key internally;
-- this table records which external API keys are active.

CREATE TABLE IF NOT EXISTS public.api_keys (
  id          UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  key_hash    TEXT NOT NULL UNIQUE,  -- SHA-256 hash of the actual key
  label       TEXT NOT NULL,
  created_by  UUID REFERENCES auth.users(id),
  revoked     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "api_keys_owner_only"
  ON public.api_keys FOR ALL TO authenticated
  USING (public.is_owner())
  WITH CHECK (public.is_owner());

-- ============================================================
-- 5. SEED OWNER ROLE
-- After running this migration, sign up with your email in the app,
-- then run the following in Supabase SQL editor (replace the UUID):
--
--   INSERT INTO public.user_roles (user_id, role)
--   VALUES ('<your-auth-user-uuid>', 'owner');
-- ============================================================
