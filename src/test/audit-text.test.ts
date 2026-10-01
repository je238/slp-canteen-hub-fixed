import { describe, expect, it } from "vitest";
import { auditSummary, bigJumps } from "@/lib/auditText";

// The REQ-252 row from the live audit log, 01 Oct 2026.
const req252 = {
  req_no: 252,
  reason: "Oil jada hai or tar Hun kam",
  changes: [
    { line_id: "589e6437", chef_qty: 45, chef_item: "Oil", final_qty: 400, final_item: "Oil", chef_item_id: "fe37",
      final_item_id: "fe37", head_chef_qty: 45, head_chef_item: "Oil", manager_base_qty: 45, head_chef_item_id: "fe37" },
    { line_id: "ab41c857", chef_qty: 90, chef_item: "watermelon", final_qty: 110, final_item: "watermelon",
      chef_item_id: "3899", final_item_id: "3899", head_chef_qty: 90, head_chef_item: "watermelon", manager_base_qty: 90 },
  ],
};

describe("auditSummary", () => {
  it("reads an order line as chef → final, with no ids", () => {
    const s = auditSummary(req252);
    expect(s).toBe("REQ-252 · Oil: chef 45 → final 400 · watermelon: chef 90 → final 110");
    expect(s).not.toMatch(/line_id|_id|\{/);
  });

  it("shows the head chef step only when it changed the quantity, and an item swap", () => {
    expect(auditSummary({ req_no: 9, changes: [{ chef_item: "Oil", final_item: "Refined Oil", chef_qty: 25, head_chef_qty: 20, final_qty: 15 }] }))
      .toBe("REQ-9 · Oil → Refined Oil: chef 25 → head chef 20 → final 15");
  });

  it("an empty change list leaves no trailing dot", () => {
    expect(auditSummary({ req_no: 251, changes: [] })).toBe("REQ-251");
  });

  it("keeps the old was → now form", () => {
    expect(auditSummary({ item: "Onion", was: 10, now: 12 })).toBe("Onion · 10 → 12");
  });

  it("never prints raw ids for unknown objects", () => {
    expect(auditSummary({ changes: [{ id: "x", ingredient_id: "y", note: "ok", qty: 5 }] })).toBe("note: ok, qty: 5");
  });
});

describe("bigJumps", () => {
  it("flags a line set to 3x or more of what was asked", () => {
    expect(bigJumps(req252)).toEqual(["Oil: 45 maanga, 400 kiya (9x)"]);
  });
  it("leaves ordinary changes alone", () => {
    expect(bigJumps({ changes: [{ chef_item: "Oil", chef_qty: 25, final_qty: 15 }] })).toEqual([]);
  });
});
