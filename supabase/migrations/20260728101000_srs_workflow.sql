-- ============================================================
-- SRS CORE WORKFLOW
--
--   Unit Manager plans the menu + headcount   (menu_plans)
--        ↓ publish
--   Chef sees it, records production, raises a raw-material
--   requisition                                (requisitions)
--        ↓
--   Unit Manager reviews, may adjust each line by ±7% ONLY,
--   then approves                              (DB-enforced)
--        ↓
--   Store Keeper issues stock; inventory + ledger update
--   atomically in one transaction              (issue_requisition)
--
-- Safe to re-run.
-- ============================================================

-- ---------- 1. Menu planning ----------
CREATE TABLE IF NOT EXISTS public.menu_plans (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canteen_id         UUID NOT NULL REFERENCES public.canteens(id) ON DELETE CASCADE,
  menu_date          DATE NOT NULL,
  meal_period        TEXT NOT NULL CHECK (meal_period IN
                       ('breakfast','lunch','evening_snacks','tea','dinner','night_snacks')),
  expected_headcount INT NOT NULL DEFAULT 0 CHECK (expected_headcount >= 0),
  actual_headcount   INT,
  status             TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','published','in_production','completed')),
  notes              TEXT,
  published_at       TIMESTAMPTZ,
  created_by         UUID DEFAULT auth.uid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (canteen_id, menu_date, meal_period)
);

CREATE TABLE IF NOT EXISTS public.menu_plan_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_plan_id  UUID NOT NULL REFERENCES public.menu_plans(id) ON DELETE CASCADE,
  recipe_id     UUID REFERENCES public.recipes(id) ON DELETE SET NULL,
  dish_name     TEXT NOT NULL,
  planned_qty   NUMERIC,
  unit          TEXT,
  produced_qty  NUMERIC,          -- filled by the chef
  produced_at   TIMESTAMPTZ,
  wastage_qty   NUMERIC,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_menu_plans_site_date ON public.menu_plans (canteen_id, menu_date);

-- ---------- 2. Requisitions ----------
CREATE TABLE IF NOT EXISTS public.requisitions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canteen_id     UUID NOT NULL REFERENCES public.canteens(id) ON DELETE CASCADE,
  menu_plan_id   UUID REFERENCES public.menu_plans(id) ON DELETE SET NULL,
  req_no         BIGINT GENERATED ALWAYS AS IDENTITY,
  req_date       DATE NOT NULL DEFAULT current_date,
  meal_period    TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected','issued','cancelled')),
  requested_by   UUID DEFAULT auth.uid(),
  reviewed_by    UUID,
  reviewed_at    TIMESTAMPTZ,
  issued_by      UUID,
  issued_at      TIMESTAMPTZ,
  notes          TEXT,
  review_notes   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.requisition_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id  UUID NOT NULL REFERENCES public.requisitions(id) ON DELETE CASCADE,
  ingredient_id   UUID NOT NULL REFERENCES public.ingredients(id),
  requested_qty   NUMERIC NOT NULL CHECK (requested_qty > 0),
  approved_qty    NUMERIC,
  issued_qty      NUMERIC,
  unit            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_requisitions_site_date ON public.requisitions (canteen_id, req_date DESC);
CREATE INDEX IF NOT EXISTS idx_requisition_items_req ON public.requisition_items (requisition_id);

-- ---------- 3. The ±7% rule, enforced by the database ----------
-- A manager may trim or pad a chef's request, but only within ±7%. Anything
-- outside that band has to go back to the chef — the UI cannot override this.
CREATE OR REPLACE FUNCTION public.enforce_requisition_tolerance()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_status TEXT;
BEGIN
  IF NEW.approved_qty IS NULL THEN RETURN NEW; END IF;

  IF NEW.approved_qty < 0 THEN
    RAISE EXCEPTION 'Approved quantity cannot be negative';
  END IF;

  -- 0 is allowed (line rejected outright); otherwise stay inside ±7%
  IF NEW.approved_qty > 0 AND
     (NEW.approved_qty < NEW.requested_qty * 0.93 OR
      NEW.approved_qty > NEW.requested_qty * 1.07) THEN
    RAISE EXCEPTION
      'Approved quantity % is outside the allowed ±7%% of the requested %. Send it back to the chef instead.',
      NEW.approved_qty, NEW.requested_qty;
  END IF;

  -- Once issued, quantities are frozen
  SELECT status INTO v_status FROM public.requisitions WHERE id = NEW.requisition_id;
  IF TG_OP = 'UPDATE' AND v_status = 'issued'
     AND NEW.approved_qty IS DISTINCT FROM OLD.approved_qty THEN
    RAISE EXCEPTION 'This requisition has already been issued and cannot be changed.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_requisition_tolerance ON public.requisition_items;
CREATE TRIGGER trg_requisition_tolerance
  BEFORE INSERT OR UPDATE ON public.requisition_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_requisition_tolerance();

