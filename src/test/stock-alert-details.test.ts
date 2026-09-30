import { describe, expect, it } from "vitest";
import { findStockAlertMovement, stockAlertRate, type StockAlertValues, type StockMovement } from "@/lib/stockAlertDetails";

const alert: StockAlertValues = {
  canteen_id: "eicher", ingredient_id: "urad", created_at: "2026-09-30T15:18:39.633625Z",
  expected_value: "116", actual_value: "38", loss_value: "9360",
};

const movement: StockMovement = {
  id: "audit-row", canteen_id: "eicher", ingredient_id: "urad", reference_type: "audit",
  change_qty: "-78", balance_after: "38", reason: "Stock audit", created_at: alert.created_at,
  created_by: "store-user",
};

describe("stock alert details", () => {
  it("matches the exact audit row, not an unrelated movement", () => {
    expect(findStockAlertMovement(alert, [
      { ...movement, id: "wrong-site", canteen_id: "other" },
      { ...movement, id: "wrong-count", balance_after: "37" },
      { ...movement, id: "old", created_at: "2026-09-29T15:18:39Z" },
      movement,
    ])?.id).toBe("audit-row");
  });

  it("derives the rate recorded in the alert rather than today's master rate", () => {
    expect(stockAlertRate(alert)).toBe(120);
    expect(stockAlertRate({ ...alert, expected_value: "38" })).toBeUndefined();
  });
});
