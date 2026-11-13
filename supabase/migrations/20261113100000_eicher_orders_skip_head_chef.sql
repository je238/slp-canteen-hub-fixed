-- ============================================================
-- EICHER ORDERS HAVE NO HEAD CHEF STAGE EITHER
--
-- The owner (13 Nov 2026): from now on at Eicher the HS or the manager
-- enters the menu, the chef orders, the manager approves and the store
-- keeper issues. Same as Sun Pharma since 7 Oct (20261007100000).
-- New orders get head_chef_required = false from set_head_chef_requirement().
-- Applied live 13/11 via REST as super admin (CLI was on another account).
--
-- Safe to re-run.
-- ============================================================

UPDATE public.canteens SET head_chef_review = false WHERE id = 'd4402630-dec6-44fa-b14c-405b45258f99';