-- ---------- 4. Store keeper issues the approved requisition ----------
-- Atomic: deducts every approved line, writes the ledger, stamps the header.
CREATE OR REPLACE FUNCTION public.issue_requisition(p_req_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_req public.requisitions%ROWTYPE; v_line RECORD; v_new NUMERIC; v_n INT := 0;
BEGIN
  SELECT * INTO v_req FROM public.requisitions WHERE id = p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown requisition'; END IF;
  IF v_req.status = 'issued' THEN
    RETURN jsonb_build_object('already', true);
  END IF;
  IF v_req.status <> 'approved' THEN
    RAISE EXCEPTION 'Only an approved requisition can be issued (current status: %)', v_req.status;
  END IF;
  IF NOT public.is_store_keeper_or_above() THEN
    RAISE EXCEPTION 'Only the store keeper can issue stock';
  END IF;

  FOR v_line IN
    SELECT ri.id, ri.ingredient_id, coalesce(ri.approved_qty, 0) AS qty, i.name
    FROM public.requisition_items ri
    JOIN public.ingredients i ON i.id = ri.ingredient_id
    WHERE ri.requisition_id = p_req_id AND coalesce(ri.approved_qty, 0) > 0
    ORDER BY ri.ingredient_id            -- stable order avoids deadlocks
  LOOP
    UPDATE public.ingredients
      SET current_stock = current_stock - v_line.qty
      WHERE id = v_line.ingredient_id AND canteen_id = v_req.canteen_id
      RETURNING current_stock INTO v_new;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Ingredient % does not belong to this site', v_line.name;
    END IF;

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, reference_id)
    VALUES (v_line.ingredient_id, v_req.canteen_id, -v_line.qty, v_new,
            'Requisition #' || v_req.req_no || ' issued to kitchen', 'issue', p_req_id);

    UPDATE public.requisition_items SET issued_qty = v_line.qty WHERE id = v_line.id;
    v_n := v_n + 1;
  END LOOP;

  UPDATE public.requisitions
    SET status = 'issued', issued_by = auth.uid(), issued_at = now()
    WHERE id = p_req_id;

  RETURN jsonb_build_object('issued_lines', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.issue_requisition(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_requisition(UUID) TO authenticated;

-- ---------- 5. RLS ----------
ALTER TABLE public.menu_plans        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_plan_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requisitions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requisition_items ENABLE ROW LEVEL SECURITY;

-- Menus: everyone on site reads; unit manager+ writes; chef records production
DROP POLICY IF EXISTS "menu_plans_select" ON public.menu_plans;
DROP POLICY IF EXISTS "menu_plans_manager_write" ON public.menu_plans;
DROP POLICY IF EXISTS "menu_plans_chef_update" ON public.menu_plans;
CREATE POLICY "menu_plans_select" ON public.menu_plans FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "menu_plans_manager_write" ON public.menu_plans FOR ALL TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));
CREATE POLICY "menu_plans_chef_update" ON public.menu_plans FOR UPDATE TO authenticated
  USING (public.is_chef() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_chef() AND public.can_access_canteen(canteen_id));

DROP POLICY IF EXISTS "menu_plan_items_select" ON public.menu_plan_items;
DROP POLICY IF EXISTS "menu_plan_items_write" ON public.menu_plan_items;
CREATE POLICY "menu_plan_items_select" ON public.menu_plan_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.menu_plans m
                 WHERE m.id = menu_plan_id AND public.can_access_canteen(m.canteen_id)));
CREATE POLICY "menu_plan_items_write" ON public.menu_plan_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.menu_plans m
                 WHERE m.id = menu_plan_id AND public.can_access_canteen(m.canteen_id)
                   AND (public.is_manager_or_above() OR public.is_chef())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.menu_plans m
                 WHERE m.id = menu_plan_id AND public.can_access_canteen(m.canteen_id)
                   AND (public.is_manager_or_above() OR public.is_chef())));

-- Requisitions: chef raises, manager reviews, store keeper issues
DROP POLICY IF EXISTS "requisitions_select" ON public.requisitions;
DROP POLICY IF EXISTS "requisitions_chef_insert" ON public.requisitions;
DROP POLICY IF EXISTS "requisitions_update" ON public.requisitions;
CREATE POLICY "requisitions_select" ON public.requisitions FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));
CREATE POLICY "requisitions_chef_insert" ON public.requisitions FOR INSERT TO authenticated
  WITH CHECK (public.can_access_canteen(canteen_id) AND public.is_store_keeper_or_above());
CREATE POLICY "requisitions_update" ON public.requisitions FOR UPDATE TO authenticated
  USING (public.can_access_canteen(canteen_id) AND public.is_store_keeper_or_above())
  WITH CHECK (public.can_access_canteen(canteen_id) AND public.is_store_keeper_or_above());

DROP POLICY IF EXISTS "requisition_items_select" ON public.requisition_items;
DROP POLICY IF EXISTS "requisition_items_write" ON public.requisition_items;
CREATE POLICY "requisition_items_select" ON public.requisition_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.requisitions r
                 WHERE r.id = requisition_id AND public.can_access_canteen(r.canteen_id)));
CREATE POLICY "requisition_items_write" ON public.requisition_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.requisitions r
                 WHERE r.id = requisition_id AND public.can_access_canteen(r.canteen_id)
                   AND public.is_store_keeper_or_above()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.requisitions r
                 WHERE r.id = requisition_id AND public.can_access_canteen(r.canteen_id)
                   AND public.is_store_keeper_or_above()));
