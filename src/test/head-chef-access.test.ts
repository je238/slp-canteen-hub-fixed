import { describe, expect, it } from "vitest";
import { canOpen, homeFor, navFor } from "@/lib/navigation";

describe("Head Chef access", () => {
  it("can open only the requisition work screen", () => {
    expect(navFor("head_chef").map((entry) => entry.path)).toEqual(["/requisitions"]);
    expect(canOpen("/requisitions", "head_chef")).toBe(true);
    expect(canOpen("/menu-planning", "head_chef")).toBe(false);
    expect(canOpen("/inventory", "head_chef")).toBe(false);
    expect(homeFor("head_chef")).toBe("/requisitions");
  });
});
