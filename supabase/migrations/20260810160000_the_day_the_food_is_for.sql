-- ============================================================
-- THE DAY THE FOOD IS FOR
--
-- The store keeper issues between 6 and 7 in the evening, and what he hands
-- over is tomorrow's order. So the goods leave the store on Monday and the
-- meal is served on Tuesday.
--
-- Every report dated consumption by the day the goods MOVED, and headcount by
-- the day the meal was SERVED. Which means cost per head was, every single
-- day, tomorrow's food divided by today's people. On a steady week that
-- roughly cancels and hides itself. It stops cancelling exactly when it
-- matters:
--
--   * a Sunday or a holiday — nothing served tomorrow, but stock still went
--     out tonight, so today reads as a day of enormous waste
--   * the last day of a month — the issue for the 1st lands in this month's
--     consumption, so no month ever closes against its own food
--   * any day the headcount really moves — the two sides are measuring
--     different days, so the per-head check fires on nothing
--
-- In a system whose job is to make theft visible, a per-head figure that
-- swings on the calendar rather than on the shelf trains everyone to ignore
-- it. Then the one day it fires for real, nobody looks.
--
-- So the ledger now records the day the food is FOR, alongside the day it
-- moved. Both are true and both are kept; the reports ask for the first.
--
-- It also records what each movement was actually worth. daily_reconciliation
-- and operations_summary were still valuing consumption at the newest rate
-- paid — the very thing the screens were just moved off — so the reports
-- could disagree with the screens again. A movement's value is a fact about
-- that movement, so it is written down when it happens.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.stock_ledger
  ADD COLUMN IF NOT EXISTS service_date DATE,
  ADD COLUMN IF NOT EXISTS value NUMERIC;

COMMENT ON COLUMN public.stock_ledger.service_date IS
  'The day this stock is for — the menu date it was issued against. Differs '
  'from created_at whenever the store issues ahead of service.';
COMMENT ON COLUMN public.stock_ledger.value IS
  'What this movement was worth, oldest lot first for issues and the invoice '
  'rate for receipts. Written when it happens, never recalculated later.';

CREATE INDEX IF NOT EXISTS idx_stock_ledger_service_date
  ON public.stock_ledger (canteen_id, service_date);

-- The immutability guard lists the columns that may never change. These two
-- are facts about the movement, so they belong under it like the rest.
CREATE OR REPLACE FUNCTION public.guard_stock_ledger_update()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.ingredient_id IS DISTINCT FROM OLD.ingredient_id
     OR NEW.canteen_id  IS DISTINCT FROM OLD.canteen_id
     OR NEW.change_qty  IS DISTINCT FROM OLD.change_qty
     OR NEW.balance_after IS DISTINCT FROM OLD.balance_after
     OR NEW.reference_type IS DISTINCT FROM OLD.reference_type
     OR NEW.service_date IS DISTINCT FROM OLD.service_date
     OR NEW.value       IS DISTINCT FROM OLD.value
     OR NEW.created_at  IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Stock movements cannot be edited — only reviewed';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------- Issue: stamp the day it is for, and what it cost ----------
