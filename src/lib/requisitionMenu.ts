export function requisitionMenuDishes(menuPlan: any): string[] {
  const names = (menuPlan?.menu_plan_items || [])
    .map((item: any) => String(item?.dish_name || "").trim())
    .filter(Boolean);

  return Array.from(new Set(names));
}
