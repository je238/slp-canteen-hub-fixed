import { describe, expect, it } from "vitest";
import { parseMenuText } from "@/lib/menuText";

describe("weekly WhatsApp menu", () => {
  it("keeps each meal on the date above it", () => {
    expect(parseMenuText(`28/09/2026
Breakfast
Poha
Lunch
Dal
29/09/2026
Breakfast
Upma
Dinner
Roti`)).toEqual([
      { date: "2026-09-28", meal_period: "breakfast", items: ["Poha"] },
      { date: "2026-09-28", meal_period: "lunch", items: ["Dal"] },
      { date: "2026-09-29", meal_period: "breakfast", items: ["Upma"] },
      { date: "2026-09-29", meal_period: "dinner", items: ["Roti"] },
    ]);
  });

  it("does not put text after a new date into yesterday's meal", () => {
    expect(parseMenuText(`28/09/2026
Lunch
Dal
29/09/2026
Note from company
Lunch
Rice`)).toEqual([
      { date: "2026-09-28", meal_period: "lunch", items: ["Dal"] },
      { date: "2026-09-29", meal_period: "lunch", items: ["Rice"] },
    ]);
  });

  it("still accepts a one-day message with its date at the bottom", () => {
    expect(parseMenuText(`Breakfast
Poha
Lunch
Dal
28/09/2026`)).toEqual([
      { date: "2026-09-28", meal_period: "breakfast", items: ["Poha"] },
      { date: "2026-09-28", meal_period: "lunch", items: ["Dal"] },
    ]);
  });

  it("keeps Monday and Tuesday as separate weekly chart days", () => {
    expect(parseMenuText(`Monday
Breakfast
Poha
Tuesday:
Breakfast
Upma`)).toEqual([
      { date: null, day: "monday", meal_period: "breakfast", items: ["Poha"] },
      { date: null, day: "tuesday", meal_period: "breakfast", items: ["Upma"] },
    ]);
  });
});
