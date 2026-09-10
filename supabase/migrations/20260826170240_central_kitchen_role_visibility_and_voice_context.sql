-- Central Kitchen material is neither a purchase nor free stock. It enters
-- the shelf as a costed FIFO batch, remains an outstanding liability, and
-- leaves through an explicit return. Direct table writes are not exposed;
-- the two audited RPCs are the only mutation path.

CREATE TABLE public.central_kitchen_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  canteen_id uuid NOT NULL REFERENCES public.canteens(id),
  source_name text NOT NULL DEFAULT 'Central Kitchen',
  transfer_date date NOT NULL DEFAULT current_date,
  expected_return_date date,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','partially_returned','returned')),
  notes text,
  received_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.central_kitchen_transfer_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES public.central_kitchen_transfers(id) ON DELETE RESTRICT,
  ingredient_id uuid NOT NULL REFERENCES public.ingredients(id),
  qty_received numeric NOT NULL CHECK (qty_received > 0),
  qty_returned numeric NOT NULL DEFAULT 0 CHECK (qty_returned >= 0 AND qty_returned <= qty_received),
  unit text NOT NULL,
  rate numeric NOT NULL DEFAULT 0 CHECK (rate >= 0),
  last_returned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, ingredient_id)
);

CREATE INDEX central_kitchen_transfers_site_status_date_idx
  ON public.central_kitchen_transfers(canteen_id,status,transfer_date DESC);
CREATE INDEX central_kitchen_transfer_items_transfer_idx
  ON public.central_kitchen_transfer_items(transfer_id);
CREATE INDEX central_kitchen_transfer_items_ingredient_idx
  ON public.central_kitchen_transfer_items(ingredient_id);

ALTER TABLE public.central_kitchen_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_kitchen_transfer_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY central_kitchen_transfers_site_read
  ON public.central_kitchen_transfers FOR SELECT TO authenticated
  USING (public.my_rank() >= 20 AND public.can_access_canteen(canteen_id));

CREATE POLICY central_kitchen_transfer_items_site_read
  ON public.central_kitchen_transfer_items FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.central_kitchen_transfers t
     WHERE t.id = transfer_id
       AND public.my_rank() >= 20
       AND public.can_access_canteen(t.canteen_id)
  ));

REVOKE ALL ON public.central_kitchen_transfers FROM anon, authenticated;
REVOKE ALL ON public.central_kitchen_transfer_items FROM anon, authenticated;
GRANT SELECT ON public.central_kitchen_transfers TO authenticated;
GRANT SELECT ON public.central_kitchen_transfer_items TO authenticated;

