import { describe, expect, it } from "vitest";
import { canOpen, navFor } from "@/lib/navigation";

describe("meal profit access", () => {
  it.each(["super_admin", "admin", "ops_manager"])(
    "shows and opens Meal Profit for %s",
    (role) => {
      expect(canOpen("/meal-profit", role)).toBe(true);
      expect(navFor(role).some((entry) => entry.path === "/meal-profit")).toBe(true);
    },
  );

  it.each(["unit_manager", "manager", "head_supervisor", "head_chef", "chef", "cashier", "store_keeper", "vendor"])(
    "keeps Meal Profit hidden from %s",
    (role) => {
      expect(canOpen("/meal-profit", role)).toBe(false);
      expect(navFor(role).some((entry) => entry.path === "/meal-profit")).toBe(false);
    },
  );
});
