-- Vendors upload their own bill photos into invoices/vendor/<supplier_id>/…
-- They may write and read only inside their own folder; canteen staff read
-- through the existing canteen-scoped policy. Safe to re-run.

DROP POLICY IF EXISTS "invoices_vendor_insert_own" ON storage.objects;
DROP POLICY IF EXISTS "invoices_vendor_read_own" ON storage.objects;

CREATE POLICY "invoices_vendor_insert_own" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'invoices'
    AND (storage.foldername(name))[1] = 'vendor'
    AND (storage.foldername(name))[2] = public.my_supplier_id()::text
  );

CREATE POLICY "invoices_vendor_read_own" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'invoices'
    AND (storage.foldername(name))[1] = 'vendor'
    AND (storage.foldername(name))[2] = public.my_supplier_id()::text
  );

-- Staff need to read vendor-uploaded photos too. The canteen-scoped read
-- policy can't match a 'vendor/...' path, so allow store keeper and above.
DROP POLICY IF EXISTS "invoices_staff_read_vendor" ON storage.objects;
CREATE POLICY "invoices_staff_read_vendor" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'invoices'
    AND (storage.foldername(name))[1] = 'vendor'
    AND public.is_store_keeper_or_above()
  );
