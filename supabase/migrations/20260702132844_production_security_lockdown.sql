-- ============================================================
-- PRODUCTION SECURITY LOCKDOWN
--
-- Before this migration the live database had RLS DISABLED on
-- almost every table: the public anon key (shipped to every QR
-- customer's browser) could read and write everything.
--
-- After this migration:
--   * RLS is enabled on every table.
--   * Staff access is scoped by user_roles (owner / manager / cashier).
--   * The anon key can ONLY: read canteen names, read available
--     menu items, and call two hardened RPCs (place_qr_order /
--     get_qr_order) that validate everything server-side.
--
-- Safe to re-run.
-- ============================================================

-- ---------- 1. Role helper functions ----------

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM public.user_roles WHERE user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_my_canteen()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT canteen_id FROM public.user_roles WHERE user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_owner()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'owner');
$$;

CREATE OR REPLACE FUNCTION public.is_manager_or_above()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('owner','manager'));
$$;

CREATE OR REPLACE FUNCTION public.can_access_canteen(cid UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND (role = 'owner' OR canteen_id = cid)
  );
$$;

-- ---------- 2. Stock triggers must run with elevated rights ----------
-- Cashiers trigger ingredient deduction/restock via order inserts and
-- kitchen updates, but only managers may write ingredients directly.
ALTER FUNCTION public.process_order_item() SECURITY DEFINER;
ALTER FUNCTION public.process_order_item() SET search_path = public;
ALTER FUNCTION public.restock_cancelled_order() SECURITY DEFINER;
ALTER FUNCTION public.restock_cancelled_order() SET search_path = public;

-- ---------- 3. Enable RLS everywhere + drop old permissive policies ----------

ALTER TABLE public.action_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canteens             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fraud_alerts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingredient_usage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingredients          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchases            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipe_ingredients   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_ledger         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suppliers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles           ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can manage fraud_alerts" ON public.fraud_alerts;
DROP POLICY IF EXISTS "Authenticated users can manage ingredient_usage_log" ON public.ingredient_usage_log;

-- ---------- 4. Policies ----------
-- (Re-runnable: drop first, then create.)

-- user_roles
DROP POLICY IF EXISTS "user_roles_select_own" ON public.user_roles;
DROP POLICY IF EXISTS "user_roles_owner_all" ON public.user_roles;
CREATE POLICY "user_roles_select_own" ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_owner());
CREATE POLICY "user_roles_owner_all" ON public.user_roles FOR ALL TO authenticated
  USING (public.is_owner()) WITH CHECK (public.is_owner());

-- canteens: staff see theirs; QR customers may read names
DROP POLICY IF EXISTS "canteens_staff_select" ON public.canteens;
DROP POLICY IF EXISTS "canteens_anon_select" ON public.canteens;
DROP POLICY IF EXISTS "canteens_owner_write" ON public.canteens;
CREATE POLICY "canteens_staff_select" ON public.canteens FOR SELECT TO authenticated
  USING (public.is_owner() OR id = public.get_my_canteen());
CREATE POLICY "canteens_anon_select" ON public.canteens FOR SELECT TO anon USING (true);
CREATE POLICY "canteens_owner_write" ON public.canteens FOR ALL TO authenticated
  USING (public.is_owner()) WITH CHECK (public.is_owner());

-- menu_items: staff full read + manager write; QR customers read available only
DROP POLICY IF EXISTS "menu_items_staff_select" ON public.menu_items;
DROP POLICY IF EXISTS "menu_items_anon_select" ON public.menu_items;
DROP POLICY IF EXISTS "menu_items_manager_write" ON public.menu_items;
CREATE POLICY "menu_items_staff_select" ON public.menu_items FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "menu_items_anon_select" ON public.menu_items FOR SELECT TO anon
  USING (available = true);
CREATE POLICY "menu_items_manager_write" ON public.menu_items FOR ALL TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

