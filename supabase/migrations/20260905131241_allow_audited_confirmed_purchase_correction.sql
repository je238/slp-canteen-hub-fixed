-- A confirmed bill must remain immutable for ordinary updates. The dedicated
-- correction RPC, however, reverses the untouched lot, writes replacement
-- stock/ledger rows, and records old/new values in the audit trail. That RPC
-- already calls allow_stock_move(), whose transaction-local flag cannot be set
-- by authenticated clients. Let that audited path update the purchase total.

CREATE OR REPLACE FUNCTION public.guard_confirmed_purchase()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'confirmed'
     AND NOT public.is_super_admin()
     AND coalesce(current_setting('app.stock_move', true), '') <> 'on' THEN
    IF NEW.total_amount IS DISTINCT FROM OLD.total_amount
       OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
       OR NEW.canteen_id  IS DISTINCT FROM OLD.canteen_id
       OR NEW.status      IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'A confirmed purchase cannot be re-priced. Record a correction instead.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
