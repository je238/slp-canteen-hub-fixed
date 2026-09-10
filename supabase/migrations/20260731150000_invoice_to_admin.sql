-- Every scanned bill goes straight to the admins with its photo attached.
-- The store keeper enters it; the admin sees it the moment it lands, without
-- having to go looking through the purchase register.
-- Safe to re-run.

CREATE OR REPLACE FUNCTION public.notify_purchase_recorded()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_site TEXT; v_vendor TEXT;
BEGIN
  IF NEW.status <> 'confirmed' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'confirmed' THEN RETURN NEW; END IF;

  SELECT name INTO v_site FROM public.canteens WHERE id = NEW.canteen_id;
  SELECT name INTO v_vendor FROM public.suppliers WHERE id = NEW.supplier_id;

  INSERT INTO public.notifications
    (canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES (
    NEW.canteen_id, 'admin',
    'Bill recorded — ₹' || round(NEW.total_amount)::text,
    coalesce(v_vendor, 'Vendor not named') || ' at ' || coalesce(v_site, 'site') ||
    CASE WHEN NEW.invoice_image_url IS NOT NULL
         THEN ' · photo attached' ELSE ' · NO PHOTO' END,
    '/purchases', 'purchase', NEW.id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_purchase_ins ON public.purchases;
DROP TRIGGER IF EXISTS trg_notify_purchase_upd ON public.purchases;
CREATE TRIGGER trg_notify_purchase_ins
  AFTER INSERT ON public.purchases
  FOR EACH ROW EXECUTE FUNCTION public.notify_purchase_recorded();
CREATE TRIGGER trg_notify_purchase_upd
  AFTER UPDATE ON public.purchases
  FOR EACH ROW EXECUTE FUNCTION public.notify_purchase_recorded();

-- Admins read every invoice photo, whichever site it came from.
DROP POLICY IF EXISTS "invoices_admin_read_all" ON storage.objects;
CREATE POLICY "invoices_admin_read_all" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'invoices' AND public.is_admin_editor());
