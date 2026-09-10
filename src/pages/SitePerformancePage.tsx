import { useMemo, useState } from "react";
import { AlertTriangle, Building2, CalendarDays, IndianRupee, Package, TrendingDown, TrendingUp, Users } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import AppLayout from "@/components/AppLayout";
import { useSitePerformance } from "@/hooks/useSrsData";
import { REPORTING_CUTOVER_DATE, clampToCutover } from "@/lib/cutover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n + 1); return iso(d); };
const money = (n: any) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
const pctChange = (now: any, before: any) => Number(before) ? ((Number(now) - Number(before)) * 100) / Number(before) : null;
function previousRange(from: string, to: string) {
  const a = new Date(`${from}T00:00:00`), b = new Date(`${to}T00:00:00`);
  const days = Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000) + 1);
  const end = new Date(a); end.setDate(end.getDate() - 1);
  const start = new Date(end); start.setDate(start.getDate() - days + 1);
  return { from: iso(start), to: iso(end), available: iso(end) >= REPORTING_CUTOVER_DATE };
}
function status(row: any) {
  const food = Number(row.food_cost_pct);
  const alerts = Number(row.open_alerts);
  if (alerts > 0 || food > 50) return { label: "Action needed", tone: "destructive" as const, rank: 2 };
  if (food > 40) return { label: "Watch", tone: "secondary" as const, rank: 1 };
  return { label: "On track", tone: "outline" as const, rank: 0 };
}
function Delta({ value, lowerIsBetter = false }: { value: number | null; lowerIsBetter?: boolean }) {
  if (value == null) return <span className="text-xs text-muted-foreground">No earlier base</span>;
  const good = lowerIsBetter ? value <= 0 : value >= 0;
  const Icon = value >= 0 ? TrendingUp : TrendingDown;
  return <span className={`inline-flex items-center gap-1 text-xs ${good ? "text-success" : "text-destructive"}`}><Icon className="h-3.5 w-3.5" />{Math.abs(value).toFixed(1)}%</span>;
}

