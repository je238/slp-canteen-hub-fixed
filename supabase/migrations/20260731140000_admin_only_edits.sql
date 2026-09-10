-- ============================================================
-- ONCE IT IS IN THE SYSTEM, ONLY ADMIN OR SUPER ADMIN MAY CHANGE IT
--
-- The distinction that matters:
--   · CREATING a record — the role whose job it is (store keeper enters a
--     bill, chef raises a requisition, manager publishes a menu).
--   · MOVING it through the designed workflow — approve, issue, confirm,
--     publish, mark paid. Still the role whose job it is.
--   · EDITING what is already recorded — rewriting a name, a rate, a
--     quantity, an amount. Admin and Super Admin only.
--
-- Without this, whoever entered a figure could quietly go back and change
-- it later, which is the whole point of having a record.
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_admin_editor()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.my_rank() >= 60;      -- admin (60) and super_admin (70)
$$;
REVOKE ALL ON FUNCTION public.is_admin_editor() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin_editor() TO authenticated;

-- ---------- Ingredients: master data is fixed after entry ----------
-- Stock itself is already guarded and moves only through the stock
-- functions; this covers the name, unit, rates and levels.
CREATE OR REPLACE FUNCTION public.guard_ingredient_edit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.is_admin_editor() THEN RETURN NEW; END IF;

  -- the stock functions run as definer and set this for their transaction
  IF coalesce(current_setting('app.stock_move', true), '') = 'on' THEN RETURN NEW; END IF;

  IF NEW.name          IS DISTINCT FROM OLD.name
     OR NEW.category   IS DISTINCT FROM OLD.category
     OR NEW.unit       IS DISTINCT FROM OLD.unit
     OR NEW.cost_per_unit IS DISTINCT FROM OLD.cost_per_unit
     OR NEW.minimum_stock IS DISTINCT FROM OLD.minimum_stock
     OR NEW.maximum_stock IS DISTINCT FROM OLD.maximum_stock
     OR NEW.reorder_level IS DISTINCT FROM OLD.reorder_level
     OR NEW.avg_daily_usage IS DISTINCT FROM OLD.avg_daily_usage THEN
    RAISE EXCEPTION 'Item details can only be changed by an admin';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_ingredient_edit ON public.ingredients;
CREATE TRIGGER trg_guard_ingredient_edit
  BEFORE UPDATE ON public.ingredients
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingredient_edit();

-- ---------- Purchases: the bill is what it is ----------
-- Payment status stays with the store keeper — recording that money went
-- out is a workflow step, not a rewrite of the bill.
CREATE OR REPLACE FUNCTION public.guard_purchase_edit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.is_admin_editor() THEN RETURN NEW; END IF;
  IF coalesce(current_setting('app.stock_move', true), '') = 'on' THEN RETURN NEW; END IF;

  IF NEW.total_amount IS DISTINCT FROM OLD.total_amount
     OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
     OR NEW.canteen_id  IS DISTINCT FROM OLD.canteen_id
     OR NEW.notes       IS DISTINCT FROM OLD.notes
     OR NEW.invoice_image_url IS DISTINCT FROM OLD.invoice_image_url THEN
    RAISE EXCEPTION 'A recorded purchase can only be changed by an admin';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_purchase_edit ON public.purchases;
CREATE TRIGGER trg_guard_purchase_edit
  BEFORE UPDATE ON public.purchases
  FOR EACH ROW EXECUTE FUNCTION public.guard_purchase_edit();

CREATE OR REPLACE FUNCTION public.guard_row_edit_admin_only()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.is_admin_editor() THEN RETURN NEW; END IF;
  IF coalesce(current_setting('app.stock_move', true), '') = 'on' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'This record is already in the system — only an admin can change it';
END;
$$;

-- Bill lines, expenses and the vendor master: no quiet corrections.
DROP TRIGGER IF EXISTS trg_guard_purchase_items ON public.purchase_items;
CREATE TRIGGER trg_guard_purchase_items
  BEFORE UPDATE OR DELETE ON public.purchase_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_row_edit_admin_only();

