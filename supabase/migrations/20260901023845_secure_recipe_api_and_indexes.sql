-- Recipes are an authenticated staff feature. Old bootstrap grants made the
-- objects discoverable to the anon API even though RLS returned no rows.
revoke all on table public.recipes from anon;
revoke all on table public.recipe_ingredients from anon;

grant select on table public.recipes to authenticated;
grant select on table public.recipe_ingredients to authenticated;

-- Cover site filtering and recipe-detail joins used by the Chef Recipe Book.
create index if not exists idx_recipes_canteen_name
  on public.recipes (canteen_id, lower(btrim(name)));
create index if not exists idx_recipe_ingredients_recipe
  on public.recipe_ingredients (recipe_id);
create index if not exists idx_recipe_ingredients_ingredient
  on public.recipe_ingredients (ingredient_id)
  where ingredient_id is not null;
create index if not exists idx_recipe_ingredients_sub_recipe
  on public.recipe_ingredients (sub_recipe_id)
  where sub_recipe_id is not null;
