import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { usePeriodSummary } from "@/hooks/useSrsData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ArrowDown, ArrowRight, ArrowUp, BadgeIndianRupee, CircleAlert, Coins, IndianRupee,
  Minus, Package, Scale, ShoppingCart, TrendingUp, Users,
} from "lucide-react";
import { fmtDate, shiftIst, todayIst } from "@/lib/date";
import { REPORTING_CUTOVER_DATE } from "@/lib/cutover";

// One period against the one before it. A single month's food cost says
// nothing on its own — 68% is only good or bad next to what last month did.
// This is the whole screen for the ops manager: no data entry, no approvals,
// just whether the site is moving the right way.

const RANGES = [
  { key: "week", label: "This week" },
  { key: "fortnight", label: "Last 15 days" },
  { key: "month", label: "This month" },
] as const;

// Lower is better for money going out; higher is better for people fed.
const ROWS: { key: string; label: string; money?: boolean; lowerIsBetter?: boolean; pct?: boolean; neutral?: boolean }[] = [
  { key: "purchase", label: "Purchases", money: true, lowerIsBetter: true },
  { key: "consumption", label: "Consumption", money: true, lowerIsBetter: true },
  { key: "sale", label: "Sale (plates × rate)", money: true },
  { key: "food_cost_pct", label: "Food cost", pct: true, lowerIsBetter: true },
  { key: "headcount", label: "Billing plates (punch → actual → expected)" },
  { key: "cost_per_plate", label: "Cost per plate", money: true, lowerIsBetter: true },
  { key: "expenses", label: "Other expenses", money: true, lowerIsBetter: true },
  { key: "wastage", label: "Wastage (kg)", lowerIsBetter: true },
  { key: "closing_stock", label: "Stock in hand", money: true },
  // Shown, not hidden. The opening count is real goods and real money — it is
  // just not this period BUYING, so it sits on its own line instead of making
  // the first month look like eleven lakh of shopping.
  { key: "opening_stock_in", label: "Opening stock brought in", money: true, neutral: true },
  // Counted by hand or re-priced. Without this line the column simply did not
  // add up, and four thousand rupees with nowhere to come from costs more
  // trust than the four thousand is worth.
  { key: "adjustments", label: "Counted / re-priced by hand", money: true, neutral: true },
];

const money = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

function SnapshotCard({ label, value, sub, icon: Icon, tone = "default", onClick }: {
  label: string; value: string; sub?: string; icon: any; tone?: "default" | "good" | "bad";
  onClick: () => void;
}) {
  const toneClass = tone === "good"
    ? "bg-success/10 text-success"
    : tone === "bad" ? "bg-destructive/10 text-destructive" : "bg-accent/10 text-accent";
  return <button type="button" onClick={onClick}
    aria-label={`${label} ki poori detail dekhein`}
    className="group h-full w-full rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
    <Card className="h-full border-none shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      <CardContent className="flex h-full items-start gap-3 p-4">
        <span className={`w-10 h-10 rounded-xl shrink-0 flex items-center justify-center ${toneClass}`}>
          <Icon className="w-4.5 h-4.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-xs text-muted-foreground block">{label}</span>
          <span className={`block break-words text-xl font-bold leading-tight ${tone === "bad" ? "text-destructive" : tone === "good" ? "text-success" : ""}`}>{value}</span>
          {sub ? <span className="text-[11px] text-muted-foreground leading-snug block mt-0.5">{sub}</span> : null}
          <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-primary">
            Detail dekho <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
          </span>
        </span>
      </CardContent>
    </Card>
  </button>;
}

function monthStart(iso: string) {
  return `${iso.slice(0, 7)}-01`;
}

