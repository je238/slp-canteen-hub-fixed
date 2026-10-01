import { describe, expect, it } from "vitest";
import { cleanVendorName, isPlausibleVendorName } from "@/lib/vendorName";

// Every input below is a real vendor name the scanner saved in September 2026.
describe("cleanVendorName", () => {
  it("takes the answer out of the model's reasoning", () => {
    const raw = "मनवानी ट्रेडर्स / MANWANI TRADERS / MANWANI DRESSES (from warranty text/header context, using standard ERP vendor mapping if applicable, but supplier letterhead says मनवानी ट्रेडर्स / MANWANI TRADERS as per stamp/header context. Let's use Manwani Traders or Manwani Dresss, matching header: Manwani Traders / MANWANI TRADERS for supplier block context.) Let's use Manwani Traders / MANWANI TRADERS (or as written MANWANI TRADERS). Let's put MANWANI TRADERS since it appears prominently as the seller block header.) Wait, the M/s is SLP HOSPITALITY INCORPORATION, so M/s SLP HOSPITALITY INCORPORATION is the buyer. The vendor name is MANWANI TRADERS (मनवानी ट्रेडर्स). Let's write MANWANI TRADERS. Let's write MANWANI TRADERS.";
    expect(cleanVendorName(raw)).toBe("Manwani Traders");
  });

  it("keeps only the first line of a pasted letterhead", () => {
    const raw = "न्यु गणेश मिल्क पाईंट्\nफॉर - न्यु गणेश मिल्क पाईंट्\nविकास नगर चौराहा, देवास (म.प्र.)\nMob.: 9098188233, 9074239101";
    expect(cleanVendorName(raw)).toBe("न्यु गणेश मिल्क पाईंट्");
  });

  it("drops the address, phone numbers and arithmetic after the name", () => {
    const raw = "माधव पनीर (Madhav Paneer) - गंगा नगर - देवास (म.प्र.) BS. 7838585964 RS. 7772983877 S.L.P Hospitality receipt no 66 dt 22/09/26 cul 13,950 total check 12000+1760+190 = 13950 wait";
    expect(cleanVendorName(raw)).toBe("माधव पनीर");
  });

  it("cuts a syllable the model looped", () => {
    const raw = "वेजिटेबुल सप्लायर्स चोईथराम नई सब्जी मण्डी, ए.बी. रोड़, इन्दौरुरत एण्ड फ्रूट भण्डारआरिफारिदेवासराआरिफारिफारिदेवासराआरिफारिफारिदेवासराआरिफारिफारिदेवासरा";
    const out = cleanVendorName(raw)!;
    expect(out.length).toBeLessThanOrEqual(60);
    expect(isPlausibleVendorName(out)).toBe(true);
  });

  it("strips zero-width characters and trailing junk", () => {
    expect(cleanVendorName("माँ अन्नपूर्णा वेजीटेबल एण्ड फ्रूट भण्डार‍‍‍‍‍‍‍")).toBe("माँ अन्नपूर्णा वेजीटेबल एण्ड फ्रूट भण्डार");
  });

  it("cuts a GSTIN, date and bill number glued onto the name", () => {
    expect(cleanVendorName("SHREE BALAJI TRADERS23AABCS1429B1ZX2026-08-21SBT")).toBe("Shree Balaji Traders");
    expect(cleanVendorName("Raza Traders 9098188233")).toBe("Raza Traders");
  });

  it("leaves a normal name alone", () => {
    expect(cleanVendorName("Rza Traders")).toBe("Rza Traders");
    expect(cleanVendorName("PUNJAB FOOD PRODUCTS")).toBe("Punjab Food Products");
    expect(cleanVendorName("New Ganesh Milk Point")).toBe("New Ganesh Milk Point");
  });

  it("returns null for nothing", () => {
    expect(cleanVendorName(null)).toBeNull();
    expect(cleanVendorName("   ")).toBeNull();
  });

  it("never takes the buyer for the vendor", () => {
    for (const b of ["Aishar", "EICHER", "M/s SLP Hospitality", "Sun Pharma Central Kitchen", "S.L.P."]) {
      expect(cleanVendorName(b)).toBeNull();
    }
    expect(cleanVendorName("Maa Annapurna Vegetable")).toBe("Maa Annapurna Vegetable");
    expect(cleanVendorName("Sunrise Traders")).toBe("Sunrise Traders");
  });
});
