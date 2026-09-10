// The client sends the day's menu as plain WhatsApp text, not a photo:
//
//   24/07/2026
//
//   Midnight
//   Chana chat
//
//   Breakfast
//   Veg Upma
//
//   Lunch
//   Chole paneer
//   Toor Dal Tadka
//   ...
//
// Reading that as text is exact and costs nothing. Running it through OCR
// would be slower, would cost a call, and could only ever be less accurate
// than the characters we were already handed.
//
// The headings are typed by a person every day, so they are matched loosely —
// "Evining snacks" and "E snacks" have both come through.

export interface ParsedMeal {
  meal_period: string;
  items: string[];
  date: string | null;   // ISO, when the text carried one
}

const PERIODS: [RegExp, string][] = [
  [/^(mid\s*-?\s*night|midnight|night\s*snack)/i, "night_snacks"],
  [/^(break\s*fast|b\s*[\/.]?\s*fast|bf|nashta|naashta)/i, "breakfast"],
  [/^(morning\s*tea|tea|chai)\b/i, "tea"],
  [/^(lunch|dopahar|mid\s*day)/i, "lunch"],
  // "evining", "evning" and "eve" all turn up, so match on the stem
  [/^(ev[ei]?n?[ei]?n?g?\s*snack|e\s*snack|snack|sham)/i, "evening_snacks"],
  [/^(dinner|dinnar|supper|raat)/i, "dinner"],
];

const periodOf = (line: string): string | null => {
  const t = line.trim().replace(/[:\-–—]+$/, "").trim();
  if (!t || t.length > 24) return null;          // a heading is short
  for (const [re, period] of PERIODS) if (re.test(t)) return period;
  return null;
};

// 24/07/2026, 24-7-26, 24.07.2026 — day first, as written in India.
const dateOf = (line: string): string | null => {
  const m = line.trim().match(/^(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{2,4})$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

/**
 * Pull the meals out of a pasted menu. Anything before the first heading is
 * ignored, so a forwarded message's greeting or the sender's name does no harm.
 */
export function parseMenuText(text: string): ParsedMeal[] {
  const lines = String(text || "").split(/\r?\n/);
  const meals: ParsedMeal[] = [];
  let date: string | null = null;
  let current: ParsedMeal | null = null;

  for (const raw of lines) {
    // WhatsApp bullets and the odd leading dash
    const line = raw.replace(/^[\s*•\-–·]+/, "").replace(/\s+$/, "");
    if (!line.trim()) continue;

    const asDate = dateOf(line);
    if (asDate) { date = asDate; continue; }

    const period = periodOf(line);
    if (period) {
      current = { meal_period: period, items: [], date };
      meals.push(current);
      continue;
    }

    if (!current) continue;   // still in the preamble

    // One dish per line, but "Salad, Pickle, Papad" on one line happens too.
    for (const part of line.split(/\s*[,/]\s*/)) {
      const dish = part.replace(/\s*\.\s*$/, "").trim();
      if (dish && dish.length < 60) current.items.push(dish);
    }
  }

  // A heading with nothing under it is not a meal.
  return meals.filter((m) => m.items.length > 0)
              .map((m) => ({ ...m, date }));   // a date anywhere applies to the day
}
