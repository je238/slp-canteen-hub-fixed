-- ============================================================
-- THE PERSON WHO ASKS CANNOT BE THE PERSON WHO APPROVES,
-- AND THE PERSON HOLDING THE KEY CANNOT REWRITE WHAT IS INSIDE
--
-- Two duties had drifted onto the wrong people.
--
-- 1. Raising a requisition was open to is_store_keeper_or_above(), which is
--    rank 20 and up — store keeper, chef, unit manager and admin, all four.
--    So a manager could raise the order they are meant to be checking, and a
--    store keeper could order the goods they then hand out. The ±7% approval
--    band means nothing when one person can be on both ends of it. Ordering
--    belongs to the chef, who is cooking the menu.
--
-- 2. adjust_stock allowed can_receive_stock(), which includes the store
--    keeper. That let the one person with the key to the store type a new
--    number into the store's own record — with a reason and a ledger entry,
--    but still by their own hand. A shortage could be written away as
--    "spillage" by the person the shortage would point at.
--
--    Stock still moves for them in the two honest ways: receiving goods
--    against a bill, and issuing against an approved requisition. A count
--    that disagrees with the book is found by somebody else, through the
--    blind audit, which is the whole point of it being blind.
--
-- Admin and super admin keep both, because correcting a genuine mistake is
-- their job and every other guard here works the same way.
--
-- Safe to re-run.
-- ============================================================

-- ---------- 1. Only the chef raises an order ----------
CREATE OR REPLACE FUNCTION public.can_raise_requisition()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role IN ('chef', 'cashier')
  ) OR public.is_admin_editor();
$$;
REVOKE ALL ON FUNCTION public.can_raise_requisition() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_raise_requisition() TO authenticated;

DROP POLICY IF EXISTS "requisitions_chef_insert" ON public.requisitions;
CREATE POLICY "requisitions_chef_insert" ON public.requisitions FOR INSERT TO authenticated
  WITH CHECK (public.can_access_canteen(canteen_id) AND public.can_raise_requisition());

DROP POLICY IF EXISTS "requisition_items_insert" ON public.requisition_items;
DROP POLICY IF EXISTS "requisition_items_chef_insert" ON public.requisition_items;
CREATE POLICY "requisition_items_chef_insert" ON public.requisition_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.requisitions r
    WHERE r.id = requisition_id
      AND public.can_access_canteen(r.canteen_id)
      AND public.can_raise_requisition()
  ));

-- ---------- 2. The store keeper no longer types stock numbers ----------
CREATE OR REPLACE FUNCTION public.adjust_stock(
  p_ingredient_id UUID, p_new_stock NUMERIC, p_reason TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ing public.ingredients%ROWTYPE; v_delta NUMERIC;
BEGIN
  IF coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'A reason is required for a manual stock adjustment';
  END IF;
  SELECT * INTO v_ing FROM public.ingredients WHERE id = p_ingredient_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown item'; END IF;

  IF NOT (public.is_admin_editor() AND public.can_access_canteen(v_ing.canteen_id)) THEN
    RAISE EXCEPTION
      'Stock cannot be typed in. Receive it against a bill, issue it against an approved order, or ask an admin to correct it.';
  END IF;

  v_delta := p_new_stock - v_ing.current_stock;
  IF v_delta = 0 THEN RETURN jsonb_build_object('changed', false); END IF;

  PERFORM public.allow_stock_move();
  UPDATE public.ingredients SET current_stock = p_new_stock WHERE id = p_ingredient_id;

  INSERT INTO public.stock_ledger
    (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, created_by)
  VALUES (p_ingredient_id, v_ing.canteen_id, v_delta, p_new_stock,
          'Manual adjustment: ' || btrim(p_reason), 'manual', auth.uid());

  RETURN jsonb_build_object('changed', true, 'delta', v_delta, 'balance', p_new_stock);
END;
$$;
REVOKE ALL ON FUNCTION public.adjust_stock(UUID, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adjust_stock(UUID, NUMERIC, TEXT) TO authenticated;
