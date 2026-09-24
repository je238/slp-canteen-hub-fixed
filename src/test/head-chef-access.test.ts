import { describe, expect, it } from "vitest";
import { canOpen, homeFor, navFor } from "@/lib/navigation";

describe("Head Chef access", () => {
  it("can open requisitions, recipes and operational reports", () => {
    expect(navFor("head_chef").map((entry) => entry.path)).toEqual([
      "/requisitions",
      "/recipes",
      "/reports-center",
    ]);
    expect(canOpen("/requisitions", "head_chef")).toBe(true);
    expect(canOpen("/recipes", "head_chef")).toBe(true);
    expect(canOpen("/reports-center", "head_chef")).toBe(true);
    expect(canOpen("/meal-profit", "head_chef")).toBe(false);
    expect(canOpen("/menu-planning", "head_chef")).toBe(false);
    expect(canOpen("/inventory", "head_chef")).toBe(false);
    expect(homeFor("head_chef")).toBe("/requisitions");
  });
});
