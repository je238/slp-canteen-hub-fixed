-- ============================================================
-- THE TRAIL USES THE REAL COUNT
--
-- merge_ingredients() rebuilds every balance_after on the item it merges
-- into, so after "onio" (170 kg) was folded into Onion, the 30 Sept count
-- row read 630 kg counted when the store had actually counted 460. The alert
-- itself kept the true figures (fraud_alerts.expected_value/actual_value);
-- the explanation now reads the count from there.
--
-- For an item that had a second name folded in after the count, the honest
-- comparison is the physical count against BOTH names' book stock at that
-- moment — for Onion 460 counted against 213.5 + 170 = 383.5, a real +76.5,
-- not the +246.5 the one-name count showed. The trail says so, names the
-- merge, and asks for a recount: the shelf figure now carries the second
-- name's stock on top of a count that had already included it.
--
-- Safe to re-run.
-- ============================================================
CREATE OR REPLACE FUNCTION public.stock_alert_trail(p_ingredient_id uuid, p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ing public.ingredients%ROWTYPE; v_audit record; v_prev record; v_alert record;
  v_moves jsonb; v_sum numeric; v_book numeric; v_counted numeric; v_diff numeric;
  v_rate numeric; v_like jsonb; v_cause text; v_code text; v_n int; v_merged jsonb; v_moved numeric;
BEGIN
  SELECT * INTO v_ing FROM public.ingredients WHERE id = p_ingredient_id;
  IF NOT FOUND OR NOT public.can_access_canteen(v_ing.canteen_id) THEN RETURN NULL; END IF;

  SELECT created_at, change_qty, balance_after INTO v_audit
    FROM public.stock_ledger
   WHERE ingredient_id = p_ingredient_id AND reference_type IN ('audit', 'manual')
     AND created_at BETWEEN p_at - interval '5 minutes' AND p_at + interval '5 minutes'
   ORDER BY abs(extract(epoch FROM created_at - p_at)) LIMIT 1;

  SELECT expected_value, actual_value INTO v_alert
    FROM public.fraud_alerts
   WHERE ingredient_id = p_ingredient_id AND alert_type = 'stock_discrepancy'
     AND expected_value IS NOT NULL AND actual_value IS NOT NULL
     AND created_at BETWEEN coalesce(v_audit.created_at, p_at) - interval '10 minutes'
                        AND coalesce(v_audit.created_at, p_at) + interval '10 minutes'
   ORDER BY abs(extract(epoch FROM created_at - coalesce(v_audit.created_at, p_at))) LIMIT 1;

  SELECT created_at, balance_after INTO v_prev
    FROM public.stock_ledger
   WHERE ingredient_id = p_ingredient_id AND reference_type = 'audit'
     AND created_at < coalesce(v_audit.created_at, p_at) - interval '10 minutes'
   ORDER BY created_at DESC LIMIT 1;

  SELECT coalesce(jsonb_agg(jsonb_build_object('type', reference_type, 'qty', q, 'entries', n) ORDER BY abs(q) DESC), '[]'::jsonb),
         coalesce(sum(q), 0), coalesce(sum(n), 0)
    INTO v_moves, v_sum, v_n
    FROM (SELECT reference_type, round(sum(change_qty), 3) q, count(*) n
            FROM public.stock_ledger
           WHERE ingredient_id = p_ingredient_id
             AND created_at > coalesce(v_prev.created_at, '-infinity')
             AND created_at < coalesce(v_audit.created_at, p_at)
           GROUP BY reference_type) x;

  -- Book stock just before the count, across every name now folded into
  -- this item (the ledger was repointed by the merge).
  v_book := v_audit.balance_after - v_audit.change_qty;
  -- Stock a later merge carried onto this item. The merge rebuilt this
  -- row's balance to include it, but it was not on the shelf being counted
  -- under this name. Read from the merge row: "...; 170 kg shelf moved; ...".
  SELECT coalesce(sum(nullif(substring(reason FROM '; ([0-9.]+) [^;]* shelf moved'), '')::numeric), 0) INTO v_moved
    FROM public.stock_ledger
   WHERE ingredient_id = p_ingredient_id AND reference_type = 'merge_reconciliation'
     AND created_at > coalesce(v_audit.created_at, p_at);
  -- What was physically counted: from the alert, which a merge never
  -- touches; otherwise the count row less what a merge added afterwards.
  v_counted := coalesce(v_alert.actual_value, v_audit.balance_after - v_moved);
  v_diff := v_counted - v_book;
  v_rate := public.item_replacement_rate(p_ingredient_id);

  SELECT coalesce(jsonb_agg(reason ORDER BY created_at), '[]'::jsonb) INTO v_merged
    FROM public.stock_ledger
   WHERE ingredient_id = p_ingredient_id AND reference_type = 'merge_reconciliation'
     AND created_at > coalesce(v_audit.created_at, p_at);

  SELECT coalesce(jsonb_agg(jsonb_build_object('name', o.name, 'stock', o.current_stock, 'unit', o.unit)), '[]'::jsonb)
    INTO v_like
    FROM public.ingredients o
   WHERE o.canteen_id = v_ing.canteen_id AND o.id <> v_ing.id AND o.archived_at IS NULL
     AND coalesce(o.current_stock, 0) > 0
     AND o.category IS NOT DISTINCT FROM v_ing.category
     AND (levenshtein(lower(o.name), lower(v_ing.name)) <= 2
          OR (length(o.name) >= 4 AND lower(v_ing.name) LIKE '%' || lower(o.name) || '%')
          OR (length(v_ing.name) >= 4 AND lower(o.name) LIKE '%' || lower(v_ing.name) || '%'));

  IF jsonb_array_length(v_merged) > 0 THEN
    v_code := 'merged_later';
    v_cause := format('Is item ka doosra naam ginti ke baad joda gaya. Dono naam milakar ginti ke waqt app me %s %s tha, gina gaya %s %s — asli farak lagbhag %s %s. Joda gaya stock ginti me pehle hi shaamil tha, isliye ye item ab dobara gino.',
      round(v_book, 3), v_ing.unit, round(v_counted, 3), v_ing.unit,
      CASE WHEN v_diff > 0 THEN '+' ELSE '' END || round(v_diff, 3), v_ing.unit);
  ELSIF jsonb_array_length(v_like) > 0 THEN
    v_code := 'look_alike';
    v_cause := 'Isi jaisa doosra item stock ke saath pada hai — maal galat naam par chadha ya utra ho sakta hai. Dono ko ek karo, phir dobara gino.';
  ELSIF v_n = 0 AND v_prev.created_at IS NULL THEN
    v_code := 'opening';
    v_cause := 'Pehle kabhi gina nahi gaya aur koi len-den nahi — shuruaati (opening) aankda hi galat tha.';
  ELSIF v_n = 0 THEN
    v_code := 'no_movement';
    v_cause := 'Pichhli ginti ke baad koi entry nahi — ya pichhli ginti galat thi, ya maal bina entry ke aaya/gaya.';
  ELSIF v_diff > 0 THEN
    v_code := 'excess';
    v_cause := 'Gina gaya zyada — maal aaya par bill nahi chadha, ya app me kitchen ko jitna diya dikhaya utna diya nahi.';
  ELSIF v_ing.category IN ('Vegetables & Fruits', 'Dairy') THEN
    v_code := 'perishable';
    v_cause := 'Roz ka taaza maal — kitchen ko bina order diya gaya, ya kharab hua aur wastage me nahi likha.';
  ELSE
    v_code := 'unexplained';
    v_cause := 'Bina entry ki kami — kitchen ko bina order diya gaya ya maal gayab hua. Store keeper se likhit wajah lo.';
  END IF;

  RETURN jsonb_build_object(
    'item', v_ing.name, 'unit', v_ing.unit, 'category', v_ing.category,
    'counted_at', v_audit.created_at, 'counted', v_counted, 'expected', v_book, 'difference', v_diff,
    'value', round(coalesce(v_diff, 0) * v_rate, 2), 'rate', round(v_rate, 2),
    'previous_count_at', v_prev.created_at, 'previous_count', v_prev.balance_after,
    'implied_start', CASE WHEN v_prev.created_at IS NULL THEN round(v_book - v_sum, 3) END,
    'movements', v_moves, 'look_alikes', v_like, 'merged_later', v_merged,
    'cause_code', v_code, 'cause', v_cause);
END;
$$;
REVOKE ALL ON FUNCTION public.stock_alert_trail(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_alert_trail(uuid, timestamptz) TO authenticated;