function previousMonth(iso: string) {
  const d = new Date(`${monthStart(iso)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const first = d.toISOString().slice(0, 10);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return { first, last: d.toISOString().slice(0, 10) };
}

export default function ComparisonPage() {
  const { selectedCanteen } = useAppContext();
  const navigate = useNavigate();
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("month");
  const { nowFrom, nowTo, prevFrom, prevTo, hasPrevious } = useMemo(() => {
    const to = todayIst();
    let from: string;
    let beforeFrom: string;
    let beforeTo: string;

    if (range === "week") {
      const weekday = new Date(`${to}T00:00:00Z`).getUTCDay();
      from = shiftIst(to, -((weekday + 6) % 7));
      beforeTo = shiftIst(from, -1);
      beforeFrom = shiftIst(beforeTo, -6);
    } else if (range === "fortnight") {
      from = shiftIst(to, -14);
      beforeTo = shiftIst(from, -1);
      beforeFrom = shiftIst(beforeTo, -14);
    } else {
      from = monthStart(to);
      const previous = previousMonth(to);
      beforeFrom = previous.first;
      beforeTo = previous.last;
    }

    const clampedFrom = from < REPORTING_CUTOVER_DATE ? REPORTING_CUTOVER_DATE : from;
    const validPrevious = beforeTo >= REPORTING_CUTOVER_DATE;
    return {
      nowFrom: clampedFrom,
      nowTo: to,
      prevFrom: validPrevious && beforeFrom < REPORTING_CUTOVER_DATE
        ? REPORTING_CUTOVER_DATE : beforeFrom,
      prevTo: beforeTo,
      hasPrevious: validPrevious,
    };
  }, [range]);

  const now = usePeriodSummary(selectedCanteen, nowFrom, nowTo);
  const prev = usePeriodSummary(selectedCanteen, hasPrevious ? prevFrom : undefined, hasPrevious ? prevTo : undefined);

  if (selectedCanteen === "all") {
    return (
      <AppLayout title="Comparison">
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          Pick a site to compare.
        </CardContent></Card>
      </AppLayout>
    );
  }

  const a: any = now.data || {}, b: any = prev.data || {};
  const sale = Number(a.sale || 0);
  const consumption = Number(a.consumption || 0);
  const grossMargin = sale - consumption;
  const marginPct = sale > 0 ? grossMargin * 100 / sale : null;
  const actual = Number(a.actual_headcount || 0);
  const punch = Number(a.company_punch_headcount || 0);
  const provisional = Number(a.provisional_headcount || 0);
  const fmt = (r: typeof ROWS[number], v: any) => {
    const n = Number(v || 0);
    if (r.pct) return n ? n.toFixed(1) + "%" : "—";
    if (r.money) return money(n);
    return Math.round(n).toLocaleString("en-IN");
  };
  const openDetail = (tab: "profit" | "purchase" | "consumption" | "financial" | "operations") => {
    const params = new URLSearchParams({ from: nowFrom, to: nowTo, tab });
    navigate(`/reports-center?${params.toString()}`);
  };

  return (
    <AppLayout title="Comparison">
      <div className="space-y-4 animate-fade-in max-w-6xl">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Business performance</h2>
            <p className="text-xs text-muted-foreground">Sale, kitchen cost aur margin ek jagah.</p>
          </div>
          <div className="flex gap-2 flex-wrap">
          {RANGES.map((r) => (
            <Button key={r.key} size="sm"
              variant={range === r.key ? "default" : "outline"}
              onClick={() => setRange(r.key)}>
              {r.label}
            </Button>
          ))}
          </div>
        </div>

        <div className="rounded-xl border bg-card px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-xs">
          <span><b>{fmtDate(nowFrom)} – {fmtDate(nowTo)}</b> ka result</span>
          {hasPrevious
            ? <span className="text-muted-foreground">Compare with {fmtDate(prevFrom)} – {fmtDate(prevTo)}</span>
            : <span className="text-muted-foreground">Comparison tab previous complete period milne ke baad activate hoga.</span>}
        </div>

        {now.isLoading ? <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Loading…</CardContent></Card> : <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SnapshotCard label="Sale" value={money(sale)} sub="plates × contracted rate" icon={IndianRupee} onClick={() => openDetail("profit")} />
            <SnapshotCard label="Kitchen consumption" value={money(consumption)} sub="unused returns minus, FIFO cost" icon={Package} tone={sale > 0 && consumption / sale > .45 ? "bad" : "default"} onClick={() => openDetail("consumption")} />
            <SnapshotCard label="Gross margin" value={money(grossMargin)} sub={marginPct == null ? "sale record nahi hai" : `${marginPct.toFixed(1)}% of sale · expenses se pehle`} icon={TrendingUp} tone={grossMargin >= 0 ? "good" : "bad"} onClick={() => openDetail("financial")} />
            <SnapshotCard label="Food cost" value={sale > 0 ? `${(consumption * 100 / sale).toFixed(1)}%` : "—"} sub="consumption ÷ sale" icon={BadgeIndianRupee} tone={sale > 0 && consumption / sale > .45 ? "bad" : "good"} onClick={() => openDetail("financial")} />
            <SnapshotCard label="Billing plates" value={Number(a.headcount || 0).toLocaleString("en-IN")} sub={`${punch.toLocaleString("en-IN")} Eicher final · ${actual.toLocaleString("en-IN")} actual${provisional ? ` · ${provisional.toLocaleString("en-IN")} provisional` : ""}`} icon={Users} onClick={() => openDetail("profit")} />
            <SnapshotCard label="Cost per plate" value={money(Number(a.cost_per_plate || 0))} sub="consumption ÷ plates" icon={Coins} onClick={() => openDetail("financial")} />
            <SnapshotCard label="Purchases" value={money(Number(a.purchase || 0))} sub="is period me saman aaya" icon={ShoppingCart} onClick={() => openDetail("purchase")} />
            <SnapshotCard label="Wastage" value={`${Number(a.wastage || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })} kg`} sub="Weight only · rupee cost recipe/yield ke bina nahi" icon={Scale} tone={Number(a.wastage || 0) > 0 ? "bad" : "good"} onClick={() => openDetail("operations")} />
          </div>

          {!hasPrevious ? <Card className="border-warning/30 bg-warning/5 shadow-none">
            <CardContent className="p-4 flex gap-3 items-start">
              <CircleAlert className="w-5 h-5 text-warning shrink-0 mt-0.5" />
              <div><p className="text-sm font-medium">Abhi fair comparison possible nahi hai</p><p className="text-xs text-muted-foreground mt-0.5">Reliable reports {fmtDate(REPORTING_CUTOVER_DATE)} se start hain. Isliye fake zero ya red/green change dikhane ke bajay upar sirf current period ka sachcha snapshot dikh raha hai.</p></div>
            </CardContent>
          </Card> : null}
        </>}

        {hasPrevious ? <Card className="border-none shadow-sm">
          <CardHeader className="pb-1"><CardTitle className="text-sm">Line-by-line comparison</CardTitle></CardHeader>
          <CardContent className="p-4 pt-2">
            {now.isLoading || prev.isLoading ? (
              <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b">
                      <th className="text-left py-2 font-medium"></th>
                      <th className="text-right py-2 font-medium">Before</th>
                      <th className="text-right py-2 font-medium">Now</th>
                      <th className="text-right py-2 font-medium">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ROWS.map((r) => {
                      const cur = Number(a[r.key] || 0), was = Number(b[r.key] || 0);
                      const diff = cur - was;
                      const pct = was ? (diff / Math.abs(was)) * 100 : null;
                      const flat = Math.abs(diff) < 0.005;
                      // "Better" depends on the row: spending less is good,
                      // feeding more people is good.
                      const good = flat || r.neutral ? null : r.lowerIsBetter ? diff < 0 : diff > 0;
                      return (
                        <tr key={r.key} className="border-b last:border-0">
                          <td className="py-2">{r.label}</td>
                          <td className="py-2 text-right text-muted-foreground">{fmt(r, was)}</td>
                          <td className="py-2 text-right font-semibold">{fmt(r, cur)}</td>
                          <td className={`py-2 text-right whitespace-nowrap ${
                            good === null ? "text-muted-foreground"
                              : good ? "text-success" : "text-destructive"}`}>
                            <span className="inline-flex items-center gap-1">
                              {flat ? <Minus className="w-3 h-3" />
                                : diff > 0 ? <ArrowUp className="w-3 h-3" />
                                : <ArrowDown className="w-3 h-3" />}
                              {flat ? "same"
                                : pct === null ? fmt(r, Math.abs(diff))
                                : `${Math.abs(pct).toFixed(1)}%`}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card> : null}

        <Card className="border-none shadow-sm">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Stock aur audit context</CardTitle></CardHeader>
          <CardContent className="grid sm:grid-cols-3 gap-3 text-sm">
            <div className="rounded-lg bg-muted/50 p-3"><p className="text-xs text-muted-foreground">Closing stock</p><p className="font-bold mt-1">{money(Number(a.closing_stock || 0))}</p></div>
            <div className="rounded-lg bg-muted/50 p-3"><p className="text-xs text-muted-foreground">Opening stock brought in</p><p className="font-bold mt-1">{money(Number(a.opening_stock_in || 0))}</p><p className="text-[10px] text-muted-foreground">Purchase nahi hai</p></div>
            <div className="rounded-lg bg-muted/50 p-3"><p className="text-xs text-muted-foreground">Manual count / re-price</p><p className="font-bold mt-1">{money(Number(a.adjustments || 0))}</p><p className="text-[10px] text-muted-foreground">Expense nahi, audit movement hai</p></div>
          </CardContent>
        </Card>

        {hasPrevious ? <p className="text-xs text-muted-foreground">Green ka matlab better direction hai—kam cost ya zyada plates. Wastage ka rupee estimate recipe aur finished-food yield ke bina nahi dikhaya jata.</p> : null}
      </div>
    </AppLayout>
  );
}
