-- The repo's purchase-creation code (invoice scanner and manual entry)
-- inserts invoice_image_url, and the void-trail work expects created_by,
-- but the live database never got these columns — invoice-scan purchase
-- creation fails against production. Safe to re-run.

ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS invoice_image_url TEXT;
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS created_by UUID DEFAULT auth.uid();
