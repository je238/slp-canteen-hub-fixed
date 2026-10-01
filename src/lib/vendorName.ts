// A vendor name as a person would write it on a register.
//
// The invoice scanner's vision model is a reasoning model, and on a hard
// handwritten bill it has put its own thinking into the vendor field ("Let's
// use Manwani Traders... Wait, the M/s is SLP..."), pasted the whole
// letterhead with phone numbers and a product list, or looped one syllable a
// thousand times. Each of those was saved as a new vendor, and every later
// bill was matched against the junk.
//
// Same rules as cleanVendorName() in supabase/functions/ocr-invoice — keep the
// two in step. The database guard (guard_supplier_name) is the last line.

const REASONING = /\b(let'?s|wait|vendor[_ ]name|as per|letterhead|context|actually|i think|check)\b/i;

// The buyer's own name is printed on many bills ("Eicher", "M/s SLP",
// "Sun Pharma") and the reader has taken it for the seller — Maa Annapurna's
// 1 Oct bill came back as vendor "Aishar". The buyer is never the vendor.
const BUYER = /^(m\/?s\.?\s*)?(eicher|aishar|aicher|ayshar|eichar|slp|s\.?\s?l\.?\s?p\.?|sun\s*pharma|sunpharma)\b/i;

export function cleanVendorName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let v = raw.replace(/[​-‍﻿]/g, "").trim();
  if (!v) return null;

  if (REASONING.test(v)) {
    const said = [...v.matchAll(/(?:vendor name is|let'?s (?:write|use|put)|name is)\s+["“]?([^."”()\n]{2,60})/gi)];
    if (said.length) v = said[said.length - 1][1];
  }

  v = v.split(/\r?\n/)[0];
  v = v.replace(/^m\s*\/\s*s\.?\s+/i, "");   // "M/s Manwani Traders" -> the name
  // A GSTIN, a date or a bill number glued onto the name: cut at the first.
  v = v.replace(/\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]{3}.*$/i, "");
  v = v.replace(/\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}.*$/, "");
  v = v.replace(/\d{5,}.*$/, "");
  v = v.replace(/\(.*$/, "");
  v = v.split(/\s+[-–|]\s+/)[0];
  const parts = v.split(/\s*\/\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) v = parts.find((p) => /[A-Za-z]{3}/.test(p)) ?? parts[0];
  v = v.replace(/(.{3,}?)\1{2,}.*/u, "$1");
  v = v.replace(/\s+/g, " ").replace(/[.,;:]+$/, "").trim();

  if (v.length < 2 || REASONING.test(v) || BUYER.test(v)) return null;
  if (v.length > 60) v = v.slice(0, 60).replace(/\s+\S*$/, "");
  if (/^[A-Z0-9 &.'-]+$/.test(v) && /[A-Z]{3}/.test(v)) {
    v = v.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return v || null;
}

/** True when a name is fit to become a vendor without a person looking at it. */
export function isPlausibleVendorName(name: string | null | undefined): name is string {
  if (!name) return false;
  return name.length >= 2 && name.length <= 60 && !/\n/.test(name) && !REASONING.test(name) && !BUYER.test(name)
    && !/(.{3,})\1\1/u.test(name);
}
