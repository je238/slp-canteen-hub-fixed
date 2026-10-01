-- ============================================================
-- EVERY STOCK COUNT SENDS A REPORT
--
-- When the store keeper submits a physical count, the manager, the admin and
-- the owner get one report of it: how many items came out more than the app
-- said and what that surplus is worth, how many came out less and what the
-- shortage is worth, the net, and the item-by-item detail. Until now a count
-- only raised separate per-item shortage alerts; the surplus side and the
-- total were never put in front of anyone.
--
-- Values are at item_replacement_rate() on the day of the count — the last
-- real purchase rate — the same rate the shortage trail uses.
--
-- One count is one report, not one per click. The store keeper submits a few
-- items at a time — on 17 Sept a single round of counting was a dozen
-- submissions in ten minutes — so a submission by the same person at the same
-- site within 2 hours of their last one joins that report: its lines merge by
-- item, the totals are recomputed from the merged lines, and the same
-- notification is refreshed (brought back to the top, unread) instead of a
-- new one landing each time.
--
-- One notification row addressed to 'manager' reaches the manager, the admin
-- and the owner (see 20260815130000 and the push fan-out in 20260903115946),
-- so nobody gets it twice.
--
-- Counts made before this migration get their reports rebuilt from the ledger
-- with the same 2-hour grouping, without notifications.
--
-- Safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.stock_audit_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canteen_id      uuid NOT NULL REFERENCES public.canteens(id) ON DELETE CASCADE,
  submitted_by    uuid,
  submitted_at    timestamptz NOT NULL DEFAULT now(),   -- first submission
  updated_at      timestamptz NOT NULL DEFAULT now(),   -- latest submission
  submissions     int NOT NULL DEFAULT 1,
  counted_ids     uuid[] NOT NULL DEFAULT '{}',         -- every item counted
  counted_items   int NOT NULL DEFAULT 0,
  matched_items   int NOT NULL DEFAULT 0,   -- counted and equal to the app
  surplus_items   int NOT NULL DEFAULT 0,
  surplus_value   numeric(14,2) NOT NULL DEFAULT 0,
  shortage_items  int NOT NULL DEFAULT 0,
  shortage_value  numeric(14,2) NOT NULL DEFAULT 0,  -- positive rupees
  net_value       numeric(14,2) NOT NULL DEFAULT 0,  -- surplus - shortage
  unpriced_items  int NOT NULL DEFAULT 0,   -- differences with no known rate
  lines           jsonb NOT NULL DEFAULT '[]'::jsonb,
  backfilled      boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_stock_audit_reports_site
  ON public.stock_audit_reports (canteen_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_audit_reports_session
  ON public.stock_audit_reports (canteen_id, submitted_by, updated_at DESC);

ALTER TABLE public.stock_audit_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stock_audit_reports_select" ON public.stock_audit_reports;
CREATE POLICY "stock_audit_reports_select" ON public.stock_audit_reports
  FOR SELECT TO authenticated
  USING (public.can_access_canteen(canteen_id)
         AND (public.is_manager_or_above() OR submitted_by = auth.uid()));
-- Written only by submit_stock_audit (SECURITY DEFINER); never edited by hand.
REVOKE INSERT, UPDATE, DELETE ON public.stock_audit_reports FROM anon, authenticated;
GRANT SELECT ON public.stock_audit_reports TO authenticated;

-- Folds lines for the same item into one: the first book figure, the last
-- count, the differences and values added up. Items that net to zero drop out.
CREATE OR REPLACE FUNCTION public.stock_audit_merge_lines(p_lines jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(m ORDER BY abs((m->>'value')::numeric) DESC, m->>'item'), '[]'::jsonb)
  FROM (
    SELECT (array_agg(l ORDER BY o DESC))[1]
           || jsonb_build_object(
                'expected', ((array_agg(l ORDER BY o))[1]->>'expected')::numeric,
                'difference', sum((l->>'difference')::numeric),
                'value', round(sum((l->>'value')::numeric), 2)) AS m
    FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) WITH ORDINALITY AS t(l, o)
    GROUP BY l->>'ingredient_id'
  ) x
  WHERE (m->>'difference')::numeric <> 0;