export default function SitePerformancePage() {
  const [from, setFrom] = useState(clampToCutover(daysAgo(30)));
  const [to, setTo] = useState(iso(new Date()));
  const current = useSitePerformance(from, to);
  const prior = previousRange(from, to);
  const previous = useSitePerformance(prior.available ? prior.from : undefined, prior.available ? prior.to : undefined);
  const priorById = new Map((previous.data || []).map((x: any) => [x.canteen_id, x]));
  const rows = useMemo(() => [...(current.data || [])].sort((a: any, b: any) => status(b).rank - status(a).rank || Number(b.revenue) - Number(a.revenue)), [current.data]);
  const totals = rows.reduce((a: any, x: any) => ({
    headcount: a.headcount + Number(x.headcount || 0), revenue: a.revenue + Number(x.revenue || 0),
    consumption: a.consumption + Number(x.consumption || 0), purchase: a.purchase + Number(x.purchase || 0),
    inventory: a.inventory + Number(x.inventory_value || 0), alerts: a.alerts + Number(x.open_alerts || 0),
  }), { headcount: 0, revenue: 0, consumption: 0, purchase: 0, inventory: 0, alerts: 0 });
  const foodCost = totals.revenue > 0 ? totals.consumption * 100 / totals.revenue : null;
  const margin = totals.revenue - totals.consumption;
  const needsAction = rows.filter((x: any) => status(x).rank > 0);

  return <AppLayout title="Site Performance">
    <div className="space-y-4 animate-fade-in">
      <Card className="border-none shadow-sm"><CardContent className="p-4 sm:p-5 space-y-4">
        <div><h2 className="text-lg font-bold">Site health at one glance</h2><p className="text-sm text-muted-foreground">Final plate count, FIFO consumption aur net kitchen returns par based.</p></div>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <div><Label>From</Label><Input type="date" min={REPORTING_CUTOVER_DATE} max={to} value={from} onChange={(e) => setFrom(clampToCutover(e.target.value))} /></div>
          <div><Label>To</Label><Input type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="flex items-end gap-1.5">{[7, 30, 90].map((n) => <Button key={n} size="sm" variant="outline" onClick={() => { setFrom(clampToCutover(daysAgo(n))); setTo(iso(new Date())); }}>{n}d</Button>)}</div>
        </div>
        <p className="text-xs text-muted-foreground"><CalendarDays className="mr-1 inline h-3.5 w-3.5" />Clean reports {REPORTING_CUTOVER_DATE} se. {prior.available ? `Trend ${prior.from} – ${prior.to} se compare hai.` : "Pehle period ka clean data abhi available nahi."}</p>
      </CardContent></Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Net sale", value: money(totals.revenue), sub: "final / clearly provisional plates", icon: IndianRupee },
          { label: "Food consumed", value: money(totals.consumption), sub: "issues minus accepted returns", icon: Package },
          { label: "Gross margin", value: money(margin), sub: "sale minus food consumed", icon: TrendingUp },
          { label: "Food cost", value: foodCost == null ? "—" : `${foodCost.toFixed(1)}%`, sub: `${totals.headcount.toLocaleString("en-IN")} plates`, icon: Users },
        ].map((x) => <Card key={x.label} className="border-none shadow-sm"><CardContent className="p-4"><x.icon className="mb-2 h-4 w-4 text-accent" /><p className="text-xs text-muted-foreground">{x.label}</p><p className="text-xl font-bold">{x.value}</p><p className="mt-1 text-[11px] text-muted-foreground">{x.sub}</p></CardContent></Card>)}
      </div>

      {needsAction.length > 0 && <Card className="border-destructive/30 bg-destructive/5 shadow-sm"><CardContent className="p-4 flex gap-3"><AlertTriangle className="h-5 w-5 shrink-0 text-destructive" /><div><p className="font-semibold">{needsAction.length} site par attention chahiye</p><p className="text-sm text-muted-foreground">{needsAction.map((x: any) => `${x.site_name}: ${x.open_alerts} alert, FC ${x.food_cost_pct ?? "—"}%`).join(" • ")}</p></div></CardContent></Card>}

      {current.isLoading ? <p className="py-10 text-center text-sm text-muted-foreground">Performance calculate ho rahi hai…</p>
        : current.error ? <Card><CardContent className="p-8 text-center text-sm text-destructive">{(current.error as Error).message}</CardContent></Card>
        : rows.length === 0 ? <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Aapke role ko koi site visible nahi.</CardContent></Card>
        : <>
          {rows.length > 1 && <Card className="border-none shadow-sm"><CardHeader><CardTitle className="text-base">Sale vs food consumption</CardTitle></CardHeader><CardContent><ResponsiveContainer width="100%" height={240}><BarChart data={rows.map((x: any) => ({ name: x.site_name, sale: Number(x.revenue), food: Number(x.consumption) }))}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" tick={{ fontSize: 11 }} /><YAxis tickFormatter={(v) => `₹${Math.round(v / 1000)}k`} tick={{ fontSize: 11 }} /><Tooltip formatter={(v: number) => money(v)} /><Bar dataKey="sale" name="Sale" fill="hsl(var(--accent))" radius={[4, 4, 0, 0]} /><Bar dataKey="food" name="Food cost" fill="hsl(var(--destructive))" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></CardContent></Card>}
          <div className="grid gap-3 xl:grid-cols-2">{rows.map((x: any) => {
            const old: any = priorById.get(x.canteen_id);
            const s = status(x);
            const siteMargin = Number(x.revenue) - Number(x.consumption);
            return <Card key={x.canteen_id} className="border-none shadow-sm"><CardContent className="p-4 sm:p-5 space-y-4">
              <div className="flex items-start justify-between gap-3"><div><p className="font-bold"><Building2 className="mr-2 inline h-4 w-4" />{x.site_name}</p><p className="text-xs text-muted-foreground">{Number(x.headcount).toLocaleString("en-IN")} plates • {x.open_alerts} open alerts</p></div><Badge variant={s.tone}>{s.label}</Badge></div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div><p className="text-xs text-muted-foreground">Sale</p><p className="font-semibold">{money(x.revenue)}</p><Delta value={pctChange(x.revenue, old?.revenue)} /></div>
                <div><p className="text-xs text-muted-foreground">Consumed</p><p className="font-semibold">{money(x.consumption)}</p><Delta value={pctChange(x.consumption, old?.consumption)} lowerIsBetter /></div>
                <div><p className="text-xs text-muted-foreground">Margin</p><p className={`font-semibold ${siteMargin < 0 ? "text-destructive" : "text-success"}`}>{money(siteMargin)}</p></div>
                <div><p className="text-xs text-muted-foreground">Food cost</p><p className={`font-semibold ${Number(x.food_cost_pct) > 50 ? "text-destructive" : ""}`}>{x.food_cost_pct == null ? "—" : `${x.food_cost_pct}%`}</p></div>
              </div>
              <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 p-3 text-center"><div><p className="text-[11px] text-muted-foreground">Purchases</p><p className="text-sm font-semibold">{money(x.purchase)}</p></div><div><p className="text-[11px] text-muted-foreground">Stock value</p><p className="text-sm font-semibold">{money(x.inventory_value)}</p></div><div><p className="text-[11px] text-muted-foreground">Cost / plate</p><p className="text-sm font-semibold">{money(x.cost_per_person)}</p></div></div>
            </CardContent></Card>;
          })}</div>
        </>}
    </div>
  </AppLayout>;
}

