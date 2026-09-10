-- Goods sometimes arrive before their paper bill. Record the physical receipt
-- immediately, but never move the same stock again when the bill arrives.

ALTER TABLE public.purchases
  ADD COLUMN IF NOT EXISTS bill_status TEXT NOT NULL DEFAULT 'received',
  ADD COLUMN IF NOT EXISTS bill_received_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE public.purchases ADD CONSTRAINT purchases_bill_status_check
    CHECK (bill_status IN ('pending', 'received'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.purchase_invoice_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES public.purchases(id) ON DELETE RESTRICT,
  canteen_id UUID NOT NULL REFERENCES public.canteens(id) ON DELETE RESTRICT,
  image_path TEXT NOT NULL UNIQUE,
  bill_number TEXT,
  bill_date DATE,
  amount NUMERIC CHECK (amount IS NULL OR amount >= 0),
  uploaded_by UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchase_invoice_files_purchase
  ON public.purchase_invoice_files(purchase_id, created_at);

ALTER TABLE public.purchase_invoice_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "site staff can read attached purchase bills"
  ON public.purchase_invoice_files;
CREATE POLICY "site staff can read attached purchase bills"
  ON public.purchase_invoice_files FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id));

REVOKE ALL ON TABLE public.purchase_invoice_files FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.purchase_invoice_files TO authenticated;

