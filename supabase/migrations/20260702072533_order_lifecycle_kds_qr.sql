-- ============================================================
-- ORDER LIFECYCLE + KITCHEN DISPLAY SYSTEM + QR ORDERING
-- Run this whole file once in the Supabase SQL Editor
-- (Dashboard → SQL Editor → New query → paste → Run).
-- Safe to re-run: every statement is idempotent.
-- ============================================================

-- 1. Lifecycle columns on orders. The backfill in step 3 must run only on
--    the FIRST application — on a re-run it would wipe live kitchen orders
--    out of the queue — so record whether the column already existed.
CREATE TEMP TABLE IF NOT EXISTS _kds_migration_state AS
SELECT NOT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'kitchen_status'
) AS is_first_run;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS kitchen_status TEXT NOT NULL DEFAULT 'new';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'pos';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'paid';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS special_instructions TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS preparing_at TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS ready_at TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS served_at TIMESTAMPTZ;

COMMENT ON COLUMN public.orders.kitchen_status IS 'Kitchen queue state: new → preparing → ready → served (or cancelled)';
COMMENT ON COLUMN public.orders.order_type IS 'pos = billed at counter, qr = self-service QR order';
COMMENT ON COLUMN public.orders.payment_status IS 'paid | unpaid — QR orders stay unpaid until settled at the counter';

-- 2. Value constraints (added idempotently)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_kitchen_status_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_kitchen_status_check
      CHECK (kitchen_status IN ('new', 'preparing', 'ready', 'served', 'cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_order_type_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_order_type_check
      CHECK (order_type IN ('pos', 'qr'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_payment_status_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_payment_status_check
      CHECK (payment_status IN ('paid', 'unpaid'));
  END IF;
END $$;

-- 3. Backfill (first run only): everything that existed before this
--    migration is history, not live kitchen work. Mark it served so the
--    KDS queue starts clean. On a re-run this must NOT touch live orders.
UPDATE public.orders
SET kitchen_status = 'served', served_at = created_at
WHERE kitchen_status = 'new'
  AND (SELECT is_first_run FROM _kds_migration_state);

DROP TABLE IF EXISTS _kds_migration_state;

-- 4. Index for the kitchen queue (canteen + live statuses, newest first)
CREATE INDEX IF NOT EXISTS idx_orders_kitchen_queue
  ON public.orders (canteen_id, kitchen_status, created_at DESC);

-- 5. Realtime: make sure orders + order_items broadcast changes
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.order_items;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;
