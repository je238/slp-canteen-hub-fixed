import { describe, expect, it } from "vitest";
import { istDay, readableDuration, summarisePageViews, type PageViewRow } from "@/lib/pageViews";

const row = (user_id: string, path: string, opened_at: string, active_seconds: number, title = path): PageViewRow =>
  ({ user_id, role: "unit_manager", path, title, opened_at, active_seconds });

describe("who looked at what", () => {
  it("groups by person and screen, most visited first", () => {
    const out = summarisePageViews([
      row("m", "/requisitions", "2026-10-17T04:00:00Z", 120, "Requisitions"),
      row("m", "/meal-profit", "2026-10-17T05:00:00Z", 300, "Meal Profit"),
      row("m", "/requisitions", "2026-10-18T04:00:00Z", 60, "Requisitions"),
      row("s", "/inventory", "2026-10-17T06:00:00Z", 30, "Inventory"),
    ]);
    expect(out.map((p) => p.userId)).toEqual(["m", "s"]);
    const m = out[0];
    expect(m.visits).toBe(3);
    expect(m.seconds).toBe(480);
    expect(m.days).toEqual(["2026-10-18", "2026-10-17"]);
    expect(m.screens.map((s) => [s.title, s.visits, s.seconds])).toEqual([["Requisitions", 2, 180], ["Meal Profit", 1, 300]]);
  });

  it("counts days in Indian time", () => {
    expect(istDay("2026-10-16T19:00:00Z")).toBe("2026-10-17");   // 00:30 IST
    expect(istDay("2026-10-16T18:00:00Z")).toBe("2026-10-16");   // 23:30 IST
  });

  it("reads durations plainly", () => {
    expect(readableDuration(20)).toBe("1 min se kam");
    expect(readableDuration(240)).toBe("4 min");
    expect(readableDuration(4320)).toBe("1 ghanta 12 min");
    expect(readableDuration(7200)).toBe("2 ghanta");
  });
});