CREATE OR REPLACE FUNCTION public.receive_stock_without_bill(
  p_canteen_id UUID,
  p_supplier_id UUID,
  p_items JSONB,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_purchase UUID;
  v_line RECORD;
  v_ing public.ingredients%ROWTYPE;
  v_new NUMERIC;
  v_sum NUMERIC := 0;
  v_count INT := 0;
  v_today DATE := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF NOT public.can_receive_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can receive goods without a bill';
  END IF;
  IF NOT public.can_access_canteen(p_canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one received item';
  END IF;

  -- Use the last known inventory rate until the paper bill arrives. The bill
  -- may later prove a different value, but it must never add stock twice.
  SELECT coalesce(sum((e->>'quantity')::numeric * coalesce(i.cost_per_unit, 0)), 0)
    INTO v_sum
  FROM jsonb_array_elements(p_items) e
  JOIN public.ingredients i ON i.id = (e->>'ingredient_id')::uuid
  WHERE i.canteen_id = p_canteen_id
    AND coalesce((e->>'quantity')::numeric, 0) > 0;

  INSERT INTO public.purchases
    (canteen_id, supplier_id, total_amount, stated_total, notes,
     invoice_image_url, status, approved_at, created_by, bill_status)
  VALUES
    (p_canteen_id, p_supplier_id, v_sum, NULL,
     concat('NO BILL — ', coalesce(nullif(btrim(p_notes), ''), 'bill will be attached later')),
     NULL, 'confirmed', now(), auth.uid(), 'pending')
  RETURNING id INTO v_purchase;

  PERFORM public.allow_stock_move();

  FOR v_line IN
    SELECT (e->>'ingredient_id')::uuid AS ingredient_id,
           coalesce((e->>'quantity')::numeric, 0) AS qty
    FROM jsonb_array_elements(p_items) e
  LOOP
    CONTINUE WHEN v_line.qty <= 0;

    SELECT * INTO v_ing
    FROM public.ingredients
    WHERE id = v_line.ingredient_id AND canteen_id = p_canteen_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Choose an inventory item from this site';
    END IF;

    UPDATE public.ingredients
       SET current_stock = current_stock + v_line.qty
     WHERE id = v_ing.id
     RETURNING current_stock INTO v_new;

    INSERT INTO public.purchase_items
      (purchase_id, item_name, quantity, unit, rate, total, ingredient_id)
    VALUES
      (v_purchase, v_ing.name, v_line.qty, v_ing.unit,
       coalesce(v_ing.cost_per_unit, 0),
       round(v_line.qty * coalesce(v_ing.cost_per_unit, 0), 2), v_ing.id);

    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason,
       reference_type, reference_id, created_by, service_date, value)
    VALUES
      (v_ing.id, p_canteen_id, v_line.qty, v_new,
       'No-bill stock-in — ' || v_ing.name,
       'purchase', v_purchase, auth.uid(), v_today,
       round(v_line.qty * coalesce(v_ing.cost_per_unit, 0), 2));

    INSERT INTO public.ingredient_batches
      (ingredient_id, canteen_id, supplier_id, purchase_id,
       qty_received, qty_remaining, rate)
    VALUES
      (v_ing.id, p_canteen_id, p_supplier_id, v_purchase,
       v_line.qty, v_line.qty, coalesce(v_ing.cost_per_unit, 0));

    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN RAISE EXCEPTION 'Add at least one positive quantity'; END IF;

  PERFORM public.notify_goods_received(v_purchase);
  RETURN jsonb_build_object(
    'purchase_id', v_purchase,
    'items_received', v_count,
    'provisional_value', v_sum,
    'bill_status', 'pending'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.receive_stock_without_bill(UUID, UUID, JSONB, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_stock_without_bill(UUID, UUID, JSONB, TEXT)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.attach_purchase_invoice(
  p_purchase_id UUID,
  p_image_path TEXT,
  p_amount NUMERIC DEFAULT NULL,
  p_bill_number TEXT DEFAULT NULL,
  p_bill_date DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_purchase public.purchases%ROWTYPE;
  v_count INT;
  v_total NUMERIC;
BEGIN
  IF NOT public.can_receive_stock() THEN
    RAISE EXCEPTION 'Only the store keeper can attach a purchase bill';
  END IF;

  SELECT * INTO v_purchase FROM public.purchases
   WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase not found'; END IF;
  IF NOT public.can_access_canteen(v_purchase.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;
  IF v_purchase.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Bills can only be attached to received goods';
  END IF;
  IF nullif(btrim(p_image_path), '') IS NULL
     OR split_part(p_image_path, '/', 1) <> v_purchase.canteen_id::text THEN
    RAISE EXCEPTION 'Invalid bill photo path';
  END IF;
  IF p_amount IS NOT NULL AND p_amount < 0 THEN
    RAISE EXCEPTION 'Bill amount cannot be negative';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.purchase_invoice_files WHERE purchase_id = p_purchase_id;
  IF v_count >= 4 THEN
    RAISE EXCEPTION 'Maximum 4 bill photos can be attached to one receiving';
  END IF;

  INSERT INTO public.purchase_invoice_files
    (purchase_id, canteen_id, image_path, bill_number, bill_date, amount, uploaded_by)
  VALUES
    (p_purchase_id, v_purchase.canteen_id, p_image_path,
     nullif(btrim(p_bill_number), ''), p_bill_date, p_amount, auth.uid());

  SELECT count(*), sum(amount) INTO v_count, v_total
  FROM public.purchase_invoice_files WHERE purchase_id = p_purchase_id;

  -- The first path stays in the legacy column so old reports/screens continue
  -- to open a bill. Every photo is kept in purchase_invoice_files.
  PERFORM public.allow_stock_move();
  UPDATE public.purchases
     SET invoice_image_url = coalesce(invoice_image_url, p_image_path),
         stated_total = CASE WHEN v_total IS NULL THEN stated_total ELSE v_total END,
         bill_status = 'received',
         bill_received_at = now()
   WHERE id = p_purchase_id;

  INSERT INTO public.notifications
    (canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES
    (v_purchase.canteen_id, 'admin',
     format('Bill attached (%s/4)', v_count),
     format('Store keeper attached bill %s for received goods. Amount recorded: ₹%s. Stock was not added again.',
            coalesce(nullif(btrim(p_bill_number), ''), 'photo'),
            coalesce(round(p_amount), 0)),
     '/purchases', 'purchase', p_purchase_id);

  RETURN jsonb_build_object(
    'purchase_id', p_purchase_id,
    'bill_count', v_count,
    'bill_total', v_total,
    'stock_changed', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.attach_purchase_invoice(UUID, TEXT, NUMERIC, TEXT, DATE)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_purchase_invoice(UUID, TEXT, NUMERIC, TEXT, DATE)
  TO authenticated;

COMMENT ON TABLE public.purchase_invoice_files IS
  'Append-only bill photos (maximum four) attached after goods were received. Attaching a bill never moves stock.';
