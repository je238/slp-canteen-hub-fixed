import { describe, expect, it } from "vitest";
import { categoryTotals, summariseByItem, type PurchaseLine } from "@/lib/purchaseDetail";

const line = (o: Partial<PurchaseLine>): PurchaseLine => ({
  purchase_id: "p1", purchase_item_id: Math.random().toString(), purchase_date: "2026-09-01",
  purchased_at: "2026-09-01T05:00:00Z", vendor_name: "Maa Annapurna", item_name: "Onion",
  category: "Vegetables & Fruits", quantity: 1, unit: "kg", rate: 0, amount: 0, ...o,
});

describe("summariseByItem", () => {
  const rows = [
    line({ purchase_id: "p1", quantity: 50, rate: 30, amount: 1500 }),
    line({ purchase_id: "p2", quantity: 10, rate: 40, amount: 400, vendor_name: "Ram Sabzi" }),
    line({ purchase_id: "p3", quantity: 40, rate: 25, amount: 1000 }),
    line({ purchase_id: "p3", item_name: "Sugar", category: "Grocery", quantity: 50, rate: 44, amount: 2200 }),
    line({ purchase_id: "p4", item_name: "onion ", quantity: 2, unit: "bag", rate: 500, amount: 1000 }),
  ];
  const s = summariseByItem(rows);

  it("averages spend over quantity, not the rates", () => {
    const onion = s.find((x) => x.item === "Onion" && x.unit === "kg")!;
    expect(onion.qty).toBe(100);
    expect(onion.amount).toBe(2900);
    expect(onion.avgRate).toBe(29);
    expect(onion.minRate).toBe(25);
    expect(onion.maxRate).toBe(40);
    expect(onion.bills).toBe(3);
  });

  it("splits an item between its vendors, biggest first", () => {
    const onion = s.find((x) => x.item === "Onion" && x.unit === "kg")!;
    expect(onion.vendors.map((v) => [v.vendor, v.qty, v.amount, v.avgRate, v.bills])).toEqual([
      ["Maa Annapurna", 90, 2500, 27.78, 2],
      ["Ram Sabzi", 10, 400, 40, 1],
    ]);
  });

  it("keeps different units apart and sorts by spend", () => {
    expect(s.map((x) => `${x.item}/${x.unit}`)).toEqual(["Onion/kg", "Sugar/kg", "onion/bag"]);
  });

  it("ignores zero rates for min/max and survives zero quantity", () => {
    const [z] = summariseByItem([line({ quantity: 0, rate: 0, amount: 0 })]);
    expect(z.minRate).toBeNull();
    expect(z.avgRate).toBeNull();
  });
});

describe("categoryTotals", () => {
  it("adds spend per category", () => {
    expect(categoryTotals([
      line({ amount: 100 }), line({ amount: 50.5 }), line({ category: "Dairy", amount: 300 }),
    ])).toEqual([{ category: "Dairy", amount: 300 }, { category: "Vegetables & Fruits", amount: 150.5 }]);
  });
});
