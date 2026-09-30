-- ============================================================
-- ONE VENDOR, ONE NAME
--
-- The bill scanner turned four shops into eleven vendors: its reasoning, a
-- whole letterhead or a looped syllable became a "new vendor", and the same
-- dairy appeared as Ganesh Milk, New Ganesh Milk Point and its Hindi
-- letterhead. Vendor-wise purchase totals were split across them.
--
-- Merged on evidence, not on the name alone — the same items at the same
-- rates:
--   Ganesh Milk ← New Ganesh Milk Point (+ Hindi letterhead, + Hindi name)
--       Amul Gold at ₹70 daily from both
--   madhav dairy ← Madhav Paneer
--       Paneer ₹300, Curd ₹95, Green Pease ₹88 from both
--   Maa Anpurna Vegetable and Food Bhandar ← Maa Annpurna Vegetable,
--       the Hindi "(MAVFB) - सेखिल चौहान" entry, and a 3,648-character one
--   Choithram entry — no bill, no lot, a looped syllable: removed
--
-- Every table that points at a vendor is repointed before a row goes, and
-- every merge is written to action_logs with the name that went away.
-- The user approved removing these on 01/10/2026.
--
-- Safe to re-run.
-- ============================================================
DO $$
DECLARE m record; fk record; v_moved int;
BEGIN
  PERFORM public.allow_stock_move();

  FOR m IN SELECT * FROM (VALUES
    ('aaedb0c2-872c-4cc0-93bf-7f390345f44c'::uuid, '10ec4225-b59a-45ff-8751-77f2fc9860fc'::uuid),
    ('aaedb0c2-872c-4cc0-93bf-7f390345f44c'::uuid, 'd0323233-79a0-4e12-914d-af4ad31d4deb'::uuid),
    ('aaedb0c2-872c-4cc0-93bf-7f390345f44c'::uuid, '644ac8eb-2d25-49ec-892e-3464512ef711'::uuid),
    ('434c50f1-6dd9-4dd3-8abf-f3347f1302c7'::uuid, 'ca8b4ac0-4ea1-4944-afcf-f95e480d227a'::uuid),
    ('0e0d8f02-5f4c-4122-93bc-c3cc175452d3'::uuid, '7c0035bc-043d-49ab-8743-5686abe21f50'::uuid),
    ('0e0d8f02-5f4c-4122-93bc-c3cc175452d3'::uuid, '5212b46f-c8cb-47c3-b609-fd42c23f2ffe'::uuid),
    ('0e0d8f02-5f4c-4122-93bc-c3cc175452d3'::uuid, '0d412245-31a7-4f38-9fa6-ec672da37579'::uuid)
  ) AS x(keep_id, drop_id)
  LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id = m.drop_id)
              OR NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id = m.keep_id);
    FOR fk IN
      SELECT conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       WHERE c.contype = 'f' AND c.confrelid = 'public.suppliers'::regclass
    LOOP
      EXECUTE format('UPDATE %s SET %I = $1 WHERE %I = $2', fk.tbl, fk.col, fk.col) USING m.keep_id, m.drop_id;
      GET DIAGNOSTICS v_moved = ROW_COUNT;
      IF v_moved > 0 THEN RAISE NOTICE 'moved % rows in %.%', v_moved, fk.tbl, fk.col; END IF;
    END LOOP;
    INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
    SELECT NULL, 'supplier_merged', 'supplier', m.keep_id, s.canteen_id,
           jsonb_build_object('merged_away', left(s.name, 160), 'merged_away_id', m.drop_id, 'into', m.keep_id)
      FROM public.suppliers s WHERE s.id = m.drop_id;
    DELETE FROM public.suppliers WHERE id = m.drop_id;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.suppliers WHERE id = 'd649676d-6118-40e2-bfdc-4d892c0ccced')
     AND NOT EXISTS (SELECT 1 FROM public.purchases WHERE supplier_id = 'd649676d-6118-40e2-bfdc-4d892c0ccced')
     AND NOT EXISTS (SELECT 1 FROM public.ingredient_batches WHERE supplier_id = 'd649676d-6118-40e2-bfdc-4d892c0ccced') THEN
    INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
    SELECT NULL, 'supplier_removed', 'supplier', s.id, s.canteen_id,
           jsonb_build_object('name', left(s.name, 160), 'why', 'no bill or lot; name was a looped syllable from the scanner')
      FROM public.suppliers s WHERE s.id = 'd649676d-6118-40e2-bfdc-4d892c0ccced';
    DELETE FROM public.suppliers WHERE id = 'd649676d-6118-40e2-bfdc-4d892c0ccced';
  END IF;

  -- The names the shops actually trade under.
  UPDATE public.suppliers SET name = 'New Ganesh Milk Point' WHERE id = 'aaedb0c2-872c-4cc0-93bf-7f390345f44c' AND name <> 'New Ganesh Milk Point';
  UPDATE public.suppliers SET name = 'Madhav Dairy' WHERE id = '434c50f1-6dd9-4dd3-8abf-f3347f1302c7' AND name <> 'Madhav Dairy';
  UPDATE public.suppliers SET name = 'Maa Annapurna Vegetable & Fruit Bhandar' WHERE id = '0e0d8f02-5f4c-4122-93bc-c3cc175452d3' AND name <> 'Maa Annapurna Vegetable & Fruit Bhandar';
END $$;