-- orders: staff of the canteen; QR customers go through RPCs only
DROP POLICY IF EXISTS "orders_staff_select" ON public.orders;
DROP POLICY IF EXISTS "orders_staff_insert" ON public.orders;
DROP POLICY IF EXISTS "orders_staff_update" ON public.orders;
DROP POLICY IF EXISTS "orders_owner_delete" ON public.orders;
CREATE POLICY "orders_staff_select" ON public.orders FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "orders_staff_insert" ON public.orders FOR INSERT TO authenticated
  WITH CHECK (public.can_access_canteen(canteen_id));
CREATE POLICY "orders_staff_update" ON public.orders FOR UPDATE TO authenticated
  USING (public.can_access_canteen(canteen_id))
  WITH CHECK (public.can_access_canteen(canteen_id));
CREATE POLICY "orders_owner_delete" ON public.orders FOR DELETE TO authenticated
  USING (public.is_owner());

-- order_items via parent order
DROP POLICY IF EXISTS "order_items_staff_select" ON public.order_items;
DROP POLICY IF EXISTS "order_items_staff_insert" ON public.order_items;
DROP POLICY IF EXISTS "order_items_owner_delete" ON public.order_items;
CREATE POLICY "order_items_staff_select" ON public.order_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND public.can_access_canteen(o.canteen_id)));
CREATE POLICY "order_items_staff_insert" ON public.order_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND public.can_access_canteen(o.canteen_id)));
CREATE POLICY "order_items_owner_delete" ON public.order_items FOR DELETE TO authenticated
  USING (public.is_owner());

-- ingredients: staff read; manager write
DROP POLICY IF EXISTS "ingredients_staff_select" ON public.ingredients;
DROP POLICY IF EXISTS "ingredients_manager_write" ON public.ingredients;
CREATE POLICY "ingredients_staff_select" ON public.ingredients FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "ingredients_manager_write" ON public.ingredients FOR ALL TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

-- stock_ledger: append-only audit trail
DROP POLICY IF EXISTS "stock_ledger_staff_select" ON public.stock_ledger;
DROP POLICY IF EXISTS "stock_ledger_staff_insert" ON public.stock_ledger;
CREATE POLICY "stock_ledger_staff_select" ON public.stock_ledger FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "stock_ledger_staff_insert" ON public.stock_ledger FOR INSERT TO authenticated
  WITH CHECK (public.can_access_canteen(canteen_id));

-- ingredient_usage_log: read-only for staff (writes come from SECURITY DEFINER triggers)
DROP POLICY IF EXISTS "usage_log_staff_select" ON public.ingredient_usage_log;
CREATE POLICY "usage_log_staff_select" ON public.ingredient_usage_log FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));

-- recipes + recipe_ingredients
DROP POLICY IF EXISTS "recipes_staff_select" ON public.recipes;
DROP POLICY IF EXISTS "recipes_manager_write" ON public.recipes;
CREATE POLICY "recipes_staff_select" ON public.recipes FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "recipes_manager_write" ON public.recipes FOR ALL TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

DROP POLICY IF EXISTS "recipe_ingredients_staff_select" ON public.recipe_ingredients;
DROP POLICY IF EXISTS "recipe_ingredients_manager_write" ON public.recipe_ingredients;
CREATE POLICY "recipe_ingredients_staff_select" ON public.recipe_ingredients FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.recipes r WHERE r.id = recipe_id AND public.can_access_canteen(r.canteen_id)));
CREATE POLICY "recipe_ingredients_manager_write" ON public.recipe_ingredients FOR ALL TO authenticated
  USING (public.is_manager_or_above()) WITH CHECK (public.is_manager_or_above());

-- suppliers (canteen_id NULL = global vendor)
DROP POLICY IF EXISTS "suppliers_staff_select" ON public.suppliers;
DROP POLICY IF EXISTS "suppliers_manager_write" ON public.suppliers;
CREATE POLICY "suppliers_staff_select" ON public.suppliers FOR SELECT TO authenticated
  USING (canteen_id IS NULL OR public.can_access_canteen(canteen_id));
