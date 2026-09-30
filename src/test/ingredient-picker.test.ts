import { describe, expect, it } from "vitest";
import { nameLikeness } from "@/components/IngredientPicker";

// The pairs the store actually split into two items in August–September.
describe("nameLikeness", () => {
  it("treats spacing and case as the same name", () => {
    expect(nameLikeness("MIX VEG", "MIX  VEG")).toBe(1);
    expect(nameLikeness("amul curd ", "Amul Curd")).toBe(1);
  });

  it("flags a name inside another as a likely duplicate", () => {
    expect(nameLikeness("Chili", "G Chili")).toBeGreaterThanOrEqual(0.6);
    expect(nameLikeness("Mint", "Mint leaves")).toBeGreaterThan(0.4);
  });

  it("flags a one-letter slip", () => {
    expect(nameLikeness("Suagr", "Sugar")).toBeGreaterThanOrEqual(0.6);
    expect(nameLikeness("Panner", "Paneer")).toBeGreaterThanOrEqual(0.6);
  });

  it("does not match unrelated items", () => {
    expect(nameLikeness("Tomato", "Paneer")).toBeLessThan(0.45);
    expect(nameLikeness("Oil", "Aata")).toBeLessThan(0.45);
  });
});
