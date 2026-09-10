-- ============================================================
-- AN ORDER BELONGS TO THE MEAL ITS MENU NAMES
--
-- The chef went to order night snacks for the 17th and was told he had
-- already ordered and this would be a top-up. He had not. What had happened
-- is worse than the message suggested.
--
-- A requisition carries a meal_period of its own AND a link to a menu plan,
-- and nothing has ever required the two to agree. The screen sets the meal
-- from the menu when the menu is picked, but they are separate fields and a
-- later touch of either dropdown pulls them apart silently. Order #182 came
-- out saying "evening_snacks" while pointing at the 17th's NIGHT SNACKS plan.
-- Its contents settle what it really was: maida 40 kg, potato 40 kg, oil 30
-- litre, amchur, ajwain — samosa, and samosa is the 17th's evening snack.
-- Night snacks that day is aloo paratha.
--
-- So two meals were wrong at once, in opposite directions:
--
--   * evening snacks on the 17th had NO order at all, though the chef had
--     raised one and the manager had approved it
--   * night snacks had an order nobody placed, which is why the top-up
--     warning fired — correctly, on a fact that was false
--
-- The warning was not the bug. The warning was the first thing to notice it.
--
-- Two fixes. The record is put where it belongs, and the field stops being
-- able to disagree: when a requisition names a menu plan, that plan decides
-- the meal. It is the more trustworthy of the two — a plan is a dated row the
-- manager published, a meal_period is a dropdown someone may have left alone.
--
-- Safe to re-run.
-- ============================================================

-- ---------- 1. The meal follows the menu, always ----------
CREATE OR REPLACE FUNCTION public.sync_requisition_meal_to_plan()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_meal TEXT;
BEGIN
  IF NEW.menu_plan_id IS NULL THEN RETURN NEW; END IF;

  SELECT meal_period INTO v_meal FROM public.menu_plans WHERE id = NEW.menu_plan_id;
  IF v_meal IS NULL THEN RETURN NEW; END IF;

  -- Silently correcting rather than refusing, deliberately. The chef picked a
  -- day and a meal off a published menu; that is the instruction. Rejecting
  -- the order would send him back to a screen where the two fields still look
  -- fine, with an error he cannot act on.
  IF NEW.meal_period IS DISTINCT FROM v_meal THEN
    NEW.meal_period := v_meal;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_a_sync_requisition_meal ON public.requisitions;
-- Named to sort before trg_guard_extra_requisition, so the top-up check runs
-- against a row whose meal already agrees with its menu.
CREATE TRIGGER trg_a_sync_requisition_meal
  BEFORE INSERT OR UPDATE OF menu_plan_id, meal_period ON public.requisitions
  FOR EACH ROW EXECUTE FUNCTION public.sync_requisition_meal_to_plan();

-- ---------- 2. Put #182 back where it belongs ----------
-- Nothing has moved: it is approved, not issued, so no stock has left the
-- shelf on it. Only the link is wrong.
DO $$
DECLARE v_req UUID; v_plan UUID; v_date DATE;
BEGIN
  SELECT r.id, m.menu_date INTO v_req, v_date
    FROM public.requisitions r
    JOIN public.menu_plans m ON m.id = r.menu_plan_id
   WHERE r.req_no = 182 AND m.meal_period = 'night_snacks' AND r.status = 'approved';

  IF v_req IS NULL THEN
    RAISE NOTICE '#182 already corrected or not in the expected state — leaving it alone';
    RETURN;
  END IF;

  SELECT id INTO v_plan FROM public.menu_plans
   WHERE menu_date = v_date AND meal_period = 'evening_snacks'
     AND canteen_id = (SELECT canteen_id FROM public.requisitions WHERE id = v_req);

  IF v_plan IS NULL THEN
    RAISE NOTICE 'no evening snacks plan on % — leaving #182 alone', v_date;
    RETURN;
  END IF;

  UPDATE public.requisitions
     SET menu_plan_id = v_plan, meal_period = 'evening_snacks'
   WHERE id = v_req;

  INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, canteen_id, details)
  SELECT r.requested_by, 'requisition_relinked', 'requisition', r.id, r.canteen_id,
         jsonb_build_object('req_no', 182, 'was', 'night_snacks', 'now', 'evening_snacks',
                            'menu_date', v_date,
                            'why', 'Order contents are samosa — the evening snack that day. It had been linked to the night snacks plan, leaving evening snacks with no order and night snacks with one nobody placed.')
    FROM public.requisitions r WHERE r.id = v_req;

  RAISE NOTICE '#182 relinked to evening snacks on %', v_date;
END $$;
