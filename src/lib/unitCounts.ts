// Plates by unit (Eicher: Unit 1, 2, 3 from 1 Oct 2026). The database derives
// the site totals from these; this mirrors that rule for the screen.

export type UnitField = "actual" | "punch";
export type UnitCounts = Record<string, Partial<Record<UnitField, number | null>>>;

interface SiteUnits { count_units?: string[] | null; count_units_from?: string | null }

// The units this site counts by on this day, or [] for a single site figure.
export function countUnitsFor(site: SiteUnits | null | undefined, menuDate: string): string[] {
  const units = site?.count_units || [];
  if (!units.length) return [];
  if (site?.count_units_from && menuDate < site.count_units_from) return [];
  return units;
}

export function unitValue(counts: UnitCounts | null | undefined, unit: string, field: UnitField): number | null {
  const v = counts?.[unit]?.[field];
  return v == null ? null : Number(v);
}

// Sum so far, how many units are in, and the total — which only exists once
// every unit has its figure, exactly as the database sets it.
export function unitTotals(counts: UnitCounts | null | undefined, units: string[], field: UnitField) {
  const entered = units.filter((u) => unitValue(counts, u, field) != null);
  const sum = entered.reduce((s, u) => s + (unitValue(counts, u, field) || 0), 0);
  return { sum, entered: entered.length, of: units.length, total: entered.length === units.length && units.length > 0 ? sum : null };
}

// Typed text → counts to save. Blank leaves a unit's figure as it was (a
// recorded figure is never blanked from here). Returns an error message for
// anything that is not a whole number of 0 or more.
export function mergeUnitInput(
  current: UnitCounts | null | undefined,
  units: string[],
  input: Record<string, Partial<Record<UnitField, string>>>,
): { counts: UnitCounts; changed: { unit: string; field: UnitField; was: number | null; now: number }[]; error?: string } {
  const counts: UnitCounts = {};
  const changed: { unit: string; field: UnitField; was: number | null; now: number }[] = [];
  for (const u of units) {
    counts[u] = { ...(current?.[u] || {}) };
    for (const f of ["actual", "punch"] as UnitField[]) {
      const raw = (input[u]?.[f] ?? "").trim();
      if (raw === "") continue;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        return { counts: current || {}, changed: [], error: `${u}: count 0 ya usse zyada poora number hona chahiye` };
      }
      const was = unitValue(current, u, f);
      if (was !== n) changed.push({ unit: u, field: f, was, now: n });
      counts[u][f] = n;
    }
    if (!Object.keys(counts[u]).length) delete counts[u];
  }
  return { counts, changed };
}