$$;

-- Totals read off a report's merged lines.
CREATE OR REPLACE FUNCTION public.stock_audit_totals(p_lines jsonb)
RETURNS TABLE (sur_n int, sur_v numeric, sho_n int, sho_v numeric, unp int)
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT (count(*) FILTER (WHERE (l->>'difference')::numeric > 0))::int,
         round(coalesce(sum((l->>'value')::numeric) FILTER (WHERE (l->>'difference')::numeric > 0), 0), 2),
         (count(*) FILTER (WHERE (l->>'difference')::numeric < 0))::int,
         round(coalesce(-sum((l->>'value')::numeric) FILTER (WHERE (l->>'difference')::numeric < 0), 0), 2),
         (count(*) FILTER (WHERE coalesce((l->>'rate')::numeric, 0) = 0))::int
  FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l;
$$;

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

-- ---- Reports for counts made before today ------------------------------
-- Grouped into sessions the same way (same person and site, gap under 2
-- hours). A later item merge rebuilt balance_after on the kept item but never
-- change_qty, so the difference is change_qty.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.stock_audit_reports WHERE backfilled) THEN RETURN; END IF;

  WITH src AS (
    SELECT l.canteen_id, l.created_by, l.created_at, l.ingredient_id, i.name AS item, i.unit, i.category,
           l.change_qty AS diff, l.balance_after AS counted, l.reason,
           coalesce(public.item_replacement_rate(l.ingredient_id, (l.created_at AT TIME ZONE 'Asia/Kolkata')::date), 0) AS rate
      FROM public.stock_ledger l
      JOIN public.ingredients i ON i.id = l.ingredient_id
     WHERE l.reference_type = 'audit' AND l.change_qty <> 0
  ), marked AS (
    SELECT s.*, CASE WHEN lag(created_at) OVER w IS NULL
                       OR created_at - lag(created_at) OVER w > interval '2 hours' THEN 1 ELSE 0 END AS starts
      FROM src s
    WINDOW w AS (PARTITION BY canteen_id, created_by ORDER BY created_at)
  ), sessions AS (
    SELECT m.*, sum(starts) OVER (PARTITION BY canteen_id, created_by ORDER BY created_at) AS sess
      FROM marked m
  ), built AS (
    SELECT canteen_id, created_by, min(created_at) AS first_at, max(created_at) AS last_at,
           count(DISTINCT created_at)::int AS subs,
           array_agg(DISTINCT ingredient_id) AS ids,
           public.stock_audit_merge_lines(jsonb_agg(jsonb_build_object(
             'ingredient_id', ingredient_id, 'item', item, 'unit', unit, 'category', category,
             'expected', counted - diff, 'counted', counted, 'difference', diff,
             'rate', round(rate, 2), 'value', round(diff * rate, 2), 'reason', reason)
             ORDER BY created_at)) AS lines
      FROM sessions
     GROUP BY canteen_id, created_by, sess
  )
  INSERT INTO public.stock_audit_reports
    (canteen_id, submitted_by, submitted_at, updated_at, submissions, counted_ids, counted_items,
     matched_items, surplus_items, surplus_value, shortage_items, shortage_value, net_value,
     unpriced_items, lines, backfilled)
  SELECT b.canteen_id, b.created_by, b.first_at, b.last_at, b.subs, b.ids, cardinality(b.ids),
         greatest(cardinality(b.ids) - t.sur_n - t.sho_n, 0), t.sur_n, t.sur_v, t.sho_n, t.sho_v,
         t.sur_v - t.sho_v, t.unp, b.lines, true
    FROM built b
    CROSS JOIN LATERAL public.stock_audit_totals(b.lines) t;
END $$;
