import AppLayout from "@/components/AppLayout";
import { useState } from "react";
import { useAppContext } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { useDailyOperatingSnapshot, useManagerDashboard, useStoreKeeperDashboard, useTodayIssueDetails, MEAL_PERIODS } from "@/hooks/useSrsData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle, CalendarDays, CheckCircle2, ClipboardList, Clock3, IndianRupee, Package,
  ChevronDown, PackageMinus, RotateCcw, ShoppingCart, Target, Users,
} from "lucide-react";
import SeniorRoleDashboard from "@/components/SeniorRoleDashboard";

// The home screen each role actually needs first thing in the morning.
// Manager and store keeper see different things, so the same page renders
// whichever set applies — one screen, one query, no empty tiles.

const money = (v: any) => `₹${Math.round(Number(v) || 0).toLocaleString()}`;
const qty = (v: any) => Number(Number(v || 0).toFixed(3)).toLocaleString("en-IN", { maximumFractionDigits: 3 });

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function Tile({ label, value, sub, icon: Icon, tone }: {
  label: string; value: string | number; sub?: string; icon: any; tone?: "warn" | "bad" | "good";
}) {
  const toneCls = tone === "bad" ? "text-destructive"
    : tone === "warn" ? "text-warning"
    : tone === "good" ? "text-success" : "";
  return (
    <Card className="border-none shadow-sm">
      <CardContent className="p-4 flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4 text-accent" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className={`text-xl font-bold ${toneCls}`}>{value}</p>
          {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { selectedCanteen } = useAppContext();
  const { canIssueStock, isManagerOrAbove, roleData } = useAuth();
  const navigate = useNavigate();
  const [date, setDate] = useState(todayIso());
  const [openIssueMeal, setOpenIssueMeal] = useState<string | null>(null);
  const isToday = date === todayIso();
  const dayLabel = isToday ? "Aaj" : date.split("-").reverse().join("/");

  const isStoreKeeper = String(roleData?.role).toLowerCase() === "store_keeper";
  const role = String(roleData?.role).toLowerCase();
  const isSeniorRole = ["ops_manager", "admin", "super_admin", "owner"].includes(role);
  const { data: mgr, error: mgrErr } = useManagerDashboard(
    !isStoreKeeper ? selectedCanteen : undefined, date);
  const { data: sk, error: skErr } = useStoreKeeperDashboard(
    isStoreKeeper ? selectedCanteen : undefined, date);
  const { data: todayIssue = [], error: todayIssueErr } = useTodayIssueDetails(
    isStoreKeeper ? selectedCanteen : undefined, date);
  const { data: moneySnapshot } = useDailyOperatingSnapshot(
    isStoreKeeper ? selectedCanteen : undefined, date);

  const issueMeals: any[] = MEAL_PERIODS
    .map((meal) => ({ ...meal, lines: todayIssue.filter((x: any) => x.meal_period === meal.value) }))
    .filter((meal) => meal.lines.length > 0);
  const extraLines = todayIssue.filter((x: any) =>
    !MEAL_PERIODS.some((meal) => meal.value === x.meal_period));
  if (extraLines.length) issueMeals.push({ value: "extra", label: "Extra saman", lines: extraLines });

  if (isSeniorRole) {
    return <AppLayout title="Dashboard"><SeniorRoleDashboard role={role} /></AppLayout>;
  }

  if (selectedCanteen === "all") {
    return (
      <AppLayout title="Dashboard">
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          Select a site to see its day.
        </CardContent></Card>
      </AppLayout>
    );
  }

  if (mgrErr && skErr) {
    return (
      <AppLayout title="Dashboard">
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          The dashboard needs its database migration applied.
        </CardContent></Card>
      </AppLayout>
    );
  }

  const budgetTone = mgr?.budget_used_pct == null ? undefined
    : Number(mgr.budget_used_pct) >= 100 ? "bad"
    : Number(mgr.budget_used_pct) >= 80 ? "warn" : "good";

  return (
    <AppLayout title="Dashboard">
      <div className="space-y-4 animate-fade-in">
        {/* ---------------- Store keeper ---------------- */}
        {isStoreKeeper && sk && (
          <>
            <Card className="border-none shadow-sm">
              <CardContent className="p-3 sm:p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <div className="w-full space-y-1.5 sm:w-64">
                    <Label className="text-xs">Kis date ka Store dashboard dekhna hai?</Label>
                    <Input type="date" className="h-12 w-full text-base" value={date}
                      onChange={(e) => { setDate(e.target.value); setOpenIssueMeal(null); }} />
                  </div>
                  {!isToday && (
                    <Button variant="outline" className="h-12" onClick={() => { setDate(todayIso()); setOpenIssueMeal(null); }}>
                      Aaj par aao
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
              <Tile label="Pending requests" value={sk.pending_requests ?? 0}
                sub="approved, waiting to be issued" icon={ClipboardList}
                tone={Number(sk.pending_requests) > 0 ? "warn" : undefined} />
              <Tile label={`${dayLabel} ka purchase`} value={money(sk.todays_purchase)}
                sub={`${sk.todays_bills ?? 0} bills`} icon={ShoppingCart} />
              <Tile label={`${dayLabel} ka issue`} value={money(sk.todays_issue_value)}
                sub="kitchen use (accepted return minus)" icon={PackageMinus} />
              <Tile label="Low stock" value={sk.low_stock_count ?? (sk.low_stock || []).length}
                sub="at or below reorder level" icon={AlertTriangle}
                tone={Number(sk.low_stock_count ?? 0) > 0 ? "bad" : "good"} />
            </div>

            <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
              <Tile label={`${dayLabel} ka consumption`} value={money(moneySnapshot?.consumption)}
                sub="FIFO issue − accepted kitchen return" icon={PackageMinus} />
              <Tile label={`${dayLabel} ka revenue`} value={money(moneySnapshot?.revenue)}
                sub={moneySnapshot?.provisional ? "Punch pending — provisional count par" : "Eicher punch final par"}
                icon={IndianRupee} />
              <Tile label="Food cost" value={`${Number(moneySnapshot?.food_cost_pct || 0).toFixed(1)}%`}
                sub="consumption ÷ revenue" icon={Target}
                tone={Number(moneySnapshot?.food_cost_pct || 0) > 50 ? "bad" : "good"} />
            </div>

            {Number(sk.unpaid_purchases) > 0 && (
              <Card className="border-none shadow-sm bg-warning/5">
                <CardContent className="p-4 flex items-center justify-between">
                  <span className="text-sm">Purchases still unpaid</span>
                  <span className="text-lg font-bold text-warning">{money(sk.unpaid_purchases)}</span>
                </CardContent>
              </Card>
            )}

            <Card className="border-none shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <PackageMinus className="w-5 h-5 text-accent" /> {dayLabel} ka pura issue
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Mila store se diya hua saman hai. Wapas Store Keeper accept karega tabhi Use hua aur consumption kam hoga.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                {todayIssueErr ? (
                  <p className="text-sm text-destructive text-center py-5">Aaj ka issue load nahi hua. Dobara refresh karein.</p>
                ) : issueMeals.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-5">{dayLabel} ke liye approved saman nahi hai.</p>
                ) : issueMeals.map((meal: any) => {
                  const mealOpen = openIssueMeal === meal.value;
                  return (
                  <section key={meal.value} className="rounded-xl border overflow-hidden">
                    <button type="button" className="flex min-h-16 w-full items-center gap-3 bg-muted/50 px-3 py-2.5 text-left hover:bg-muted"
                      onClick={() => setOpenIssueMeal(mealOpen ? null : meal.value)}>
                      <div className="min-w-0 flex-1">
                        <h3 className="font-semibold text-sm">{meal.label}</h3>
                        <span className="text-xs text-muted-foreground">
                          {meal.lines.filter((x: any) => x.line_status === "complete").length}/{meal.lines.length} complete · {meal.lines.length} items
                        </span>
                      </div>
                      <ChevronDown className={`h-5 w-5 shrink-0 transition-transform ${mealOpen ? "rotate-180" : ""}`} />
                    </button>
                    {mealOpen && <div className="divide-y border-t">
                      {meal.lines.map((line: any) => {
                        const complete = line.line_status === "complete";
                        const partial = line.line_status === "partial";
                        return (
                          <div key={line.item_id} className={`p-3 ${complete ? "bg-success/5" : partial ? "bg-warning/5" : "bg-destructive/5"}`}>
                            <div className="flex items-center justify-between gap-2 mb-2">
                              <div className="min-w-0">
                                <p className="font-semibold text-sm truncate">{line.item_name}</p>
                                <p className="text-[11px] text-muted-foreground">REQ-{line.req_no}</p>
                              </div>
                              <Badge variant="outline" className={complete
                                ? "border-success/40 text-success bg-success/10"
                                : partial ? "border-warning/40 text-warning bg-warning/10"
                                : "border-destructive/40 text-destructive bg-destructive/10"}>
                                {complete ? <CheckCircle2 className="w-3 h-3 mr-1" /> : <Clock3 className="w-3 h-3 mr-1" />}
                                {complete ? "Diya" : partial ? "Thoda baaki" : "Dena baaki"}
                              </Badge>
                            </div>
                            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 text-center">
                              <IssueNumber label="Manga" value={line.approved_qty} unit={line.unit} />
                              <IssueNumber label="Mila" value={line.issued_qty} unit={line.unit} tone="good" />
                              <IssueNumber label="Wapas" value={line.returned_qty} unit={line.unit} tone={Number(line.returned_qty) > 0 ? "return" : undefined} />
                              <IssueNumber label="Use hua" value={line.used_qty} unit={line.unit} tone="used" />
                              <IssueNumber label="Baaki" value={line.pending_qty} unit={line.unit} tone={Number(line.pending_qty) > 0 ? "warn" : undefined} />
                            </div>
                          </div>
                        );
                      })}
                    </div>}
                  </section>
                  );
                })}
              </CardContent>
            </Card>

            {(sk.low_stock || []).length > 0 && (
              <Card className="border-none shadow-sm">
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm">Reorder these — showing {(sk.low_stock || []).length} of {sk.low_stock_count ?? 0}</CardTitle>
                  <Button variant="outline" size="sm" className="text-xs"
                    onClick={() => navigate("/inventory")}>Open inventory</Button>
                </CardHeader>
                <CardContent className="p-0 max-h-64 overflow-y-auto">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead className="text-xs">Item</TableHead>
                      <TableHead className="text-xs text-right">In stock</TableHead>
                      <TableHead className="text-xs text-right">Reorder at</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {(sk.low_stock || []).map((l: any) => (
                        <TableRow key={l.name} className="bg-destructive/5">
                          <TableCell className="text-sm font-medium">{l.name}</TableCell>
                          <TableCell className="text-sm text-right text-destructive font-semibold">
                            {Number(l.stock)} {l.unit}
                          </TableCell>
                          <TableCell className="text-sm text-right">{Number(l.reorder)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* ---------------- Manager ---------------- */}
        {!isStoreKeeper && mgr && (
          <>
            <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
              <Tile label="Today's purchase" value={money(mgr.todays_purchase)} icon={ShoppingCart} />
              <Tile label="Today's consumption" value={money(mgr.todays_consumption)}
                sub={mgr.cost_per_head != null ? `${money(mgr.cost_per_head)} per head` : undefined}
                icon={IndianRupee} />
              <Tile label="Inventory value" value={money(mgr.inventory_value)} icon={Package} />
              <Tile label="Stock status" value={mgr.low_stock_items ?? 0}
                sub="items below reorder" icon={AlertTriangle}
                tone={Number(mgr.low_stock_items) > 0 ? "warn" : "good"} />
              <Tile label="Budget balance"
                value={mgr.budget_balance != null ? money(mgr.budget_balance) : "—"}
                sub={mgr.budget_used_pct != null ? `${mgr.budget_used_pct}% used this month` : "no budget set"}
                icon={Target} tone={budgetTone} />
            </div>

            {Number(mgr.pending_requisitions) > 0 && (
              <Card className="border-none shadow-sm bg-warning/5">
                <CardContent className="p-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <ClipboardList className="w-4 h-4 text-warning" />
                    <span className="text-sm font-medium">
                      {mgr.pending_requisitions} requisition{Number(mgr.pending_requisitions) > 1 ? "s" : ""} waiting for your approval
                    </span>
                  </div>
                  <Button size="sm" onClick={() => navigate("/requisitions")}>Review now</Button>
                </CardContent>
              </Card>
            )}

            <Card className="border-none shadow-sm">
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <CalendarDays className="w-4 h-4" /> Today's menu
                  {Number(mgr.headcount) > 0 && (
                    <span className="text-xs font-normal text-muted-foreground flex items-center gap-1">
                      <Users className="w-3 h-3" /> {mgr.headcount} expected
                    </span>
                  )}
                </CardTitle>
                <Button variant="outline" size="sm" className="text-xs"
                  onClick={() => navigate("/menu-scan")}>Upload menu</Button>
              </CardHeader>
              <CardContent>
                {(mgr.todays_menu || []).length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">
                    No menu published for today yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {(mgr.todays_menu || []).map((m: any) => (
                      <div key={m.meal_period} className="flex items-start gap-3 border-b last:border-0 pb-2">
                        <span className="w-32 text-sm font-medium shrink-0">
                          {MEAL_PERIODS.find((x) => x.value === m.meal_period)?.label || m.meal_period}
                        </span>
                        <span className="flex-1 text-sm text-muted-foreground">
                          {(m.dishes || []).join(", ") || "—"}
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs text-muted-foreground">{m.headcount} pax</span>
                          <Badge variant="outline" className="text-[10px] uppercase">{m.status}</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppLayout>
  );
}

function IssueNumber({ label, value, unit, tone }: {
  label: string; value: any; unit: string; tone?: "good" | "warn" | "return" | "used";
}) {
  const color = tone === "good" ? "text-success" : tone === "warn" ? "text-warning"
    : tone === "return" ? "text-blue-600" : tone === "used" ? "text-primary" : "";
  return (
    <div className="rounded-lg bg-background/80 border px-1.5 py-2 min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex justify-center items-center gap-1">
        {tone === "return" && <RotateCcw className="w-3 h-3" />}{label}
      </p>
      <p className={`text-sm font-bold truncate ${color}`}>{qty(value)} <span className="text-[10px] font-medium">{unit}</span></p>
    </div>
  );
}
