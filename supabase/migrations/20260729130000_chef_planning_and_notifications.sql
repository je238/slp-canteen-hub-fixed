-- ============================================================
-- CHEF PLANNING · INVOICE PRICING · SELF-LEARNING · NOTIFICATIONS
--                · PHOTO RETENTION
--
-- 1. Rates come from what the store keeper actually scanned, never typed.
-- 2. The chef's suggested quantity is learned from this site's own history
--    (issued per head over the last 30 days), so it improves every day.
-- 3. Admin is notified of every requisition, for monitoring only.
-- 4. Evidence photos self-destruct after a month.
--
-- Safe to re-run.
-- ============================================================

-- ---------- 1. Latest invoice rate per ingredient ----------
-- The newest confirmed purchase line wins; cost_per_unit is only a fallback
-- for items never purchased through the system.
CREATE OR REPLACE VIEW public.ingredient_rates AS
SELECT i.id AS ingredient_id,
       i.canteen_id,
       i.name,
       i.category,
       i.unit,
       i.current_stock,
       coalesce(lp.rate, i.cost_per_unit, 0) AS latest_rate,
       lp.purchased_at AS rate_from,
       (lp.rate IS NOT NULL)                AS rate_from_invoice
FROM public.ingredients i
LEFT JOIN LATERAL (
  SELECT pi.rate, p.created_at AS purchased_at
  FROM public.purchase_items pi
  JOIN public.purchases p ON p.id = pi.purchase_id
  WHERE pi.ingredient_id = i.id
    AND p.status = 'confirmed'
    AND pi.rate > 0
  ORDER BY p.created_at DESC
  LIMIT 1
) lp ON true;

GRANT SELECT ON public.ingredient_rates TO authenticated;

