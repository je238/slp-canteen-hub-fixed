import { describe, expect, it } from "vitest";
import { countUnitsFor, mergeUnitInput, unitTotals } from "@/lib/unitCounts";

const UNITS = ["Unit 1", "Unit 2", "Unit 3"];
const eicher = { count_units: UNITS, count_units_from: "2026-10-01" };

describe("countUnitsFor", () => {
  it("counts by unit from the start date only", () => {
    expect(countUnitsFor(eicher, "2026-10-01")).toEqual(UNITS);
    expect(countUnitsFor(eicher, "2026-09-30")).toEqual([]);
  });
  it("a site without units keeps the single figure", () => {
    expect(countUnitsFor({ count_units: [] }, "2026-10-05")).toEqual([]);
    expect(countUnitsFor(undefined, "2026-10-05")).toEqual([]);
  });
});

describe("unitTotals", () => {
  it("has no total until every unit is in, but shows the sum so far", () => {
    expect(unitTotals({ "Unit 1": { actual: 500 }, "Unit 2": { actual: 620 } }, UNITS, "actual"))
      .toEqual({ sum: 1120, entered: 2, of: 3, total: null });
  });
  it("totals once all are in, counting a 0 unit as entered", () => {
    expect(unitTotals({ "Unit 1": { actual: 500 }, "Unit 2": { actual: 620 }, "Unit 3": { actual: 0 } }, UNITS, "actual").total)
      .toBe(1120);
  });
  it("actual and punch are separate", () => {
    const c = { "Unit 1": { actual: 5, punch: 4 }, "Unit 2": { actual: 5 }, "Unit 3": { actual: 5 } };
    expect(unitTotals(c, UNITS, "actual").total).toBe(15);
    expect(unitTotals(c, UNITS, "punch")).toEqual({ sum: 4, entered: 1, of: 3, total: null });
  });
});

describe("mergeUnitInput", () => {
  const current = { "Unit 1": { actual: 500 } };
  it("adds new figures, keeps old ones, and lists what changed", () => {
    const r = mergeUnitInput(current, UNITS, { "Unit 1": { actual: "", punch: "490" }, "Unit 2": { actual: "620" } });
    expect(r.error).toBeUndefined();
    expect(r.counts).toEqual({ "Unit 1": { actual: 500, punch: 490 }, "Unit 2": { actual: 620 } });
    expect(r.changed).toEqual([
      { unit: "Unit 1", field: "punch", was: null, now: 490 },
      { unit: "Unit 2", field: "actual", was: null, now: 620 },
    ]);
  });
  it("flags a correction of a recorded figure", () => {
    const r = mergeUnitInput(current, UNITS, { "Unit 1": { actual: "510" } });
    expect(r.changed).toEqual([{ unit: "Unit 1", field: "actual", was: 500, now: 510 }]);
  });
  it("retyping the same figure is not a change", () => {
    expect(mergeUnitInput(current, UNITS, { "Unit 1": { actual: "500" } }).changed).toEqual([]);
  });
  it("refuses negatives and fractions", () => {
    expect(mergeUnitInput(current, UNITS, { "Unit 2": { actual: "-1" } }).error).toMatch(/Unit 2/);
    expect(mergeUnitInput(current, UNITS, { "Unit 2": { actual: "2.5" } }).error).toMatch(/Unit 2/);
  });
});
