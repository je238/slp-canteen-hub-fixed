-- ============================================================
-- A STOCK COUNT CORRECTS THE LOTS, NOT ONLY THE NUMBER
--
-- submit_stock_audit() set ingredients.current_stock to the counted figure
-- but never touched ingredient_batches, the FIFO lots every issue is costed
-- from. So a shortage stayed on the books as lots that were not on the
-- shelf, and a surplus had no lot at all. On 1 Oct 2026, 105 of Eicher's 132
-- items had lots that did not add up to their stock: Ginger 146.42 kg in
-- lots against 23.4 kg counted, Papad Katrang 133 against 42, Uarad mogar
-- 97 kg in stock with no lot. Lots worth about ₹1,32,532 no longer existed
-- and ₹82,023 of stock had none.
--
-- sync_lots_to_count() makes an item's open lots add up to a figure:
--   · too much in lots  → take the difference off the OLDEST lots first,
--                         the same order the kitchen draws them;
--   · too little        → open one lot for the difference at the item's
--                         last real purchase rate (item_replacement_rate),
--                         marked as found in a count.
-- submit_stock_audit() now calls it for every counted item.
--
-- Bringing the existing 105 items into line is a separate, one-off file
-- (20261001200001), applied only with the owner's go-ahead.
--
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.sync_lots_to_count(p_ingredient_id uuid, p_canteen_id uuid, p_qty numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lots numeric; v_gap numeric; v_rate numeric; v_cost numeric := 0;
BEGIN
  IF p_qty IS NULL OR p_qty < 0 THEN RETURN jsonb_build_object('removed', 0, 'added', 0); END IF;
  SELECT coalesce(sum(qty_remaining), 0) INTO v_lots FROM public.ingredient_batches
   WHERE ingredient_id = p_ingredient_id AND canteen_id = p_canteen_id AND qty_remaining > 0;
  v_gap := v_lots - p_qty;
  IF abs(v_gap) < 0.0005 THEN RETURN jsonb_build_object('removed', 0, 'added', 0); END IF;
  PERFORM public.allow_stock_move();

  IF v_gap > 0 THEN
    v_cost := public.consume_batches_fifo(p_ingredient_id, p_canteen_id, v_gap);
    RETURN jsonb_build_object('removed', round(v_gap, 3), 'removed_value', round(v_cost, 2), 'added', 0);
  END IF;

  v_rate := coalesce(nullif(public.item_replacement_rate(p_ingredient_id), 0),
                     (SELECT cost_per_unit FROM public.ingredients WHERE id = p_ingredient_id), 0);
  INSERT INTO public.ingredient_batches
    (ingredient_id, canteen_id, batch_no, qty_received, qty_remaining, rate, received_at)
  VALUES (p_ingredient_id, p_canteen_id, 'COUNT-FOUND', -v_gap, -v_gap, v_rate, now());
  RETURN jsonb_build_object('removed', 0, 'added', round(-v_gap, 3), 'added_value', round(-v_gap * v_rate, 2));
END;
$$;
-- Called only from inside other SECURITY DEFINER functions.
REVOKE ALL ON FUNCTION public.sync_lots_to_count(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.submit_stock_audit(
  p_canteen_id UUID, p_entries JSONB      -- [{ingredient_id, counted, reason}]
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_line RECORD; v_ing RECORD; v_delta NUMERIC; v_n INT := 0; v_short NUMERIC := 0;
  v_rate NUMERIC; v_lines JSONB := '[]'::jsonb; v_ids uuid[] := '{}';
  v_report public.stock_audit_reports%ROWTYPE; v_found BOOLEAN; v_t RECORD;
  v_site TEXT; v_who TEXT; v_body TEXT;
BEGIN
  IF NOT (public.can_receive_stock() AND public.can_access_canteen(p_canteen_id)) THEN
    RAISE EXCEPTION 'You cannot record a stock audit at this site';
  END IF;
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'Nothing to record';
  END IF;

  PERFORM public.allow_stock_move();

  FOR v_line IN
    SELECT (e->>'ingredient_id')::uuid AS ing,
           (nullif(btrim(e->>'counted'), ''))::numeric AS counted,
           coalesce(nullif(btrim(e->>'reason'), ''), 'Stock audit') AS reason
    FROM jsonb_array_elements(p_entries) e
  LOOP
    SELECT id, name, unit, category, current_stock INTO v_ing FROM public.ingredients
    WHERE id = v_line.ing AND canteen_id = p_canteen_id FOR UPDATE;
    CONTINUE WHEN NOT FOUND OR v_line.counted IS NULL;
    IF v_line.counted < 0 THEN
      RAISE EXCEPTION 'Count for % cannot be negative', v_ing.name;
    END IF;

    v_ids := v_ids || v_ing.id;
    v_delta := v_line.counted - coalesce(v_ing.current_stock, 0);
    -- The lots follow the count too, even when the count matched the book:
    -- they are what every later issue is costed from.
    PERFORM public.sync_lots_to_count(v_ing.id, p_canteen_id, v_line.counted);
    CONTINUE WHEN v_delta = 0;

    UPDATE public.ingredients SET current_stock = v_line.counted WHERE id = v_line.ing;

    -- reference_type 'audit' is what fires the shortage alert trigger
    INSERT INTO public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason, reference_type, created_by)
    VALUES (v_line.ing, p_canteen_id, v_delta, v_line.counted,
            v_line.reason, 'audit', auth.uid());

    v_rate := coalesce(public.item_replacement_rate(v_line.ing, (now() AT TIME ZONE 'Asia/Kolkata')::date), 0);
    v_lines := v_lines || jsonb_build_object(
      'ingredient_id', v_ing.id, 'item', v_ing.name, 'unit', v_ing.unit,
      'category', v_ing.category, 'expected', coalesce(v_ing.current_stock, 0),
      'counted', v_line.counted, 'difference', v_delta,
      'rate', round(v_rate, 2), 'value', round(v_delta * v_rate, 2), 'reason', v_line.reason);
    IF v_delta < 0 THEN v_short := v_short + abs(v_delta); END IF;
    v_n := v_n + 1;
  END LOOP;

  IF cardinality(v_ids) = 0 THEN
    RETURN jsonb_build_object('adjusted', 0, 'shortage_qty', 0, 'report_id', NULL);
  END IF;

  -- Same person, same site, within 2 hours of their last submission: one count.
  SELECT * INTO v_report FROM public.stock_audit_reports
   WHERE canteen_id = p_canteen_id AND submitted_by IS NOT DISTINCT FROM auth.uid()
     AND NOT backfilled AND updated_at > now() - interval '2 hours'
   ORDER BY updated_at DESC LIMIT 1 FOR UPDATE;
  v_found := FOUND;

  IF v_found THEN
    UPDATE public.stock_audit_reports
       SET lines = public.stock_audit_merge_lines(lines || v_lines),
           counted_ids = ARRAY(SELECT DISTINCT unnest(counted_ids || v_ids)),
           submissions = submissions + 1, updated_at = now()
     WHERE id = v_report.id
    RETURNING * INTO v_report;
  ELSE
    INSERT INTO public.stock_audit_reports (canteen_id, submitted_by, lines, counted_ids)
    VALUES (p_canteen_id, auth.uid(), public.stock_audit_merge_lines(v_lines),
            ARRAY(SELECT DISTINCT unnest(v_ids)))
    RETURNING * INTO v_report;
  END IF;

  SELECT * INTO v_t FROM public.stock_audit_totals(v_report.lines);
  UPDATE public.stock_audit_reports SET
    counted_items  = cardinality(counted_ids),
    surplus_items  = v_t.sur_n, surplus_value = v_t.sur_v,
    shortage_items = v_t.sho_n, shortage_value = v_t.sho_v,
    net_value      = v_t.sur_v - v_t.sho_v,
    unpriced_items = v_t.unp,
    matched_items  = greatest(cardinality(counted_ids) - v_t.sur_n - v_t.sho_n, 0)
  WHERE id = v_report.id
  RETURNING * INTO v_report;

  SELECT name INTO v_site FROM public.canteens WHERE id = p_canteen_id;
  SELECT split_part(email, '@', 1) INTO v_who FROM auth.users WHERE id = auth.uid();
  v_body := format('%s items gine%s. Zyada: %s items ₹%s · Kam: %s items ₹%s · Net: %s₹%s',
    v_report.counted_items, CASE WHEN v_who IS NOT NULL THEN ' (' || v_who || ')' ELSE '' END,
    v_report.surplus_items, to_char(round(v_report.surplus_value), 'FM99,99,99,990'),
    v_report.shortage_items, to_char(round(v_report.shortage_value), 'FM99,99,99,990'),
    CASE WHEN v_report.net_value < 0 THEN '−' ELSE '+' END,
    to_char(abs(round(v_report.net_value)), 'FM99,99,99,990'));
  IF v_report.unpriced_items > 0 THEN
    v_body := v_body || format(' · %s item ka rate nahi mila', v_report.unpriced_items);
  END IF;

  UPDATE public.notifications
     SET body = v_body, read_at = NULL, created_at = now()
   WHERE ref_type = 'stock_audit_report' AND ref_id = v_report.id;
  IF NOT FOUND THEN
    INSERT INTO public.notifications (canteen_id, target_role, title, body, link, ref_type, ref_id)
    VALUES (p_canteen_id, 'manager',
            'Stock verification report — ' || coalesce(v_site, 'site'),
            v_body, '/stock-audit?report=' || v_report.id, 'stock_audit_report', v_report.id);
  END IF;

  RETURN jsonb_build_object('adjusted', v_n, 'shortage_qty', v_short, 'report_id', v_report.id,
    'counted', v_report.counted_items, 'matched', v_report.matched_items,
    'surplus_items', v_report.surplus_items, 'surplus_value', v_report.surplus_value,
    'shortage_items', v_report.shortage_items, 'shortage_value', v_report.shortage_value,
    'net_value', v_report.net_value, 'joined_earlier', v_found);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_stock_audit(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_stock_audit(UUID, JSONB) TO authenticated;
