-- ============================================================
-- THE SCANNER CHECKS ITSELF EVERY MORNING
--
-- The invoice scanner has gone dead about once a week (a retired model, a
-- lapsed key, a quota) and the first anyone heard was the store keeper
-- failing to scan a bill. Every day at 08:00 IST the database now pings the
-- scanner's health mode; if Google does not answer, ocr-invoice itself
-- writes the admin an alert saying why (see alertScannerDown()).
--
-- The token is never in this file. It is set once as the function secret
-- SCANNER_HEALTH_TOKEN and stored in Vault as 'scanner_health_token':
--   select vault.create_secret('<token>', 'scanner_health_token');
-- Without both, the job runs and the function ignores it.
--
-- Needs pg_cron and pg_net; does nothing if either is missing.
-- Safe to re-run.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE 'pg_cron or pg_net missing — scanner health job not scheduled';
    RETURN;
  END IF;

  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'scanner-health';
  PERFORM cron.schedule('scanner-health', '30 2 * * *', $job$
    SELECT net.http_post(
      url     := 'https://djexqeisvrybemkftbxm.supabase.co/functions/v1/ocr-invoice',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-health-token', coalesce((SELECT decrypted_secret FROM vault.decrypted_secrets
                                                WHERE name = 'scanner_health_token' LIMIT 1), '')),
      body    := '{}'::jsonb,
      timeout_milliseconds := 30000);
  $job$);
END $$;