CREATE POLICY "suppliers_manager_write" ON public.suppliers FOR ALL TO authenticated
  USING (public.is_manager_or_above()) WITH CHECK (public.is_manager_or_above());

-- purchases + purchase_items
DROP POLICY IF EXISTS "purchases_staff_select" ON public.purchases;
DROP POLICY IF EXISTS "purchases_manager_write" ON public.purchases;
CREATE POLICY "purchases_staff_select" ON public.purchases FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "purchases_manager_write" ON public.purchases FOR ALL TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

DROP POLICY IF EXISTS "purchase_items_staff_select" ON public.purchase_items;
DROP POLICY IF EXISTS "purchase_items_manager_write" ON public.purchase_items;
CREATE POLICY "purchase_items_staff_select" ON public.purchase_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.purchases p WHERE p.id = purchase_id AND public.can_access_canteen(p.canteen_id)));
CREATE POLICY "purchase_items_manager_write" ON public.purchase_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.purchases p WHERE p.id = purchase_id AND public.is_manager_or_above() AND public.can_access_canteen(p.canteen_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.purchases p WHERE p.id = purchase_id AND public.is_manager_or_above() AND public.can_access_canteen(p.canteen_id)));

-- expenses
DROP POLICY IF EXISTS "expenses_staff_select" ON public.expenses;
DROP POLICY IF EXISTS "expenses_manager_insert" ON public.expenses;
DROP POLICY IF EXISTS "expenses_owner_delete" ON public.expenses;
CREATE POLICY "expenses_staff_select" ON public.expenses FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "expenses_manager_insert" ON public.expenses FOR INSERT TO authenticated
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));
CREATE POLICY "expenses_owner_delete" ON public.expenses FOR DELETE TO authenticated
  USING (public.is_owner());

-- staff + attendance
DROP POLICY IF EXISTS "staff_staff_select" ON public.staff;
DROP POLICY IF EXISTS "staff_manager_write" ON public.staff;
CREATE POLICY "staff_staff_select" ON public.staff FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "staff_manager_write" ON public.staff FOR ALL TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

DROP POLICY IF EXISTS "attendance_staff_all" ON public.attendance;
CREATE POLICY "attendance_staff_all" ON public.attendance FOR ALL TO authenticated
  USING (public.can_access_canteen(canteen_id))
  WITH CHECK (public.can_access_canteen(canteen_id));

-- action_logs: insert own, owners read all
DROP POLICY IF EXISTS "action_logs_select" ON public.action_logs;
DROP POLICY IF EXISTS "action_logs_insert_own" ON public.action_logs;
CREATE POLICY "action_logs_select" ON public.action_logs FOR SELECT TO authenticated
  USING (public.is_owner() OR (canteen_id IS NOT NULL AND public.can_access_canteen(canteen_id)));
CREATE POLICY "action_logs_insert_own" ON public.action_logs FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- fraud_alerts
DROP POLICY IF EXISTS "fraud_alerts_staff_select" ON public.fraud_alerts;
DROP POLICY IF EXISTS "fraud_alerts_manager_write" ON public.fraud_alerts;
CREATE POLICY "fraud_alerts_staff_select" ON public.fraud_alerts FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "fraud_alerts_manager_write" ON public.fraud_alerts FOR ALL TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

-- api_keys: owner only
DROP POLICY IF EXISTS "api_keys_owner_only" ON public.api_keys;
CREATE POLICY "api_keys_owner_only" ON public.api_keys FOR ALL TO authenticated
  USING (public.is_owner()) WITH CHECK (public.is_owner());

-- ---------- 5. QR ordering RPCs (the ONLY writes anon can perform) ----------