CREATE OR REPLACE FUNCTION public.receive_central_kitchen_transfer(
  p_canteen_id uuid,
  p_source_name text,
  p_transfer_date date,
  p_expected_return_date date,
  p_items jsonb,
  p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transfer public.central_kitchen_transfers%ROWTYPE;
  v_input jsonb;
  v_ing public.ingredients%ROWTYPE;
  v_qty numeric;
  v_rate numeric;
  v_new_balance numeric;
  v_count integer := 0;
BEGIN
  IF NOT public.can_receive_stock() OR NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'Only the authorised Store Keeper can receive Central Kitchen stock';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item is required';
  END IF;
  IF p_expected_return_date IS NOT NULL
     AND p_expected_return_date < coalesce(p_transfer_date, current_date) THEN
    RAISE EXCEPTION 'Return date cannot be before the received date';
  END IF;

  INSERT INTO public.central_kitchen_transfers(
    canteen_id,source_name,transfer_date,expected_return_date,notes,received_by
  ) VALUES (
    p_canteen_id,coalesce(nullif(btrim(p_source_name),''),'Central Kitchen'),
    coalesce(p_transfer_date,current_date),p_expected_return_date,
    nullif(btrim(coalesce(p_notes,'')),''),auth.uid()
  ) RETURNING * INTO v_transfer;

  -- Stable ingredient order prevents two simultaneous receipts from locking
  -- the same ingredients in opposite order.
  FOR v_input IN
    SELECT value FROM jsonb_array_elements(p_items)
     ORDER BY (value->>'ingredient_id')::uuid
  LOOP
    v_qty := round(coalesce((v_input->>'qty')::numeric,0),3);
    IF v_qty <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_ing FROM public.ingredients
     WHERE id=(v_input->>'ingredient_id')::uuid AND canteen_id=p_canteen_id
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Central Kitchen item is not part of this site inventory'; END IF;
    IF EXISTS (SELECT 1 FROM public.central_kitchen_transfer_items
                WHERE transfer_id=v_transfer.id AND ingredient_id=v_ing.id) THEN
      RAISE EXCEPTION '% is repeated in this transfer', v_ing.name;
    END IF;

    v_rate := greatest(coalesce((v_input->>'rate')::numeric,v_ing.cost_per_unit,0),0);
    INSERT INTO public.central_kitchen_transfer_items(
      transfer_id,ingredient_id,qty_received,unit,rate
    ) VALUES (v_transfer.id,v_ing.id,v_qty,v_ing.unit,v_rate);

    PERFORM public.allow_stock_move();
    UPDATE public.ingredients SET current_stock=current_stock+v_qty
     WHERE id=v_ing.id RETURNING current_stock INTO v_new_balance;

    INSERT INTO public.ingredient_batches(
      ingredient_id,canteen_id,batch_no,qty_received,qty_remaining,rate,received_at
    ) VALUES (
      v_ing.id,p_canteen_id,'CK-'||v_transfer.transfer_no::text,
      v_qty,v_qty,v_rate,now()
    );

    INSERT INTO public.stock_ledger(
      ingredient_id,canteen_id,change_qty,balance_after,reason,reference_type,
      reference_id,created_by,service_date,value
    ) VALUES (
      v_ing.id,p_canteen_id,v_qty,v_new_balance,
      format('Central Kitchen se mila — transfer #%s; return pending',v_transfer.transfer_no),
      'central_kitchen_in',v_transfer.id,auth.uid(),v_transfer.transfer_date,
      round(v_qty*v_rate,2)
    );
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN RAISE EXCEPTION 'Every quantity is zero'; END IF;

  INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
  VALUES(auth.uid(),'central_kitchen_transfer_received','central_kitchen_transfer',
    v_transfer.id,p_canteen_id,jsonb_build_object(
      'transfer_no',v_transfer.transfer_no,'source',v_transfer.source_name,
      'items',v_count,'expected_return_date',v_transfer.expected_return_date
    ));

  RETURN jsonb_build_object('id',v_transfer.id,'transfer_no',v_transfer.transfer_no,
                            'items_received',v_count,'status','open');
END;
$$;

CREATE OR REPLACE FUNCTION public.return_central_kitchen_transfer(
  p_transfer_id uuid,
  p_items jsonb,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transfer public.central_kitchen_transfers%ROWTYPE;
  v_line public.central_kitchen_transfer_items%ROWTYPE;
  v_input jsonb;
  v_qty numeric;
  v_balance numeric;
  v_cost numeric;
  v_count integer := 0;
  v_status text;
  v_changes jsonb := '[]'::jsonb;
BEGIN
  IF nullif(btrim(coalesce(p_reason,'')),'') IS NULL THEN
    RAISE EXCEPTION 'Return reason is required';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)=0 THEN
    RAISE EXCEPTION 'At least one return item is required';
  END IF;

  SELECT * INTO v_transfer FROM public.central_kitchen_transfers
   WHERE id=p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Central Kitchen transfer not found'; END IF;
  IF v_transfer.status='returned' THEN RAISE EXCEPTION 'This transfer is already fully returned'; END IF;
  IF NOT public.can_receive_stock() OR NOT public.can_access_canteen(v_transfer.canteen_id) THEN
    RAISE EXCEPTION 'Only the authorised Store Keeper can return Central Kitchen stock';
  END IF;

  FOR v_input IN
    SELECT value FROM jsonb_array_elements(p_items)
     ORDER BY (value->>'item_id')::uuid
  LOOP
    v_qty := round(coalesce((v_input->>'qty')::numeric,0),3);
    IF v_qty <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_line FROM public.central_kitchen_transfer_items
     WHERE id=(v_input->>'item_id')::uuid AND transfer_id=p_transfer_id
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'A transfer item was not found'; END IF;
    IF v_qty > v_line.qty_received-v_line.qty_returned+0.000000001 THEN
      RAISE EXCEPTION 'Return quantity exceeds the pending Central Kitchen quantity';
    END IF;

    PERFORM public.allow_stock_move();
    UPDATE public.ingredients
       SET current_stock=current_stock-v_qty
     WHERE id=v_line.ingredient_id AND canteen_id=v_transfer.canteen_id
       AND current_stock>=v_qty
     RETURNING current_stock INTO v_balance;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Shelf stock is less than the quantity being returned';
    END IF;

    v_cost := public.consume_batches_fifo(v_line.ingredient_id,v_transfer.canteen_id,v_qty);
    UPDATE public.central_kitchen_transfer_items
       SET qty_returned=qty_returned+v_qty,last_returned_at=now()
     WHERE id=v_line.id;

    INSERT INTO public.stock_ledger(
      ingredient_id,canteen_id,change_qty,balance_after,reason,reference_type,
      reference_id,created_by,service_date,value
    ) VALUES (
      v_line.ingredient_id,v_transfer.canteen_id,-v_qty,v_balance,
      format('Central Kitchen ko wapas — transfer #%s; %s',v_transfer.transfer_no,btrim(p_reason)),
      'central_kitchen_return',v_transfer.id,auth.uid(),current_date,round(v_cost,2)
    );

    v_count := v_count+1;
    v_changes := v_changes||jsonb_build_array(jsonb_build_object(
      'item_id',v_line.id,'ingredient_id',v_line.ingredient_id,
      'qty',v_qty,'unit',v_line.unit,'value',round(v_cost,2)
    ));
  END LOOP;

  IF v_count=0 THEN RAISE EXCEPTION 'Every return quantity is zero'; END IF;

  SELECT CASE
    WHEN bool_and(qty_returned>=qty_received) THEN 'returned'
    ELSE 'partially_returned' END
    INTO v_status FROM public.central_kitchen_transfer_items
   WHERE transfer_id=p_transfer_id;

  UPDATE public.central_kitchen_transfers SET status=v_status,updated_at=now()
   WHERE id=p_transfer_id;

  INSERT INTO public.action_logs(user_id,action,entity_type,entity_id,canteen_id,details)
  VALUES(auth.uid(),'central_kitchen_transfer_returned','central_kitchen_transfer',
    p_transfer_id,v_transfer.canteen_id,jsonb_build_object(
      'transfer_no',v_transfer.transfer_no,'reason',btrim(p_reason),
      'status',v_status,'changes',v_changes
    ));

  RETURN jsonb_build_object('transfer_no',v_transfer.transfer_no,'returned_lines',v_count,
                            'status',v_status,'changes',v_changes);
END;
$$;

-- A small daily financial card for kitchen/store roles. It deliberately
-- exposes only operational totals requested by the business, not budgets,
-- vendor dues or cross-site data.
CREATE OR REPLACE FUNCTION public.daily_operating_snapshot(
  p_canteen_id uuid,
  p_date date
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ops jsonb;
  v_pending_actual integer;
BEGIN
  IF public.my_rank()<20 OR NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site summary';
  END IF;
  v_ops := public.operations_summary(p_canteen_id,p_date,p_date);
  SELECT count(*) INTO v_pending_actual FROM public.menu_plans
   WHERE canteen_id=p_canteen_id AND menu_date=p_date
     AND status<>'draft' AND actual_headcount IS NULL;
  RETURN jsonb_build_object(
    'date',p_date,
    'consumption',coalesce((v_ops->>'consumption')::numeric,0),
    'revenue',coalesce((v_ops->>'revenue')::numeric,0),
    'food_cost_pct',(v_ops->>'food_cost_pct')::numeric,
    'headcount',coalesce((v_ops->>'headcount')::bigint,0),
    'provisional',v_pending_actual>0
  );
END;
$$;

-- The Chef orders ingredients but current wastage is recorded against dishes.
-- Until recipes connect every ingredient to a dish, dish history is the only
-- honest comparison. Use unit rows when present; fall back to legacy wastage.
CREATE OR REPLACE FUNCTION public.menu_wastage_context(p_menu_plan_id uuid)
RETURNS TABLE(
  dish_name text,
  last_date date,
  last_wastage numeric,
  avg_wastage_30d numeric,
  times_recorded integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_plan public.menu_plans%ROWTYPE;
BEGIN
  SELECT * INTO v_plan FROM public.menu_plans WHERE id=p_menu_plan_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Menu not found'; END IF;
  IF public.my_rank()<20 OR NOT public.can_access_canteen(v_plan.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this menu';
  END IF;

  RETURN QUERY
  WITH current_dishes AS (
    SELECT DISTINCT mi.dish_name FROM public.menu_plan_items mi
     WHERE mi.menu_plan_id=p_menu_plan_id
  ), history AS (
    SELECT mi.dish_name,m.menu_date,
      CASE WHEN EXISTS(SELECT 1 FROM public.menu_unit_wastage u WHERE u.menu_plan_item_id=mi.id)
        THEN (SELECT coalesce(sum(u.quantity),0) FROM public.menu_unit_wastage u WHERE u.menu_plan_item_id=mi.id)
        ELSE coalesce(mi.wastage_qty,0) END AS wasted
    FROM public.menu_plan_items mi
    JOIN public.menu_plans m ON m.id=mi.menu_plan_id
    JOIN current_dishes c ON lower(btrim(c.dish_name))=lower(btrim(mi.dish_name))
    WHERE m.canteen_id=v_plan.canteen_id AND m.menu_date<v_plan.menu_date
      AND m.menu_date>=v_plan.menu_date-30
  )
  SELECT c.dish_name,
    (SELECT h.menu_date FROM history h WHERE lower(btrim(h.dish_name))=lower(btrim(c.dish_name))
      ORDER BY h.menu_date DESC LIMIT 1),
    coalesce((SELECT h.wasted FROM history h WHERE lower(btrim(h.dish_name))=lower(btrim(c.dish_name))
      ORDER BY h.menu_date DESC LIMIT 1),0),
    coalesce((SELECT round(avg(h.wasted),3) FROM history h
      WHERE lower(btrim(h.dish_name))=lower(btrim(c.dish_name))),0),
    coalesce((SELECT count(*)::integer FROM history h
      WHERE lower(btrim(h.dish_name))=lower(btrim(c.dish_name))),0)
  FROM current_dishes c ORDER BY c.dish_name;
END;
$$;

REVOKE ALL ON FUNCTION public.receive_central_kitchen_transfer(uuid,text,date,date,jsonb,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.return_central_kitchen_transfer(uuid,jsonb,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.daily_operating_snapshot(uuid,date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.menu_wastage_context(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_central_kitchen_transfer(uuid,text,date,date,jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.return_central_kitchen_transfer(uuid,jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.daily_operating_snapshot(uuid,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.menu_wastage_context(uuid) TO authenticated;

-- Unit Managers now have the requested full correction/report rights. Keep
-- all existing issued-stock locks, reason requirements and audit history;
-- only the role threshold and user-facing wording change.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef('public.admin_correct_requisition(uuid,jsonb,text)'::regprocedure)
    INTO v_def;
  v_new := replace(v_def,
    'IF NOT public.is_admin_editor() THEN',
    'IF NOT (public.is_admin_editor() OR public.is_manager_or_above()) THEN');
  v_new := replace(v_new,
    'Only an admin can fully edit an approved order',
    'Only the manager or an admin can fully edit an approved order');
  v_new := replace(v_new,'admin_corrected_requisition','full_corrected_requisition');
  v_new := replace(v_new,'admin ne correct kiya','manager/admin ne correct kiya');
  IF v_new=v_def THEN RAISE EXCEPTION 'admin_correct_requisition signature changed; migration stopped safely'; END IF;
  EXECUTE v_new;

  SELECT pg_get_functiondef('public.owner_menu_profit_breakdown(uuid,date,date)'::regprocedure)
    INTO v_def;
  v_new := replace(v_def,'public.my_rank() < 50','public.my_rank() < 40');
  v_new := replace(v_new,
    'Only Operations Manager, Owner or Super Admin can view this report',
    'Only Unit Manager or above can view this report');
  IF v_new=v_def THEN RAISE EXCEPTION 'owner_menu_profit_breakdown signature changed; migration stopped safely'; END IF;
  EXECUTE v_new;
END;
$$;

COMMENT ON TABLE public.central_kitchen_transfers IS
  'Returnable material received from a Central Kitchen; excluded from purchases.';
COMMENT ON FUNCTION public.daily_operating_snapshot(uuid,date) IS
  'Site-scoped consumption, revenue and food-cost summary for Chef and Store Keeper.';
