-- ============================================================
-- THE STORE RECORDS WHAT IT SAVED
--
-- The chef orders 20 kg of sugar, the order is approved at every level, and
-- the store hands over 18 because 18 is what the kitchen actually needs. The
-- store keeper could already enter "asal mein diya 18", but the other 2 kg
-- then sat on the order as pending — as if still owed — until the chef closed
-- it. Nothing recorded that the store had deliberately held 2 kg back, or
-- what that was worth.
--
-- Now, for each line given short, the store keeper chooses:
--   baaki baad mein denge   — the remainder stays pending (as before)
--   baaki ki zaroorat nahi  — the remainder is closed as a saving: saved_qty
--                             and saved_value (at replacement rate) are kept
--                             on the line, and the order closes if nothing
--                             else is pending.
-- A saving is never consumption and never moves stock: the 2 kg never left
-- the shelf. It is a record of an order that asked for more than was used.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.requisition_items
  ADD COLUMN IF NOT EXISTS saved_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS saved_value numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.requisition_items.saved_qty IS
  'Approved quantity the store deliberately did not hand over and closed as not needed.';
COMMENT ON COLUMN public.requisition_items.saved_value IS
  'saved_qty at the item''s replacement rate when it was closed.';

CREATE OR REPLACE FUNCTION public.issue_requisition_actual_with_savings(p_req_id uuid, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_issue jsonb; v_req public.requisitions%ROWTYPE;
  v_input jsonb; v_line public.requisition_items%ROWTYPE;
  v_pending numeric; v_rate numeric; v_reason text; v_name text;
  v_saved_lines int := 0; v_saved_value numeric := 0; v_left int; v_saved jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.can_issue_stock() THEN
    RAISE EXCEPTION 'Sirf Store Keeper ya Manager stock issue kar sakta hai';
  END IF;

  -- Hand over what was actually given, exactly as the plain issue does.
  v_issue := public.issue_requisition_actual(p_req_id, p_items);

  SELECT * INTO v_req FROM public.requisitions WHERE id = p_req_id FOR UPDATE;

  FOR v_input IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    CONTINUE WHEN coalesce((v_input->>'close_rest')::boolean, false) IS NOT TRUE;

    SELECT * INTO v_line FROM public.requisition_items
     WHERE id = (v_input->>'requisition_item_id')::uuid AND requisition_id = p_req_id FOR UPDATE;
    CONTINUE WHEN NOT FOUND;

    v_pending := greatest(coalesce(v_line.approved_qty, v_line.requested_qty) - coalesce(v_line.issued_qty, 0), 0);
    CONTINUE WHEN v_pending <= 0;

    v_reason := nullif(btrim(coalesce(v_input->>'reason', '')), '');
    v_rate := public.item_replacement_rate(v_line.ingredient_id);

    PERFORM public.allow_stock_move();
    PERFORM set_config('app.close_pending', 'on', true);
    UPDATE public.requisition_items
       SET cancelled_qty = coalesce(cancelled_qty, 0) + v_pending,
           cancellation_reason = 'Bachat — store ne kam diya' || coalesce(': ' || v_reason, ''),
           cancelled_by = auth.uid(),
           cancelled_at = now(),
           saved_qty = saved_qty + v_pending,
           saved_value = saved_value + round(v_pending * v_rate, 2),
           approved_qty = coalesce(issued_qty, 0)
     WHERE id = v_line.id;
    PERFORM set_config('app.close_pending', '', true);

    SELECT name INTO v_name FROM public.ingredients WHERE id = v_line.ingredient_id;
    v_saved_lines := v_saved_lines + 1;
    v_saved_value := v_saved_value + round(v_pending * v_rate, 2);
    v_saved := v_saved || jsonb_build_array(jsonb_build_object(
      'item', v_name, 'ordered', coalesce(v_line.approved_qty, v_line.requested_qty),
      'given', coalesce(v_line.issued_qty, 0), 'saved', v_pending, 'unit', v_line.unit,
      'value', round(v_pending * v_rate, 2)));
  END LOOP;

  IF v_saved_lines > 0 THEN
    SELECT count(*) INTO v_left FROM public.requisition_items
     WHERE requisition_id = p_req_id
       AND greatest(coalesce(approved_qty, requested_qty) - coalesce(issued_qty, 0), 0) > 0;

    IF v_left = 0 AND v_req.status = 'approved' THEN
      UPDATE public.requisitions
         SET status = 'issued', issued_by = coalesce(issued_by, auth.uid()), issued_at = coalesce(issued_at, now())
       WHERE id = p_req_id;
    END IF;

    INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
    VALUES (auth.uid(), 'store_saved_quantity', 'requisition', p_req_id, v_req.canteen_id,
      jsonb_build_object('req_no', v_req.req_no, 'lines', v_saved, 'value', v_saved_value));
  END IF;

  RETURN coalesce(v_issue, '{}'::jsonb) || jsonb_build_object(
    'saved_lines', v_saved_lines, 'saved_value', v_saved_value, 'saved', v_saved,
    'pending_lines', (SELECT count(*) FROM public.requisition_items
                       WHERE requisition_id = p_req_id
                         AND greatest(coalesce(approved_qty, requested_qty) - coalesce(issued_qty, 0), 0) > 0));
END;
$$;
REVOKE ALL ON FUNCTION public.issue_requisition_actual_with_savings(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_requisition_actual_with_savings(uuid, jsonb) TO authenticated;

-- What the store saved over a period, for the store keeper and the owner.
CREATE OR REPLACE FUNCTION public.store_savings(p_canteen_id uuid, p_from date, p_to date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN NOT public.can_access_canteen(p_canteen_id) THEN NULL ELSE
    jsonb_build_object(
      'value', coalesce(sum(ri.saved_value), 0),
      'lines', count(*),
      'items', coalesce((
        SELECT jsonb_agg(x ORDER BY x.value DESC) FROM (
          SELECT i.name AS item, i.unit, sum(r2.saved_qty) AS qty, sum(r2.saved_value) AS value
            FROM public.requisition_items r2
            JOIN public.requisitions q2 ON q2.id = r2.requisition_id
            JOIN public.ingredients i ON i.id = r2.ingredient_id
           WHERE q2.canteen_id = p_canteen_id AND r2.saved_qty > 0
             AND (r2.cancelled_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN p_from AND p_to
           GROUP BY i.name, i.unit
           ORDER BY sum(r2.saved_value) DESC LIMIT 10) x), '[]'::jsonb))
  END
  FROM public.requisition_items ri
  JOIN public.requisitions q ON q.id = ri.requisition_id
  WHERE q.canteen_id = p_canteen_id AND ri.saved_qty > 0
    AND (ri.cancelled_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN p_from AND p_to;
$$;
REVOKE ALL ON FUNCTION public.store_savings(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_savings(uuid, date, date) TO authenticated;

-- ---------- No second item under the same name ----------
-- Near names ("Chili" / "G Chili") can be different things and are left to
-- the person, who is shown them. The same name typed twice never is.
CREATE OR REPLACE FUNCTION public.guard_ingredient_duplicate_name()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_clash text;
BEGIN
  NEW.name := regexp_replace(btrim(NEW.name), '\s+', ' ', 'g');
  SELECT name INTO v_clash FROM public.ingredients
   WHERE canteen_id = NEW.canteen_id AND id <> NEW.id
     AND archived_at IS NULL
     AND lower(regexp_replace(name, '[^[:alnum:]]', '', 'g')) = lower(regexp_replace(NEW.name, '[^[:alnum:]]', '', 'g'))
   LIMIT 1;
  IF v_clash IS NOT NULL THEN
    RAISE EXCEPTION '"%" pehle se inventory mein hai — naya item mat banao, list se wahi chuno', v_clash;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_ingredient_duplicate_name ON public.ingredients;
CREATE TRIGGER trg_guard_ingredient_duplicate_name
  BEFORE INSERT ON public.ingredients
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingredient_duplicate_name();

-- The bill scanner matched an existing item on lower(btrim(name)), so
-- "MIX  VEG" (two spaces) missed "MIX VEG" and opened a second item. Match
-- on the same normalised key the duplicate guard uses, so the goods land on
-- the item that already exists instead of being refused.
DO $$
DECLARE def text; old_pred text := 'lower(btrim(i.name)) = lower(v_line.name)';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'add_stock_from_invoice' LIMIT 1;
  IF def IS NULL THEN RAISE NOTICE 'add_stock_from_invoice not found'; RETURN; END IF;
  IF position(old_pred IN def) = 0 THEN
    RAISE NOTICE 'add_stock_from_invoice already matches on a normalised name';
    RETURN;
  END IF;
  def := replace(def, old_pred,
    'i.archived_at IS NULL AND lower(regexp_replace(i.name, ''[^[:alnum:]]'', '''', ''g'')) = lower(regexp_replace(v_line.name, ''[^[:alnum:]]'', '''', ''g''))');
  EXECUTE def;
END $$;
