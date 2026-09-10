// The canteen works in IST and the database stores instants in UTC. Between
// midnight and 05:30 IST those disagree about what day it is, and
// `new Date().toISOString().slice(0,10)` quietly returns yesterday — which
// showed the wrong day's register and blocked the usage entry for the shift
// that is actually running.

const IST_OFFSET_MIN = 330;   // +05:30, India has no daylight saving

/** Today as the canteen sees it. */
export function todayIst(): string {
  return istDate(new Date());
}

/** The IST calendar date of any instant. */
export function istDate(d: Date): string {
  const shifted = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** Shift an IST date string by whole days, staying in IST. */
export function shiftIst(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const tomorrowIst = () => shiftIst(todayIst(), 1);

// Yesterday is reachable on purpose, in one place only: the chef's order.
// A day the kitchen cooked but nobody wrote down does not undo itself — the
// food left the shelf, and refusing the late entry only keeps the book wrong
// for ever. So the day before is offered, marked as late, and still walks the
// full road through the manager and the store.
export const yesterdayIst = () => shiftIst(todayIst(), -1);

// ---------------------------------------------------------------------------
// How a date is written on screen. One shape everywhere: 06/08/2026.
//
// The screens had drifted into five different formats — "6 Aug 2026" on the
// requisition, "06 Aug 2026" on the vendor page, "Aug 2026" on budgets, and
// a bare toLocaleDateString() on expenses and purchases which follows the
// PHONE's language, so the same date read 06/08/2026 for one member of staff
// and 8/6/2026 for another. On a register where the day matters that is not
// a cosmetic problem.
// ---------------------------------------------------------------------------

const two = (n: number) => String(n).padStart(2, "0");

/** A date as dd/mm/yyyy, in IST, whatever the phone is set to. */
export function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  // A plain "2026-08-06" is already an IST calendar date; don't shift it.
  const d = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00Z`)
    : new Date(new Date(value).getTime() + IST_OFFSET_MIN * 60_000);
  if (isNaN(d.getTime())) return "—";
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/** dd/mm/yyyy hh:mm, in IST — for ledger rows and anything timestamped. */
export function fmtDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(new Date(value).getTime() + IST_OFFSET_MIN * 60_000);
  if (isNaN(d.getTime())) return "—";
  return `${fmtDate(value)} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** "Monday 06/08/2026" — where the weekday earns its place, as on a weekly
 *  menu chart the kitchen reads by day rather than by date. */
export function fmtDayDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const iso = typeof value === "string" ? value.slice(0, 10) : istDate(new Date(value));
  const d = new Date(`${iso}T00:00:00Z`);
  if (isNaN(d.getTime())) return "—";
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `${days[d.getUTCDay()]} ${fmtDate(iso)}`;
}

/** mm/yyyy — for a month, where a day would be meaningless. */
export function fmtMonth(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00Z`)
    : new Date(new Date(value).getTime() + IST_OFFSET_MIN * 60_000);
  if (isNaN(d.getTime())) return "—";
  return `${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}
