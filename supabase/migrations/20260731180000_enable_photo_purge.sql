-- ============================================================
-- The one-month photo rule was never actually running
--
-- Two separate reasons, both silent:
--
--   1. Scheduling was wrapped in "if pg_cron is available", and it was not
--      installed on this project. The block did nothing and said nothing.
--
--   2. purge_expired_stock_photos() deleted straight out of storage.objects.
--      Supabase blocks that outright ("Direct deletion from storage tables is
--      not allowed"), so even once scheduled the job would have failed every
--      night. And the escape hatch would only have dropped the database row —
--      the image itself would have stayed in storage forever, which is the
--      opposite of what a retention rule is for.
--
-- Deleting the actual file needs the Storage API, so the work moved to the
-- purge-photos edge function and this schedules it. The SQL function is kept
-- as a row-level fallback but is no longer what runs.
--
-- The caller's token lives in Vault, never in this file.
-- Safe to re-run.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Set once, out of band:
--   select vault.create_secret('<token>', 'purge_photos_token');
--   select vault.create_secret('<project url>', 'project_url');
-- and the same token as the PURGE_TOKEN secret on the edge function.

CREATE OR REPLACE FUNCTION public.run_photo_purge()
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_token TEXT; v_url TEXT; v_req BIGINT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'purge_photos_token';
  SELECT decrypted_secret INTO v_url   FROM vault.decrypted_secrets WHERE name = 'project_url';
  IF v_token IS NULL OR v_url IS NULL THEN
    -- Loud, not silent: the whole point of this migration.
    INSERT INTO public.action_logs (action, entity_type, details)
    VALUES ('photos_purge_failed', 'stock_photos',
            jsonb_build_object('error', 'purge_photos_token or project_url missing from vault'));
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url := v_url || '/functions/v1/purge-photos',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-purge-token', v_token),
    body := '{}'::jsonb
  ) INTO v_req;
  RETURN v_req;
END;
$$;
REVOKE ALL ON FUNCTION public.run_photo_purge() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  PERFORM cron.unschedule('purge-stock-photos')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-stock-photos');
  -- 19:30 UTC is 01:00 IST — after the canteen has closed for the night.
  PERFORM cron.schedule('purge-stock-photos', '30 19 * * *', 'SELECT public.run_photo_purge();');
END $$;
