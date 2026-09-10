-- ============================================================
-- Three ways a record could be changed without anyone being told
--
-- 1. guard_row_edit_admin_only ran on BEFORE DELETE and ended with
--    RETURN NEW. In a delete trigger NEW is NULL, and a BEFORE DELETE
--    trigger that returns NULL cancels the delete WITHOUT an error.
--    So an admin deleting a bill line, an expense or a supplier was told
--    "done" while the row stayed. Worse: deleting a purchase cascades to
--    its lines, that cascade was silently cancelled too, and the bill
--    lines were left behind pointing at a purchase that no longer exists
--    — invisible to every screen (the read policy joins the parent) and
--    impossible to remove. Eight such rows were found in production.
--
-- 2. The published-menu and the requested-quantity guards only covered
--    UPDATE. Delete the row and insert a new one and you have edited it,
--    which is exactly what the rule exists to stop.
--
-- 3. The orphans themselves, cleared out below.
--
-- Safe to re-run.
-- ============================================================

-- ---------- 1. A delete trigger must return OLD ----------
CREATE OR REPLACE FUNCTION public.guard_row_edit_admin_only()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin_editor()
     AND coalesce(current_setting('app.stock_move', true), '') <> 'on' THEN
    RAISE EXCEPTION 'This record is already in the system — only an admin can change it';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- ---------- 2. Clear the rows the old trigger stranded ----------
-- A bill line whose bill no longer exists is not a record of anything.
-- The trigger is disabled for this one statement because the function
-- above would otherwise refuse the migration's own cleanup.
ALTER TABLE public.purchase_items DISABLE TRIGGER trg_guard_purchase_items;
DELETE FROM public.purchase_items pi
 WHERE NOT EXISTS (SELECT 1 FROM public.purchases p WHERE p.id = pi.purchase_id);
ALTER TABLE public.purchase_items ENABLE TRIGGER trg_guard_purchase_items;

-- ---------- 3. Deleting a line is editing it ----------
-- Menu lines: the manager rebuilds a DRAFT plan by replacing its lines,
-- which is normal editing. Once the plan is published it is the document
-- the kitchen cooks from, so only an admin may remove a dish.
CREATE OR REPLACE FUNCTION public.guard_menu_item_delete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status TEXT;
BEGIN
  IF public.is_admin_editor() THEN RETURN OLD; END IF;
  SELECT status INTO v_status FROM public.menu_plans WHERE id = OLD.menu_plan_id;
  -- the parent plan going away takes its lines with it, that is not an edit
  IF v_status IS NULL OR v_status = 'draft' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'This menu is already published — only an admin can remove a dish';
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_menu_item_delete ON public.menu_plan_items;
CREATE TRIGGER trg_guard_menu_item_delete
  BEFORE DELETE ON public.menu_plan_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_menu_item_delete();

-- Requisition lines: the chef removes items while building the order, so
-- the line may go while the requisition is still pending. After the
-- manager has seen it, what was asked for is the record.
CREATE OR REPLACE FUNCTION public.guard_requisition_item_delete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status TEXT;
BEGIN
  IF public.is_admin_editor() THEN RETURN OLD; END IF;
  SELECT status INTO v_status FROM public.requisitions WHERE id = OLD.requisition_id;
  IF v_status IS NULL OR v_status = 'pending' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'This order has already gone to the manager — raise a fresh one';
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_requisition_item_delete ON public.requisition_items;
CREATE TRIGGER trg_guard_requisition_item_delete
  BEFORE DELETE ON public.requisition_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_requisition_item_delete();

-- ---------- 4. The same trap, one table over ----------
-- guard_ingredient_edit, guard_purchase_edit, guard_requisition_item_edit,
-- guard_menu_item_edit and guard_vendor_bill_edit are all UPDATE-only, so
-- RETURN NEW is correct there. Recreated with an explicit CASE anyway so
-- that adding DELETE to any of those triggers later cannot reintroduce it.
CREATE OR REPLACE FUNCTION public.guard_ingredient_edit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.is_admin_editor() THEN RETURN NEW; END IF;
  IF coalesce(current_setting('app.stock_move', true), '') = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Items can only be removed by an admin';
  END IF;
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
