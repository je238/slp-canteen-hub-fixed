export type MealProfitMenu = {
  menu_plan_id: string;
  menu_date: string;
  meal_period: string;
  diner_count: number;
  provisional: boolean;
  revenue: number;
  actual_food_cost: number;
  gross_margin: number;
};

export type MealProfitTotals = {
  totalMenuCount: number;
  menuCount: number;
  pendingCount: number;
  provisionalCount: number;
  diners: number;
  revenue: number;
  foodCost: number;
  profit: number;
  costPerPerson: number | null;
  foodCostPercent: number | null;
};

const amount = (value: number | null | undefined) => Number(value || 0);

// Owner financial comparisons need actual diners, valued issues and a known meal sale.
export const hasCompleteMealCost = (menu: MealProfitMenu) =>
  !menu.provisional && amount(menu.diner_count) > 0 && amount(menu.actual_food_cost) > 0 && amount(menu.revenue) > 0;

export function summarizeMealProfit(menus: MealProfitMenu[]): MealProfitTotals {
  const completeMenus = menus.filter(hasCompleteMealCost);
  const totals = completeMenus.reduce((result, menu) => ({
    menuCount: result.menuCount + 1,
    diners: result.diners + amount(menu.diner_count),
    revenue: result.revenue + amount(menu.revenue),
    foodCost: result.foodCost + amount(menu.actual_food_cost),
    profit: result.profit + amount(menu.gross_margin),
  }), { menuCount: 0, diners: 0, revenue: 0, foodCost: 0, profit: 0 });

  return {
    ...totals,
    totalMenuCount: menus.length,
    pendingCount: menus.length - completeMenus.length,
    provisionalCount: menus.filter((menu) => menu.provisional).length,
    costPerPerson: totals.diners > 0 ? totals.foodCost / totals.diners : null,
    foodCostPercent: totals.revenue > 0 ? totals.foodCost * 100 / totals.revenue : null,
  };
}

export function topProfitMenus<T extends MealProfitMenu>(menus: T[], count = 3): T[] {
  const finalMenus = menus.filter((menu) => hasCompleteMealCost(menu) && amount(menu.revenue) > 0);
  return [...finalMenus].sort((a, b) => amount(b.gross_margin) - amount(a.gross_margin)).slice(0, count);
}

export function marginPerPerson(menu: MealProfitMenu): number | null {
  return hasCompleteMealCost(menu) && amount(menu.revenue) > 0
    ? amount(menu.gross_margin) / amount(menu.diner_count) : null;
}

export function rankMenusByMarginPerPerson<T extends MealProfitMenu>(menus: T[], order: "best" | "worst", count = 3): T[] {
  const ranked = menus.filter((menu) => marginPerPerson(menu) !== null);
  return ranked.sort((a, b) => (marginPerPerson(b)! - marginPerPerson(a)!) * (order === "best" ? 1 : -1)).slice(0, count);
}

export type MenuSignal = "pending" | "loss" | "over_target" | "within_target" | "no_target";

export function getMenuSignal(menu: MealProfitMenu, targetFoodCostPct: number | null): MenuSignal {
  if (!hasCompleteMealCost(menu) || amount(menu.revenue) <= 0) return "pending";
  if (amount(menu.gross_margin) < 0) return "loss";
  if (targetFoodCostPct == null || targetFoodCostPct <= 0) return "no_target";
  return amount(menu.actual_food_cost) * 100 / amount(menu.revenue) > targetFoodCostPct
    ? "over_target" : "within_target";
}
