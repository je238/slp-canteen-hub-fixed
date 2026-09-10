-- ============================================================
-- ONLY THE LOOK-ALIKES WORTH LOOKING AT
--
-- The duplicate finder compared every pair of names and flagged anything
-- within two letters. On this store's list that produced:
--
--     Potato (300)  vs  Tomato (20)
--     Mint (2)      vs  Hing (21)
--     Curd (0)      vs  Gud (2)
--     Beans (0)     vs  Besan (170)
--     Aata (2200)   vs  Mawa (0)
--
-- Nine of the fourteen pairs it found were nonsense. A warning list that is
-- two-thirds wrong is worse than no list: the admin learns to scroll past it,
-- and the four real duplicates underneath — G Chilyy sitting at zero while
-- forty kilos of the same chilli sat under G Chili — go with them.
--
-- Two letters is simply not much on a four-letter word. So:
--
--   * same word once case and spacing are stripped -> certain, always shown
--     ("Kabuli  Chana" and "Kabuli Chana")
--   * otherwise the names must be long enough for two letters to mean
--     something, AND start the same way. Potato and Tomato are two edits
--     apart and share nothing at the front; G Chili and G Chilyy share five
--     characters and differ at the tail, which is what a misspelling looks
--     like.
--
-- Safe to re-run.
-- ============================================================

-- The shape changes (a plain-words reason is added), so the old one goes first.
DROP FUNCTION IF EXISTS public.similar_ingredients(UUID);
CREATE FUNCTION public.similar_ingredients(p_canteen_id UUID)
RETURNS TABLE (
  a_id UUID, a_name TEXT, a_stock NUMERIC,
  b_id UUID, b_name TEXT, b_stock NUMERIC, distance INT, why TEXT
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH n AS (
    SELECT id, name, current_stock, canteen_id,
           -- letters and digits only: case, spaces and punctuation are not
           -- differences anyone means
           regexp_replace(lower(name), '[^a-z0-9]', '', 'g') AS key
    FROM public.ingredients
    WHERE canteen_id = p_canteen_id
  ),
  pairs AS (
    SELECT a.id AS a_id, a.name AS a_name, a.current_stock AS a_stock,
           b.id AS b_id, b.name AS b_name, b.current_stock AS b_stock,
           a.key AS ak, b.key AS bk,
           levenshtein(a.key, b.key) AS d,
           -- how many characters they agree on from the start
           (SELECT count(*)::int FROM generate_series(1, least(length(a.key), length(b.key))) g
             WHERE substr(a.key, g, 1) = substr(b.key, g, 1)
               AND substr(a.key, 1, g) = substr(b.key, 1, g)) AS shared_start
    FROM n a JOIN n b ON b.id > a.id
  )
  SELECT a_id, a_name, a_stock, b_id, b_name, b_stock, d,
         CASE WHEN d = 0 THEN 'the same word, only spacing or capitals differ'
              ELSE 'one looks like a misspelling of the other' END
  FROM pairs
  WHERE public.can_access_canteen(p_canteen_id)
    AND (
      d = 0
      OR (d <= 2
          AND least(length(ak), length(bk)) >= 6
          AND shared_start >= 4)
    )
  ORDER BY d, a_name;
$$;
REVOKE ALL ON FUNCTION public.similar_ingredients(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.similar_ingredients(UUID) TO authenticated;
