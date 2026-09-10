-- ============================================================
-- THE BILL PHOTO ACTUALLY GETS KEPT, AND REACHES THE ADMIN
--
-- The whole anti-theft story rests on one thing: the paper the goods came in
-- on is photographed and cannot be quietly replaced later. The app has asked
-- for that photo on every scan since the beginning, held it in memory,
-- uploaded it on save, and written the path onto the purchase.
--
-- The bucket it uploads to does not exist.
--
-- So every upload has failed, the failure was swallowed into a warning toast
-- nobody reads while a delivery driver waits, and every goods receipt ever
-- recorded — including today's ₹5,44,392 opening count — carries no photo at
-- all. The one control the system was built around has never once run.
--
-- This creates the bucket, gives the store keeper permission to put a photo
-- in it and nobody permission to take one out again, and sends the admin the
-- photo the moment the receipt is booked — rather than leaving it sitting in
-- a screen they would have to think to go and open.
--
-- The admin, not the owner. The admin checks the paper against the goods;
-- that is their job. Handing the owner a photo of every bill is how a control
-- turns into noise nobody reads.
--
-- Safe to re-run.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('invoices', 'invoices', false, 15728640)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 15728640;

-- The photo is filed under the site it belongs to: invoices/<canteen_id>/...
DROP POLICY IF EXISTS "store keeper files a bill photo" ON storage.objects;
CREATE POLICY "store keeper files a bill photo"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'invoices'
    AND public.can_receive_stock()
    AND public.can_access_canteen(((storage.foldername(name))[1])::uuid)
  );

-- Read is for the people who check the paper against the goods.
DROP POLICY IF EXISTS "the site's people can look at its bills" ON storage.objects;
CREATE POLICY "the site's people can look at its bills"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'invoices'
    AND public.can_access_canteen(((storage.foldername(name))[1])::uuid)
  );

-- No update and no delete policy, deliberately. A photo that can be swapped
-- for a better one later is not evidence of anything. Retention is handled by
-- the purge function, which runs as the service role and is not bound by
-- these policies.

-- ---------- The admin is told, with the photo ----------
CREATE OR REPLACE FUNCTION public.notify_goods_received()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lines INT; v_supplier TEXT;
BEGIN
  IF NEW.status <> 'confirmed' THEN RETURN NEW; END IF;

  SELECT count(*) INTO v_lines FROM public.purchase_items WHERE purchase_id = NEW.id;
  SELECT name INTO v_supplier FROM public.suppliers WHERE id = NEW.supplier_id;

  INSERT INTO public.notifications
    (canteen_id, target_role, title, body, link, ref_type, ref_id)
  VALUES (
    NEW.canteen_id, 'admin',
    CASE WHEN NEW.invoice_image_url IS NULL
         THEN format('Goods received — ₹%s, NO BILL PHOTO', round(coalesce(NEW.total_amount, 0)))
         ELSE format('Goods received — ₹%s', round(coalesce(NEW.total_amount, 0)))
    END,
    format('%s from %s. %s',
           coalesce(v_lines, 0) || ' item(s)',
           coalesce(v_supplier, 'an unnamed vendor'),
           CASE
             WHEN NEW.invoice_image_url IS NULL
               THEN 'No photo of the bill was attached — worth asking why before this is settled.'
             WHEN NEW.stated_total IS NOT NULL
                  AND abs(NEW.stated_total - coalesce(NEW.total_amount, 0)) > 0.5
               THEN format('The bill claims ₹%s but the lines received add to ₹%s. Check the photo.',
                           round(NEW.stated_total), round(NEW.total_amount))
             ELSE 'Photo of the bill is attached.'
           END),
    '/purchases', 'purchase', NEW.id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_goods_received ON public.purchases;
CREATE TRIGGER trg_notify_goods_received
  AFTER INSERT ON public.purchases
  FOR EACH ROW EXECUTE FUNCTION public.notify_goods_received();

-- ---------- Receipts that came in with no photo ----------
-- A missing photo is not proof of anything on its own. A store keeper who is
-- always missing one is worth a conversation.
CREATE OR REPLACE FUNCTION public.receipts_without_a_photo(p_canteen_id UUID, p_days INT DEFAULT 30)
RETURNS TABLE (
  purchase_id UUID, received_on DATE, value NUMERIC, supplier TEXT, taken_by TEXT
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT p.id, (p.created_at AT TIME ZONE 'Asia/Kolkata')::date,
         p.total_amount, coalesce(s.name, '—'), coalesce(u.email, '—')
  FROM public.purchases p
  LEFT JOIN public.suppliers s ON s.id = p.supplier_id
  LEFT JOIN public.user_directory u ON u.id = p.created_by
  WHERE p.canteen_id = p_canteen_id
    AND p.invoice_image_url IS NULL
    AND p.created_at >= (timezone('Asia/Kolkata', now())::date - p_days)
    AND public.can_access_canteen(p_canteen_id)
  ORDER BY p.created_at DESC;
$$;
REVOKE ALL ON FUNCTION public.receipts_without_a_photo(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receipts_without_a_photo(UUID, INT) TO authenticated;