DROP TRIGGER IF EXISTS trg_guard_expenses ON public.expenses;
CREATE TRIGGER trg_guard_expenses
  BEFORE UPDATE OR DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.guard_row_edit_admin_only();

DROP TRIGGER IF EXISTS trg_guard_suppliers ON public.suppliers;
CREATE TRIGGER trg_guard_suppliers
  BEFORE UPDATE OR DELETE ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.guard_row_edit_admin_only();

-- ---------- Requisition lines ----------
-- The manager's approval is a workflow step; the chef's original request and
-- the issued figures are the record.
CREATE OR REPLACE FUNCTION public.guard_requisition_item_edit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.is_admin_editor() THEN RETURN NEW; END IF;
  IF coalesce(current_setting('app.stock_move', true), '') = 'on' THEN RETURN NEW; END IF;

  IF NEW.requested_qty IS DISTINCT FROM OLD.requested_qty
     OR NEW.ingredient_id IS DISTINCT FROM OLD.ingredient_id
     OR NEW.rate IS DISTINCT FROM OLD.rate THEN
    RAISE EXCEPTION 'What was requested cannot be edited — raise a fresh requisition';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_requisition_item_edit ON public.requisition_items;
CREATE TRIGGER trg_guard_requisition_item_edit
  BEFORE UPDATE ON public.requisition_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_requisition_item_edit();

-- ---------- Menu, once it has gone to the kitchen ----------
-- The chef still records what was produced and wasted; the menu itself is
-- the manager's published document.
CREATE OR REPLACE FUNCTION public.guard_menu_item_edit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status TEXT;
BEGIN
  IF public.is_admin_editor() THEN RETURN NEW; END IF;
  SELECT status INTO v_status FROM public.menu_plans WHERE id = NEW.menu_plan_id;
  IF v_status IS DISTINCT FROM 'draft'
     AND (NEW.dish_name IS DISTINCT FROM OLD.dish_name
          OR NEW.planned_qty IS DISTINCT FROM OLD.planned_qty
          OR NEW.recipe_id IS DISTINCT FROM OLD.recipe_id) THEN
    RAISE EXCEPTION 'This menu is already published — only an admin can change the dishes';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_menu_item_edit ON public.menu_plan_items;
CREATE TRIGGER trg_guard_menu_item_edit
  BEFORE UPDATE ON public.menu_plan_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_menu_item_edit();

-- ---------- Vendor bills: fixed once the canteen has looked at them ----------
CREATE OR REPLACE FUNCTION public.guard_vendor_bill_edit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.is_admin_editor() THEN RETURN NEW; END IF;
  IF OLD.status <> 'submitted'
     AND (NEW.total_value IS DISTINCT FROM OLD.total_value
          OR NEW.bill_no IS DISTINCT FROM OLD.bill_no
          OR NEW.image_path IS DISTINCT FROM OLD.image_path) THEN
    RAISE EXCEPTION 'This bill has already been reviewed — only an admin can change it';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_vendor_bill_edit ON public.vendor_bills;
CREATE TRIGGER trg_guard_vendor_bill_edit
  BEFORE UPDATE ON public.vendor_bills
  FOR EACH ROW EXECUTE FUNCTION public.guard_vendor_bill_edit();

-- ---------- Deleting a record is an admin act everywhere ----------
DROP POLICY IF EXISTS "requisitions_owner_delete" ON public.requisitions;
CREATE POLICY "requisitions_owner_delete" ON public.requisitions FOR DELETE TO authenticated
  USING (public.is_admin_editor());

DROP POLICY IF EXISTS "menu_plans_admin_delete" ON public.menu_plans;
CREATE POLICY "menu_plans_admin_delete" ON public.menu_plans FOR DELETE TO authenticated
  USING (public.is_admin_editor());

DROP POLICY IF EXISTS "purchases_admin_delete" ON public.purchases;
CREATE POLICY "purchases_admin_delete" ON public.purchases FOR DELETE TO authenticated
  USING (public.is_admin_editor());
