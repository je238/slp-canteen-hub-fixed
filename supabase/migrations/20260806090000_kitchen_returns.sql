-- ============================================================
-- WHAT THE KITCHEN DID NOT USE GOES BACK TO THE STORE
--
-- The chef draws 100 kg of rice for the day and cooks 80. Until now the
-- other 20 kg had nowhere to go: the requisition was closed, the stock had
-- already left the store's books, and the day's consumption said 100 kg.
-- So either the register overstated what was eaten every single day, or the
-- 20 kg quietly sat in the kitchen off the books — which is exactly where
-- ration goes missing.
--
-- A return is the mirror of an issue, and it is treated like one:
--
--   · The chef records what is going back. Nothing moves yet.
--   · The store keeper accepts it, because they are the one physically
--     taking the sacks back onto the shelf. Only then does stock move.
--
-- That second step matters. If the chef could put stock back on the books
-- alone, 20 kg could be "returned" on paper and carried out of the gate,
-- and the shortfall would surface later as a store shortage pointing at the
-- store keeper, who never saw it. Somebody has to receive what is handed
-- over, the same way a delivery is received.
--
-- You cannot return more than was issued to you, so a return can never be
-- used to invent stock that was never drawn.
--
-- Safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.kitchen_returns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canteen_id      UUID NOT NULL REFERENCES public.canteens(id) ON DELETE CASCADE,
  requisition_id  UUID REFERENCES public.requisitions(id) ON DELETE SET NULL,
  ingredient_id   UUID NOT NULL REFERENCES public.ingredients(id),
  qty             NUMERIC NOT NULL CHECK (qty > 0),
  unit            TEXT,
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'rejected')),
  returned_by     UUID,
  accepted_by     UUID,
  accepted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kitchen_returns_open
  ON public.kitchen_returns (canteen_id, status, created_at DESC);

ALTER TABLE public.kitchen_returns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kitchen_returns_select" ON public.kitchen_returns;
CREATE POLICY "kitchen_returns_select" ON public.kitchen_returns FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));

-- Written only through the functions below, never by hand.
DROP POLICY IF EXISTS "kitchen_returns_admin_write" ON public.kitchen_returns;
CREATE POLICY "kitchen_returns_admin_write" ON public.kitchen_returns FOR ALL TO authenticated
  USING (public.is_admin_editor()) WITH CHECK (public.is_admin_editor());

