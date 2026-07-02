-- ============================================================
-- INGREDIENT DEDUCTION FIX + RESTOCK ON CANCELLED ORDERS
--
-- 1. process_order_item (existed on the live DB but not in this
--    repo) deducts recipe ingredients whenever an order item is
--    inserted. It had a fatal bug: it never set canteen_id on
--    ingredient_usage_log, whose NOT NULL constraint then aborted
--    the entire sale for any recipe-linked menu item. Redefined
--    here with the fix.
--
-- 2. The Kitchen Display allows cancelling orders, so a
--    cancellation must put the deducted stock back — otherwise
--    cancelled food silently drains inventory. Reversal amounts
--    come from ingredient_usage_log, so the restock exactly
--    mirrors the deduction; a stock_ledger guard prevents double
--    restock.
-- ============================================================

CREATE OR REPLACE FUNCTION public.process_order_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  r_id UUID;
  o_canteen UUID;
  r_ing RECORD;
  usage_qty NUMERIC;
BEGIN
  SELECT recipe_id INTO r_id FROM public.menu_items WHERE id = NEW.menu_item_id;
  SELECT canteen_id INTO o_canteen FROM public.orders WHERE id = NEW.order_id;

  IF r_id IS NOT NULL THEN
    FOR r_ing IN
      WITH RECURSIVE recipe_tree AS (
        SELECT ingredient_id, sub_recipe_id, quantity, unit
        FROM public.recipe_ingredients
        WHERE recipe_id = r_id

        UNION ALL

        SELECT ri.ingredient_id, ri.sub_recipe_id, ri.quantity * rt.quantity, ri.unit
        FROM public.recipe_ingredients ri
        INNER JOIN recipe_tree rt ON rt.sub_recipe_id = ri.recipe_id
      )
      SELECT ingredient_id, SUM(quantity) AS calc_qty, MAX(unit) AS calc_unit
      FROM recipe_tree
      WHERE ingredient_id IS NOT NULL
      GROUP BY ingredient_id
    LOOP
      usage_qty := r_ing.calc_qty * NEW.quantity;

      INSERT INTO public.ingredient_usage_log (canteen_id, order_id, menu_item_id, ingredient_id, quantity_used, unit)
      VALUES (o_canteen, NEW.order_id, NEW.menu_item_id, r_ing.ingredient_id, usage_qty, r_ing.calc_unit);

      UPDATE public.ingredients
      SET current_stock = current_stock - usage_qty
      WHERE id = r_ing.ingredient_id;

      INSERT INTO public.stock_ledger (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, reference_id)
      SELECT r_ing.ingredient_id, o_canteen, -usage_qty, i.current_stock, 'POS Sale: ' || NEW.item_name, 'recipe', NEW.order_id
      FROM public.ingredients i
      WHERE i.id = r_ing.ingredient_id;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.restock_cancelled_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  IF NEW.kitchen_status = 'cancelled' AND OLD.kitchen_status IS DISTINCT FROM 'cancelled' THEN
    -- Already restocked once? (positive recipe ledger entry for this order)
    IF EXISTS (
      SELECT 1 FROM public.stock_ledger
      WHERE reference_id = NEW.id AND reference_type = 'recipe' AND change_qty > 0
    ) THEN
      RETURN NEW;
    END IF;

    FOR r IN
      SELECT ingredient_id, SUM(quantity_used) AS qty
      FROM public.ingredient_usage_log
      WHERE order_id = NEW.id AND ingredient_id IS NOT NULL
      GROUP BY ingredient_id
    LOOP
      UPDATE public.ingredients
      SET current_stock = current_stock + r.qty
      WHERE id = r.ingredient_id;

      INSERT INTO public.stock_ledger
        (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, reference_id)
      SELECT r.ingredient_id, NEW.canteen_id, r.qty, i.current_stock,
             'Order #' || NEW.order_number || ' cancelled - restock', 'recipe', NEW.id
      FROM public.ingredients i
      WHERE i.id = r.ingredient_id;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_order_cancelled_restock ON public.orders;
CREATE TRIGGER on_order_cancelled_restock
  AFTER UPDATE OF kitchen_status ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.restock_cancelled_order();
