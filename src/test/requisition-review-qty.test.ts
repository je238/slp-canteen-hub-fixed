import { describe, expect, it } from "vitest";
import { parseReviewQty } from "@/lib/requisitionReviewQty";

describe("order review quantity", () => {
  it("accepts zero and decimal edits", () => {
    expect(parseReviewQty("0")).toBe(0);
    expect(parseReviewQty("0.2")).toBe(0.2);
    expect(parseReviewQty("750")).toBe(750);
  });

  it("does not treat an empty edit as a cancelled line", () => {
    expect(Number.isNaN(parseReviewQty(""))).toBe(true);
    expect(Number.isNaN(parseReviewQty("  "))).toBe(true);
    expect(Number.isNaN(parseReviewQty(undefined))).toBe(true);
  });
});
