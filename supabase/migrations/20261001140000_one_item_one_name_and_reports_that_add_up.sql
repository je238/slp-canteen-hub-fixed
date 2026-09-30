-- ============================================================
-- ONE ITEM, ONE NAME — AND REPORTS THAT ADD UP
--
-- The September variance (₹1.02 lakh short, ₹60k over, at the 30 Sept count)
-- was inflated by the same stock sitting under two names. Half-typed names
-- became items and took real deliveries:
--   onio 170 kg (Onion counted 460 and showed +246 "excess")
--   Rajama 150 kg at ₹600/kg — ₹90,000 on the books for Rajma worth ~₹112/kg
--   photo 240 kg at ₹15 — potatoes, from Maa Annapurna on 26/09
--   Panner 31.3 kg, chacha 60 kg, cab 7 kg, khada 1 kg, garli, maid,
--   rosted papad
-- Each is merged into the real item with merge_ingredients(), which carries
-- the stock, lots, bills, orders and ledger across and writes a
-- reconciliation row. Rajama's lots are repriced to Rajma's paid rate first:
-- the ₹600 came from a hand entry with no bill behind it.
--
-- Three names with no stock and no bill (ba, A030753, ILI565) are archived,
-- not deleted. "mir" and "cef" are real bills whose names only the store
-- keeper can read; they are left for him.
--
-- Reports: "vegetable purchase" counted only items whose category said
-- Vegetables — 13 of 143 — so most vegetables fell out of it, and 67 items
-- had no category at all. Every item now has one of seven groups, and
-- purchase_by_category() gives grocery / vegetables / dairy / masala /
-- namkeen / housekeeping side by side, with the bill total reconciled to
-- the lines + GST + charges so the two can never silently disagree.
--
-- Alerts: stock_alert_trail() explains a count difference — the last count,
-- what came in and went out since, what the app expected, what was counted,
-- any look-alike item holding stock, and the likely cause.
--
-- The user approved merging and removing these on 01/10/2026.
-- Safe to re-run.
-- ============================================================

-- Run as the owner so merge_ingredients() and the edit guards accept it.
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '1f309655-eb07-43f9-af57-1b5c52d43e05', 'role', 'authenticated')::text, true);

-- ---------- 1. Rajama's rate had no bill behind it ----------
DO $$
DECLARE v_from uuid; v_into uuid; v_rate numeric;
BEGIN
  SELECT id INTO v_from FROM public.ingredients
   WHERE canteen_id = 'd4402630-dec6-44fa-b14c-405b45258f99' AND name = 'Rajama' AND archived_at IS NULL;
  SELECT id INTO v_into FROM public.ingredients
   WHERE canteen_id = 'd4402630-dec6-44fa-b14c-405b45258f99' AND name = 'Rajma' AND archived_at IS NULL;
  IF v_from IS NULL OR v_into IS NULL THEN RETURN; END IF;
  v_rate := public.item_replacement_rate(v_into);
  IF coalesce(v_rate, 0) = 0 THEN RETURN; END IF;
  PERFORM public.allow_stock_move();
  UPDATE public.ingredient_batches SET rate = v_rate WHERE ingredient_id = v_from AND rate > v_rate * 2;
  UPDATE public.ingredients SET cost_per_unit = v_rate WHERE id = v_from AND cost_per_unit > v_rate * 2;
  INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'rate_corrected', 'ingredient', v_from, 'd4402630-dec6-44fa-b14c-405b45258f99',
    jsonb_build_object('item', 'Rajama', 'was', 600, 'now', v_rate,
      'reason', 'No bill behind ₹600/kg; set to Rajma''s last paid rate before merging the duplicate'));
END $$;

-- ---------- 2. Merge the half-typed duplicates into the real items ----------
DO $$
DECLARE m record; v_from uuid; v_into uuid; r jsonb;
BEGIN
  FOR m IN SELECT * FROM (VALUES
    ('onio', 'Onion'), ('garli', 'Garlic'), ('maid', 'Maida'), ('rosted papad', 'Roasted papad'),
    ('Panner', 'Paneer'), ('Rajama', 'Rajma'), ('photo', 'Potato'), ('chacha', 'CHHACH'),
    ('cab', 'Cabbage'), ('khada', 'KHADA MASALA')
  ) AS x(from_name, into_name)
  LOOP
    SELECT id INTO v_from FROM public.ingredients
     WHERE canteen_id = 'd4402630-dec6-44fa-b14c-405b45258f99' AND name = m.from_name AND archived_at IS NULL;
    SELECT id INTO v_into FROM public.ingredients
     WHERE canteen_id = 'd4402630-dec6-44fa-b14c-405b45258f99' AND name = m.into_name AND archived_at IS NULL;
    CONTINUE WHEN v_from IS NULL OR v_into IS NULL;
    r := public.merge_ingredients(v_from, v_into);
    RAISE NOTICE 'merged % into %: %', m.from_name, m.into_name, r;
  END LOOP;
