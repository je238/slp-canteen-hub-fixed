import { describe, expect, it } from "vitest";
import { getMenuSignal, marginPerPerson, rankMenusByMarginPerPerson, summarizeMealProfit, topProfitMenus, type MealProfitMenu } from "@/lib/mealProfitOverview";

const menu = (overrides: Partial<MealProfitMenu>): MealProfitMenu => ({
  menu_plan_id: "a", menu_date: "2026-09-20", meal_period: "lunch", diner_count: 0,
  provisional: false, revenue: 0, actual_food_cost: 0, gross_margin: 0, ...overrides,
});

describe("meal profit overview", () => {
  it("weights food cost per person by diners, not by menu count", () => {
    const totals = summarizeMealProfit([
      menu({ diner_count: 100, actual_food_cost: 1000, revenue: 3000, gross_margin: 2000 }),
      menu({ menu_plan_id: "b", diner_count: 10, actual_food_cost: 500, revenue: 1000, gross_margin: 500 }),
    ]);
    expect(totals.costPerPerson).toBeCloseTo(1500 / 110);
    expect(totals.foodCostPercent).toBeCloseTo(37.5);
    expect(totals.profit).toBe(2500);
  });

  it("keeps missing diners and revenue as unavailable instead of zero percent", () => {
    const totals = summarizeMealProfit([menu({ provisional: true, actual_food_cost: 50 })]);
    expect(totals.provisionalCount).toBe(1);
    expect(totals.pendingCount).toBe(1);
    expect(totals.costPerPerson).toBeNull();
    expect(totals.foodCostPercent).toBeNull();
  });

  it("excludes future estimates, zero-cost and zero-sale menus from owner averages", () => {
    const totals = summarizeMealProfit([
      menu({ menu_plan_id: "complete", diner_count: 100, actual_food_cost: 2000, revenue: 5000, gross_margin: 3000 }),
      menu({ menu_plan_id: "no-issue", diner_count: 1000, actual_food_cost: 0, revenue: 50000, gross_margin: 50000 }),
      menu({ menu_plan_id: "expected", diner_count: 1000, provisional: true, actual_food_cost: 100, revenue: 50000, gross_margin: 49900 }),
      menu({ menu_plan_id: "no-sale", diner_count: 100, actual_food_cost: 2000, revenue: 0, gross_margin: -2000 }),
    ]);
    expect(totals.totalMenuCount).toBe(4);
    expect(totals.menuCount).toBe(1);
    expect(totals.pendingCount).toBe(3);
    expect(totals.costPerPerson).toBe(20);
    expect(totals.profit).toBe(3000);
  });

  it("ranks only menus with final diner counts and positive sale", () => {
    const result = topProfitMenus([
      menu({ menu_plan_id: "estimate", provisional: true, revenue: 1000, gross_margin: 900 }),
      menu({ menu_plan_id: "final", diner_count: 10, actual_food_cost: 300, revenue: 500, gross_margin: 200 }),
      menu({ menu_plan_id: "no-sale", diner_count: 10, actual_food_cost: 100, revenue: 0, gross_margin: 500 }),
    ]);
    expect(result.map((row) => row.menu_plan_id)).toEqual(["final"]);
  });

  it("ranks by margin per person instead of total profit", () => {
    const large = menu({ menu_plan_id: "large", diner_count: 1000, actual_food_cost: 20000, revenue: 30000, gross_margin: 10000 });
    const efficient = menu({ menu_plan_id: "efficient", diner_count: 100, actual_food_cost: 1000, revenue: 3000, gross_margin: 2000 });
    const incomplete = menu({ menu_plan_id: "incomplete", diner_count: 100, revenue: 10000, gross_margin: 10000 });
    expect(marginPerPerson(efficient)).toBe(20);
    expect(rankMenusByMarginPerPerson([large, efficient, incomplete], "best").map((row) => row.menu_plan_id)).toEqual(["efficient", "large"]);
    expect(rankMenusByMarginPerPerson([large, efficient, incomplete], "worst")[0].menu_plan_id).toBe("large");
  });

  it("flags losses and saved-target breaches without inventing a target", () => {
    const healthy = menu({ diner_count: 100, actual_food_cost: 1000, revenue: 3000, gross_margin: 2000 });
    expect(getMenuSignal(healthy, null)).toBe("no_target");
    expect(getMenuSignal(healthy, 30)).toBe("over_target");
    expect(getMenuSignal(healthy, 40)).toBe("within_target");
    expect(getMenuSignal(menu({ ...healthy, actual_food_cost: 3500, gross_margin: -500 }), null)).toBe("loss");
    expect(getMenuSignal(menu({ ...healthy, actual_food_cost: 0 }), 40)).toBe("pending");
  });
});