CREATE OR REPLACE FUNCTION public.place_qr_order(
  p_canteen_id UUID,
  p_items JSONB,
  p_customer_name TEXT DEFAULT NULL,
  p_instructions TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_line RECORD;
  v_menu RECORD;
  v_subtotal NUMERIC := 0;
  v_gst NUMERIC;
  v_total NUMERIC;
  v_order public.orders%ROWTYPE;
  v_count INT;
  v_open INT;
  v_rows JSONB := '[]'::jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.canteens WHERE id = p_canteen_id) THEN
    RAISE EXCEPTION 'Unknown canteen';
  END IF;

  -- Abuse guard: cap the number of open self-service orders per canteen
  SELECT count(*) INTO v_open FROM public.orders
  WHERE canteen_id = p_canteen_id AND order_type = 'qr'
    AND kitchen_status IN ('new','preparing','ready');
  IF v_open >= 50 THEN
    RAISE EXCEPTION 'The kitchen queue is full right now — please order at the counter.';
  END IF;

  SELECT count(*) INTO v_count FROM jsonb_array_elements(p_items);
  IF v_count IS NULL OR v_count < 1 OR v_count > 30 THEN
    RAISE EXCEPTION 'An order must contain between 1 and 30 items.';
  END IF;

  -- Validate every line against the menu; prices always come from the DB
  FOR v_line IN
    SELECT (e->>'menu_item_id')::uuid AS menu_item_id, (e->>'quantity')::int AS quantity
    FROM jsonb_array_elements(p_items) e
  LOOP
    IF v_line.quantity IS NULL OR v_line.quantity < 1 OR v_line.quantity > 20 THEN
      RAISE EXCEPTION 'Item quantity must be between 1 and 20.';
    END IF;
    SELECT id, name, price INTO v_menu FROM public.menu_items
    WHERE id = v_line.menu_item_id AND canteen_id = p_canteen_id AND available = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'An item in your order is no longer available. Please refresh the menu.';
    END IF;
    v_subtotal := v_subtotal + v_menu.price * v_line.quantity;
    v_rows := v_rows || jsonb_build_object(
      'menu_item_id', v_menu.id,
      'item_name', v_menu.name,
      'quantity', v_line.quantity,
      'unit_price', v_menu.price,
      'total_price', v_menu.price * v_line.quantity
    );
  END LOOP;

  v_gst := round(v_subtotal * 0.05);
  v_total := v_subtotal + v_gst;

  INSERT INTO public.orders
    (canteen_id, total_amount, payment_mode, status, kitchen_status, order_type, payment_status, customer_name, special_instructions)
  VALUES
    (p_canteen_id, v_total, 'counter', 'pending', 'new', 'qr', 'unpaid',
     nullif(left(trim(p_customer_name), 60), ''), nullif(left(trim(p_instructions), 200), ''))
  RETURNING * INTO v_order;

  INSERT INTO public.order_items (order_id, menu_item_id, item_name, quantity, unit_price, total_price)
  SELECT v_order.id, (e->>'menu_item_id')::uuid, e->>'item_name', (e->>'quantity')::int,
         (e->>'unit_price')::numeric, (e->>'total_price')::numeric
  FROM jsonb_array_elements(v_rows) e;

  RETURN jsonb_build_object(
    'id', v_order.id,
    'order_number', v_order.order_number,
    'subtotal', v_subtotal,
    'gst', v_gst,
    'total_amount', v_total
  );
END;
$$;

-- Track a single order by its (unguessable) uuid — limited fields only
CREATE OR REPLACE FUNCTION public.get_qr_order(p_order_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', o.id,
    'order_number', o.order_number,
    'kitchen_status', o.kitchen_status,
    'payment_status', o.payment_status,
    'customer_name', o.customer_name,
    'total_amount', o.total_amount,
    'created_at', o.created_at,
    'order_items', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id, 'item_name', i.item_name, 'quantity', i.quantity, 'total_price', i.total_price
      )), '[]'::jsonb)
      FROM public.order_items i WHERE i.order_id = o.id
    )
  )
  FROM public.orders o WHERE o.id = p_order_id;
$$;

REVOKE ALL ON FUNCTION public.place_qr_order(UUID, JSONB, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_qr_order(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_qr_order(UUID, JSONB, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_qr_order(UUID) TO anon, authenticated;
