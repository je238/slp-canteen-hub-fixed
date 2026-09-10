-- ============================================================
-- ANTI-THEFT: STOCK VARIANCE REPORTING + AUTOMATIC SHORTAGE ALERTS
--
-- Theft shows up as the gap between what the recipes say the kitchen
-- should have used and what a physical count finds. Two pieces:
--
-- 1. stock_variance_report(canteen, from, to) — per-ingredient movement
--    summary over a period, straight from the append-only stock_ledger:
--      purchased_qty   (reference_type 'purchase')
--      consumed_qty    (reference_type 'recipe', the automatic order
--                       deductions — negative movements only)
--      manual_adjust   (reference_type 'manual')
--      audit_adjust    (reference_type 'audit' — a negative number here
--                       is unexplained loss found by physical count)
--
-- 2. flag_audit_shortage trigger — the moment a stock audit books a
--    shortage worth >= Rs.300 (or any shortage on an ingredient worth
--    >= Rs.300/unit like ghee/paneer/dry fruits), an open fraud_alert
--    is created automatically so it can't be quietly absorbed.
--
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.stock_variance_report(
  p_canteen_id UUID,
  p_start DATE,
  p_end   DATE
)
RETURNS TABLE (
  ingredient_id  UUID,
  name           TEXT,
  unit           TEXT,
  cost_per_unit  NUMERIC,
  current_stock  NUMERIC,
  purchased_qty  NUMERIC,
  consumed_qty   NUMERIC,
  manual_adjust  NUMERIC,
  audit_adjust   NUMERIC,
  audit_loss_value NUMERIC
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  SELECT
    i.id,
    i.name,
    i.unit,
    i.cost_per_unit,
    i.current_stock,
    coalesce(sum(l.change_qty) FILTER (WHERE l.reference_type = 'purchase'), 0),
    coalesce(-sum(l.change_qty) FILTER (WHERE l.reference_type = 'recipe' AND l.change_qty < 0), 0),
    coalesce(sum(l.change_qty) FILTER (WHERE l.reference_type = 'manual'), 0),
    coalesce(sum(l.change_qty) FILTER (WHERE l.reference_type = 'audit'), 0),
    coalesce(-sum(l.change_qty * i.cost_per_unit) FILTER (WHERE l.reference_type = 'audit' AND l.change_qty < 0), 0)
  FROM public.ingredients i
  LEFT JOIN public.stock_ledger l
    ON l.ingredient_id = i.id
   AND l.created_at >= p_start
   AND l.created_at < p_end + 1
  WHERE i.canteen_id = p_canteen_id
  GROUP BY i.id, i.name, i.unit, i.cost_per_unit, i.current_stock
  ORDER BY 10 DESC, i.name;
$$;

GRANT EXECUTE ON FUNCTION public.stock_variance_report(UUID, DATE, DATE) TO authenticated;

-- ---------- Automatic shortage alerts ----------
CREATE OR REPLACE FUNCTION public.flag_audit_shortage()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_ing public.ingredients%ROWTYPE;
  v_loss NUMERIC;
BEGIN
  IF NEW.reference_type <> 'audit' OR NEW.change_qty >= 0 OR NEW.ingredient_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_ing FROM public.ingredients WHERE id = NEW.ingredient_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  v_loss := abs(NEW.change_qty) * coalesce(v_ing.cost_per_unit, 0);

  -- Alert on any shortage worth >= Rs.300, and on ANY shortage of
  -- high-value items (>= Rs.300/unit): those are the walkable goods.
  IF v_loss >= 300 OR coalesce(v_ing.cost_per_unit, 0) >= 300 THEN
    INSERT INTO public.fraud_alerts
      (canteen_id, ingredient_id, alert_type, severity, title, description, loss_value, status)
    VALUES (
      NEW.canteen_id,
      NEW.ingredient_id,
      'stock_discrepancy',
      CASE WHEN v_loss >= 2000 THEN 'critical' ELSE 'warning' END,
      'Audit shortage: ' || v_ing.name,
      format('Physical count was %s %s below system stock (reason given: %s). Estimated loss ₹%s.',
             abs(NEW.change_qty), v_ing.unit, coalesce(NEW.reason, 'none'), round(v_loss)),
      v_loss,
      'open'
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_flag_audit_shortage ON public.stock_ledger;
CREATE TRIGGER trg_flag_audit_shortage
  AFTER INSERT ON public.stock_ledger
  FOR EACH ROW EXECUTE FUNCTION public.flag_audit_shortage();
