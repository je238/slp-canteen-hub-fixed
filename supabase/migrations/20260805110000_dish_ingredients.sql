-- ============================================================
-- WHAT EACH DISH NEEDS, UNDER THE DISH
--
-- The chef gets the whole day at once and cooks it in order — breakfast
-- first, then lunch, and so on. For each dish they then have to work out
-- what to draw from the store, from memory, and type it into an order.
--
-- The recipe tables existed and were completely empty, so nothing linked a
-- dish to its ingredients. The menus arrive as plain text from a scan or a
-- WhatsApp paste, with recipe_id null.
--
-- Rather than ask anyone to type a hundred recipes up front, the book fills
-- itself: the first time the chef says what "Poha" takes, that becomes the
-- recipe, and every future "Poha" on any menu — scanned, pasted or typed —
-- picks it up by name. The kitchen gets easier every week instead of
-- needing a week of data entry before it is useful at all.
--
-- Safe to re-run.
-- ============================================================

-- ---------- 1. A dish finds its recipe by name ----------
CREATE OR REPLACE FUNCTION public.link_dish_recipe()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_canteen UUID; v_recipe UUID;
BEGIN
  IF NEW.recipe_id IS NOT NULL THEN RETURN NEW; END IF;

  SELECT canteen_id INTO v_canteen FROM public.menu_plans WHERE id = NEW.menu_plan_id;
  IF v_canteen IS NULL THEN RETURN NEW; END IF;

  -- case and spacing are not how a cook distinguishes two dishes
  SELECT id INTO v_recipe FROM public.recipes
  WHERE canteen_id = v_canteen
    AND lower(btrim(name)) = lower(btrim(NEW.dish_name))
  LIMIT 1;

  NEW.recipe_id := v_recipe;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_link_dish_recipe ON public.menu_plan_items;
CREATE TRIGGER trg_link_dish_recipe
  BEFORE INSERT ON public.menu_plan_items
  FOR EACH ROW EXECUTE FUNCTION public.link_dish_recipe();