-- ---------- What is still out with the kitchen ----------
-- Issued, less anything already handed back or waiting to be.
CREATE OR REPLACE FUNCTION public.returnable_items(p_requisition_id UUID)
RETURNS TABLE (
  ingredient_id UUID, name TEXT, unit TEXT,
  issued NUMERIC, already_returned NUMERIC, can_return NUMERIC
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT ri.ingredient_id, i.name, coalesce(ri.unit, i.unit),
         coalesce(ri.issued_qty, 0),
         coalesce((SELECT sum(kr.qty) FROM public.kitchen_returns kr
                   WHERE kr.requisition_id = p_requisition_id
                     AND kr.ingredient_id = ri.ingredient_id
                     AND kr.status IN ('pending', 'accepted')), 0),
         greatest(coalesce(ri.issued_qty, 0)
                  - coalesce((SELECT sum(kr.qty) FROM public.kitchen_returns kr
                              WHERE kr.requisition_id = p_requisition_id
                                AND kr.ingredient_id = ri.ingredient_id
                                AND kr.status IN ('pending', 'accepted')), 0), 0)
  FROM public.requisition_items ri
  JOIN public.ingredients i ON i.id = ri.ingredient_id
  JOIN public.requisitions r ON r.id = ri.requisition_id
  WHERE ri.requisition_id = p_requisition_id
    AND r.status = 'issued'
    AND public.can_access_canteen(r.canteen_id)
    AND coalesce(ri.issued_qty, 0) > 0
  ORDER BY i.name;
$$;
REVOKE ALL ON FUNCTION public.returnable_items(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.returnable_items(UUID) TO authenticated;

-- ---------- 1. The kitchen says what is coming back ----------
CREATE OR REPLACE FUNCTION public.return_to_store(
  p_requisition_id UUID,
  p_items JSONB,                 -- [{ingredient_id, qty, reason}]
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_req public.requisitions%ROWTYPE; v_it JSONB; v_n INT := 0;
  v_issued NUMERIC; v_done NUMERIC; v_qty NUMERIC; v_unit TEXT;
BEGIN
  SELECT * INTO v_req FROM public.requisitions WHERE id = p_requisition_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown requisition'; END IF;
  IF v_req.status <> 'issued' THEN
    RAISE EXCEPTION 'Only stock that has actually been issued can be sent back';
  END IF;
  IF NOT public.can_access_canteen(v_req.canteen_id) THEN
    RAISE EXCEPTION 'You cannot return stock at this site';
  END IF;
  IF NOT public.can_raise_requisition() THEN
    RAISE EXCEPTION 'Only the kitchen can send stock back to the store';
  END IF;

  FOR v_it IN SELECT * FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) LOOP
    v_qty := coalesce((v_it->>'qty')::numeric, 0);
    CONTINUE WHEN v_qty <= 0;

    SELECT coalesce(ri.issued_qty, 0), coalesce(ri.unit, i.unit)
    INTO v_issued, v_unit
    FROM public.requisition_items ri
    JOIN public.ingredients i ON i.id = ri.ingredient_id
    WHERE ri.requisition_id = p_requisition_id
      AND ri.ingredient_id = (v_it->>'ingredient_id')::uuid;

    IF v_issued IS NULL OR v_issued <= 0 THEN
      RAISE EXCEPTION 'That item was not issued on this requisition';
    END IF;

    SELECT coalesce(sum(qty), 0) INTO v_done FROM public.kitchen_returns
    WHERE requisition_id = p_requisition_id
      AND ingredient_id = (v_it->>'ingredient_id')::uuid
      AND status IN ('pending', 'accepted');

    -- the ceiling that stops a return being used to invent stock
    IF v_qty > v_issued - v_done + 1e-9 THEN
      RAISE EXCEPTION
        'You can send back at most % of that item — % was issued and % is already going back',
        v_issued - v_done, v_issued, v_done;
    END IF;

    INSERT INTO public.kitchen_returns
      (canteen_id, requisition_id, ingredient_id, qty, unit, reason, returned_by)
    VALUES (v_req.canteen_id, p_requisition_id, (v_it->>'ingredient_id')::uuid,
            v_qty, v_unit, coalesce(v_it->>'reason', p_reason), auth.uid());
    v_n := v_n + 1;
  END LOOP;

  IF v_n = 0 THEN RAISE EXCEPTION 'Nothing to send back'; END IF;

  INSERT INTO public.notifications
    (canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES (v_req.canteen_id, 'store_keeper',
          v_n || ' item' || CASE WHEN v_n > 1 THEN 's' ELSE '' END || ' coming back from the kitchen',
          'The kitchen has sent unused stock back. Accept it to put it on the shelf.',
          '/requisitions', 'kitchen_return', p_requisition_id);

  RETURN jsonb_build_object('returned_lines', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.return_to_store(UUID, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.return_to_store(UUID, JSONB, TEXT) TO authenticated;

-- ---------- 2. The store keeper takes it back onto the shelf ----------
CREATE OR REPLACE FUNCTION public.accept_return(p_return_id UUID, p_accept BOOLEAN DEFAULT true)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r public.kitchen_returns%ROWTYPE; v_new NUMERIC;
BEGIN
  SELECT * INTO v_r FROM public.kitchen_returns WHERE id = p_return_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown return'; END IF;
  IF v_r.status <> 'pending' THEN RAISE EXCEPTION 'This return has already been dealt with'; END IF;
  IF NOT (public.can_receive_stock() AND public.can_access_canteen(v_r.canteen_id)) THEN
    RAISE EXCEPTION 'Only the store keeper can take stock back onto the shelf';
  END IF;

  IF NOT p_accept THEN
    UPDATE public.kitchen_returns
    SET status = 'rejected', accepted_by = auth.uid(), accepted_at = now()
    WHERE id = p_return_id;
    RETURN jsonb_build_object('accepted', false);
  END IF;

  PERFORM public.allow_stock_move();
  UPDATE public.ingredients
  SET current_stock = current_stock + v_r.qty
  WHERE id = v_r.ingredient_id
  RETURNING current_stock INTO v_new;

  INSERT INTO public.stock_ledger
    (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type,
     reference_id, created_by)
  VALUES (v_r.ingredient_id, v_r.canteen_id, v_r.qty, v_new,
          'Returned unused by the kitchen' ||
          CASE WHEN coalesce(v_r.reason, '') <> '' THEN ' — ' || v_r.reason ELSE '' END,
          'return', v_r.requisition_id, auth.uid());

  UPDATE public.kitchen_returns
  SET status = 'accepted', accepted_by = auth.uid(), accepted_at = now()
  WHERE id = p_return_id;

  RETURN jsonb_build_object('accepted', true, 'qty', v_r.qty, 'balance', v_new);
END;
$$;
REVOKE ALL ON FUNCTION public.accept_return(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_return(UUID, BOOLEAN) TO authenticated;
