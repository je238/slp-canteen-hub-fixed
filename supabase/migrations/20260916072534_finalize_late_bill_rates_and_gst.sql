-- A no-bill receipt starts with provisional rates so physical stock can be
-- recorded immediately. When the paper arrives, finalise the commercial
-- values without moving the same quantity onto the shelf a second time.

ALTER TABLE public.purchases
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_charges NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bill_finalized_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS bill_finalized_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE public.purchases ADD CONSTRAINT purchases_tax_amount_nonnegative
    CHECK (tax_amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.purchases ADD CONSTRAINT purchases_other_charges_nonnegative
    CHECK (other_charges >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.finalize_pending_purchase_bill(
  p_purchase_id UUID,
  p_files JSONB,
  p_lines JSONB,
  p_tax_amount NUMERIC DEFAULT 0,
  p_other_charges NUMERIC DEFAULT 0,
  p_bill_total NUMERIC DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_purchase public.purchases%ROWTYPE;
  v_line RECORD;
  v_file RECORD;
  v_existing_files INT;
  v_purchase_lines INT;
  v_input_lines INT;
  v_subtotal NUMERIC := 0;
  v_file_total NUMERIC;
  v_final_total NUMERIC;
  v_received NUMERIC;
  v_remaining NUMERIC;
  v_consumed NUMERIC;
  v_remaining_delta NUMERIC;
  v_consumed_delta NUMERIC;
  v_new_total NUMERIC;
  v_changed INT := 0;
  v_today DATE := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_first_path TEXT;
BEGIN
  IF NOT public.can_receive_stock() THEN
    RAISE EXCEPTION 'Only the Store Keeper, Manager or Admin can finalise a received bill';
  END IF;
  IF coalesce(p_tax_amount, 0) < 0 OR coalesce(p_other_charges, 0) < 0 THEN
    RAISE EXCEPTION 'GST and other charges cannot be negative';
  END IF;

  SELECT * INTO v_purchase
    FROM public.purchases
   WHERE id = p_purchase_id
   FOR UPDATE;
  IF NOT FOUND OR v_purchase.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Confirmed goods receipt not found';
  END IF;
  IF NOT public.can_access_canteen(v_purchase.canteen_id) THEN
    RAISE EXCEPTION 'You do not have access to this site';
  END IF;
  IF jsonb_typeof(p_files) <> 'array' THEN
    RAISE EXCEPTION 'Bill files must be an array';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Final rate is required for every received item';
  END IF;

  SELECT count(*) INTO v_existing_files
    FROM public.purchase_invoice_files
   WHERE purchase_id = p_purchase_id;
  IF v_existing_files + jsonb_array_length(p_files) = 0
     AND nullif(v_purchase.invoice_image_url, '') IS NULL THEN
    RAISE EXCEPTION 'Add at least one bill photo or PDF';
  END IF;
  IF v_existing_files + jsonb_array_length(p_files) > 4 THEN
    RAISE EXCEPTION 'Maximum 4 bill files can be attached to one receiving';
  END IF;

  SELECT count(*) INTO v_purchase_lines
    FROM public.purchase_items
   WHERE purchase_id = p_purchase_id;
  SELECT count(DISTINCT nullif(e->>'purchase_item_id', '')::uuid)
    INTO v_input_lines
    FROM jsonb_array_elements(p_lines) e;
  IF v_input_lines <> v_purchase_lines
     OR jsonb_array_length(p_lines) <> v_purchase_lines THEN
    RAISE EXCEPTION 'Enter one final rate for every received item';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) e
     WHERE coalesce((e->>'rate')::numeric, -1) < 0
  ) THEN
    RAISE EXCEPTION 'Final rate cannot be negative';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) e
    LEFT JOIN public.purchase_items pi
      ON pi.id = nullif(e->>'purchase_item_id', '')::uuid
     AND pi.purchase_id = p_purchase_id
    WHERE pi.id IS NULL
  ) THEN
    RAISE EXCEPTION 'A bill line does not belong to this receiving';
  END IF;

  PERFORM public.allow_stock_move();

  FOR v_line IN
    SELECT pi.*, (e->>'rate')::numeric AS final_rate
      FROM jsonb_array_elements(p_lines) e
      JOIN public.purchase_items pi
        ON pi.id = (e->>'purchase_item_id')::uuid
     WHERE pi.purchase_id = p_purchase_id
     FOR UPDATE OF pi
  LOOP
    v_new_total := round(coalesce(v_line.quantity, 0) * v_line.final_rate, 2);

    PERFORM 1 FROM public.ingredient_batches
     WHERE purchase_id = p_purchase_id
       AND ingredient_id = v_line.ingredient_id
     FOR UPDATE;
    SELECT coalesce(sum(qty_received), 0), coalesce(sum(qty_remaining), 0)
      INTO v_received, v_remaining
      FROM public.ingredient_batches
     WHERE purchase_id = p_purchase_id
       AND ingredient_id = v_line.ingredient_id;
    v_consumed := greatest(v_received - v_remaining, 0);
    v_remaining_delta := round(v_remaining * (v_line.final_rate - coalesce(v_line.rate, 0)), 2);
    v_consumed_delta := round(v_consumed * (v_line.final_rate - coalesce(v_line.rate, 0)), 2);

    IF v_line.final_rate IS DISTINCT FROM v_line.rate THEN
      UPDATE public.purchase_items
         SET rate = v_line.final_rate,
             total = v_new_total
       WHERE id = v_line.id;

      UPDATE public.ingredient_batches
         SET rate = v_line.final_rate
       WHERE purchase_id = p_purchase_id
         AND ingredient_id = v_line.ingredient_id;

      UPDATE public.stock_ledger
         SET value = round(abs(change_qty) * v_line.final_rate, 2),
             reason = 'No-bill stock-in final rate — ' || v_line.item_name
       WHERE reference_type = 'purchase'
         AND reference_id = p_purchase_id
         AND ingredient_id = v_line.ingredient_id
         AND change_qty > 0;

      IF v_remaining_delta <> 0 THEN
        INSERT INTO public.stock_ledger
          (ingredient_id, canteen_id, change_qty, balance_after, reason,
           reference_type, reference_id, created_by, service_date, value)
        SELECT v_line.ingredient_id, v_purchase.canteen_id, 0, i.current_stock,
               format('Late bill final rate: %s → %s per %s (stock on hand)',
                      coalesce(v_line.rate, 0), v_line.final_rate, v_line.unit),
               'reprice', p_purchase_id, auth.uid(), v_today, v_remaining_delta
          FROM public.ingredients i WHERE i.id = v_line.ingredient_id;
      END IF;

      -- If some provisional stock was already issued, recognise the price
      -- correction on the day the bill arrives instead of silently leaving
      -- food cost at the guessed rate.
      IF v_consumed_delta <> 0 THEN
        INSERT INTO public.stock_ledger
          (ingredient_id, canteen_id, change_qty, balance_after, reason,
           reference_type, reference_id, created_by, service_date, value)
        SELECT v_line.ingredient_id, v_purchase.canteen_id, 0, i.current_stock,
               format('Late bill final rate: %s → %s per %s (%s already issued)',
                      coalesce(v_line.rate, 0), v_line.final_rate, v_line.unit, v_consumed),
               'bill_reprice_consumed', p_purchase_id, auth.uid(), v_today, v_consumed_delta
          FROM public.ingredients i WHERE i.id = v_line.ingredient_id;
      END IF;

      UPDATE public.ingredients i
         SET cost_per_unit = v_line.final_rate
       WHERE i.id = v_line.ingredient_id
         AND NOT EXISTS (
           SELECT 1
             FROM public.purchase_items later_pi
             JOIN public.purchases later_p ON later_p.id = later_pi.purchase_id
            WHERE later_pi.ingredient_id = i.id
              AND later_p.status = 'confirmed'
              AND later_p.created_at > v_purchase.created_at
         );

      INSERT INTO public.purchase_line_corrections
        (canteen_id, purchase_id, purchase_item_id, corrected_by, reason, old_values, new_values)
      VALUES
        (v_purchase.canteen_id, p_purchase_id, v_line.id, auth.uid(),
         'Late bill received — provisional rate replaced with final invoice rate',
         jsonb_build_object('rate', v_line.rate, 'total', v_line.total,
                            'rate_status', 'provisional'),
         jsonb_build_object('rate', v_line.final_rate, 'total', v_new_total,
                            'rate_status', 'final', 'qty_already_issued', v_consumed,
                            'consumed_value_delta', v_consumed_delta));
      v_changed := v_changed + 1;
    END IF;
  END LOOP;

  SELECT coalesce(sum(total), 0) INTO v_subtotal
    FROM public.purchase_items WHERE purchase_id = p_purchase_id;

  FOR v_file IN
    SELECT e->>'image_path' AS image_path,
           nullif(btrim(e->>'bill_number'), '') AS bill_number,
           nullif(e->>'bill_date', '')::date AS bill_date,
           nullif(e->>'amount', '')::numeric AS amount
      FROM jsonb_array_elements(p_files) e
  LOOP
    IF nullif(btrim(v_file.image_path), '') IS NULL
       OR split_part(v_file.image_path, '/', 1) <> v_purchase.canteen_id::text THEN
      RAISE EXCEPTION 'Invalid bill file path';
    END IF;
    IF v_file.amount IS NOT NULL AND v_file.amount < 0 THEN
      RAISE EXCEPTION 'Bill amount cannot be negative';
    END IF;
    v_first_path := coalesce(v_first_path, v_file.image_path);
    INSERT INTO public.purchase_invoice_files
      (purchase_id, canteen_id, image_path, bill_number, bill_date, amount, uploaded_by)
    VALUES
      (p_purchase_id, v_purchase.canteen_id, v_file.image_path,
       v_file.bill_number, v_file.bill_date, v_file.amount, auth.uid());
  END LOOP;

  SELECT sum(amount) INTO v_file_total
    FROM public.purchase_invoice_files WHERE purchase_id = p_purchase_id;
  v_final_total := coalesce(p_bill_total, v_file_total,
                            v_subtotal + coalesce(p_tax_amount, 0) + coalesce(p_other_charges, 0));
  IF v_final_total < 0 THEN RAISE EXCEPTION 'Bill total cannot be negative'; END IF;

  UPDATE public.purchases
     SET total_amount = v_subtotal,
         stated_total = v_final_total,
         tax_amount = coalesce(p_tax_amount, 0),
         other_charges = coalesce(p_other_charges, 0),
         invoice_image_url = coalesce(invoice_image_url, v_first_path),
         bill_status = 'received',
         bill_received_at = now(),
         bill_finalized_by = auth.uid(),
         bill_finalized_at = now()
   WHERE id = p_purchase_id;

  INSERT INTO public.action_logs
    (user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES
    (auth.uid(), 'late_bill_finalized', 'purchase', p_purchase_id,
     v_purchase.canteen_id,
     jsonb_build_object('provisional_subtotal', v_purchase.total_amount,
                        'final_subtotal', v_subtotal,
                        'gst', coalesce(p_tax_amount, 0),
                        'other_charges', coalesce(p_other_charges, 0),
                        'bill_total', v_final_total,
                        'rates_changed', v_changed,
                        'files_added', jsonb_array_length(p_files)));

  INSERT INTO public.notifications
    (canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES
    (v_purchase.canteen_id, 'admin', 'Pending bill finalised',
     format('%s item rate(s) final hue. Items ₹%s + GST ₹%s + other ₹%s = bill ₹%s. Stock quantity dobara add nahi hui.',
            v_changed, round(v_subtotal, 2), round(coalesce(p_tax_amount, 0), 2),
            round(coalesce(p_other_charges, 0), 2), round(v_final_total, 2)),
     '/purchases', 'purchase', p_purchase_id);

  RETURN jsonb_build_object(
    'purchase_id', p_purchase_id,
    'rates_changed', v_changed,
    'items_subtotal', v_subtotal,
    'tax_amount', coalesce(p_tax_amount, 0),
    'other_charges', coalesce(p_other_charges, 0),
    'bill_total', v_final_total,
    'stock_quantity_changed', false,
    'mismatch', CASE
      WHEN abs(v_final_total - (v_subtotal + coalesce(p_tax_amount, 0) + coalesce(p_other_charges, 0))) > 1
      THEN round(v_final_total - (v_subtotal + coalesce(p_tax_amount, 0) + coalesce(p_other_charges, 0)), 2)
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_pending_purchase_bill(UUID,JSONB,JSONB,NUMERIC,NUMERIC,NUMERIC)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_pending_purchase_bill(UUID,JSONB,JSONB,NUMERIC,NUMERIC,NUMERIC)
  TO authenticated;

COMMENT ON FUNCTION public.finalize_pending_purchase_bill(UUID,JSONB,JSONB,NUMERIC,NUMERIC,NUMERIC) IS
  'Finalises provisional no-bill rates, GST/charges and evidence without adding stock twice.';

-- Include corrections for provisional stock already issued before its bill
-- arrived. Quantity stays zero; only the later-known value difference enters
-- consumption on the bill-finalisation date.
CREATE OR REPLACE FUNCTION public.net_consumption_lines(
  p_canteen_id UUID, p_start DATE, p_end DATE
) RETURNS TABLE(
  ingredient_id UUID, item_name TEXT, unit TEXT, service_date DATE,
  qty NUMERIC, value NUMERIC
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.ingredient_id, i.name, i.unit,
         CASE WHEN l.reference_type='return'
              THEN coalesce(l.service_date,m.menu_date,r.req_date,
                            (l.created_at AT TIME ZONE 'Asia/Kolkata')::date)
              ELSE coalesce(l.service_date,(l.created_at AT TIME ZONE 'Asia/Kolkata')::date) END,
         CASE WHEN l.reference_type='bill_reprice_consumed' THEN 0 ELSE -l.change_qty END,
         CASE
           WHEN l.reference_type IN ('issue','recipe') AND l.change_qty < 0
             THEN abs(coalesce(l.value, -l.change_qty * coalesce(i.cost_per_unit, 0)))
           WHEN l.reference_type = 'return' AND l.change_qty > 0
             THEN -abs(coalesce(l.value,l.change_qty*coalesce(ic.unit_cost,i.cost_per_unit,0)))
           WHEN l.reference_type = 'bill_reprice_consumed'
             THEN coalesce(l.value, 0)
           ELSE 0
         END
    FROM public.stock_ledger l
    JOIN public.ingredients i ON i.id = l.ingredient_id
    LEFT JOIN public.requisitions r ON r.id=l.reference_id AND l.reference_type='return'
    LEFT JOIN public.menu_plans m ON m.id=r.menu_plan_id
    LEFT JOIN LATERAL (
      SELECT sum(abs(coalesce(x.value,0)))/nullif(sum(-x.change_qty),0) unit_cost
        FROM public.stock_ledger x
       WHERE x.reference_id=l.reference_id AND x.ingredient_id=l.ingredient_id
         AND x.reference_type IN ('issue','recipe') AND x.change_qty<0
    ) ic ON true
   WHERE l.canteen_id = p_canteen_id
     AND public.can_access_canteen(p_canteen_id)
     AND (((l.reference_type IN ('issue','recipe')) AND l.change_qty < 0)
       OR (l.reference_type = 'return' AND l.change_qty > 0)
       OR l.reference_type = 'bill_reprice_consumed')
     AND (CASE WHEN l.reference_type='return'
               THEN coalesce(l.service_date,m.menu_date,r.req_date,
                             (l.created_at AT TIME ZONE 'Asia/Kolkata')::date)
               ELSE coalesce(l.service_date,(l.created_at AT TIME ZONE 'Asia/Kolkata')::date) END)
         BETWEEN p_start AND p_end;
$$;

REVOKE ALL ON FUNCTION public.net_consumption_lines(UUID,DATE,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.net_consumption_lines(UUID,DATE,DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';
