-- Every stock movement gets the login that made it ("Rice −200 kg,
-- entry: ramesh@..., 8:42 PM"). Trigger-written rows (recipe deductions,
-- restocks) also capture the acting user because auth.uid() reads the
-- caller's JWT even inside SECURITY DEFINER functions. Old rows stay NULL.
-- Safe to re-run.

ALTER TABLE public.stock_ledger ADD COLUMN IF NOT EXISTS created_by UUID DEFAULT auth.uid();

-- Small directory so the app can turn the uuid into a readable name.
-- Staff-only (never anon): exposes just id + email of this org's ~few users.
CREATE OR REPLACE VIEW public.user_directory AS
  SELECT id, email FROM auth.users;

REVOKE ALL ON public.user_directory FROM PUBLIC;
REVOKE ALL ON public.user_directory FROM anon;
GRANT SELECT ON public.user_directory TO authenticated;
