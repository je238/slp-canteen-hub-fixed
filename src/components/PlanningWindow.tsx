import { usePlanningWindow } from "@/hooks/useSrsData";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CalendarRange, Users } from "lucide-react";
import { fmtDate } from "@/lib/date";

// Thirty working days at a glance.
//
// Planning ahead was always allowed — nothing ever blocked a future date —
// but with one date box and no map, the manager had no way to see which of
// the coming days were done and which were still blank. So it was permitted
// and impossible at the same time. This is the map.
//
// A day is only "done" once it carries dishes AND a headcount. The headcount
// is deliberately not carried forward from another day: it is the number the
// company is billed on, and a figure copied from a fortnight ago is a guess
// wearing the clothes of a count. So a day with dishes but no headcount is
// shown as unfinished, not as done.

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function PlanningWindow({
  canteenId, current, onPick,
}: { canteenId: string; current: string; onPick: (d: string) => void }) {
  const { data: days } = usePlanningWindow(canteenId, 30);
  if (!days || days.length === 0) return null;

  // A site that serves every day has no "working days" to speak of — calling
  // them that invites the question "so which day are we closed?", which is
  // exactly the question this site does not have.
  const span = Math.round(
    (new Date(days[days.length - 1].work_date).getTime()
      - new Date(days[0].work_date).getTime()) / 864e5);
  const everyDay = span === days.length - 1;

  const blank = days.filter((d: any) => d.meals_planned === 0).length;
  const noHeads = days.filter((d: any) => d.missing_headcount > 0).length;

  return (
    <Card className="border-none shadow-sm">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <CalendarRange className="w-4 h-4 text-accent" />
          <p className="text-xs font-semibold">
            Next {days.length} {everyDay ? "days" : "working days"}
          </p>
          <p className="text-[11px] text-muted-foreground flex-1 min-w-[200px]">
            {blank === 0
              ? "every day has a menu"
              : `${blank} day${blank > 1 ? "s" : ""} still empty`}
            {noHeads > 0 && ` · ${noHeads} waiting on a headcount`}
          </p>
        </div>

        <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-10 gap-1.5">
          {days.map((d: any) => {
            const dt = new Date(`${d.work_date}T00:00:00`);
            const empty = d.meals_planned === 0;
            const needsHeads = d.missing_headcount > 0;
            const done = !empty && !needsHeads;
            const isCurrent = d.work_date === current;
            return (
              <Button
                key={d.work_date}
                size="sm"
                variant="ghost"
                onClick={() => onPick(d.work_date)}
                title={
                  empty ? "no menu yet"
                  : needsHeads ? `${d.missing_headcount} meal(s) without a headcount`
                  : `${d.meals_planned} meal(s), ${d.dishes} dish(es), ${d.heads} expected`
                }
                className={[
                  "h-auto flex-col items-start gap-0 p-1.5 border rounded-md text-left",
                  isCurrent ? "ring-2 ring-accent" : "",
                  done ? "bg-success/10 border-success/30"
                       : needsHeads ? "bg-warning/10 border-warning/40"
                       : "bg-muted/40",
                ].join(" ")}
              >
                <span className="text-[10px] text-muted-foreground leading-tight">
                  {DAY[dt.getDay()]}
                </span>
                <span className="text-[11px] font-semibold leading-tight">
                  {fmtDate(d.work_date)}
                </span>
                <span className="text-[10px] leading-tight text-muted-foreground">
                  {empty ? "—"
                    : needsHeads ? "no count"
                    : <span className="inline-flex items-center gap-0.5">
                        <Users className="w-2.5 h-2.5" />{d.heads}
                      </span>}
                </span>
              </Button>
            );
          })}
        </div>

        <p className="text-[10px] text-muted-foreground">
          Green = menu and headcount both in · amber = dishes entered but the
          headcount is still missing, so it cannot be published · grey = empty.
          The headcount is typed per day on purpose — it is what the day is
          billed on. Only tomorrow's menu can be sent to the chef — the rest
          stay drafts until their turn, and the chef's order is still approved
          one day at a time.
        </p>
      </CardContent>
    </Card>
  );
}
