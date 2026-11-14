-- ============================================================
-- THE STORE RECORDS WHAT COMES BACK FROM, AND WHAT EXTRA GOES TO, THE KITCHEN
--
-- 14 Nov 2026, asked for at Eicher: the store keeper (and the manager) must
-- be able to enter two things themselves, without waiting for the chef:
--
--   1. Bacha saman wapas: the kitchen hands unused stock back. Until now only
--      the chef could start a return and the store keeper then accepted it.
--      When the store keeper is the one holding the sacks, that second step
--      is the same person twice, so the store records it and it goes straight
--      back on the shelf (through accept_return, so the lot, rate, ledger and
--      consumption figures are exactly what a chef-started return gives).
--      Still capped at what was issued on that order, so a return can never
--      invent stock.
--
--   2. Extra saman: the kitchen ran short mid-cooking and the store handed
--      over more. The chef's "Aur saman mangao" top-up still exists; this is
--      for when the goods have already gone. It is booked on the same order,
--      so that meal's consumption shows 20 + 5 = 25, the stock leaves by FIFO
--      like any issue, and a reason is required. The manager is told every
--      time the store keeper does it, because an extra draw that nobody sees
--      is exactly where ration goes missing.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.requisition_items
  ADD COLUMN IF NOT EXISTS store_extra_qty NUMERIC NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.requisition_items.store_extra_qty IS
  'Given to the kitchen by the store on top of the approved order (issue_extra_to_kitchen). Already included in approved_qty and issued_qty.';

-- ---------- 1. Store takes unused stock back from the kitchen ----------
CREATE OR REPLACE FUNCTION public.store_take_back_from_kitchen(
  p_requisition_id UUID,
  p_items JSONB,                 -- [{ingredient_id, qty}]
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_req public.requisitions%ROWTYPE; v_it JSONB; v_n INT := 0;
  v_issued NUMERIC; v_done NUMERIC; v_qty NUMERIC; v_unit TEXT; v_name TEXT;
  v_id UUID; v_value NUMERIC := 0; v_res JSONB;
BEGIN
  SELECT * INTO v_req FROM public.requisitions WHERE id = p_requisition_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order nahi mila'; END IF;
  IF NOT (public.can_receive_stock() AND public.can_access_canteen(v_req.canteen_id)) THEN
    RAISE EXCEPTION 'Sirf Store Keeper ya Manager kitchen se saman wapas le sakta hai';
  END IF;
  IF v_req.status NOT IN ('approved', 'issued') THEN
    RAISE EXCEPTION 'Is order se abhi koi saman diya hi nahi gaya';
  END IF;
  IF jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Items list chahiye';
  END IF;

  FOR v_it IN SELECT * FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) LOOP
    v_qty := coalesce((v_it->>'qty')::numeric, 0);
    CONTINUE WHEN v_qty <= 0;

    SELECT sum(coalesce(ri.issued_qty, 0)), max(coalesce(ri.unit, i.unit)), max(i.name)
      INTO v_issued, v_unit, v_name
      FROM public.requisition_items ri
      JOIN public.ingredients i ON i.id = ri.ingredient_id
     WHERE ri.requisition_id = p_requisition_id
       AND ri.ingredient_id = (v_it->>'ingredient_id')::uuid;
    IF coalesce(v_issued, 0) <= 0 THEN
      RAISE EXCEPTION 'Ye item is order mein kitchen ko diya hi nahi gaya';
    END IF;

    SELECT coalesce(sum(qty), 0) INTO v_done FROM public.kitchen_returns
     WHERE requisition_id = p_requisition_id
       AND ingredient_id = (v_it->>'ingredient_id')::uuid
       AND status IN ('pending', 'accepted');

    IF v_qty > v_issued - v_done + 1e-9 THEN
      RAISE EXCEPTION '% zyada se zyada % % wapas ho sakta hai (% diya, % pehle wapas)',
        v_name, round(v_issued - v_done, 3), coalesce(v_unit, ''), v_issued, v_done;
    END IF;

    INSERT INTO public.kitchen_returns
      (canteen_id, requisition_id, ingredient_id, qty, unit, reason, returned_by)
    VALUES (v_req.canteen_id, p_requisition_id, (v_it->>'ingredient_id')::uuid,
            v_qty, v_unit,
            coalesce(nullif(btrim(p_reason), ''), 'Bacha saman') || ' (store ne darj kiya)',
            auth.uid())
    RETURNING id INTO v_id;

    -- the store keeper is the one taking it back, so it is accepted now
    v_res := public.accept_return(v_id, true);
    v_value := v_value + coalesce((v_res->>'returned_value')::numeric, 0);
    v_n := v_n + 1;
  END LOOP;

  IF v_n = 0 THEN RAISE EXCEPTION 'Kitna wapas aaya wo bharo'; END IF;

  INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'store_kitchen_return', 'requisition', p_requisition_id, v_req.canteen_id,
          jsonb_build_object('lines', v_n, 'value', round(v_value, 2), 'reason', p_reason));

  RETURN jsonb_build_object('returned_lines', v_n, 'returned_value', round(v_value, 2));