-- ---------- 2. Self-learning requisition suggestion ----------
-- per_head is measured, not configured: everything issued for this
-- ingredient over the window, divided by the headcount actually planned in
-- the same window. Feed it tomorrow's headcount and it sizes the order.
CREATE OR REPLACE FUNCTION public.suggest_requisition(
  p_canteen_id UUID,
  p_headcount  INT,
  p_days       INT DEFAULT 30
)
RETURNS TABLE (
  ingredient_id UUID, name TEXT, category TEXT, unit TEXT,
  per_head NUMERIC, suggested_qty NUMERIC, current_stock NUMERIC,
  shortfall NUMERIC, latest_rate NUMERIC, est_value NUMERIC,
  days_of_history INT, rate_from_invoice BOOLEAN
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE v_heads NUMERIC;
BEGIN
  -- how many people this site actually served over the window
  SELECT coalesce(sum(coalesce(actual_headcount, expected_headcount, 0)), 0)
  INTO v_heads
  FROM public.menu_plans
  WHERE canteen_id = p_canteen_id
    AND menu_date >= (current_date - p_days)
    AND menu_date <= current_date;

  RETURN QUERY
  WITH used AS (
    SELECT l.ingredient_id, -sum(l.change_qty) AS qty,
           count(DISTINCT date_trunc('day', l.created_at)) AS days
    FROM public.stock_ledger l
    WHERE l.canteen_id = p_canteen_id
      AND l.reference_type IN ('issue','recipe')
      AND l.change_qty < 0
      AND l.created_at >= now() - (p_days || ' days')::interval
    GROUP BY l.ingredient_id
  )
  SELECT r.ingredient_id, r.name, coalesce(r.category, 'Other'), r.unit,
         CASE WHEN v_heads > 0 THEN round(u.qty / v_heads, 4) END,
         CASE WHEN v_heads > 0 AND p_headcount > 0
              THEN round(u.qty / v_heads * p_headcount, 2) END,
         r.current_stock,
         CASE WHEN v_heads > 0 AND p_headcount > 0
              THEN greatest(round(u.qty / v_heads * p_headcount, 2) - r.current_stock, 0) END,
         r.latest_rate,
         CASE WHEN v_heads > 0 AND p_headcount > 0
              THEN round(u.qty / v_heads * p_headcount * r.latest_rate, 2) END,
         coalesce(u.days, 0)::int,
         r.rate_from_invoice
  FROM public.ingredient_rates r
  JOIN used u ON u.ingredient_id = r.ingredient_id
  WHERE r.canteen_id = p_canteen_id
  ORDER BY 10 DESC NULLS LAST, r.name;
END;
$$;
REVOKE ALL ON FUNCTION public.suggest_requisition(UUID, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.suggest_requisition(UUID, INT, INT) TO authenticated;

-- ---------- 3. Notifications ----------
CREATE TABLE IF NOT EXISTS public.notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canteen_id   UUID REFERENCES public.canteens(id) ON DELETE CASCADE,
  target_role  TEXT,             -- broadcast to a role, e.g. 'admin'
  target_user  UUID,             -- or to one person
  title        TEXT NOT NULL,
  body         TEXT,
  link         TEXT,
  ref_type     TEXT,
  ref_id       UUID,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_feed
  ON public.notifications (canteen_id, created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notifications_select" ON public.notifications;
DROP POLICY IF EXISTS "notifications_update_own" ON public.notifications;
-- You see it if it was addressed to you personally, to your role, or if you
-- are admin+ (monitoring everything is the point).
CREATE POLICY "notifications_select" ON public.notifications FOR SELECT TO authenticated
  USING (
    target_user = auth.uid()
    OR public.is_owner()
    OR (target_role IS NOT NULL
        AND public.role_rank(target_role) <= public.my_rank()
        AND (canteen_id IS NULL OR public.can_access_canteen(canteen_id)))
  );
CREATE POLICY "notifications_update_own" ON public.notifications FOR UPDATE TO authenticated
  USING (target_user = auth.uid() OR public.is_owner())
  WITH CHECK (target_user = auth.uid() OR public.is_owner());

-- Requisition raised → tell the admins (monitoring) and the site managers.
CREATE OR REPLACE FUNCTION public.notify_requisition()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_site TEXT;
BEGIN
  SELECT name INTO v_site FROM public.canteens WHERE id = NEW.canteen_id;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.notifications (canteen_id, target_role, title, body, link, ref_type, ref_id)
    VALUES (NEW.canteen_id, 'admin',
            'New requisition REQ-' || NEW.req_no,
            'Raised at ' || coalesce(v_site, 'site') ||
            coalesce(' for ' || NEW.meal_period, '') || ' — awaiting approval.',
            '/requisitions', 'requisition', NEW.id);
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- tell whoever raised it what happened
    INSERT INTO public.notifications (canteen_id, target_user, title, body, link, ref_type, ref_id)
    VALUES (NEW.canteen_id, NEW.requested_by,
            'REQ-' || NEW.req_no || ' ' || NEW.status,
            CASE NEW.status
              WHEN 'approved' THEN 'Approved — the store keeper can issue it now.'
              WHEN 'rejected' THEN coalesce(NEW.review_notes, 'Sent back by the manager.')
              WHEN 'issued'   THEN 'Stock has been issued to the kitchen.'
              ELSE 'Status changed to ' || NEW.status
            END,
            '/requisitions', 'requisition', NEW.id);

    -- admins keep watching the whole chain
    INSERT INTO public.notifications (canteen_id, target_role, title, body, link, ref_type, ref_id)
    VALUES (NEW.canteen_id, 'admin',
            'REQ-' || NEW.req_no || ' ' || NEW.status,
            coalesce(v_site, 'site') || ' — ' || NEW.status,
            '/requisitions', 'requisition', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_requisition_ins ON public.requisitions;
DROP TRIGGER IF EXISTS trg_notify_requisition_upd ON public.requisitions;
CREATE TRIGGER trg_notify_requisition_ins
  AFTER INSERT ON public.requisitions
  FOR EACH ROW EXECUTE FUNCTION public.notify_requisition();
CREATE TRIGGER trg_notify_requisition_upd
  AFTER UPDATE ON public.requisitions
  FOR EACH ROW EXECUTE FUNCTION public.notify_requisition();

-- ---------- 4. Photo retention: one month, then gone ----------
ALTER TABLE public.stock_photos
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
  DEFAULT (now() + interval '30 days');

UPDATE public.stock_photos
  SET expires_at = created_at + interval '30 days'
  WHERE expires_at IS NULL;

-- Deletes the storage object and the row together. Returns how many went.
CREATE OR REPLACE FUNCTION public.purge_expired_stock_photos()
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n INT;
BEGIN
  DELETE FROM storage.objects o
  USING public.stock_photos p
  WHERE o.bucket_id = 'stock-photos'
    AND o.name = p.image_path
    AND p.expires_at < now();

  WITH gone AS (
    DELETE FROM public.stock_photos WHERE expires_at < now() RETURNING 1
  )
  SELECT count(*) INTO v_n FROM gone;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.purge_expired_stock_photos() FROM PUBLIC, anon;

-- Run it nightly if pg_cron is available; otherwise the function is still
-- there to be called manually or from a scheduled edge function.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('purge-stock-photos')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-stock-photos');
    PERFORM cron.schedule('purge-stock-photos', '30 19 * * *',
                          'SELECT public.purge_expired_stock_photos();');
  END IF;
END $$;

-- ---------- 5. Daily reconciliation: what went out vs what is left ----------
CREATE OR REPLACE FUNCTION public.daily_reconciliation(p_canteen_id UUID, p_date DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_start TIMESTAMPTZ := (p_date::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_end   TIMESTAMPTZ := ((p_date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_in NUMERIC; v_out NUMERIC; v_stock NUMERIC; v_heads INT;
BEGIN
  -- valued at the invoice rate, not a typed-in cost
  SELECT coalesce(sum(l.change_qty * r.latest_rate), 0) INTO v_in
  FROM public.stock_ledger l JOIN public.ingredient_rates r ON r.ingredient_id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type = 'purchase'
    AND l.created_at >= v_start AND l.created_at < v_end;

  SELECT coalesce(-sum(l.change_qty * r.latest_rate), 0) INTO v_out
  FROM public.stock_ledger l JOIN public.ingredient_rates r ON r.ingredient_id = l.ingredient_id
  WHERE l.canteen_id = p_canteen_id AND l.reference_type IN ('issue','recipe')
    AND l.change_qty < 0
    AND l.created_at >= v_start AND l.created_at < v_end;

  SELECT coalesce(sum(current_stock * latest_rate), 0) INTO v_stock
  FROM public.ingredient_rates WHERE canteen_id = p_canteen_id;

  SELECT coalesce(sum(coalesce(actual_headcount, expected_headcount, 0)), 0) INTO v_heads
  FROM public.menu_plans WHERE canteen_id = p_canteen_id AND menu_date = p_date;

  RETURN jsonb_build_object(
    'date', p_date,
    'stock_in_value', round(v_in, 2),
    'consumption_value', round(v_out, 2),
    'closing_stock_value', round(v_stock, 2),
    'headcount', v_heads,
    'cost_per_head', CASE WHEN v_heads > 0 THEN round(v_out / v_heads, 2) END
  );
END;
$$;
REVOKE ALL ON FUNCTION public.daily_reconciliation(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.daily_reconciliation(UUID, DATE) TO authenticated;
