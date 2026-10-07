-- ============================================================
-- SUN PHARMA ORDERS HAVE NO HEAD CHEF STAGE
--
-- The owner (7 Oct 2026): at Sun Pharma an order goes Head Supervisor →
-- Chef → Manager → Store Keeper, with no Head Chef. Eicher stays as it is.
--
-- Until now the Head Chef stage switched itself on for any site that had a
-- user with the head_chef role. A site setting now decides it:
-- canteens.head_chef_review, on everywhere, off for Sun Pharma; and a
-- head_chef role cannot be given at a site where it is off, so the stage
-- cannot creep back in by someone creating the account.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.canteens ADD COLUMN IF NOT EXISTS head_chef_review boolean NOT NULL DEFAULT true;
UPDATE public.canteens SET head_chef_review = false WHERE id = '98fb85b0-4943-4da7-9b45-a663463d7f05';

CREATE OR REPLACE FUNCTION public.set_head_chef_requirement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  NEW.head_chef_required :=
    coalesce((SELECT c.head_chef_review FROM public.canteens c WHERE c.id = NEW.canteen_id), true)
    AND EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.canteen_id = NEW.canteen_id AND lower(ur.role) = 'head_chef'
    );
  NEW.head_chef_status := 'pending';
  NEW.head_chef_reviewed_by := NULL;
  NEW.head_chef_reviewed_at := NULL;
  NEW.head_chef_notes := NULL;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.set_head_chef_requirement() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_head_chef_site()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  IF lower(NEW.role) = 'head_chef' AND NEW.canteen_id IS NOT NULL
     AND NOT coalesce((SELECT c.head_chef_review FROM public.canteens c WHERE c.id = NEW.canteen_id), true) THEN
    RAISE EXCEPTION 'Is site par Head Chef ka role nahi hota — Chef role dein';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_head_chef_site() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_head_chef_site ON public.user_roles;
CREATE TRIGGER trg_guard_head_chef_site
  BEFORE INSERT OR UPDATE OF role, canteen_id ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.guard_head_chef_site();