CREATE OR REPLACE FUNCTION public.issue_requisition(p_req_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.requisitions%ROWTYPE; v_line RECORD; v_new NUMERIC;
        v_n INT := 0; v_cost NUMERIC; v_total NUMERIC := 0; v_short TEXT := '';
        v_for DATE;
BEGIN
  SELECT * INTO v_req FROM public.requisitions WHERE id = p_req_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown requisition'; END IF;
  IF v_req.status = 'issued' THEN RETURN jsonb_build_object('already', true); END IF;
  IF v_req.status <> 'approved' THEN
    RAISE EXCEPTION 'Only an approved requisition can be issued (current status: %)', v_req.status;
  END IF;
  IF NOT public.can_issue_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can issue stock';
  END IF;
  IF NOT public.can_access_canteen(v_req.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  -- The day this food will actually be eaten. The menu the chef ordered
  -- against knows it; without one, the requisition's own date is the best
  -- available answer, and that is the same day it is issued.
  SELECT m.menu_date INTO v_for
  FROM public.menu_plans m WHERE m.id = v_req.menu_plan_id;
  v_for := coalesce(v_for, v_req.req_date,
                    (now() AT TIME ZONE 'Asia/Kolkata')::date);

  -- Check the whole order before moving any of it, so a short line does not
  -- leave half a requisition issued.
  SELECT string_agg(format('%s: asked %s, only %s on the shelf',
                           i.name, ri.approved_qty, i.current_stock), '; ')
  INTO v_short
  FROM public.requisition_items ri
  JOIN public.ingredients i ON i.id = ri.ingredient_id
  WHERE ri.requisition_id = p_req_id
    AND coalesce(ri.approved_qty, 0) > 0
    AND i.current_stock < ri.approved_qty;

  IF coalesce(v_short, '') <> '' THEN
    RAISE EXCEPTION
      'Not enough stock to issue this order — %. Record the delivery first, then issue.', v_short;
  END IF;

  PERFORM public.allow_stock_move();

  FOR v_line IN
    SELECT ri.id, ri.ingredient_id, coalesce(ri.approved_qty, 0) AS qty, i.name
    FROM public.requisition_items ri JOIN public.ingredients i ON i.id = ri.ingredient_id
    WHERE ri.requisition_id = p_req_id AND coalesce(ri.approved_qty, 0) > 0
    ORDER BY ri.ingredient_id
  LOOP
    UPDATE public.ingredients SET current_stock = current_stock - v_line.qty
      WHERE id = v_line.ingredient_id AND canteen_id = v_req.canteen_id
      RETURNING current_stock INTO v_new;
    IF NOT FOUND THEN RAISE EXCEPTION 'Ingredient % does not belong to this site', v_line.name; END IF;

    v_cost := public.consume_batches_fifo(v_line.ingredient_id, v_req.canteen_id, v_line.qty);
    v_total := v_total + v_cost;

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason,
       reference_type, reference_id, created_by, service_date, value)
    VALUES (v_line.ingredient_id, v_req.canteen_id, -v_line.qty, v_new,
            'Requisition #' || v_req.req_no || ' issued to kitchen',
            'issue', p_req_id, auth.uid(), v_for, round(v_cost, 2));

    UPDATE public.requisition_items
       SET issued_qty = v_line.qty, issued_value = round(v_cost, 2)
     WHERE id = v_line.id;
    v_n := v_n + 1;
  END LOOP;

  UPDATE public.requisitions SET status = 'issued', issued_by = auth.uid(), issued_at = now()
  WHERE id = p_req_id;
  RETURN jsonb_build_object('issued_lines', v_n, 'fifo_value', round(v_total, 2),
                            'for_date', v_for);
END;
$$;

-- ---------- Receipts: goods are for the day they arrive ----------
-- A delivery is not "for" a future menu — it sits on the shelf until someone
-- draws it. So service_date is the day it came in, and the value is what the
-- bill said.
CREATE OR REPLACE FUNCTION public.add_stock_from_invoice(
  p_canteen_id UUID, p_supplier_id UUID, p_items JSONB,
  p_notes TEXT DEFAULT NULL, p_image_path TEXT DEFAULT NULL, p_total NUMERIC DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_purchase UUID; v_line RECORD; v_ing UUID; v_new NUMERIC;
  v_created INT := 0; v_topped INT := 0; v_sum NUMERIC := 0;
  v_today DATE := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF NOT public.can_receive_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can take stock in';
  END IF;
  IF NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;
  PERFORM public.allow_stock_move();

  SELECT coalesce(sum((e->>'total')::numeric), 0) INTO v_sum
  FROM jsonb_array_elements(p_items) e;

  INSERT INTO public.purchases
    (canteen_id, supplier_id, total_amount, notes, invoice_image_url, status, approved_at, created_by)
  VALUES (p_canteen_id, p_supplier_id, coalesce(p_total, v_sum), p_notes, p_image_path,
          'confirmed', now(), auth.uid())
  RETURNING id INTO v_purchase;

  FOR v_line IN
    SELECT nullif(btrim(e->>'name'), '') AS name,
           coalesce((e->>'quantity')::numeric, 0) AS qty,
           coalesce(nullif(e->>'unit', ''), 'kg') AS unit,
           coalesce((e->>'rate')::numeric, 0) AS rate,
           coalesce((e->>'total')::numeric, 0) AS total,
           coalesce(nullif(e->>'category', ''), 'Uncategorised') AS category
    FROM jsonb_array_elements(p_items) e
  LOOP
    CONTINUE WHEN v_line.name IS NULL OR v_line.qty <= 0;

    SELECT id INTO v_ing FROM public.ingredients
    WHERE canteen_id = p_canteen_id AND lower(btrim(name)) = lower(v_line.name) LIMIT 1;

    IF v_ing IS NULL THEN
      INSERT INTO public.ingredients
        (canteen_id, name, category, unit, current_stock, minimum_stock, cost_per_unit)
      VALUES (p_canteen_id, v_line.name, v_line.category, v_line.unit, 0, 0, v_line.rate)
      RETURNING id INTO v_ing;
      v_created := v_created + 1;
    ELSE
      v_topped := v_topped + 1;
    END IF;

    UPDATE public.ingredients
      SET current_stock = current_stock + v_line.qty,
          cost_per_unit = CASE WHEN v_line.rate > 0 THEN v_line.rate ELSE cost_per_unit END
      WHERE id = v_ing RETURNING current_stock INTO v_new;

    INSERT INTO public.purchase_items
      (purchase_id, item_name, quantity, unit, rate, total, ingredient_id)
    VALUES (v_purchase, v_line.name, v_line.qty, v_line.unit, v_line.rate, v_line.total, v_ing);

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason,
       reference_type, reference_id, created_by, service_date, value)
    VALUES (v_ing, p_canteen_id, v_line.qty, v_new,
            'Invoice stock-in — ' || v_line.name, 'purchase', v_purchase, auth.uid(),
            v_today, round(v_line.qty * v_line.rate, 2));

    INSERT INTO public.ingredient_batches
      (ingredient_id, canteen_id, supplier_id, purchase_id, qty_received, qty_remaining, rate)
    VALUES (v_ing, p_canteen_id, p_supplier_id, v_purchase, v_line.qty, v_line.qty, v_line.rate);
  END LOOP;

  RETURN jsonb_build_object('purchase_id', v_purchase, 'new_items', v_created,
                            'existing_items', v_topped, 'total', coalesce(p_total, v_sum));
END;
$$;

-- ---------- Reports ask for the day the food was for ----------
-- coalesce keeps every movement written before today counting exactly as it
-- did — an unstamped row falls back to the day it moved, which for those rows
-- is all anyone ever knew.
-- Left as SECURITY INVOKER, as it has always been: the row-level rules on
-- stock_ledger already decide what this caller may see, and switching it to
-- DEFINER would quietly hand every signed-in user every site's numbers.
CREATE OR REPLACE FUNCTION public.daily_reconciliation(p_canteen_id UUID, p_date DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_in NUMERIC; v_out NUMERIC; v_stock NUMERIC; v_heads INT;
BEGIN

  SELECT coalesce(sum(coalesce(l.value, l.change_qty * r.latest_rate)), 0) INTO v_in
  FROM public.stock_ledger l
  JOIN public.ingredient_rates r ON r.ingredient_id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type = 'purchase'
    AND coalesce(l.service_date,
                 (l.created_at AT TIME ZONE 'Asia/Kolkata')::date) = p_date;

  SELECT coalesce(sum(coalesce(abs(l.value), -l.change_qty * r.latest_rate)), 0) INTO v_out
  FROM public.stock_ledger l
  JOIN public.ingredient_rates r ON r.ingredient_id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('issue','recipe')
    AND l.change_qty < 0
    AND coalesce(l.service_date,
                 (l.created_at AT TIME ZONE 'Asia/Kolkata')::date) = p_date;

  SELECT coalesce(sum(stock_value), 0) INTO v_stock
  FROM public.ingredient_rates WHERE canteen_id = p_canteen_id;

  SELECT coalesce(sum(coalesce(actual_headcount, expected_headcount, 0)), 0) INTO v_heads
  FROM public.menu_plans WHERE canteen_id = p_canteen_id AND menu_date = p_date;

  RETURN jsonb_build_object(
    'date', p_date,
    'stock_in_value', round(v_in, 2),
    'consumption_value', round(v_out, 2),
    'closing_stock_value', round(v_stock, 2),
    'headcount', v_heads,
    'cost_per_head', CASE WHEN v_heads > 0 THEN round(v_out / v_heads, 2) END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.operations_summary(p_canteen_id UUID, p_start DATE, p_end DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_heads BIGINT; v_revenue NUMERIC; v_consumption NUMERIC;
  v_purchase NUMERIC; v_meals BIGINT; v_wastage NUMERIC; v_reqs BIGINT;
BEGIN
  -- This one runs as its owner and had no site check at all, so any signed-in
  -- user could ask it for any site's revenue and food cost. It has one now.
  IF NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;

  v_revenue := public.computed_sale(p_canteen_id, p_start, p_end);
  IF v_revenue = 0 THEN
    SELECT coalesce(sum(amount), 0) INTO v_revenue
    FROM public.meal_entries
    WHERE canteen_id = p_canteen_id AND entry_date BETWEEN p_start AND p_end;
  END IF;

  SELECT coalesce(sum(coalesce(actual_headcount, expected_headcount, 0)), 0), count(*)
  INTO v_heads, v_meals
  FROM public.menu_plans
  WHERE canteen_id = p_canteen_id AND menu_date BETWEEN p_start AND p_end
    AND status <> 'draft';

  -- Dated by the day the food was for, and valued at what it actually cost,
  -- so this figure and the headcount above are finally measuring the same
  -- meals.
  SELECT coalesce(sum(coalesce(abs(l.value), -l.change_qty * coalesce(i.cost_per_unit, 0))), 0)
  INTO v_consumption
  FROM public.stock_ledger l JOIN public.ingredients i ON i.id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('recipe','issue')
    AND l.change_qty < 0
    AND coalesce(l.service_date,
                 (l.created_at AT TIME ZONE 'Asia/Kolkata')::date) BETWEEN p_start AND p_end;

  SELECT coalesce(sum(total_amount), 0) INTO v_purchase
  FROM public.purchases
  WHERE canteen_id = p_canteen_id AND status = 'confirmed'
    AND created_at >= (p_start::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND created_at <  ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');

  SELECT coalesce(sum(mi.wastage_qty), 0) INTO v_wastage
  FROM public.menu_plan_items mi JOIN public.menu_plans m ON m.id = mi.menu_plan_id
  WHERE m.canteen_id = p_canteen_id AND m.menu_date BETWEEN p_start AND p_end;

  SELECT count(*) INTO v_reqs FROM public.requisitions
  WHERE canteen_id = p_canteen_id AND req_date BETWEEN p_start AND p_end;

  RETURN jsonb_build_object(
    'headcount', v_heads,
    'meals_served', v_meals,
    'revenue', v_revenue,
    'consumption', v_consumption,
    'purchase', v_purchase,
    'wastage_qty', v_wastage,
    'requisitions', v_reqs,
    'cost_per_person', CASE WHEN v_heads > 0 THEN round(v_consumption / v_heads, 2) END,
    'revenue_per_person', CASE WHEN v_heads > 0 THEN round(v_revenue / v_heads, 2) END,
    'food_cost_pct', CASE WHEN v_revenue > 0 THEN round(v_consumption * 100 / v_revenue, 2) END,
    'margin_per_person', CASE WHEN v_heads > 0
                              THEN round((v_revenue - v_consumption) / v_heads, 2) END
  );
END;
$$;