END $$;

-- ---------- 3. Names with no stock and no bill ----------
DO $$
BEGIN
  PERFORM public.allow_stock_move();
  UPDATE public.ingredients SET archived_at = now()
   WHERE canteen_id = 'd4402630-dec6-44fa-b14c-405b45258f99'
     AND name IN ('ba', 'A030753', 'ILI565')
     AND archived_at IS NULL AND coalesce(current_stock, 0) = 0
     AND NOT EXISTS (SELECT 1 FROM public.purchase_items pi WHERE pi.ingredient_id = ingredients.id);
END $$;

-- ---------- 4. Every item gets a group ----------
DO $$
DECLARE g record;
BEGIN
  PERFORM public.allow_stock_move();
  FOR g IN SELECT * FROM (VALUES
    ('Vegetables & Fruits', ARRAY['beetroot','cabbage','capsicum','cucumber','drumstick','garlic','ginger','green pease','lemon','onion','potato','pumpkin','tomato','bottle groud','carrot','chili','coriander leaves','curry leaves','dum potato','garlic pleed','green chili','mix veg','mint leaves','pomegranate','banana karate','okra ladyfinger','papita','parwal','sponge gourd','watermelon','chawla']),
    ('Dairy', ARRAY['amul gold','chhach','paneer','amul curd','amul tikki','amul cream','curd','mawa']),
    ('Grocery', ARRAY['atta','besan','maida','suji','oil','salt','rock salt','black salt','sugar','gud','mishri','dawat rice','rice biryani','rice bhasmati','kheer rice','sabudana','poha fresh','cornflour','dal chana','chana dal','dal red malka','dal toor','peanut','rajma','kabuli chana','black chana','moong chilka','moong mogar','uarad mogar','urad daal','seviyan','coconut powder','kaju tukdi','kaju','kismis','pista katran','tutay furti','imli','tatri','tili']),
    ('Masala', ARRAY['ajwain','amchur','biryani m','chili powder','red chilli powder','coriander powder','garam masala','hing','jeera','katuri methi','khada dhaniya','khada masala','kitchen king masala','paneer masala','pawbhaji masala','rai','raita masala','red chilly whole','khadi mirchi','sambhar m.','sounf barik','sounf moti','sweet sounf','tej patta','turmeric powder','chhole masala','idli powder','ajinomoto','red colour','yello colour']),
    ('Namkeen & Ready Mix', ARRAY['barik sev','sev moti','boondi','papad katrang','roasted papad','battar papar','khaman mix','gulab jamun','pickle','soya souce','red chilyy souce','green chili sose','vinger','fingar']),
    ('Housekeeping', ARRAY['nirma','hand gloves','spoon','pepar plate','clean file'])
  ) AS x(grp, names)
  LOOP
    UPDATE public.ingredients SET category = g.grp
     WHERE canteen_id = 'd4402630-dec6-44fa-b14c-405b45258f99'
       AND lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = ANY (g.names)
       AND category IS DISTINCT FROM g.grp;
  END LOOP;
  UPDATE public.ingredients SET category = 'Unknown — check'
   WHERE canteen_id = 'd4402630-dec6-44fa-b14c-405b45258f99' AND archived_at IS NULL
     AND category NOT IN ('Vegetables & Fruits','Dairy','Grocery','Masala','Namkeen & Ready Mix','Housekeeping');
END $$;