END;
$$;
REVOKE ALL ON FUNCTION public.store_take_back_from_kitchen(UUID, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_take_back_from_kitchen(UUID, JSONB, TEXT) TO authenticated;

-- ---------- 2. Store gives the kitchen more than the order ----------
CREATE OR REPLACE FUNCTION public.issue_extra_to_kitchen(
  p_requisition_id UUID,
  p_items JSONB,                 -- [{ingredient_id, qty}]
  p_reason TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_req public.requisitions%ROWTYPE; v_it JSONB; v_n INT := 0;
  v_qty NUMERIC; v_ing public.ingredients%ROWTYPE; v_new NUMERIC; v_cost NUMERIC;
  v_total NUMERIC := 0; v_service_date DATE; v_line UUID; v_names TEXT[] := '{}';
BEGIN
  SELECT * INTO v_req FROM public.requisitions WHERE id = p_requisition_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order nahi mila'; END IF;
  IF NOT (public.can_issue_stock() AND public.can_access_canteen(v_req.canteen_id)) THEN
    RAISE EXCEPTION 'Sirf Store Keeper ya Manager extra saman de sakta hai';
  END IF;
  IF v_req.status NOT IN ('approved', 'issued') THEN
    RAISE EXCEPTION 'Extra saman sirf us order par jud sakta hai jo approve ho chuka ho';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'Extra saman kyun diya, wo reason likho';
  END IF;
  IF jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Items list chahiye';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_items)) <>
     (SELECT count(DISTINCT e->>'ingredient_id') FROM jsonb_array_elements(p_items) e) THEN
    RAISE EXCEPTION 'Same item do baar nahi bhej sakte';
  END IF;

  SELECT m.menu_date INTO v_service_date FROM public.menu_plans m WHERE m.id = v_req.menu_plan_id;
  v_service_date := coalesce(v_service_date, v_req.req_date, (now() AT TIME ZONE 'Asia/Kolkata')::date);

  FOR v_it IN
    SELECT e FROM jsonb_array_elements(p_items) e ORDER BY e->>'ingredient_id'
  LOOP
    v_qty := coalesce((v_it->>'qty')::numeric, 0);
    CONTINUE WHEN v_qty <= 0;

    SELECT * INTO v_ing FROM public.ingredients
     WHERE id = (v_it->>'ingredient_id')::uuid AND canteen_id = v_req.canteen_id
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Ye item is site ka nahi hai'; END IF;
    IF v_qty > coalesce(v_ing.current_stock, 0) + 1e-9 THEN
      RAISE EXCEPTION '% stock mein sirf % % hai', v_ing.name, v_ing.current_stock, coalesce(v_ing.unit, '');
    END IF;

    PERFORM public.allow_stock_move();
    UPDATE public.ingredients SET current_stock = current_stock - v_qty
     WHERE id = v_ing.id RETURNING current_stock INTO v_new;
    v_cost := public.consume_batches_fifo(v_ing.id, v_req.canteen_id, v_qty);

    SELECT id INTO v_line FROM public.requisition_items
     WHERE requisition_id = p_requisition_id AND ingredient_id = v_ing.id
     ORDER BY created_at LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      -- An approved line is locked (enforce_requisition_tolerance) except
      -- through an audited correction that never goes below what was issued.
      -- This is one: logged in action_logs with the reason, manager told.
      -- Switched on for this one row only.
      PERFORM set_config('app.admin_order_correction', 'on', true);
      UPDATE public.requisition_items
         SET approved_qty    = coalesce(approved_qty, 0) + v_qty,
             issued_qty      = coalesce(issued_qty, 0) + v_qty,
             issued_value    = round(coalesce(issued_value, 0) + v_cost, 2),
             store_extra_qty = store_extra_qty + v_qty
       WHERE id = v_line;
      PERFORM set_config('app.admin_order_correction', '', true);
    ELSE
      INSERT INTO public.requisition_items
        (requisition_id, ingredient_id, requested_qty, approved_qty, issued_qty, unit,
         rate, issued_value, store_extra_qty)
      -- requested_qty must be > 0; store_extra_qty = requested_qty marks the
      -- whole line as the store's extra, not something the chef asked for
      VALUES (p_requisition_id, v_ing.id, v_qty, v_qty, v_qty, v_ing.unit,
              round(v_cost / v_qty, 4), round(v_cost, 2), v_qty);
    END IF;

    INSERT INTO public.stock_ledger(ingredient_id, canteen_id, change_qty, balance_after, reason,
      reference_type, reference_id, created_by, service_date, value)
    VALUES (v_ing.id, v_req.canteen_id, -v_qty, v_new,
            format('REQ-%s extra kitchen ko: %s %s — %s', v_req.req_no, v_qty,
                   coalesce(v_ing.unit, ''), btrim(p_reason)),
            'issue', v_req.id, auth.uid(), v_service_date, round(v_cost, 2));

    v_total := v_total + v_cost;
    v_names := v_names || format('%s %s %s', v_ing.name, v_qty, coalesce(v_ing.unit, ''));
    v_n := v_n + 1;
  END LOOP;

  IF v_n = 0 THEN RAISE EXCEPTION 'Kam se kam ek item ki quantity bharo'; END IF;

  -- an order that only had lines left open because of the extra stays as it was
  IF v_req.status = 'approved' AND NOT EXISTS (
       SELECT 1 FROM public.requisition_items
        WHERE requisition_id = p_requisition_id
          AND greatest(coalesce(approved_qty, 0) - coalesce(issued_qty, 0), 0) > 0) THEN
    UPDATE public.requisitions SET status = 'issued', issued_by = coalesce(issued_by, auth.uid()),
           issued_at = coalesce(issued_at, now())
     WHERE id = p_requisition_id;
  END IF;

  INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'store_extra_to_kitchen', 'requisition', p_requisition_id, v_req.canteen_id,
          jsonb_build_object('lines', v_n, 'fifo_value', round(v_total, 2),
                             'reason', btrim(p_reason), 'items', to_jsonb(v_names),
                             'service_date', v_service_date));

  IF NOT public.is_manager_or_above() THEN
    INSERT INTO public.notifications (canteen_id, target_role, title, body, link, ref_type, ref_id)
    VALUES (v_req.canteen_id, 'manager',
            'REQ-' || v_req.req_no || ': store ne kitchen ko extra saman diya',
            array_to_string(v_names, ', ') || ' · ₹' || round(v_total) || ' · Reason: ' || btrim(p_reason),
            '/requisitions', 'requisition', p_requisition_id);
  END IF;

  RETURN jsonb_build_object('extra_lines', v_n, 'fifo_value', round(v_total, 2));
END;
$$;
REVOKE ALL ON FUNCTION public.issue_extra_to_kitchen(UUID, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_extra_to_kitchen(UUID, JSONB, TEXT) TO authenticated;
