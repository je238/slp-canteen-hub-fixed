import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle, ArrowRight, Building2, CalendarDays, CheckCircle2, ClipboardList,
  Clock3, IndianRupee, Package, PackageCheck, ReceiptText, RotateCcw, Scale,
  ShieldAlert, ShoppingCart, Users,
} from "lucide-react";
import { useExecutiveSiteDashboard } from "@/hooks/useSrsData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { clampToCutover, REPORTING_CUTOVER_DATE } from "@/lib/cutover";

const money = (value: any) => `₹${Math.round(Number(value) || 0).toLocaleString("en-IN")}`;
const num = (value: any, digits = 1) => Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: digits });

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function Metric({ label, value, sub, icon: Icon, to, danger }: {
  label: string; value: string | number; sub?: string; icon: any; to: string; danger?: boolean;
}) {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(to)} className="text-left min-w-0">
    <Card className="border-none shadow-sm h-full transition hover:ring-1 hover:ring-accent/40">
      <CardContent className="p-3.5 flex gap-3 items-start">
        <span className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${danger ? "bg-destructive/10" : "bg-accent/10"}`}>
          <Icon className={`w-4 h-4 ${danger ? "text-destructive" : "text-accent"}`} />
        </span>
        <span className="min-w-0 block">
          <span className="text-xs text-muted-foreground block">{label}</span>
          <span className={`text-lg sm:text-xl font-bold truncate block ${danger ? "text-destructive" : ""}`}>{value}</span>
          {sub ? <span className="text-[10px] text-muted-foreground leading-snug block">{sub}</span> : null}
        </span>
      </CardContent>
    </Card>
  </button>;
}

type AlertItem = { key: string; site: string; label: string; value: string; to: string; severity: "red" | "amber" };

function alertsFor(rows: any[], gm: boolean): AlertItem[] {
  const out: AlertItem[] = [];
  const add = (row: any, key: string, label: string, value: any, to: string, severity: "red" | "amber" = "red") => {
    if (Number(value) <= 0) return;
    out.push({ key: `${row.canteen_id}-${key}`, site: row.site_name, label, value: String(value), to, severity });
  };
  for (const row of rows) {
    if (gm && Number(row.menu_published) < 5) out.push({ key: `${row.canteen_id}-menu`, site: row.site_name, label: "Aaj ke menu publish nahi hue", value: `${row.menu_published}/5`, to: "/menu-planning", severity: "red" });
    add(row, "approval", "Chef order approval pending", row.approvals_pending, "/requisitions", "amber");
    add(row, "issue", "Kitchen issue incomplete", row.issues_pending, "/requisitions");
    add(row, "pending", "Items abhi dena baaki", row.pending_item_count, "/requisitions");
    add(row, "critical", "Critical stock items", row.critical_stock_count, "/inventory");
    add(row, "return", "Kitchen return accept hona baaki", row.returns_pending, "/requisitions", "amber");
    add(row, "ledger", "Physical shelf aur ledger mismatch", row.ledger_mismatch_count, "/stock-audit");
    add(row, "invoice", "Invoice total aur lines mismatch", row.invoice_mismatch_count, "/purchases");
    add(row, "scan", "7 din me invoice scan failures", row.scan_failures, "/executive-alerts", "amber");
    add(row, "nobill", "Saman aaya, bill pending", row.no_bill_count, "/purchases", "amber");
    if (!gm && Number(row.food_cost_pct) > 45) out.push({ key: `${row.canteen_id}-fc`, site: row.site_name, label: "Food cost unusually high", value: `${row.food_cost_pct}%`, to: "/reports-center", severity: "red" });
    if (!gm && Number(row.unpaid_amount) > 0) out.push({ key: `${row.canteen_id}-unpaid`, site: row.site_name, label: "Vendor bills unpaid", value: money(row.unpaid_amount), to: "/purchases", severity: "amber" });
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "red" ? -1 : 1));
}

export default function ExecutiveControlDashboard({ role, selectedCanteen }: { role: string; selectedCanteen: string }) {
  const gm = role === "ops_manager";
  const [date, setDate] = useState(todayIso());
  const { data: rows = [], isLoading, error } = useExecutiveSiteDashboard(date);
  const navigate = useNavigate();
  const visibleRows = useMemo(() => selectedCanteen === "all"
    ? rows
    : rows.filter((row: any) => row.canteen_id === selectedCanteen), [rows, selectedCanteen]);

  const totals = useMemo(() => visibleRows.reduce((a: any, row: any) => {
    for (const key of ["sale","consumption","expected_headcount","plates_served","wastage_qty","wastage_value_estimate",
      "purchase_amount","unpaid_amount","inventory_value","menu_total","menu_published","orders_total","approvals_pending",
      "issues_pending","pending_item_count","returned_qty","returns_pending","open_alerts","ledger_mismatch_count",
      "invoice_mismatch_count","scan_failures","low_stock_count","critical_stock_count","no_bill_count"]) {
      a[key] = Number(a[key] || 0) + Number(row[key] || 0);
    }
    return a;
  }, {}), [visibleRows]);
  const foodCost = totals.sale > 0 ? totals.consumption * 100 / totals.sale : null;
  const costPerPlate = totals.plates_served > 0 ? totals.consumption / totals.plates_served : null;
  const alerts = useMemo(() => alertsFor(visibleRows, gm), [visibleRows, gm]);
  const activeSites = visibleRows.filter((r: any) => Number(r.menu_total) > 0 || Number(r.orders_total) > 0 || Number(r.purchase_amount) > 0).length;

  if (isLoading) return <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Control dashboard load ho raha hai…</CardContent></Card>;
  if (error) return <Card><CardContent className="p-8 text-center text-sm text-destructive">Executive dashboard load nahi hua. Database migration/access check karein.</CardContent></Card>;

  return <div className="space-y-4 animate-fade-in">
    <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
      <div><h2 className="font-semibold">{gm ? "GM daily operations" : "Owner business control"}</h2><p className="text-xs text-muted-foreground">{gm ? "Assigned sites me aaj kya complete hai aur kya atka hai" : "Aaj ka paisa, performance aur exceptions — daily entry ke bina"}</p></div>
      <div className="flex gap-2 items-center"><Input type="date" min={REPORTING_CUTOVER_DATE} value={date} onChange={(e) => setDate(clampToCutover(e.target.value))} className="w-40" />{date !== todayIso() ? <Button size="sm" variant="outline" onClick={() => setDate(todayIso())}>Today</Button> : null}</div>
    </div>

    {gm ? <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
      <Metric label="Operational sites" value={`${activeSites}/${visibleRows.length}`} sub="aaj activity wali units" icon={Building2} to="/site-performance" danger={activeSites < visibleRows.length} />
      <Metric label="Menu published" value={`${totals.menu_published || 0}/${Math.max(visibleRows.length * 5, Number(totals.menu_total || 0))}`} icon={CalendarDays} to="/menu-planning" danger={Number(totals.menu_published || 0) < visibleRows.length * 5} />
      <Metric label="Approval / issue pending" value={`${totals.approvals_pending} / ${totals.issues_pending}`} icon={ClipboardList} to="/requisitions" danger={totals.approvals_pending + totals.issues_pending > 0} />
      <Metric label="Items dena baaki" value={totals.pending_item_count || 0} icon={Package} to="/requisitions" danger={totals.pending_item_count > 0} />
      <Metric label="Critical stock" value={totals.critical_stock_count || 0} sub={`${totals.low_stock_count || 0} low stock`} icon={AlertTriangle} to="/inventory" danger={totals.critical_stock_count > 0} />
      <Metric label="Aaj purchase" value={money(totals.purchase_amount)} sub={`${totals.no_bill_count || 0} bills pending · read-only report`} icon={ShoppingCart} to="/reports-center" danger={totals.no_bill_count > 0} />
      <Metric label="Plates / expected" value={`${num(totals.plates_served,0)} / ${num(totals.expected_headcount,0)}`} icon={Users} to="/reports-center" danger={totals.plates_served < totals.expected_headcount && date <= todayIso()} />
      <Metric label="Wastage" value={`${num(totals.wastage_qty)} kg`} icon={Scale} to="/reports-center" danger={totals.wastage_qty > 0} />
      <Metric label="Unused returned" value={`${num(totals.returned_qty)} qty`} sub={`${totals.returns_pending || 0} acceptance pending`} icon={RotateCcw} to="/requisitions" danger={totals.returns_pending > 0} />
      <Metric label="Open alerts" value={alerts.length} icon={ShieldAlert} to="/executive-alerts" danger={alerts.length > 0} />
    </div> : <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
      <Metric label="Aaj ki sale" value={money(totals.sale)} sub={`${num(totals.plates_served,0)} actual plates`} icon={IndianRupee} to="/reports-center" />
      <Metric label="Consumption cost" value={money(totals.consumption)} sub="returns minus, FIFO value" icon={PackageCheck} to="/reports-center" />
      <Metric label="Food cost %" value={foodCost == null ? "—" : `${foodCost.toFixed(1)}%`} sub="consumption ÷ sale" icon={IndianRupee} to="/site-performance" danger={foodCost != null && foodCost > 45} />
      <Metric label="Plates served" value={num(totals.plates_served,0)} sub={`${num(totals.expected_headcount,0)} expected`} icon={Users} to="/reports-center" />
      <Metric label="Cost per plate" value={costPerPlate == null ? "—" : money(costPerPlate)} icon={ReceiptText} to="/reports-center" />
      <Metric label="Wastage" value={`${num(totals.wastage_qty)} kg`} sub="Weight recorded · cost needs recipe/yield" icon={Scale} to="/reports-center" danger={totals.wastage_qty > 0} />
      <Metric label="Aaj purchases" value={money(totals.purchase_amount)} icon={ShoppingCart} to="/purchases" />
      <Metric label="Stock value" value={money(totals.inventory_value)} sub="FIFO lots + unlotted stock" icon={Package} to="/inventory" />
      <Metric label="Unpaid vendor bills" value={money(totals.unpaid_amount)} sub={`${totals.no_bill_count || 0} goods receipts need bill`} icon={ReceiptText} to="/purchases" danger={totals.unpaid_amount > 0} />
      <Metric label="Pending / corrections" value={alerts.length} sub="click for exception list" icon={ShieldAlert} to="/executive-alerts" danger={alerts.length > 0} />
    </div>}

    <Card className="border-none shadow-sm">
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2"><div><CardTitle className="text-sm">Important alerts only</CardTitle><p className="text-[11px] text-muted-foreground">Old/new value, reason, person aur time Audit & Changes me safe hai.</p></div><Button size="sm" variant="outline" onClick={() => navigate("/executive-alerts")}>All alerts <ArrowRight className="w-3.5 h-3.5 ml-1" /></Button></CardHeader>
      <CardContent className="grid sm:grid-cols-2 gap-2">
        {alerts.length === 0 ? <div className="sm:col-span-2 py-5 text-sm text-success text-center flex justify-center items-center gap-2"><CheckCircle2 className="w-4 h-4" /> Koi important exception nahi hai.</div>
          : alerts.slice(0,8).map((alert) => <button key={alert.key} onClick={() => navigate(alert.to)} className={`rounded-lg border p-3 text-left flex justify-between gap-3 hover:bg-muted/50 ${alert.severity === "red" ? "border-destructive/30 bg-destructive/5" : "border-warning/30 bg-warning/5"}`}><span className="min-w-0"><span className="text-xs text-muted-foreground block truncate">{alert.site}</span><span className="text-sm font-medium block">{alert.label}</span></span><span className={alert.severity === "red" ? "font-bold text-destructive" : "font-bold text-warning"}>{alert.value}</span></button>)}
      </CardContent>
    </Card>

    <SiteControlTable rows={visibleRows} gm={gm} />
    {gm ? <Timeline rows={visibleRows} /> : null}

    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => navigate("/site-performance")}>Site comparison</Button>
      <Button variant="outline" onClick={() => navigate("/reports-center")}>Consumption & wastage reports</Button>
      <Button variant="outline" onClick={() => navigate("/audit-log")}>Audit & reasons</Button>
      {gm ? <Button onClick={() => navigate("/requisitions")}>All assigned-site orders</Button> : null}
    </div>
  </div>;
}

function SiteControlTable({ rows, gm }: { rows: any[]; gm: boolean }) {
  return <Card className="border-none shadow-sm">
    <CardHeader className="pb-2 flex flex-row justify-between items-center"><CardTitle className="text-sm">{gm ? "Site red / amber / green" : "Site comparison & risk"}</CardTitle><Badge variant="outline">{rows.length} accessible sites</Badge></CardHeader>
    <CardContent className="p-0 divide-y">
      {rows.length === 0 ? <p className="p-6 text-center text-sm text-muted-foreground">Is role ko koi site assigned nahi hai.</p> : rows.map((row) => <div key={row.canteen_id} className="p-3 sm:p-4 flex flex-col xl:flex-row xl:items-center gap-3">
        <div className="xl:w-64 min-w-0 flex items-center gap-2"><span className={`w-3 h-3 rounded-full shrink-0 ${row.rag_status === "green" ? "bg-success" : row.rag_status === "amber" ? "bg-warning" : "bg-destructive"}`} /><div className="min-w-0"><p className="font-semibold truncate">{row.site_name}</p><p className="text-[11px] text-muted-foreground">Operations score {row.operational_score}/100</p></div></div>
        <div className={`grid ${gm ? "grid-cols-4 sm:grid-cols-7" : "grid-cols-4 sm:grid-cols-8"} gap-1.5 flex-1`}>
          {gm ? <>
            <Mini label="Menu" value={`${row.menu_published}/5`} bad={Number(row.menu_published)<5} />
            <Mini label="Approval" value={row.approvals_pending} bad={Number(row.approvals_pending)>0} />
            <Mini label="Issue" value={row.issues_pending} bad={Number(row.issues_pending)>0} />
            <Mini label="Pending" value={row.pending_item_count} bad={Number(row.pending_item_count)>0} />
            <Mini label="Plates" value={`${row.plates_served}/${row.expected_headcount}`} bad={Number(row.plates_served)<Number(row.expected_headcount)} />
            <Mini label="Wastage" value={`${num(row.wastage_qty)}kg`} bad={Number(row.wastage_qty)>0} />
            <Mini label="Critical" value={row.critical_stock_count} bad={Number(row.critical_stock_count)>0} />
          </> : <>
            <Mini label="Sale" value={money(row.sale)} />
            <Mini label="Consume" value={money(row.consumption)} />
            <Mini label="FC %" value={row.food_cost_pct == null ? "—" : `${row.food_cost_pct}%`} bad={Number(row.food_cost_pct)>45} />
            <Mini label="₹/plate" value={row.cost_per_plate == null ? "—" : money(row.cost_per_plate)} />
            <Mini label="Plates" value={row.plates_served} />
            <Mini label="Waste" value={`${num(row.wastage_qty)}kg`} bad={Number(row.wastage_qty)>0} />
            <Mini label="Purchase" value={money(row.purchase_amount)} />
            <Mini label="Stock" value={money(row.inventory_value)} />
          </>}
        </div>
      </div>)}
    </CardContent>
  </Card>;
}

function Timeline({ rows }: { rows: any[] }) {
  const steps = [
    ["Menu", "menu_published_last"], ["Chef order", "order_submitted_last"], ["Approved", "approved_last"],
    ["Issue start", "issue_started"], ["Issue complete", "issue_completed"], ["Meal / plates", "plates_entered"],
    ["Wastage", "wastage_recorded"], ["Return", "unused_returned"],
  ];
  const time = (value: any) => value ? new Date(value).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "Pending";
  return <Card className="border-none shadow-sm"><CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Clock3 className="w-4 h-4" /> Daily operations timeline</CardTitle></CardHeader><CardContent className="space-y-3">
    {rows.map((row) => <div key={row.canteen_id} className="rounded-xl border p-3"><p className="font-semibold text-sm mb-2">{row.site_name}</p><div className="grid grid-cols-4 lg:grid-cols-8 gap-1.5">{steps.map(([label,key]) => { const done=!!row.timeline?.[key]; return <div key={key} className={`rounded-lg px-1.5 py-2 text-center ${done ? "bg-success/10" : "bg-warning/10"}`}><p className="text-[9px] text-muted-foreground">{label}</p><p className={`text-[11px] font-semibold ${done ? "text-success" : "text-warning"}`}>{time(row.timeline?.[key])}</p></div>; })}</div></div>)}
  </CardContent></Card>;
}

function Mini({ label, value, bad }: { label: string; value: any; bad?: boolean }) {
  return <div className="rounded-lg bg-muted/50 px-1.5 py-2 text-center min-w-0"><p className="text-[9px] text-muted-foreground truncate">{label}</p><p className={`text-[11px] sm:text-xs font-bold truncate ${bad ? "text-destructive" : ""}`}>{value}</p></div>;
}
