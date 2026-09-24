import { describe, expect, it } from "vitest";
import { canOpen, homeFor, navFor } from "@/lib/navigation";

describe("Head Supervisor and Manager access", () => {
  it("gives HS only menu and data-entry screens", () => {
    expect(navFor("head_supervisor").map((entry) => entry.path)).toEqual([
      "/menu-planning",
      "/menu-scan",
    ]);
    expect(canOpen("/requisitions", "head_supervisor")).toBe(false);
    expect(canOpen("/inventory", "head_supervisor")).toBe(false);
    expect(homeFor("head_supervisor")).toBe("/menu-planning");
  });

  it("restores the Manager's earlier operational and reporting screens", () => {
    expect(navFor("unit_manager").map((entry) => entry.path)).toEqual([
      "/dashboard",
      "/menu-planning",
      "/requisitions",
      "/recipes",
      "/menu-scan",
      "/inventory",
      "/central-kitchen",
      "/purchases",
      "/vendors",
      "/reports-center",
      "/meal-profit",
      "/canteens",
    ]);
    expect(canOpen("/menu-scan", "unit_manager")).toBe(true);
    expect(canOpen("/inventory", "unit_manager")).toBe(true);
    expect(homeFor("unit_manager")).toBe("/requisitions");
  });

  it("sends Chef straight to requisitions", () => {
    expect(navFor("chef").map((entry) => entry.path)).toEqual([
      "/requisitions",
      "/recipes",
    ]);
    expect(canOpen("/menu-planning", "chef")).toBe(false);
    expect(homeFor("chef")).toBe("/requisitions");
  });
});
