-- ============================================================
-- THE LIST OF HAND CORRECTIONS READS THE LOG, NOT THE LEDGER
--
-- hand_corrections was built to read the stock ledger. The ledger rows those
-- corrections wrote have since been cleared — they were double-counting once
-- the opening receipts were corrected to the same figures — so the list came
-- back empty and looked as though nobody had touched anything.
--
-- Nothing was lost. Every correction is in the action log with the item, the
-- old figure, the new one, the reason and who typed it, which is more than
-- the ledger ever carried. So the list reads that instead, and it now shows
-- rate corrections beside quantity ones — both change what the store is
-- worth and both belong in the same place.
--
-- Safe to re-run.
-- ============================================================
DROP FUNCTION IF EXISTS public.hand_corrections(UUID, INT);

CREATE FUNCTION public.hand_corrections(p_canteen_id UUID, p_days INT DEFAULT 7)
RETURNS TABLE (
  at TIMESTAMPTZ, kind TEXT, item TEXT,
  was NUMERIC, now_is NUMERIC, effect NUMERIC,
  reason TEXT, by_whom TEXT
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT a.created_at,
         CASE a.action WHEN 'stock_adjusted' THEN 'counted' ELSE 're-priced' END,
         a.details->>'item',
         (a.details->>'was')::numeric,
         (a.details->>'now')::numeric,
         CASE a.action
           WHEN 'stock_adjusted' THEN (a.details->>'delta')::numeric
           ELSE (a.details->>'value_swing')::numeric
         END,
         coalesce(a.details->>'reason', '—'),
         coalesce(u.email, '—')
  FROM public.action_logs a
  LEFT JOIN public.user_directory u ON u.id = a.user_id
  WHERE a.canteen_id = p_canteen_id
    AND a.action IN ('stock_adjusted', 'rate_corrected')
    AND a.created_at >= now() - make_interval(days => p_days)
    AND public.can_access_canteen(p_canteen_id)
  ORDER BY a.created_at DESC;
$$;
REVOKE ALL ON FUNCTION public.hand_corrections(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hand_corrections(UUID, INT) TO authenticated;
