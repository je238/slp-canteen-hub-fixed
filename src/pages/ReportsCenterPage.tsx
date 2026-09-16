import { Fragment, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import {
  usePurchaseReport, useConsumptionReport, useOperationsSummary, useStockAgeing,
  useStockInOutReport, usePeriodSummary,
  useWastageLog, useOwnerMenuProfitBreakdown, useMenuPlans,
  useDailyItemUsageRateTrend, useItemPurchaseRateHistory, useVegetablePurchaseReport,
} from "@/hooks/useSrsData";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { useIngredients } from "@/hooks/useSupabaseData";
import { useIngredientRates } from "@/hooks/useSrsData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChevronDown, Download, Image as ImageIcon, Search, Share2 } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { clampToCutover, REPORTING_CUTOVER_DATE } from "@/lib/cutover";
import { fmtDayDate } from "@/lib/date";
import { toast } from "sonner";

// The SRS report suite in one place: purchase, inventory, consumption,
// financial and operations. Every figure comes from a Postgres aggregate,
// so these stay correct as the ledger grows.

function daysAgoIso(n: number) {
  const d = new Date(Date.now() - n * 86400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const money = (v: any) => `₹${Math.round(Number(v) || 0).toLocaleString()}`;
const num = (v: any) => Number(Number(v || 0).toFixed(3));
const purchaseTime = (v: any) => v ? new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
}).format(new Date(v)) : "—";

function exportCsv(name: string, rows: (string | number)[][]) {
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const blob = new Blob(["﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n")],
    { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

const CLASS_STYLE: Record<string, string> = {
  dead: "bg-destructive/10 text-destructive border-destructive/20",
  slow: "bg-warning/10 text-warning border-warning/20",
  fast: "bg-accent/10 text-accent border-accent/20",
  empty: "bg-muted text-muted-foreground",
  normal: "",
};

function PurchaseRateHistory({ rows, loading }: { rows: any[]; loading: boolean }) {
  if (loading) return <p className="py-3 text-xs text-muted-foreground">Purchase rates loading…</p>;
  if (!rows.length) return <p className="py-3 text-xs text-muted-foreground">Is item ki confirmed purchase history nahi mili.</p>;
  return <div className="space-y-2 py-2">
    <p className="text-xs font-semibold">Har purchase ka rate — newest first ({rows.length})</p>
    {rows.map((r: any, index: number) => {
      const converted = r.invoice_unit !== r.stock_unit
        || Math.abs(Number(r.invoice_rate || 0) - Number(r.effective_stock_rate || 0)) > 0.01;
      const previous = rows[index + 1];
      const currentRate = Number(r.effective_stock_rate ?? r.invoice_rate ?? 0);
      const previousRate = previous == null
        ? null
        : Number(previous.effective_stock_rate ?? previous.invoice_rate ?? 0);
      const difference = previousRate == null ? null : currentRate - previousRate;
      const differencePct = previousRate == null || previousRate === 0
        ? null
        : (difference! / previousRate) * 100;
      return <div key={`${r.purchase_id}-${r.purchase_at}`} className="grid grid-cols-2 gap-2 rounded-lg border bg-background p-2 text-xs md:grid-cols-7">
        <div><span className="block text-[10px] text-muted-foreground">Date</span><b>{purchaseTime(r.purchase_at)}</b></div>
        <div><span className="block text-[10px] text-muted-foreground">Supplier</span><b>{r.supplier_name}</b></div>
        <div><span className="block text-[10px] text-muted-foreground">Quantity</span><b>{num(r.invoice_qty)} {r.invoice_unit}</b></div>
        <div><span className="block text-[10px] text-muted-foreground">Purchase rate</span><b>₹{num(r.invoice_rate)}/{r.invoice_unit}</b>
          {converted && <span className="block text-[10px] text-muted-foreground">Stock unit: ₹{num(currentRate)}/{r.stock_unit}</span>}
        </div>
        <div><span className="block text-[10px] text-muted-foreground">Amount</span><b>{money(r.line_total)}</b></div>
        <div><span className="block text-[10px] text-muted-foreground">Previous purchase</span><b>{previousRate == null ? "First recorded" : `₹${num(previousRate)}/${r.stock_unit}`}</b></div>
        <div><span className="block text-[10px] text-muted-foreground">Rate difference</span>
          {difference == null ? <b>—</b> : <b className={difference > 0 ? "text-destructive" : difference < 0 ? "text-accent" : ""}>
            {difference > 0 ? "+" : difference < 0 ? "−" : ""}₹{num(Math.abs(difference))}/{r.stock_unit}
            {differencePct != null && <span className="block text-[10px]">{differencePct > 0 ? "+" : ""}{num(differencePct)}%</span>}
          </b>}
        </div>
      </div>;
    })}
  </div>;
}

const MEAL_ORDER = ["breakfast", "lunch", "evening_snacks", "tea", "dinner", "night_snacks", "extra"];
const MEAL_LABEL: Record<string, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  evening_snacks: "Evening Snacks",
  tea: "Tea",
  dinner: "Dinner",
  night_snacks: "Night Snacks",
  extra: "Extra / Other",
};

const REPORT_TABS = new Set(["profit", "purchase", "inventory", "stockmove", "consumption", "financial", "operations", "summary"]);

export default function ReportsCenterPage() {
  const { selectedCanteen } = useAppContext();
  const { rank } = useAuth();
  const [searchParams] = useSearchParams();
  const requestedFrom = searchParams.get("from");
  const requestedTo = searchParams.get("to");
  const requestedTab = searchParams.get("tab") || "";
  const [from, setFrom] = useState(() => clampToCutover(requestedFrom || daysAgoIso(30)));
  const [to, setTo] = useState(() => requestedTo || daysAgoIso(0));
  const [expandedMeal, setExpandedMeal] = useState<string | null>(null);
  const [expandedMenu, setExpandedMenu] = useState<string | null>(null);
  const [itemTrendSearch, setItemTrendSearch] = useState("");
  const [reportSearch, setReportSearch] = useState("");
  const [expandedRateItem, setExpandedRateItem] = useState<string | null>(null);
  // Unit managers run the site and need the complete menu-wise business view.
  // The RPC repeats this permission check in the database.
  const canViewProfit = rank >= 40;
  const [activeTab, setActiveTab] = useState(() =>
    REPORT_TABS.has(requestedTab) && (requestedTab !== "profit" || canViewProfit)
      ? requestedTab : canViewProfit ? "profit" : "purchase");

  const { data: purchase } = usePurchaseReport(selectedCanteen, from, to);
  const { data: vegetablePurchases, isLoading: vegetablePurchasesLoading } =
    useVegetablePurchaseReport(selectedCanteen, from, to);
  const { data: consumption } = useConsumptionReport(selectedCanteen, from, to);
  const { data: ops } = useOperationsSummary(selectedCanteen, from, to);
  const { data: ageing } = useStockAgeing(selectedCanteen);
  const { data: ingredients } = useIngredients(selectedCanteen);
  const { data: rates } = useIngredientRates(selectedCanteen);
  const { data: stockMove } = useStockInOutReport(selectedCanteen, from, to);
  const { data: summary } = usePeriodSummary(selectedCanteen, from, to);
  const { data: reportMenus } = useMenuPlans(selectedCanteen, from, to);
  const { data: wastage, isLoading: wastageLoading } = useWastageLog(selectedCanteen, from, to);
  const { data: ownerBreakdown, isLoading: ownerLoading } = useOwnerMenuProfitBreakdown(
    selectedCanteen, from, to, canViewProfit,
  );
  const { data: itemTrend, isLoading: itemTrendLoading } = useDailyItemUsageRateTrend(
    selectedCanteen, to, 7, canViewProfit,
  );
  const { data: purchaseRateHistory = [], isLoading: purchaseRateHistoryLoading } = useItemPurchaseRateHistory(
    selectedCanteen, expandedRateItem, to,
  );

  const openWastagePhoto = async (path: string) => {
    const { data, error } = await supabase.storage.from("wastage").createSignedUrl(path, 300);
    if (error || !data?.signedUrl) {
      toast.error("Wastage photo open nahi hui");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  // The weekly performance report and the monthly summary are the same
  // report over different dates, so the buttons just move the window.
  const setPeriod = (kind: "week" | "lastweek" | "month" | "lastmonth") => {
    const d = new Date();
    const iso = (x: Date) =>
      `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
    if (kind === "week" || kind === "lastweek") {
      const back = kind === "week" ? 0 : 7;
      const monday = new Date(d);
      monday.setDate(d.getDate() - ((d.getDay() + 6) % 7) - back);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      setFrom(clampToCutover(iso(monday)));
      setTo(iso(kind === "week" ? d : sunday));
    } else {
      const off = kind === "month" ? 0 : 1;
      const first = new Date(d.getFullYear(), d.getMonth() - off, 1);
      const last = new Date(d.getFullYear(), d.getMonth() - off + 1, 0);
      setFrom(clampToCutover(iso(first)));
      setTo(iso(kind === "month" ? d : last));
    }
  };

  // Managers send these on WhatsApp; a plain text block travels better than
  // a spreadsheet attachment.
  const shareSummary = () => {
    if (!summary) return;
    const lines = [
      `SLP Canteen — report ${summary.start} to ${summary.end}`,
      `Expected headcount: ${Number(summary.expected_headcount || 0).toLocaleString()}`,
      `Actual served: ${Number(summary.actual_headcount || 0).toLocaleString()}`,
      `Eicher punch final: ${Number(summary.company_punch_headcount || 0).toLocaleString()}`,
      Number(summary.final_meals || 0) < Number(summary.meals_planned || 0)
        ? `Billing status: PROVISIONAL (${Number(summary.meals_planned || 0) - Number(summary.final_meals || 0)} meals ka punch pending)`
        : "Billing status: FINAL",
      `Food consumed: ${money(summary.consumption)}`,
      `Purchases: ${money(summary.purchase)}`,
      summary.cost_per_head != null ? `Cost per head: ${money(summary.cost_per_head)}` : "",
      `Closing stock: ${money(summary.closing_stock)}`,
      summary.budget_used_pct != null ? `Food budget used: ${summary.budget_used_pct}%` : "",
      Number(summary.open_alerts) > 0 ? `Open alerts: ${summary.open_alerts}` : "",
      "",
      "Top consumption:",
      ...(summary.top_items || []).slice(0, 5).map((t: any) => `  ${t.name} — ${num(t.qty)} ${t.unit} (${money(t.value)})`),
    ].filter(Boolean);
    window.open(`https://wa.me/?text=${encodeURIComponent(lines.join("\n"))}`, "_blank");
  };

  const pick = (rows: any[] | undefined, scope: string) =>
    (rows || []).filter((r: any) => r.scope === scope);

  const byVendor = pick(purchase, "vendor");
  const byItem = pick(purchase, "item");
  const byDay = pick(purchase, "day");
  const vegetableRows = (vegetablePurchases || []) as any[];
  const vegetableSummary = useMemo(() => ({
    amount: vegetableRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    purchases: new Set(vegetableRows.map((row) => row.purchase_id)).size,
    vendors: new Set(vegetableRows.map((row) => row.vendor_name)).size,
    items: new Set(vegetableRows.map((row) => row.item_name)).size,
  }), [vegetablePurchases]);
  const consByItem = pick(consumption, "item");
  const consByDay = pick(consumption, "day");
  const itemTrendRows = useMemo(() => {
    const q = itemTrendSearch.trim().toLowerCase();
    return ((itemTrend || []) as any[]).filter((row) => !q ||
      String(row.item_name || "").toLowerCase().includes(q));
  }, [itemTrend, itemTrendSearch]);
  const itemTrendSummary = useMemo(() => ({
    purchase: ((itemTrend || []) as any[]).reduce((s, row) => s + Number(row.purchase_value || 0), 0),
    rateUp: ((itemTrend || []) as any[]).filter((row) => Number(row.rate_change || 0) > 0).length,
    usageUp: ((itemTrend || []) as any[]).filter((row) => Number(row.usage_change_qty || 0) > 0).length,
  }), [itemTrend]);
  const menuProfit = (ownerBreakdown?.menus || []) as any[];
  const publishedMenus = ((reportMenus || []) as any[]).filter((m: any) => m.status !== "draft");
  const menuCounts = useMemo(() => new Map(publishedMenus.map((m: any) => [m.id, {
    expected: Number(m.expected_headcount || 0),
    actual: m.actual_headcount == null ? null : Number(m.actual_headcount),
    punch: m.company_punch_count == null ? null : Number(m.company_punch_count),
  }])), [reportMenus]);
  const actualHeadcount = publishedMenus.reduce((sum: number, m: any) =>
    sum + (m.actual_headcount == null ? 0 : Number(m.actual_headcount || 0)), 0);
  const expectedHeadcount = publishedMenus.reduce((sum: number, m: any) =>
    sum + Number(m.expected_headcount || 0), 0);
  const punchHeadcount = publishedMenus.reduce((sum: number, m: any) =>
    sum + (m.company_punch_count == null ? 0 : Number(m.company_punch_count || 0)), 0);
  const pendingActualMeals = publishedMenus.filter((m: any) => m.actual_headcount == null).length;
  const pendingPunchMeals = publishedMenus.filter((m: any) => m.company_punch_count == null).length;
  const wastageByMeal = useMemo(() => {
    const groups = new Map<string, { qty: number; rows: any[] }>();
    for (const row of (wastage || []) as any[]) {
      const key = `${row.menu_date}|${row.meal_period}`;
      const current = groups.get(key) || { qty: 0, rows: [] };
      current.qty += Number(row.wasted || 0);
      current.rows.push(row);
      groups.set(key, current);
    }
    return groups;
  }, [wastage]);
  const menuProfitWithCounts = useMemo(() => menuProfit.map((row: any) => {
    const counts = menuCounts.get(row.menu_plan_id) || { expected: 0, actual: null, punch: null };
    const waste = wastageByMeal.get(`${row.menu_date}|${row.meal_period}`) || { qty: 0, rows: [] };
    return { ...row, expected_headcount: counts.expected, actual_headcount: counts.actual,
      company_punch_count: counts.punch, wastage_qty: waste.qty,
      wastage_rows: waste.rows };
  }), [menuProfit, menuCounts, wastageByMeal]);
  const todayPurchase = (ownerBreakdown?.today?.purchases || []) as any[];
  const todayIssued = (ownerBreakdown?.today?.issued || []) as any[];
  const purchaseItems = (ownerBreakdown?.purchase_items || []) as any[];
  const issuedItems = (ownerBreakdown?.issued_items || []) as any[];
  const selectedRevenue = Number(ownerBreakdown?.summary?.menu_revenue || 0);
  const selectedCost = Number(ownerBreakdown?.summary?.all_issued_cost || 0);
  const unallocatedCost = Number(ownerBreakdown?.summary?.unallocated_issued_cost || 0);
  const dailyProfit = useMemo(() => {
    const byDate = new Map<string, { date: string; sale: number; cost: number; profit: number }>();
    for (const row of menuProfit) {
      const current = byDate.get(row.menu_date) || { date: row.menu_date, sale: 0, cost: 0, profit: 0 };
      current.sale += Number(row.revenue || 0);
      current.cost += Number(row.issued_cost || 0);
      current.profit += Number(row.margin || 0);
      byDate.set(row.menu_date, current);
    }
    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [menuProfit]);
  const dateGroups = useMemo(() => Array.from(new Set(menuProfitWithCounts.map((row: any) => row.menu_date)))
    .sort((a, b) => String(b).localeCompare(String(a))).map((date) => {
    const rows = menuProfitWithCounts
      .filter((row: any) => row.menu_date === date)
      .sort((a: any, b: any) => MEAL_ORDER.indexOf(a.meal_period || "extra") - MEAL_ORDER.indexOf(b.meal_period || "extra"));
    return {
      key: String(date),
      label: fmtDayDate(String(date)),
      rows,
      sale: rows.reduce((sum: number, row: any) => sum + Number(row.revenue || 0), 0),
      cost: rows.reduce((sum: number, row: any) => sum + Number(row.issued_cost || 0), 0),
      wastageQty: rows.reduce((sum: number, row: any) => sum + Number(row.wastage_qty || 0), 0),
    };
  }).filter((group) => group.rows.length > 0), [menuProfitWithCounts]);

  // The money actually tied up in the goods on hand: each lot at the rate it
  // was bought at. Multiplying the whole shelf by the newest rate overstated
  // this every time a price went up.
  const inventoryValue = useMemo(
    () => (rates || []).reduce((s: number, r: any) => s + (Number(r.stock_value) || 0), 0),
    [rates]
  );

  const reorderList = (ingredients || []).filter((i: any) => {
    const level = Number(i.reorder_level ?? i.minimum_stock ?? 0);
    return level > 0 && Number(i.current_stock) <= level;
  });

  const dead = (ageing || []).filter((a: any) => a.movement_class === "dead");
  const slow = (ageing || []).filter((a: any) => a.movement_class === "slow");
  const fast = (ageing || []).filter((a: any) => a.movement_class === "fast");
  const searchText = reportSearch.trim().toLowerCase();
  const matchesSearch = (...values: any[]) => !searchText || values
    .filter((value) => value != null)
    .some((value) => String(value).toLowerCase().includes(searchText));
  const visibleVegetableRows = vegetableRows.filter((row: any) =>
    matchesSearch(row.item_name, row.vendor_name, row.purchase_date, row.unit));
  const visibleVendors = byVendor.filter((row: any) => matchesSearch(row.label));
  const visiblePurchaseItems = byItem.filter((row: any) => matchesSearch(row.label, row.unit));
  const visibleStockMove = (stockMove || []).filter((row: any) =>
    (Number(row.stock_in) || Number(row.stock_out) || Number(row.adjustments) || Number(row.closing))
      && matchesSearch(row.name, row.unit));
  const visibleReorder = reorderList.filter((row: any) => matchesSearch(row.name, row.unit));
  const visibleAgeing = (ageing || []).filter((row: any) =>
    matchesSearch(row.name, row.unit, row.movement_class));
  const visibleConsumption = consByItem.filter((row: any) => matchesSearch(row.label, row.unit));
  const visibleWastage = ((wastage || []) as any[]).filter((row: any) =>
    matchesSearch(row.dish, row.meal_period, row.recorded_by, row.menu_date, row.unit));
  const visibleTopItems = ((summary?.top_items || []) as any[]).filter((row: any) =>
    matchesSearch(row.name, row.unit));
  const visibleSummaryVendors = ((summary?.vendors || []) as any[]).filter((row: any) =>
    matchesSearch(row.vendor));

  if (selectedCanteen === "all") {
    return (
      <AppLayout title="Reports">
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          Select a site to run its reports.
        </CardContent></Card>
      </AppLayout>
    );
  }

  return (
    <AppLayout title="Reports">
      <div className="space-y-4 animate-fade-in">
        <Card className="border-none shadow-sm">
          <CardContent className="p-4 flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">From</Label>
              <Input type="date" min={REPORTING_CUTOVER_DATE} value={from} onChange={(e) => setFrom(clampToCutover(e.target.value))} className="w-40" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">To</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
            </div>
            <div className="flex gap-1.5 ml-auto">
              {[7, 30, 90].map((d) => (
                <Button key={d} variant="outline" size="sm" className="text-xs"
                  onClick={() => { setFrom(clampToCutover(daysAgoIso(d))); setTo(daysAgoIso(0)); }}>
                  {d}d
                </Button>
              ))}
            </div>
            <p className="w-full text-xs text-muted-foreground">Reports 19 Aug 2026 se shuru hain. Purana trial data audit mein safe hai.</p>
          </CardContent>
        </Card>

        {/* Headline financials */}
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          {[
            { label: "Expected headcount", value: expectedHeadcount.toLocaleString(), note: "Menu planning estimate" },
            { label: "Actual served", value: actualHeadcount.toLocaleString(), note: pendingActualMeals ? `${pendingActualMeals} meals ka actual pending` : "Sab actual entered" },
            { label: "Eicher punch final", value: punchHeadcount.toLocaleString(), note: pendingPunchMeals ? `${pendingPunchMeals} meals ka final punch pending` : "Sab meals final" },
            { label: pendingPunchMeals ? "Revenue (provisional)" : "Revenue billed (final)", value: money(ops?.revenue), note: pendingPunchMeals ? "Punch na ho to actual, phir expected use hua" : "Eicher punch × contracted rate" },
            { label: "Food consumed", value: money(ops?.consumption) },
            { label: "Purchases", value: money(ops?.purchase) },
            { label: pendingPunchMeals ? "Food cost % (provisional)" : "Food cost % (final)", value: ops?.food_cost_pct != null ? `${ops.food_cost_pct}%` : "—" },
          ].map((k) => (
            <Card key={k.label} className="border-none shadow-sm">
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">{k.label}</p>
                <p className="text-lg font-bold">{k.value}</p>
                {k.note && <p className="mt-1 text-[10px] text-muted-foreground">{k.note}</p>}
              </CardContent>
            </Card>
          ))}
        </div>

        <Tabs value={activeTab} onValueChange={(value) => { setActiveTab(value); setReportSearch(""); }}>
          <TabsList className="flex-wrap h-auto">
            {canViewProfit && <TabsTrigger value="profit">Menu Profit & Item Spend</TabsTrigger>}
            <TabsTrigger value="purchase">Purchase</TabsTrigger>
            <TabsTrigger value="inventory">Inventory</TabsTrigger>
            <TabsTrigger value="stockmove">Stock In/Out</TabsTrigger>
            <TabsTrigger value="consumption">Consumption</TabsTrigger>
            <TabsTrigger value="financial">Financial</TabsTrigger>
            <TabsTrigger value="operations">Operations</TabsTrigger>
            <TabsTrigger value="summary">Weekly / Monthly</TabsTrigger>
          </TabsList>

          {["purchase", "inventory", "stockmove", "consumption", "operations", "summary"].includes(activeTab) && (
            <div className="relative mt-3 w-full sm:max-w-sm">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                value={reportSearch}
                onChange={(event) => setReportSearch(event.target.value)}
                className="pl-9"
                placeholder={activeTab === "purchase" ? "Item ya vendor search"
                  : activeTab === "operations" ? "Dish, meal ya manager search"
                    : "Item search — e.g. Onion"}
                aria-label="Report search"
              />
            </div>
          )}

          {/* ---------- Owner / GM profitability ---------- */}
          {canViewProfit && (
            <TabsContent value="profit" className="mt-3 space-y-4">
              <Card className="border-warning/30 bg-warning/5 shadow-sm">
                <CardContent className="p-4 text-sm">
                  <p className="font-semibold">Sahi हिसाब: Purchase aur menu cost alag hain</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Purchase batata hai kitna maal kharida. Menu cost sirf FIFO value of issued saman minus kitchen return hai.
                    Profit = plates ki sale − net issued cost. Eicher punch final hai; punch pending ho to actual served,
                    aur actual bhi pending ho to expected count se provisional figure dikhega.
                  </p>
                </CardContent>
              </Card>

              <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
                {[
                  { label: "Aaj purchase", value: money(ownerBreakdown?.today?.purchase_total) },
                  { label: "Aaj net issue", value: money(ownerBreakdown?.today?.issued_total) },
                  { label: "Selected menu sale", value: money(selectedRevenue) },
                  { label: "Selected menu cost", value: money(selectedCost) },
                  { label: "Selected gross profit", value: money(selectedRevenue - selectedCost) },
                ].map((k) => (
                  <Card key={k.label} className="border-none shadow-sm">
                    <CardContent className="p-4">
                      <p className="text-xs text-muted-foreground">{k.label}</p>
                      <p className="text-lg font-bold">{k.value}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {Math.abs(unallocatedCost) > 0.01 && (
                <Card className="border-warning/30 bg-warning/5 shadow-sm">
                  <CardContent className="p-3 text-xs">
                    <span className="font-semibold">{money(unallocatedCost)} issue cost kisi published menu se link nahi hai.</span>{" "}
                    Ye total profit me include hai, lekin kisi ek menu par अंदाज़े se nahi dala gaya.
                  </CardContent>
                </Card>
              )}

              <div className="grid gap-4 lg:grid-cols-2">
                {[
                  { title: "Aaj kya kharida", rows: todayPurchase, empty: "Aaj confirmed purchase nahi hai." },
                  { title: "Aaj kitchen ko kya issue hua", rows: todayIssued, empty: "Aaj net issue nahi hai." },
                ].map((section) => (
                  <Card key={section.title} className="border-none shadow-sm">
                    <CardHeader className="pb-2"><CardTitle className="text-sm">{section.title}</CardTitle></CardHeader>
                    <CardContent className="p-0 max-h-80 overflow-auto">
                      <Table className="min-w-[28rem]">
                        <TableHeader><TableRow>
                          <TableHead className="text-xs">Item</TableHead>
                          <TableHead className="text-xs text-right">Qty</TableHead>
                          <TableHead className="text-xs text-right">Value</TableHead>
                        </TableRow></TableHeader>
                        <TableBody>
                          {!section.rows.length ? (
                            <TableRow><TableCell colSpan={3} className="py-6 text-center text-sm text-muted-foreground">{section.empty}</TableCell></TableRow>
                          ) : section.rows.map((r: any) => (
                            <TableRow key={`${section.title}-${r.ingredient_id || r.item_name}`}>
                              <TableCell className="text-sm font-medium">{r.item_name}</TableCell>
                              <TableCell className="text-sm text-right">{num(r.qty)} {r.unit}</TableCell>
                              <TableCell className="text-sm text-right font-semibold">{money(r.value)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <Card className="border-none shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Date-wise Sale, Cost aur Profit</CardTitle>
                  <p className="text-xs text-muted-foreground">Har date par sab meal periods ka total.</p>
                </CardHeader>
                <CardContent className="px-2 sm:px-4">
                  {!dailyProfit.length ? (
                    <p className="py-12 text-center text-sm text-muted-foreground">Selected dates me menu data nahi hai.</p>
                  ) : (
                    <>
                      <div className="mb-2 flex flex-wrap justify-center gap-4 text-xs">
                        <span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-primary" />Sale</span>
                        <span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-warning" />Net issue cost</span>
                        <span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-success" />Gross profit</span>
                      </div>
                      <div className="h-72 min-w-0">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={dailyProfit.map((d) => ({ ...d, label: `${d.date.slice(8)}/${d.date.slice(5, 7)}` }))} margin={{ left: 0, right: 8 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={dailyProfit.length > 15 ? 2 : 0} />
                            <YAxis tickFormatter={(v) => `₹${Math.round(v / 1000)}k`} tick={{ fontSize: 10 }} width={45} />
                            <Tooltip formatter={(v: number, name: string) => [money(v), name === "sale" ? "Sale" : name === "cost" ? "Net issue cost" : "Gross profit"]} labelFormatter={(_, p) => p?.[0]?.payload?.date || ""} />
                            <Bar dataKey="sale" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                            <Bar dataKey="cost" fill="hsl(var(--warning))" radius={[3, 3, 0, 0]} />
                            <Bar dataKey="profit" fill="hsl(var(--success))" radius={[3, 3, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">Date-wise menu, headcount aur profit</h3>
                    <p className="text-xs text-muted-foreground">Pehle date kholein → phir Breakfast, Lunch, Dinner ya Snacks par click karke item detail dekhein.</p>
                  </div>
                  <Button variant="outline" size="sm" className="text-xs" disabled={!menuProfit.length}
                    onClick={() => exportCsv(`menu-profit-${from}_${to}.csv`, [
                      ["Date", "Meal", "Dishes", "Expected", "Actual served", "Eicher punch final", "Billing source", "Revenue", "Net issued cost", "Gross profit", "Food cost %", "Wastage kg", "Provisional"],
                      ...menuProfitWithCounts.map((r: any) => [r.menu_date, r.meal_period, (r.dishes || []).join(" + "), r.expected_headcount, r.actual_headcount ?? "Pending",
                        r.company_punch_count ?? "Pending", r.count_source, r.revenue, r.issued_cost, r.margin, r.food_cost_pct ?? "", num(r.wastage_qty), r.provisional ? "Yes" : "No"]),
                    ])}>
                    <Download className="w-3.5 h-3.5 mr-1" /> CSV
                  </Button>
                </div>

                {ownerLoading ? (
                  <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Profit report load ho raha hai…</CardContent></Card>
                ) : !dateGroups.length ? (
                  <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Selected dates me published menu nahi hai.</CardContent></Card>
                ) : dateGroups.map((group) => {
                  const mealOpen = expandedMeal === group.key;
                  return (
                    <Card key={group.key} className="overflow-hidden border-none shadow-sm">
                      <button type="button" className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/40"
                        onClick={() => { setExpandedMeal(mealOpen ? null : group.key); setExpandedMenu(null); }}>
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold">{group.label}</p>
                          <p className="text-xs text-muted-foreground">{group.rows.length} meals · click karke dekhein</p>
                        </div>
                        <div className="hidden gap-6 text-right sm:flex">
                          <div><p className="text-[10px] text-muted-foreground">SALE</p><p className="text-sm font-semibold">{money(group.sale)}</p></div>
                          <div><p className="text-[10px] text-muted-foreground">COST</p><p className="text-sm font-semibold">{money(group.cost)}</p></div>
                          <div><p className="text-[10px] text-muted-foreground">PROFIT</p><p className={`text-sm font-bold ${group.sale - group.cost < 0 ? "text-destructive" : "text-success"}`}>{money(group.sale - group.cost)}</p></div>
                          <div><p className="text-[10px] text-muted-foreground">WASTAGE</p><p className={`text-sm font-bold ${group.wastageQty > 0 ? "text-destructive" : "text-success"}`}>{num(group.wastageQty)} kg</p></div>
                        </div>
                        <ChevronDown className={`h-5 w-5 shrink-0 transition-transform ${mealOpen ? "rotate-180" : ""}`} />
                      </button>
                      <div className="grid grid-cols-2 gap-y-2 border-t bg-muted/20 px-4 py-2 text-center sm:hidden">
                        <div><p className="text-[9px] text-muted-foreground">SALE</p><p className="text-xs font-semibold">{money(group.sale)}</p></div>
                        <div><p className="text-[9px] text-muted-foreground">COST</p><p className="text-xs font-semibold">{money(group.cost)}</p></div>
                        <div><p className="text-[9px] text-muted-foreground">PROFIT</p><p className={`text-xs font-bold ${group.sale - group.cost < 0 ? "text-destructive" : "text-success"}`}>{money(group.sale - group.cost)}</p></div>
                        <div><p className="text-[9px] text-muted-foreground">WASTAGE</p><p className={`text-xs font-bold ${group.wastageQty > 0 ? "text-destructive" : "text-success"}`}>{num(group.wastageQty)} kg</p></div>
                      </div>
                      {mealOpen && (
                        <div className="overflow-x-auto border-t">
                          <Table className="min-w-[66rem]">
                            <TableHeader><TableRow>
                              <TableHead className="text-xs">Meal</TableHead>
                              <TableHead className="text-xs">Menu dishes</TableHead>
                              <TableHead className="text-xs text-right">Expected</TableHead>
                              <TableHead className="text-xs text-right">Actual</TableHead>
                              <TableHead className="text-xs text-right">Eicher final</TableHead>
                              <TableHead className="text-xs text-right">Sale</TableHead>
                              <TableHead className="text-xs text-right">Cost</TableHead>
                              <TableHead className="text-xs text-right">Profit</TableHead>
                              <TableHead className="text-xs text-right">Food cost</TableHead>
                              <TableHead className="text-xs text-right">Wastage</TableHead>
                              <TableHead className="w-10" />
                            </TableRow></TableHeader>
                            <TableBody>
                              {group.rows.map((r: any) => {
                                const rowOpen = expandedMenu === r.menu_plan_id;
                                return (
                                  <Fragment key={r.menu_plan_id}>
                                    <TableRow className="cursor-pointer" onClick={() => setExpandedMenu(rowOpen ? null : r.menu_plan_id)}>
                                      <TableCell className="text-sm font-medium">{MEAL_LABEL[r.meal_period] || r.meal_period}{r.provisional && <Badge variant="outline" className="ml-1 text-[9px]">PUNCH PENDING</Badge>}</TableCell>
                                      <TableCell className="max-w-sm text-xs">{(r.dishes || []).join(" + ") || "—"}</TableCell>
                                      <TableCell className="text-sm text-right">{Number(r.expected_headcount || 0).toLocaleString()}</TableCell>
                                      <TableCell className={`text-sm text-right font-semibold ${r.actual_headcount == null ? "text-warning" : ""}`}>
                                        {r.actual_headcount == null ? "Pending" : Number(r.actual_headcount).toLocaleString()}
                                      </TableCell>
                                      <TableCell className={`text-sm text-right font-bold ${r.company_punch_count == null ? "text-warning" : "text-success"}`}>
                                        {r.company_punch_count == null ? "Pending" : Number(r.company_punch_count).toLocaleString()}
                                      </TableCell>
                                      <TableCell className="text-sm text-right">{money(r.revenue)}</TableCell>
                                      <TableCell className="text-sm text-right">{money(r.issued_cost)}</TableCell>
                                      <TableCell className={`text-sm text-right font-bold ${Number(r.margin) < 0 ? "text-destructive" : "text-success"}`}>{money(r.margin)}</TableCell>
                                      <TableCell className="text-sm text-right">{r.food_cost_pct == null ? "—" : `${r.food_cost_pct}%`}</TableCell>
                                      <TableCell className={`whitespace-nowrap text-right text-sm font-semibold ${Number(r.wastage_qty) > 0 ? "text-destructive" : "text-muted-foreground"}`}>
                                        {Number(r.wastage_qty) > 0 ? `${num(r.wastage_qty)} kg` : "—"}
                                      </TableCell>
                                      <TableCell><ChevronDown className={`h-4 w-4 transition-transform ${rowOpen ? "rotate-180" : ""}`} /></TableCell>
                                    </TableRow>
                                    {rowOpen && (
                                      <TableRow className="bg-muted/30">
                                        <TableCell colSpan={11} className="p-3">
                                          <div className="grid gap-3 lg:grid-cols-2">
                                          <div className="rounded-md border bg-background overflow-hidden">
                                            <Table>
                                              <TableHeader><TableRow>
                                                <TableHead className="text-xs">Issued item</TableHead>
                                                <TableHead className="text-xs text-right">Kitchen me use</TableHead>
                                                <TableHead className="text-xs text-right">FIFO cost</TableHead>
                                              </TableRow></TableHeader>
                                              <TableBody>
                                                {!(r.issued_items || []).length ? (
                                                  <TableRow><TableCell colSpan={3} className="py-4 text-center text-xs text-muted-foreground">Is menu se linked issue nahi mila.</TableCell></TableRow>
                                                ) : (r.issued_items || []).map((item: any) => (
                                                  <TableRow key={`${r.menu_plan_id}-${item.ingredient_id}`}>
                                                    <TableCell className="text-sm">{item.item}</TableCell>
                                                    <TableCell className="text-sm text-right">{num(item.qty)} {item.unit}</TableCell>
                                                    <TableCell className="text-sm text-right font-medium">{money(item.value)}</TableCell>
                                                  </TableRow>
                                                ))}
                                              </TableBody>
                                            </Table>
                                          </div>
                                          <div className="rounded-md border bg-background overflow-hidden">
                                            <Table>
                                              <TableHeader><TableRow>
                                                <TableHead className="text-xs">Wastage dish / unit</TableHead>
                                                <TableHead className="text-xs text-right">Weight</TableHead>
                                              </TableRow></TableHeader>
                                              <TableBody>
                                                {!(r.wastage_rows || []).length ? (
                                                  <TableRow><TableCell colSpan={2} className="py-4 text-center text-xs text-muted-foreground">Is meal ka wastage record nahi hai.</TableCell></TableRow>
                                                ) : (r.wastage_rows || []).map((item: any, index: number) => (
                                                  <TableRow key={`${item.recorded_at}-${index}`}>
                                                    <TableCell className="text-sm">{item.dish}</TableCell>
                                                    <TableCell className="whitespace-nowrap text-right text-sm">{num(item.wasted)} {item.unit || "kg"}</TableCell>
                                                  </TableRow>
                                                ))}
                                              </TableBody>
                                            </Table>
                                          </div>
                                          </div>
                                        </TableCell>
                                      </TableRow>
                                    )}
                                  </Fragment>
                                );
                              })}
                            </TableBody>
                          </Table>
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                {[
                  { title: "Selected period — item-wise purchase spend", rows: purchaseItems, file: "purchase-item-spend" },
                  { title: "Selected period — item-wise net consumption", rows: issuedItems, file: "issued-item-cost" },
                ].map((section) => (
                  <Card key={section.title} className="border-none shadow-sm">
                    <CardHeader className="pb-2 flex flex-row items-center justify-between">
                      <CardTitle className="text-sm">{section.title}</CardTitle>
                      <Button variant="outline" size="sm" className="text-xs" disabled={!section.rows.length}
                        onClick={() => exportCsv(`${section.file}-${from}_${to}.csv`, [
                          ["Item", "Qty", "Unit", "Value"], ...section.rows.map((r: any) => [r.item_name, r.qty, r.unit, r.value]),
                        ])}>
                        <Download className="w-3.5 h-3.5 mr-1" /> CSV
                      </Button>
                    </CardHeader>
                    <CardContent className="p-0 max-h-96 overflow-auto">
                      <Table className="min-w-[28rem]">
                        <TableHeader><TableRow>
                          <TableHead className="text-xs">Item</TableHead>
                          <TableHead className="text-xs text-right">Qty</TableHead>
                          <TableHead className="text-xs text-right">Value</TableHead>
                        </TableRow></TableHeader>
                        <TableBody>
                          {section.rows.map((r: any) => (
                            <TableRow key={`${section.file}-${r.ingredient_id || r.item_name}`}>
                              <TableCell className="text-sm">{r.item_name}</TableCell>
                              <TableCell className="text-sm text-right">{num(r.qty)} {r.unit}</TableCell>
                              <TableCell className="text-sm text-right font-semibold">{money(r.value)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </TabsContent>
          )}

          {/* ---------- Stock In / Out ---------- */}
          <TabsContent value="stockmove" className="mt-3">
            <Card className="border-none shadow-sm">
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-sm">Stock movement, item by item</CardTitle>
                <Button variant="outline" size="sm" className="text-xs"
                  onClick={() => exportCsv(`stock-in-out-${from}_${to}.csv`,
                    [["Item", "Unit", "Opening", "In", "Out", "Adjust", "Closing", "In ₹", "Out ₹", "Closing ₹"],
                     ...visibleStockMove.map((r: any) => [r.name, r.unit, num(r.opening), num(r.stock_in),
                       num(r.stock_out), num(r.adjustments), num(r.closing),
                       Math.round(r.in_value), Math.round(r.out_value), Math.round(r.closing_value)])])}>
                  <Download className="w-3.5 h-3.5 mr-1" /> CSV
                </Button>
              </CardHeader>
              <CardContent className="p-0 max-h-[32rem] overflow-y-auto">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead className="text-xs">Item</TableHead>
                    <TableHead className="text-xs text-right">Opening</TableHead>
                    <TableHead className="text-xs text-right">In</TableHead>
                    <TableHead className="text-xs text-right">Out</TableHead>
                    <TableHead className="text-xs text-right">Adjust</TableHead>
                    <TableHead className="text-xs text-right">Closing</TableHead>
                    <TableHead className="text-xs text-right">Closing ₹</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {visibleStockMove.map((r: any) => (
                      <TableRow key={r.ingredient_id}>
                        <TableCell className="text-sm">{r.name} <span className="text-xs text-muted-foreground">({r.unit})</span></TableCell>
                        <TableCell className="text-sm text-right">{num(r.opening)}</TableCell>
                        <TableCell className="text-sm text-right text-success">{Number(r.stock_in) ? `+${num(r.stock_in)}` : "—"}</TableCell>
                        <TableCell className="text-sm text-right">{Number(r.stock_out) ? `−${num(r.stock_out)}` : "—"}</TableCell>
                        <TableCell className={`text-sm text-right ${Number(r.adjustments) < 0 ? "text-destructive" : ""}`}>
                          {Number(r.adjustments) ? num(r.adjustments) : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-right font-semibold">{num(r.closing)}</TableCell>
                        <TableCell className="text-sm text-right">{money(r.closing_value)}</TableCell>
                      </TableRow>
                    ))}
                    {visibleStockMove.length === 0 && (
                      <TableRow><TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-8">
                        No movement in this period, or the report migration isn't applied yet.
                      </TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---------- Weekly performance / Monthly summary ---------- */}
          <TabsContent value="summary" className="mt-3 space-y-4">
            <Card className="border-none shadow-sm">
              <CardContent className="p-4 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground mr-1">Report for:</span>
                <Button variant="outline" size="sm" className="text-xs" onClick={() => setPeriod("week")}>
                  This week
                </Button>
                <Button variant="outline" size="sm" className="text-xs" onClick={() => setPeriod("lastweek")}>
                  Last week
                </Button>
                <Button variant="outline" size="sm" className="text-xs" onClick={() => setPeriod("month")}>
                  This month
                </Button>
                <Button variant="outline" size="sm" className="text-xs" onClick={() => setPeriod("lastmonth")}>
                  Last month
                </Button>
                <span className="text-xs font-medium ml-auto">
                  {from} → {to} ({summary?.days ?? 0} days)
                </span>
                <Button size="sm" className="text-xs" onClick={shareSummary} disabled={!summary}>
                  <Share2 className="w-3.5 h-3.5 mr-1" /> Share report
                </Button>
              </CardContent>
            </Card>

            <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
              {[
                { label: "Expected headcount", value: Number(summary?.expected_headcount || 0).toLocaleString() },
                { label: "Actual served", value: Number(summary?.actual_headcount || 0).toLocaleString() },
                { label: "Eicher punch final", value: Number(summary?.company_punch_headcount || 0).toLocaleString() },
                { label: "Food consumed", value: money(summary?.consumption) },
                { label: "Purchases", value: money(summary?.purchase) },
                { label: "Cost / head", value: summary?.cost_per_head != null ? money(summary.cost_per_head) : "—" },
                { label: "Closing stock", value: money(summary?.closing_stock) },
                { label: "Other expenses", value: money(summary?.expenses) },
                { label: "Requisitions", value: Number(summary?.requisitions || 0) },
                { label: "Open alerts", value: Number(summary?.open_alerts || 0) },
              ].map((k) => (
                <Card key={k.label} className="border-none shadow-sm">
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">{k.label}</p>
                    <p className="text-lg font-bold">{k.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            {summary?.budget_used_pct != null && (
              <Card className="border-none shadow-sm">
                <CardContent className="p-4 flex items-center justify-between">
                  <span className="text-sm font-medium">Food budget used this month</span>
                  <span className={`text-xl font-bold ${
                    Number(summary.budget_used_pct) >= 90 ? "text-destructive"
                      : Number(summary.budget_used_pct) >= 80 ? "text-warning" : "text-success"}`}>
                    {summary.budget_used_pct}%
                  </span>
                </CardContent>
              </Card>
            )}

            <div className="grid lg:grid-cols-2 gap-4">
              <Card className="border-none shadow-sm">
                <CardHeader className="pb-2"><CardTitle className="text-sm">Top consumption</CardTitle></CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead className="text-xs">Item</TableHead>
                      <TableHead className="text-xs text-right">Qty</TableHead>
                      <TableHead className="text-xs text-right">Value</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {visibleTopItems.length === 0 ? (
                        <TableRow><TableCell colSpan={3} className="text-center text-sm text-muted-foreground py-6">No consumption yet.</TableCell></TableRow>
                      ) : visibleTopItems.map((t: any) => (
                        <TableRow key={t.name}>
                          <TableCell className="text-sm">{t.name}</TableCell>
                          <TableCell className="text-sm text-right">{num(t.qty)} {t.unit}</TableCell>
                          <TableCell className="text-sm text-right font-medium">{money(t.value)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card className="border-none shadow-sm">
                <CardHeader className="pb-2"><CardTitle className="text-sm">Vendors this period</CardTitle></CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead className="text-xs">Vendor</TableHead>
                      <TableHead className="text-xs text-right">Bills</TableHead>
                      <TableHead className="text-xs text-right">Amount</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {visibleSummaryVendors.length === 0 ? (
                        <TableRow><TableCell colSpan={3} className="text-center text-sm text-muted-foreground py-6">No purchases yet.</TableCell></TableRow>
                      ) : visibleSummaryVendors.map((v: any) => (
                        <TableRow key={v.vendor}>
                          <TableCell className="text-sm">{v.vendor}</TableCell>
                          <TableCell className="text-sm text-right">{v.bills}</TableCell>
                          <TableCell className="text-sm text-right font-medium">{money(v.amount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* ---------- Purchase ---------- */}
          <TabsContent value="purchase" className="mt-3 space-y-4">
            <Card className="border-none shadow-sm">
              <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-sm">Vegetable purchase detail</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">Selected dates me kis vendor se, kitni quantity aur kis rate par vegetables aaye.</p>
                </div>
                <Button variant="outline" size="sm" className="text-xs"
                  disabled={!visibleVegetableRows.length}
                  onClick={() => exportCsv(`vegetable-purchase-${from}_${to}.csv`, [
                    ["Purchase date", "Vendor", "Item", "Quantity", "Unit", "Rate", "Amount"],
                    ...visibleVegetableRows.map((r: any) => [r.purchase_date, r.vendor_name, r.item_name, num(r.quantity), r.unit, num(r.rate), Math.round(Number(r.amount || 0))]),
                  ])}>
                  <Download className="w-3.5 h-3.5 mr-1" /> CSV
                </Button>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  {[
                    ["Vegetable purchase", money(vegetableSummary.amount)],
                    ["Purchase bills", vegetableSummary.purchases],
                    ["Vendors", vegetableSummary.vendors],
                    ["Vegetable items", vegetableSummary.items],
                  ].map(([label, value]) => <div key={String(label)} className="rounded-lg bg-muted/60 p-3"><p className="text-[10px] text-muted-foreground">{label}</p><p className="font-bold">{value}</p></div>)}
                </div>
                <div className="max-h-[28rem] overflow-auto rounded-lg border">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead className="text-xs whitespace-nowrap">Date</TableHead>
                      <TableHead className="text-xs">Vendor</TableHead>
                      <TableHead className="text-xs">Vegetable</TableHead>
                      <TableHead className="text-xs text-right whitespace-nowrap">Quantity</TableHead>
                      <TableHead className="text-xs text-right whitespace-nowrap">Rate</TableHead>
                      <TableHead className="text-xs text-right whitespace-nowrap">Total</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {vegetablePurchasesLoading ? <TableRow><TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">Vegetable purchases load ho rahe hain…</TableCell></TableRow>
                        : visibleVegetableRows.length === 0 ? <TableRow><TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">Search ya selected dates me vegetable purchase nahi mili.</TableCell></TableRow>
                        : visibleVegetableRows.map((r: any) => <TableRow key={r.purchase_item_id}>
                          <TableCell className="text-xs whitespace-nowrap">{purchaseTime(r.purchased_at)}</TableCell>
                          <TableCell className="text-sm">{r.vendor_name}</TableCell>
                          <TableCell className="text-sm font-medium">{r.item_name}</TableCell>
                          <TableCell className="text-sm text-right whitespace-nowrap">{num(r.quantity)} {r.unit}</TableCell>
                          <TableCell className="text-sm text-right whitespace-nowrap">₹{num(r.rate)}/{r.unit}</TableCell>
                          <TableCell className="text-sm text-right font-semibold whitespace-nowrap">{money(r.amount)}</TableCell>
                        </TableRow>)}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
            <div className="grid lg:grid-cols-2 gap-4">
              <Card className="border-none shadow-sm">
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm">Vendor-wise purchase</CardTitle>
                  <Button variant="outline" size="sm" className="text-xs"
                    onClick={() => exportCsv(`vendor-purchase-${from}_${to}.csv`,
                      [["Vendor", "Bills", "Amount"], ...visibleVendors.map((r: any) => [r.label, r.txn_count, Math.round(r.amount)])])}>
                    <Download className="w-3.5 h-3.5 mr-1" /> CSV
                  </Button>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead className="text-xs">Vendor</TableHead>
                      <TableHead className="text-xs text-right">Bills</TableHead>
                      <TableHead className="text-xs text-right">Amount</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {visibleVendors.length === 0 ? (
                        <TableRow><TableCell colSpan={3} className="text-center text-sm text-muted-foreground py-6">No confirmed purchases in this period.</TableCell></TableRow>
                      ) : visibleVendors.map((r: any) => (
                        <TableRow key={r.label}>
                          <TableCell className="text-sm">{r.label}</TableCell>
                          <TableCell className="text-sm text-right">{r.txn_count}</TableCell>
                          <TableCell className="text-sm text-right font-medium">{money(r.amount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card className="border-none shadow-sm">
                <CardHeader className="pb-2"><CardTitle className="text-sm">Daily purchase trend</CardTitle></CardHeader>
                <CardContent>
                  {byDay.length === 0 ? <p className="text-sm text-muted-foreground text-center py-12">No data</p> : (
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={byDay.map((r: any) => ({ name: r.label.slice(5), value: Number(r.amount) }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                        <YAxis tickFormatter={(v) => `₹${v}`} tick={{ fontSize: 11 }} />
                        <Tooltip formatter={(v: number) => [money(v), "Purchases"]} />
                        <Bar dataKey="value" fill="hsl(var(--accent))" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card className="border-none shadow-sm">
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-sm">Item-wise purchase</CardTitle>
                <Button variant="outline" size="sm" className="text-xs"
                  onClick={() => exportCsv(`item-purchase-${from}_${to}.csv`,
                    [["Item", "Qty", "Amount"], ...visiblePurchaseItems.map((r: any) => [r.label, num(r.qty), Math.round(r.amount)])])}>
                  <Download className="w-3.5 h-3.5 mr-1" /> CSV
                </Button>
              </CardHeader>
              <CardContent className="p-0 max-h-96 overflow-y-auto">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead className="text-xs">Item</TableHead>
                    <TableHead className="text-xs text-right">Qty</TableHead>
                    <TableHead className="text-xs text-right">Amount</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {visiblePurchaseItems.length === 0 && (
                      <TableRow><TableCell colSpan={3} className="py-6 text-center text-sm text-muted-foreground">Matching item nahi mila.</TableCell></TableRow>
                    )}
                    {visiblePurchaseItems.map((r: any) => (
                      <TableRow key={r.label}>
                        <TableCell className="text-sm">{r.label}</TableCell>
                        <TableCell className="text-sm text-right">{num(r.qty)}</TableCell>
                        <TableCell className="text-sm text-right font-medium">{money(r.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---------- Inventory ---------- */}
          <TabsContent value="inventory" className="mt-3 space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              {[
                { label: "Inventory value", value: money(inventoryValue) },
                { label: "Below reorder level", value: reorderList.length },
                { label: "Dead stock items", value: dead.length },
                { label: "Fast moving", value: fast.length },
              ].map((k) => (
                <Card key={k.label} className="border-none shadow-sm">
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">{k.label}</p>
                    <p className="text-lg font-bold">{k.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            {reorderList.length > 0 && (
              <Card className="border-none shadow-sm">
                <CardHeader className="pb-2"><CardTitle className="text-sm">Reorder now</CardTitle></CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead className="text-xs">Item</TableHead>
                      <TableHead className="text-xs text-right">In stock</TableHead>
                      <TableHead className="text-xs text-right">Reorder at</TableHead>
                      <TableHead className="text-xs text-right">Max level</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {visibleReorder.length === 0 && (
                        <TableRow><TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">Matching reorder item nahi mila.</TableCell></TableRow>
                      )}
                      {visibleReorder.map((i: any) => (
                        <TableRow key={i.id} className="bg-destructive/5">
                          <TableCell className="text-sm font-medium">{i.name}</TableCell>
                          <TableCell className="text-sm text-right text-destructive font-semibold">
                            {num(i.current_stock)} {i.unit}
                          </TableCell>
                          <TableCell className="text-sm text-right">{num(i.reorder_level ?? i.minimum_stock)}</TableCell>
                          <TableCell className="text-sm text-right text-muted-foreground">{i.maximum_stock ? num(i.maximum_stock) : "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            <Card className="border-none shadow-sm">
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-sm">Stock ageing & movement</CardTitle>
                <Button variant="outline" size="sm" className="text-xs"
                  onClick={() => exportCsv(`stock-ageing.csv`,
                    [["Item", "Stock", "Value", "Days since movement", "Days of stock", "Class"],
                     ...visibleAgeing.map((a: any) => [a.name, num(a.current_stock), Math.round(a.stock_value),
                       a.days_since_movement ?? "", a.days_of_stock ?? "", a.movement_class])])}>
                  <Download className="w-3.5 h-3.5 mr-1" /> CSV
                </Button>
              </CardHeader>
              <CardContent className="p-0 max-h-96 overflow-y-auto">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead className="text-xs">Item</TableHead>
                    <TableHead className="text-xs text-right">Stock</TableHead>
                    <TableHead className="text-xs text-right">Value</TableHead>
                    <TableHead className="text-xs text-right">Idle days</TableHead>
                    <TableHead className="text-xs text-right">Days of stock</TableHead>
                    <TableHead className="text-xs">Class</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {visibleAgeing.length === 0 ? (
                      <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-6">
                        Matching inventory item nahi mila.
                      </TableCell></TableRow>
                    ) : visibleAgeing.map((a: any) => (
                      <TableRow key={a.ingredient_id}>
                        <TableCell className="text-sm">{a.name}</TableCell>
                        <TableCell className="text-sm text-right">{num(a.current_stock)} {a.unit}</TableCell>
                        <TableCell className="text-sm text-right">{money(a.stock_value)}</TableCell>
                        <TableCell className="text-sm text-right">{a.days_since_movement ?? "—"}</TableCell>
                        <TableCell className="text-sm text-right">{a.days_of_stock ?? "—"}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-[10px] uppercase ${CLASS_STYLE[a.movement_class] || ""}`}>
                            {a.movement_class}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---------- Consumption ---------- */}
          <TabsContent value="consumption" className="mt-3 space-y-4">
            {canViewProfit && (
              <Card className="border-primary/20 shadow-sm">
                <CardHeader className="gap-3 pb-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <CardTitle className="text-base">Daily item use & purchase rate</CardTitle>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {fmtDayDate(to)} ka net kitchen consumption, usse pehle ke 7 din ka daily average,
                      aur isi din hui purchase ka weighted average rate.
                    </p>
                  </div>
                  <div className="flex w-full gap-2 md:w-auto">
                    <Input
                      value={itemTrendSearch}
                      onChange={(e) => setItemTrendSearch(e.target.value)}
                      placeholder="Item search — e.g. Onion"
                      className="min-w-0 md:w-60"
                    />
                    <Button variant="outline" size="sm" className="h-10 shrink-0"
                      disabled={!itemTrendRows.length}
                      onClick={() => exportCsv(`daily-item-trend-${to}.csv`, [
                        ["Date", "Item", "Unit", "Net used", "Previous 7-day avg", "Use change", "Use change %",
                          "Purchased", "Purchase value", "Day weighted rate", "Previous rate", "Rate change", "Rate change %", "Suppliers"],
                        ...itemTrendRows.map((r: any) => [to, r.item_name, r.unit, num(r.consumed_qty),
                          num(r.prior_daily_avg_qty), num(r.usage_change_qty), r.usage_change_pct ?? "",
                          num(r.purchase_qty), Math.round(Number(r.purchase_value || 0)), r.day_avg_rate ?? "",
                          r.previous_rate ?? "", r.rate_change ?? "", r.rate_change_pct ?? "", r.suppliers || ""]),
                      ])}>
                      <Download className="mr-1 h-3.5 w-3.5" /> CSV
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-lg bg-muted/60 p-3">
                      <p className="text-[10px] text-muted-foreground">Day purchase</p>
                      <p className="text-sm font-bold">{money(itemTrendSummary.purchase)}</p>
                    </div>
                    <div className="rounded-lg bg-muted/60 p-3">
                      <p className="text-[10px] text-muted-foreground">Rate increased</p>
                      <p className="text-sm font-bold text-destructive">{itemTrendSummary.rateUp} items</p>
                    </div>
                    <div className="rounded-lg bg-muted/60 p-3">
                      <p className="text-[10px] text-muted-foreground">Use above avg</p>
                      <p className="text-sm font-bold text-warning">{itemTrendSummary.usageUp} items</p>
                    </div>
                  </div>

                  {itemTrendLoading ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">Daily item हिसाब loading…</p>
                  ) : itemTrendRows.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      Is date par matching consumption ya confirmed purchase nahi hai.
                    </p>
                  ) : (
                    <>
                      <div className="hidden max-h-[32rem] overflow-auto rounded-lg border md:block">
                        <Table>
                          <TableHeader className="sticky top-0 z-10 bg-background"><TableRow>
                            <TableHead>Item</TableHead>
                            <TableHead className="text-right">Used</TableHead>
                            <TableHead className="text-right">Previous daily avg</TableHead>
                            <TableHead className="text-right">Use change</TableHead>
                            <TableHead className="text-right">Purchased</TableHead>
                            <TableHead className="text-right">Day avg rate</TableHead>
                            <TableHead className="text-right">Previous rate</TableHead>
                            <TableHead className="text-right">Rate change</TableHead>
                          </TableRow></TableHeader>
                          <TableBody>{itemTrendRows.map((row: any) => {
                            const useChange = Number(row.usage_change_qty || 0);
                            const rateChange = Number(row.rate_change || 0);
                            const isRateOpen = expandedRateItem === row.ingredient_id;
                            return <Fragment key={row.ingredient_id}><TableRow>
                              <TableCell>
                                <button type="button" onClick={() => setExpandedRateItem(isRateOpen ? null : row.ingredient_id)}
                                  className="flex items-center gap-1 text-left font-medium hover:text-primary">
                                  <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isRateOpen ? "rotate-180" : ""}`} />
                                  {row.item_name}
                                </button>
                                <p className="text-[10px] text-muted-foreground">
                                  {row.purchase_count > 0
                                    ? `${row.purchase_count} purchase · ${row.suppliers || "No supplier"} · ${purchaseTime(row.last_purchase_at)}`
                                    : `Last purchase: ${purchaseTime(row.previous_purchase_at)}`}
                                </p>
                              </TableCell>
                              <TableCell className="text-right">{num(row.consumed_qty)} {row.unit}</TableCell>
                              <TableCell className="text-right">{row.comparison_days > 0
                                ? `${num(row.prior_daily_avg_qty)} ${row.unit}/day` : "No baseline"}</TableCell>
                              <TableCell className={`text-right font-medium ${useChange > 0 ? "text-warning" : useChange < 0 ? "text-accent" : ""}`}>
                                {useChange > 0 ? "+" : ""}{num(useChange)} {row.unit}
                                {row.usage_change_pct != null && <span className="block text-[10px]">{Number(row.usage_change_pct) > 0 ? "+" : ""}{row.usage_change_pct}%</span>}
                              </TableCell>
                              <TableCell className="text-right">{Number(row.purchase_qty || 0) > 0
                                ? <>{num(row.purchase_qty)} {row.unit}<span className="block text-[10px] text-muted-foreground">{money(row.purchase_value)}</span></>
                                : "—"}</TableCell>
                              <TableCell className="text-right font-medium">{row.day_avg_rate != null ? `₹${num(row.day_avg_rate)}/${row.unit}` : "No purchase"}</TableCell>
                              <TableCell className="text-right">{row.previous_rate != null ? `₹${num(row.previous_rate)}/${row.unit}` : "—"}</TableCell>
                              <TableCell className={`text-right font-semibold ${rateChange > 0 ? "text-destructive" : rateChange < 0 ? "text-accent" : ""}`}>
                                {row.rate_change == null ? "—" : <>{rateChange > 0 ? "+" : ""}₹{num(rateChange)}
                                  {row.rate_change_pct != null && <span className="block text-[10px]">{rateChange > 0 ? "+" : ""}{row.rate_change_pct}%</span>}</>}
                              </TableCell>
                            </TableRow>
                            {isRateOpen && <TableRow className="bg-muted/30">
                              <TableCell colSpan={8} className="px-4 py-2">
                                <PurchaseRateHistory rows={purchaseRateHistory} loading={purchaseRateHistoryLoading} />
                              </TableCell>
                            </TableRow>}
                            </Fragment>;
                          })}</TableBody>
                        </Table>
                      </div>

                      <div className="space-y-2 md:hidden">{itemTrendRows.map((row: any) => {
                        const useChange = Number(row.usage_change_qty || 0);
                        const rateChange = Number(row.rate_change || 0);
                        const isRateOpen = expandedRateItem === row.ingredient_id;
                        return <div key={row.ingredient_id} className="rounded-xl border p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div><button type="button" onClick={() => setExpandedRateItem(isRateOpen ? null : row.ingredient_id)}
                              className="flex items-center gap-1 text-left font-semibold hover:text-primary">
                              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isRateOpen ? "rotate-180" : ""}`} />
                              {row.item_name}
                            </button><p className="text-[10px] text-muted-foreground">
                              {row.purchase_count > 0 ? `${row.suppliers || "No supplier"} · ${purchaseTime(row.last_purchase_at)}` : "No purchase on this day"}
                            </p></div>
                            {rateChange > 0 && <Badge variant="destructive">Rate +{row.rate_change_pct ?? 0}%</Badge>}
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                            <div className="rounded-lg bg-muted/60 p-2"><p className="text-[10px] text-muted-foreground">Used</p><b>{num(row.consumed_qty)} {row.unit}</b></div>
                            <div className="rounded-lg bg-muted/60 p-2"><p className="text-[10px] text-muted-foreground">Previous daily avg</p><b>{row.comparison_days > 0 ? `${num(row.prior_daily_avg_qty)} ${row.unit}` : "No baseline"}</b></div>
                            <div className="rounded-lg bg-muted/60 p-2"><p className="text-[10px] text-muted-foreground">Use difference</p><b className={useChange > 0 ? "text-warning" : useChange < 0 ? "text-accent" : ""}>{useChange > 0 ? "+" : ""}{num(useChange)} {row.unit}</b></div>
                            <div className="rounded-lg bg-muted/60 p-2"><p className="text-[10px] text-muted-foreground">Purchased</p><b>{Number(row.purchase_qty || 0) > 0 ? `${num(row.purchase_qty)} ${row.unit}` : "—"}</b></div>
                            <div className="rounded-lg bg-muted/60 p-2"><p className="text-[10px] text-muted-foreground">Day avg rate</p><b>{row.day_avg_rate != null ? `₹${num(row.day_avg_rate)}` : "No purchase"}</b></div>
                            <div className="rounded-lg bg-muted/60 p-2"><p className="text-[10px] text-muted-foreground">Previous rate</p><b>{row.previous_rate != null ? `₹${num(row.previous_rate)}` : "—"}</b></div>
                          </div>
                          {isRateOpen && <div className="mt-3 border-t pt-2">
                            <PurchaseRateHistory rows={purchaseRateHistory} loading={purchaseRateHistoryLoading} />
                          </div>}
                        </div>;
                      })}</div>
                    </>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Used = FIFO issue minus accepted kitchen return. Day avg rate = total purchase value ÷ total stock quantity.
                    Sirf confirmed purchases count hote hain.
                  </p>
                </CardContent>
              </Card>
            )}
            <div className="grid lg:grid-cols-2 gap-4">
              <Card className="border-none shadow-sm">
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm">Item-wise consumption</CardTitle>
                  <Button variant="outline" size="sm" className="text-xs"
                    onClick={() => exportCsv(`consumption-${from}_${to}.csv`,
                      [["Item", "Qty", "Unit", "Value"], ...visibleConsumption.map((r: any) => [r.label, num(r.qty), r.unit || "", Math.round(r.value)])])}>
                    <Download className="w-3.5 h-3.5 mr-1" /> CSV
                  </Button>
                </CardHeader>
                <CardContent className="p-0 max-h-96 overflow-y-auto">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead className="text-xs">Item</TableHead>
                      <TableHead className="text-xs text-right">Qty</TableHead>
                      <TableHead className="text-xs text-right">Value</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {visibleConsumption.length === 0 ? (
                        <TableRow><TableCell colSpan={3} className="text-center text-sm text-muted-foreground py-6">No consumption recorded.</TableCell></TableRow>
                      ) : visibleConsumption.map((r: any) => (
                        <TableRow key={r.label}>
                          <TableCell className="text-sm">{r.label}</TableCell>
                          <TableCell className="text-sm text-right">{num(r.qty)} {r.unit}</TableCell>
                          <TableCell className="text-sm text-right font-medium">{money(r.value)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card className="border-none shadow-sm">
                <CardHeader className="pb-2"><CardTitle className="text-sm">Daily consumption value</CardTitle></CardHeader>
                <CardContent>
                  {consByDay.length === 0 ? <p className="text-sm text-muted-foreground text-center py-12">No data</p> : (
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={consByDay.map((r: any) => ({ name: r.label.slice(5), value: Number(r.value) }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                        <YAxis tickFormatter={(v) => `₹${v}`} tick={{ fontSize: 11 }} />
                        <Tooltip formatter={(v: number) => [money(v), "Consumed"]} />
                        <Bar dataKey="value" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* ---------- Financial ---------- */}
          <TabsContent value="financial" className="mt-3">
            <Card className="border-none shadow-sm">
              <CardHeader className="pb-2"><CardTitle className="text-sm">Financial summary</CardTitle></CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableBody>
                    {[
                      ["Revenue billed to companies", money(ops?.revenue)],
                      ["Food consumed (at cost)", money(ops?.consumption)],
                      ["Purchases in period", money(ops?.purchase)],
                      ["Closing inventory value", money(inventoryValue)],
                      ["Gross margin", money(Number(ops?.revenue || 0) - Number(ops?.consumption || 0))],
                      ["Food cost %", ops?.food_cost_pct != null ? `${ops.food_cost_pct}%` : "—"],
                      ["Revenue per person", ops?.revenue_per_person != null ? money(ops.revenue_per_person) : "—"],
                      ["Cost per person", ops?.cost_per_person != null ? money(ops.cost_per_person) : "—"],
                      ["Margin per person", ops?.margin_per_person != null ? money(ops.margin_per_person) : "—"],
                    ].map(([k, v]) => (
                      <TableRow key={k as string}>
                        <TableCell className="text-sm">{k}</TableCell>
                        <TableCell className="text-sm text-right font-semibold">{v}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---------- Operations ---------- */}
          <TabsContent value="operations" className="mt-3">
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                { label: "Meals served", value: Number(ops?.meals_served || 0) },
                { label: "Actual served", value: actualHeadcount.toLocaleString() },
                { label: "Expected headcount", value: expectedHeadcount.toLocaleString() },
                { label: "Eicher punch final", value: punchHeadcount.toLocaleString() },
                { label: "Requisitions raised", value: Number(ops?.requisitions || 0) },
                { label: "Recorded wastage (qty)", value: num(ops?.wastage_qty) },
                { label: "Slow moving items", value: slow.length },
                { label: "Dead stock items", value: dead.length },
              ].map((k) => (
                <Card key={k.label} className="border-none shadow-sm">
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">{k.label}</p>
                    <p className="text-lg font-bold">{k.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card className="mt-3 border-none shadow-sm">
              <CardHeader className="pb-2 flex flex-row items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-sm">Manager wastage records</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Har dish aur Unit 1/2/3 ka weight, Manager aur uploaded photo.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!wastage?.length}
                  onClick={() => exportCsv("wastage-records.csv", [
                    ["Date", "Meal", "Dish / unit", "Wastage", "Unit", "Recorded by", "Recorded at"],
                    ...visibleWastage.map((row: any) => [
                      row.menu_date, row.meal_period, row.dish, num(row.wasted), row.unit,
                      row.recorded_by, row.recorded_at,
                    ]),
                  ])}
                >
                  <Download className="mr-1.5 h-4 w-4" /> CSV
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                {wastageLoading ? (
                  <p className="p-6 text-center text-sm text-muted-foreground">Wastage load ho raha hai…</p>
                ) : visibleWastage.length === 0 ? (
                  <p className="p-6 text-center text-sm text-muted-foreground">Search ya selected dates mein wastage record nahi hai.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Date / meal</TableHead>
                          <TableHead>Item / unit</TableHead>
                          <TableHead className="text-right">Wastage</TableHead>
                          <TableHead>Manager</TableHead>
                          <TableHead className="text-right">Photo</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleWastage.map((row: any, index: number) => (
                          <TableRow key={`${row.recorded_at}-${index}`}>
                            <TableCell className="whitespace-nowrap text-sm">
                              <b>{row.menu_date}</b>
                              <div className="text-xs capitalize text-muted-foreground">
                                {String(row.meal_period || "").replace(/_/g, " ")}
                              </div>
                            </TableCell>
                            <TableCell className="text-sm font-medium">{row.dish}</TableCell>
                            <TableCell className="whitespace-nowrap text-right text-sm font-semibold">
                              {num(row.wasted)} {row.unit || "kg"}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {row.recorded_by || "—"}
                            </TableCell>
                            <TableCell className="text-right">
                              {row.photo ? (
                                <Button variant="outline" size="sm" onClick={() => openWastagePhoto(row.photo)}>
                                  <ImageIcon className="mr-1.5 h-4 w-4" /> Dekho
                                </Button>
                              ) : <span className="text-xs text-muted-foreground">—</span>}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
