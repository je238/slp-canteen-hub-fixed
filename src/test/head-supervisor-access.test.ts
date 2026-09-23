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

  it("keeps Manager on correction and requisition approval screens", () => {
    expect(navFor("unit_manager").map((entry) => entry.path)).toEqual([
      "/menu-planning",
      "/requisitions",
    ]);
    expect(canOpen("/menu-scan", "unit_manager")).toBe(false);
    expect(canOpen("/inventory", "unit_manager")).toBe(false);
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
