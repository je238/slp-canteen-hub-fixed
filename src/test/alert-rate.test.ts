import { describe, expect, it } from "vitest";
import { formatAlertRate } from "@/lib/alertRate";

describe("price-spike alert display", () => {
  it("shows the previous average to two decimal places", () => {
    expect(formatAlertRate("28.4615384615384615")).toBe("₹28.46");
  });

  it("shows the new purchase rate to two decimal places", () => {
    expect(formatAlertRate(40)).toBe("₹40.00");
  });
});
