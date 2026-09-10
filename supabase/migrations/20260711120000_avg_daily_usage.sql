-- The owner plans ration by daily averages ("1000 kg rice = 10 days at
-- 100 kg/day"). Storing that expected burn rate per ingredient lets the
-- app show days-of-stock-left and flag items that are finishing faster
-- than they should — an average-based leak check that works even before
-- thali recipes are entered. Safe to re-run.

ALTER TABLE public.ingredients ADD COLUMN IF NOT EXISTS avg_daily_usage NUMERIC;