-- ---------- 2. Save what a dish takes, and link it everywhere ----------
-- One call: create or replace the recipe for a dish name, then attach it to
-- every menu line with that name that has not been cooked yet — including
-- the rest of a published week, so entering it once fixes the whole week.
CREATE OR REPLACE FUNCTION public.save_dish_recipe(
  p_canteen_id UUID,
  p_dish_name TEXT,
  p_items JSONB,             -- [{ingredient_id, quantity, unit}]
  p_yield_qty NUMERIC DEFAULT 1,
  p_yield_unit TEXT DEFAULT 'plate'
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_recipe UUID; v_name TEXT := btrim(p_dish_name); v_linked INT; v_it JSONB;
BEGIN
  IF NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'You cannot change recipes for this site';
  END IF;
  IF v_name = '' THEN RAISE EXCEPTION 'The dish needs a name'; END IF;
  IF jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Add at least one ingredient';
  END IF;
  IF coalesce(p_yield_qty, 0) <= 0 THEN
    RAISE EXCEPTION 'How much this makes must be more than zero';
  END IF;

  SELECT id INTO v_recipe FROM public.recipes
  WHERE canteen_id = p_canteen_id AND lower(btrim(name)) = lower(v_name) LIMIT 1;

  IF v_recipe IS NULL THEN
    INSERT INTO public.recipes (canteen_id, name, yield_qty, yield_unit)
    VALUES (p_canteen_id, v_name, p_yield_qty, p_yield_unit)
    RETURNING id INTO v_recipe;
  ELSE
    UPDATE public.recipes SET yield_qty = p_yield_qty, yield_unit = p_yield_unit,
           updated_at = now()
    WHERE id = v_recipe;
    DELETE FROM public.recipe_ingredients WHERE recipe_id = v_recipe;
  END IF;

  FOR v_it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO public.recipe_ingredients (recipe_id, ingredient_id, quantity, unit)
    VALUES (v_recipe,
            (v_it->>'ingredient_id')::uuid,
            coalesce((v_it->>'quantity')::numeric, 0),
            coalesce(v_it->>'unit', 'kg'));
  END LOOP;

  -- attach to menu lines still to be cooked
  UPDATE public.menu_plan_items mi SET recipe_id = v_recipe
  FROM public.menu_plans m
  WHERE mi.menu_plan_id = m.id
    AND m.canteen_id = p_canteen_id
    AND mi.recipe_id IS NULL
    AND lower(btrim(mi.dish_name)) = lower(v_name)
    AND m.menu_date >= timezone('Asia/Kolkata', now())::date;
  GET DIAGNOSTICS v_linked = ROW_COUNT;

  RETURN jsonb_build_object('recipe_id', v_recipe, 'menu_lines_linked', v_linked);
END;
$$;
REVOKE ALL ON FUNCTION public.save_dish_recipe(UUID, TEXT, JSONB, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_dish_recipe(UUID, TEXT, JSONB, NUMERIC, TEXT) TO authenticated;

-- ---------- 3. The day, in the order it is cooked ----------
-- Each meal, each dish, and under the dish what it takes — scaled to the
-- quantity the manager asked for, or to the plate count when the recipe is
-- written per plate.
CREATE OR REPLACE FUNCTION public.day_kitchen_plan(p_canteen_id UUID, p_date DATE)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH ord AS (
    SELECT * FROM (VALUES
      ('tea', 1), ('breakfast', 2), ('lunch', 3),
      ('evening_snacks', 4), ('dinner', 5), ('night_snacks', 6)
    ) AS t(period, seq)
  ),
  dish AS (
    SELECT
      m.id AS plan_id, m.meal_period, m.status,
      coalesce(m.actual_headcount, m.expected_headcount, 0) AS heads,
      mi.id AS item_id, mi.dish_name, mi.planned_qty, mi.unit, mi.recipe_id,
      r.yield_qty, r.yield_unit,
      -- a recipe written per plate scales with the headcount; one written in
      -- kg scales with how much of the dish is being made
      CASE
        WHEN r.id IS NULL THEN NULL
        WHEN lower(coalesce(r.yield_unit, '')) IN ('plate', 'plates', 'pax')
          THEN coalesce(m.actual_headcount, m.expected_headcount, 0)::numeric
               / nullif(r.yield_qty, 0)
        ELSE coalesce(mi.planned_qty, r.yield_qty) / nullif(r.yield_qty, 0)
      END AS scale
    FROM public.menu_plans m
    JOIN public.menu_plan_items mi ON mi.menu_plan_id = m.id
    LEFT JOIN public.recipes r ON r.id = mi.recipe_id
    WHERE m.canteen_id = p_canteen_id AND m.menu_date = p_date
      AND m.status <> 'draft'
  )
  SELECT coalesce(jsonb_agg(meal ORDER BY seq), '[]'::jsonb) FROM (
    SELECT o.seq, jsonb_build_object(
      'meal_period', d.meal_period,
      'plan_id', min(d.plan_id::text),
      'headcount', max(d.heads),
      'dishes', jsonb_agg(jsonb_build_object(
        'item_id', d.item_id,
        'dish_name', d.dish_name,
        'planned_qty', d.planned_qty,
        'unit', d.unit,
        'has_recipe', d.recipe_id IS NOT NULL,
        'ingredients', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
                   'ingredient_id', ri.ingredient_id,
                   'name', i.name,
                   'unit', coalesce(ri.unit, i.unit),
                   'qty', round(ri.quantity * coalesce(d.scale, 1), 3),
                   'in_stock', i.current_stock,
                   'rate', i.cost_per_unit
                 ) ORDER BY i.name)
          FROM public.recipe_ingredients ri
          JOIN public.ingredients i ON i.id = ri.ingredient_id
          WHERE ri.recipe_id = d.recipe_id
        ), '[]'::jsonb)
      ) ORDER BY d.dish_name)
    ) AS meal
    FROM dish d JOIN ord o ON o.period = d.meal_period
    GROUP BY o.seq, d.meal_period
  ) x;
$$;
REVOKE ALL ON FUNCTION public.day_kitchen_plan(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.day_kitchen_plan(UUID, DATE) TO authenticated;
