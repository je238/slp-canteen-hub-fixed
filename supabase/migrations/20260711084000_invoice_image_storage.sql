-- Private storage bucket for scanned vendor invoices. The photo is the
-- anti-theft evidence trail: a purchase without its invoice image can be
-- fabricated, one with it can be re-checked line by line. Staff upload
-- and read via signed URLs; nothing is public. Safe to re-run.

INSERT INTO storage.buckets (id, name, public)
VALUES ('invoices', 'invoices', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "invoices_staff_read" ON storage.objects;
DROP POLICY IF EXISTS "invoices_manager_insert" ON storage.objects;
CREATE POLICY "invoices_staff_read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'invoices');
CREATE POLICY "invoices_manager_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'invoices' AND public.is_manager_or_above());