-- ---------- 5. Purchases by group, reconciled to the bills ----------
CREATE OR REPLACE FUNCTION public.purchase_by_category(p_canteen_id uuid, p_start date, p_end date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF NOT public.can_access_canteen(p_canteen_id) THEN RAISE EXCEPTION 'You do not have access to this site'; END IF;
  WITH bills AS (
    SELECT p.* FROM public.purchases p
     WHERE p.canteen_id = p_canteen_id AND p.status = 'confirmed'
       AND (p.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN p_start AND p_end
  ), lines AS (
    SELECT coalesce(i.category, 'Unknown — check') AS grp,
           coalesce(i.name, pi.item_name) AS item, coalesce(i.unit, pi.unit) AS unit,
           pi.quantity, pi.total, b.supplier_id, b.id AS bill_id
      FROM bills b JOIN public.purchase_items pi ON pi.purchase_id = b.id
      LEFT JOIN public.ingredients i ON i.id = pi.ingredient_id
  ), g AS (
    SELECT grp, round(sum(total), 2) AS amount, count(*) AS lines, count(DISTINCT bill_id) AS bills,
           count(DISTINCT item) AS items
      FROM lines GROUP BY grp
  ), top AS (
    SELECT grp, jsonb_agg(jsonb_build_object('item', item, 'qty', qty, 'unit', unit, 'amount', amount,
                          'avg_rate', CASE WHEN qty > 0 THEN round(amount / qty, 2) END)
                          ORDER BY amount DESC) AS items
      FROM (SELECT grp, item, unit, round(sum(quantity), 3) qty, round(sum(total), 2) amount,
                   row_number() OVER (PARTITION BY grp ORDER BY sum(total) DESC) rn
              FROM lines GROUP BY grp, item, unit) t
     WHERE rn <= 8 GROUP BY grp
  )
  SELECT jsonb_build_object(
    'groups', coalesce((SELECT jsonb_agg(jsonb_build_object('group', g.grp, 'amount', g.amount, 'lines', g.lines,
                         'bills', g.bills, 'items', g.items, 'top', coalesce(top.items, '[]'::jsonb)) ORDER BY g.amount DESC)
                        FROM g LEFT JOIN top ON top.grp = g.grp), '[]'::jsonb),
    'lines_total', coalesce((SELECT round(sum(total), 2) FROM lines), 0),
    'tax_total', coalesce((SELECT round(sum(coalesce(tax_amount, 0)), 2) FROM bills), 0),
    'other_charges', coalesce((SELECT round(sum(coalesce(other_charges, 0)), 2) FROM bills), 0),
    'bill_total', coalesce((SELECT round(sum(total_amount), 2) FROM bills), 0),
    'bills', (SELECT count(*) FROM bills)
  ) INTO v;
  RETURN v || jsonb_build_object('gap',
    round((v->>'bill_total')::numeric - (v->>'lines_total')::numeric - (v->>'tax_total')::numeric - (v->>'other_charges')::numeric, 2));
END;
$$;
REVOKE ALL ON FUNCTION public.purchase_by_category(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purchase_by_category(uuid, date, date) TO authenticated;

-- ---------- 6. Why a count came out different ----------
CREATE OR REPLACE FUNCTION public.stock_alert_trail(p_ingredient_id uuid, p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ing public.ingredients%ROWTYPE; v_audit record; v_prev record;
  v_moves jsonb; v_sum numeric; v_expected numeric; v_counted numeric; v_diff numeric;
  v_rate numeric; v_like jsonb; v_cause text; v_code text; v_n int;
BEGIN
  SELECT * INTO v_ing FROM public.ingredients WHERE id = p_ingredient_id;
  IF NOT FOUND OR NOT public.can_access_canteen(v_ing.canteen_id) THEN RETURN NULL; END IF;

  SELECT created_at, change_qty, balance_after INTO v_audit
    FROM public.stock_ledger
   WHERE ingredient_id = p_ingredient_id AND reference_type IN ('audit', 'manual')
     AND created_at BETWEEN p_at - interval '5 minutes' AND p_at + interval '5 minutes'
   ORDER BY abs(extract(epoch FROM created_at - p_at)) LIMIT 1;

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

  v_counted := v_audit.balance_after;
  v_expected := v_audit.balance_after - v_audit.change_qty;
  v_diff := v_audit.change_qty;
  v_rate := public.item_replacement_rate(p_ingredient_id);

  SELECT coalesce(jsonb_agg(jsonb_build_object('name', o.name, 'stock', o.current_stock, 'unit', o.unit)), '[]'::jsonb)
    INTO v_like
    FROM public.ingredients o
   WHERE o.canteen_id = v_ing.canteen_id AND o.id <> v_ing.id AND o.archived_at IS NULL
     AND coalesce(o.current_stock, 0) > 0
     AND (levenshtein(lower(o.name), lower(v_ing.name)) <= 2
          OR (length(o.name) >= 4 AND lower(v_ing.name) LIKE '%' || lower(o.name) || '%')
          OR (length(v_ing.name) >= 4 AND lower(o.name) LIKE '%' || lower(v_ing.name) || '%'));

  IF jsonb_array_length(v_like) > 0 THEN
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
    'counted_at', v_audit.created_at, 'counted', v_counted, 'expected', v_expected, 'difference', v_diff,
    'value', round(coalesce(v_diff, 0) * v_rate, 2), 'rate', round(v_rate, 2),
    'previous_count_at', v_prev.created_at, 'previous_count', v_prev.balance_after,
    'implied_start', CASE WHEN v_prev.created_at IS NULL THEN round(v_expected - v_sum, 3) END,
    'movements', v_moves, 'look_alikes', v_like, 'cause_code', v_code, 'cause', v_cause);
END;
$$;
REVOKE ALL ON FUNCTION public.stock_alert_trail(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_alert_trail(uuid, timestamptz) TO authenticated;
