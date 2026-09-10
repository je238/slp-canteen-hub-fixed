-- The chef's order list has to read like an order: item, quantity, amount,
-- and the number of people it is for. The headcount is the manager's figure
-- (it comes from the published menu), and the rate is the store keeper's
-- last scanned invoice — the chef supplies neither, so both are recorded on
-- the requisition at the moment it is raised and never drift afterwards.
-- Safe to re-run.

ALTER TABLE public.requisitions
  ADD COLUMN IF NOT EXISTS expected_headcount INT;

ALTER TABLE public.requisition_items
  ADD COLUMN IF NOT EXISTS rate NUMERIC;

-- Amount always follows whatever quantity currently stands: the approved
-- figure once the manager has ruled, the requested one until then.
ALTER TABLE public.requisition_items
  ADD COLUMN IF NOT EXISTS amount NUMERIC
  GENERATED ALWAYS AS (coalesce(approved_qty, requested_qty) * coalesce(rate, 0)) STORED;

-- Carry the manager's headcount across automatically when the chef links a
-- menu, so it cannot be typed differently by mistake.
CREATE OR REPLACE FUNCTION public.set_requisition_headcount()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.menu_plan_id IS NOT NULL THEN
    SELECT coalesce(actual_headcount, expected_headcount)
    INTO NEW.expected_headcount
    FROM public.menu_plans WHERE id = NEW.menu_plan_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_requisition_headcount ON public.requisitions;
CREATE TRIGGER trg_set_requisition_headcount
  BEFORE INSERT OR UPDATE OF menu_plan_id ON public.requisitions
  FOR EACH ROW EXECUTE FUNCTION public.set_requisition_headcount();
