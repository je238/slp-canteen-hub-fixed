-- ============================================================
-- WEEKLY MENU PLAN
--
-- The kitchen's menu rotates by weekday (Monday lunch is not
-- Tuesday lunch), so plate-count deduction must pick the recipe
-- by the entry's day of week. The plan is per canteen (every
-- client company eats from the same kitchen).
--
-- Resolution order for a plate entry's recipe:
--   1. meal_plan (canteen, meal_type, weekday of entry_date)
--   2. corporate_meal_rates.recipe_id (fallback / default thali)
--   3. none → billing only, no stock deduction
--
-- Safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.meal_plan (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canteen_id UUID NOT NULL REFERENCES public.canteens(id) ON DELETE CASCADE,
  meal_type  TEXT NOT NULL,
  weekday    INT NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Sunday (Postgres DOW)
  recipe_id  UUID REFERENCES public.recipes(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (canteen_id, meal_type, weekday)
);

ALTER TABLE public.meal_plan ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "meal_plan_staff_select" ON public.meal_plan;
DROP POLICY IF EXISTS "meal_plan_manager_write" ON public.meal_plan;
CREATE POLICY "meal_plan_staff_select" ON public.meal_plan FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "meal_plan_manager_write" ON public.meal_plan FOR ALL TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

-- Re-create the deduction trigger with weekday-plan resolution.
CREATE OR REPLACE FUNCTION public.process_meal_entry()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_recipe UUID;
  v_yield NUMERIC;
  v_delta INT;
  v_ri RECORD;
  v_qty NUMERIC;
  v_new_stock NUMERIC;
  v_label TEXT;
  v_date DATE;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.corporate_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'This entry is already on an invoice and cannot be changed.';
  END IF;
  IF TG_OP = 'DELETE' AND OLD.corporate_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'This entry is already on an invoice and cannot be deleted.';
  END IF;

  v_delta := CASE TG_OP
    WHEN 'INSERT' THEN NEW.plates
    WHEN 'UPDATE' THEN NEW.plates - OLD.plates
    ELSE -OLD.plates
  END;

  IF v_delta = 0 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_date := COALESCE(NEW.entry_date, OLD.entry_date);

  -- 1) this weekday's menu; 2) the meal's default thali
  SELECT p.recipe_id INTO v_recipe
  FROM public.meal_plan p
  WHERE p.canteen_id = COALESCE(NEW.canteen_id, OLD.canteen_id)
    AND p.meal_type = COALESCE(NEW.meal_type, OLD.meal_type)
    AND p.weekday = EXTRACT(DOW FROM v_date)::int
    AND p.recipe_id IS NOT NULL
  LIMIT 1;

  IF v_recipe IS NULL THEN
    SELECT r.recipe_id INTO v_recipe
    FROM public.corporate_meal_rates r
    WHERE r.corporate_account_id = COALESCE(NEW.corporate_account_id, OLD.corporate_account_id)
      AND r.meal_type = COALESCE(NEW.meal_type, OLD.meal_type)
    LIMIT 1;
  END IF;

  IF v_recipe IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT greatest(coalesce(yield_qty, 1), 1) INTO v_yield FROM public.recipes WHERE id = v_recipe;
  v_label := COALESCE(NEW.meal_type, OLD.meal_type) || ' × ' || abs(v_delta)::text || ' plates ('
             || to_char(v_date, 'DD Mon') || ')';

  FOR v_ri IN
    SELECT ri.ingredient_id, ri.quantity
    FROM public.recipe_ingredients ri
    WHERE ri.recipe_id = v_recipe AND ri.ingredient_id IS NOT NULL
  LOOP
    v_qty := v_ri.quantity / v_yield * v_delta;

    UPDATE public.ingredients
    SET current_stock = current_stock - v_qty
    WHERE id = v_ri.ingredient_id
    RETURNING current_stock INTO v_new_stock;

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, reference_id)
    VALUES
      (v_ri.ingredient_id, COALESCE(NEW.canteen_id, OLD.canteen_id), -v_qty, v_new_stock,
       CASE WHEN v_delta > 0 THEN 'Plate count: ' ELSE 'Plate count corrected: ' END || v_label,
       'recipe', COALESCE(NEW.id, OLD.id));
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$$;
