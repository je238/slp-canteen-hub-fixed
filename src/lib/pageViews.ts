// Turns page_views rows into "who looked at what": per person, which
// screens, how many times, how long, on which days.

export interface PageViewRow {
  user_id: string;
  role: string | null;
  path: string;
  title: string;
  opened_at: string;
  active_seconds: number;
}

export interface ScreenSummary {
  title: string;
  path: string;
  visits: number;
  seconds: number;
  lastOpened: string;
}

export interface PersonSummary {
  userId: string;
  role: string | null;
  visits: number;
  seconds: number;
  days: string[];            // yyyy-mm-dd in IST, newest first
  lastOpened: string;
  screens: ScreenSummary[];  // most visited first
}

export const istDay = (iso: string) =>
  new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);

export function summarisePageViews(rows: PageViewRow[]): PersonSummary[] {
  const people = new Map<string, PersonSummary & { dayset: Set<string>; byPath: Map<string, ScreenSummary> }>();
  for (const r of rows) {
    let p = people.get(r.user_id);
    if (!p) {
      p = { userId: r.user_id, role: r.role, visits: 0, seconds: 0, days: [], lastOpened: r.opened_at,
        screens: [], dayset: new Set(), byPath: new Map() };
      people.set(r.user_id, p);
    }
    const secs = Math.max(0, Number(r.active_seconds) || 0);
    p.visits += 1;
    p.seconds += secs;
    p.dayset.add(istDay(r.opened_at));
    if (r.opened_at > p.lastOpened) { p.lastOpened = r.opened_at; p.role = r.role ?? p.role; }
    let s = p.byPath.get(r.path);
    if (!s) { s = { title: r.title, path: r.path, visits: 0, seconds: 0, lastOpened: r.opened_at }; p.byPath.set(r.path, s); }
    s.visits += 1;
    s.seconds += secs;
    if (r.opened_at >= s.lastOpened) { s.lastOpened = r.opened_at; s.title = r.title; }
  }
  return [...people.values()]
    .map(({ dayset, byPath, ...p }) => ({
      ...p,
      days: [...dayset].sort().reverse(),
      screens: [...byPath.values()].sort((a, b) => b.visits - a.visits || b.seconds - a.seconds),
    }))
    .sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
}

/** "1 min se kam", "4 min", "1 ghanta 12 min". */
export function readableDuration(seconds: number): string {
  if (seconds < 60) return "1 min se kam";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h} ghanta ${m} min` : `${h} ghanta`;
}
