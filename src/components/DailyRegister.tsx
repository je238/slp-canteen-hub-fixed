import { useMemo, useState } from "react";
import { todayIst, shiftIst, istDate } from "@/lib/date";
import { useIngredients, useLedgerSince, useRecordDailyUsage } from "@/hooks/useSupabaseData";
import { useHeadcountRange, useIngredientRates } from "@/hooks/useSrsData";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, PackageMinus, Search } from "lucide-react";
import { toast } from "sonner";

// The Excel register, digitised: per item and day —
//   Opening | Purchased | Used (with ₹ value) | Adjustments | Closing
// Opening is yesterday's closing automatically; nothing is typed twice.



const BASELINE_DAYS = 14;

const shiftDate = shiftIst;

export default function DailyRegister({ canteenId }: { canteenId: string }) {
  const [date, setDate] = useState(todayIst());
  const { data: ingredients } = useIngredients(canteenId);
  // Ledger from 14 days back: the extra window builds each item's normal
  // per-head consumption, so today's draw can be judged against it.
  const baselineStart = shiftDate(date, -BASELINE_DAYS);
  const { data: ledger } = useLedgerSince(canteenId, baselineStart);
  const { data: headsByDate } = useHeadcountRange(canteenId, baselineStart, date);
  // Priced off the lots actually on the shelf, so this register agrees with
  // the reports rather than running high whenever a price rose.
  const { data: rates } = useIngredientRates(canteenId);
  const rateOf = (id: string, fallback: any) =>
    Number((rates || []).find((r: any) => r.ingredient_id === id)?.stock_rate)
      || Number(fallback) || 0;
  const recordUsage = useRecordDailyUsage();
  const { canIssueStock } = useAuth();

  const [usageOpen, setUsageOpen] = useState(false);
  const [usageSearch, setUsageSearch] = useState("");
  const [usageQty, setUsageQty] = useState<Record<string, string>>({});

  const todayHeads = headsByDate?.[date] || 0;

  const rows = useMemo(() => {
    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(`${date}T00:00:00`);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const isOut = (l: any) => (l.reference_type === "recipe" || l.reference_type === "issue") && Number(l.change_qty) < 0;
    return (ingredients || []).map((i: any) => {
      const mine = (ledger || []).filter((l: any) => l.ingredient_id === i.id);
      const onDay = mine.filter((l: any) => new Date(l.created_at) >= dayStart && new Date(l.created_at) < dayEnd);
      const after = mine.filter((l: any) => new Date(l.created_at) >= dayEnd);
      const sum = (ls: any[], f: (l: any) => boolean) => ls.filter(f).reduce((s, l) => s + Number(l.change_qty), 0);
      const closing = Number(i.current_stock) - sum(after, () => true);
      const opening = closing - sum(onDay, () => true);
      const purchased = sum(onDay, (l) => l.reference_type === "purchase");
      const used = -sum(onDay, isOut);

      // The store issues at 6pm for the NEXT day's cooking, so the stock
      // columns above and the per-head check below have to be dated
      // differently — and both are right. Opening, purchased and closing are
      // a stock book: they must follow the shelf, on the day it actually
      // moved, or the register stops balancing. Per-head is a question about
      // food and people, so it follows the day the food was cooked for. Using
      // the movement date for both is what divided tomorrow's rice by today's
      // diners every single evening.
      const forDay = (l: any) => l.service_date || istDate(new Date(l.created_at));
      const servedToday = -mine.filter((l: any) => isOut(l) && forDay(l) === date)
        .reduce((t: number, l: any) => t + Number(l.change_qty), 0);
      const adjust = sum(onDay, (l) => l.reference_type === "audit" || l.reference_type === "manual")
        + sum(onDay, (l) => l.reference_type === "recipe" && Number(l.change_qty) > 0); // cancel-restocks
      const cost = rateOf(i.id, i.cost_per_unit);

      // Per-head check: today's draw ÷ today's headcount vs this item's
      // normal per-head over the previous days. Per-head is stable even
      // when the weekly menu changes — that's what makes it a theft check.
      const usedByDay: Record<string, number> = {};
      for (const l of mine.filter((x: any) => isOut(x) && forDay(x) < date)) {
        // Bucket by the day the food was FOR, the same day the headcount is
        // recorded against. Movements written before this column existed fall
        // back to their IST movement day, which is all anyone knew then.
        const day = forDay(l);
        usedByDay[day] = (usedByDay[day] || 0) - Number(l.change_qty);
      }
      const perHeadHistory = Object.entries(usedByDay)
        .map(([d, u]) => {
          const h = headsByDate?.[d] || 0;
          return h > 0 ? u / h : null;
        })
        .filter((v): v is number => v !== null && v > 0);
      const normalPerHead = perHeadHistory.length >= 3
        ? perHeadHistory.reduce((s, v) => s + v, 0) / perHeadHistory.length
        : null;
      const todayPerHead = todayHeads > 0 && servedToday > 0 ? servedToday / todayHeads : null;
      const deviation = normalPerHead && todayPerHead ? (todayPerHead / normalPerHead - 1) * 100 : null;

      return {
        id: i.id, name: i.name, unit: i.unit, cost,
        opening, purchased, used, usedValue: used * cost, adjust, closing,
        todayPerHead, normalPerHead, deviation,
        moved: purchased !== 0 || used !== 0 || adjust !== 0,
      };
    });
  }, [ingredients, ledger, date, headsByDate, todayHeads]);

  const movedRows = rows.filter((r) => r.moved);
  const totalUsedValue = rows.reduce((s, r) => s + r.usedValue, 0);
  const n = (v: number) => Number(v.toFixed(3));

  const exportCsv = () => {
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [
      [`Daily Stock Register — ${date}`],
      [],
      ["Item", "Unit", "Opening", "Purchased", "Used", "Used Value (₹)", "Adjustments", "Closing"],
      ...rows.map((r) => [r.name, r.unit, n(r.opening), n(r.purchased), n(r.used), Math.round(r.usedValue), n(r.adjust), n(r.closing)]),
      [],
      ["", "", "", "", "TOTAL USED ₹", Math.round(totalUsedValue), "", ""],
    ].map((r) => r.map(esc).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + lines], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `stock-register-${date}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const usageItems = (ingredients || []).filter((i: any) =>
    i.name.toLowerCase().includes(usageSearch.toLowerCase())
  );
  const usageEntries = (ingredients || [])
    .map((i: any) => ({ ingredient_id: i.id, name: i.name, unit: i.unit, cost: rateOf(i.id, i.cost_per_unit), qty: Number(usageQty[i.id]) || 0 }))
    .filter((e) => e.qty > 0);
  const usageTotal = usageEntries.reduce((s, e) => s + e.qty * e.cost, 0);

  const saveUsage = async () => {
    if (usageEntries.length === 0) { toast.error("Enter at least one quantity"); return; }
    try {
      // No photo here: material leaving the store for the kitchen was already
      // approved. Evidence is captured at stock-in, where goods arrive.
      await recordUsage.mutateAsync({ canteen_id: canteenId, entries: usageEntries });
      toast.success(`${usageEntries.length} items issued — ₹${Math.round(usageTotal).toLocaleString()} worth of stock deducted`);
      setUsageOpen(false);
      setUsageQty({});
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="border-none shadow-sm">
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Date</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
          </div>
          <div className="flex-1 min-w-[220px] text-xs text-muted-foreground">
            Opening = previous day's closing, automatically.
            {todayHeads > 0
              ? ` ${todayHeads} people ate on this date — "vs Normal" compares today's per-head draw with this item's own ${BASELINE_DAYS}-day average, so weekly menu changes don't break the check.`
              : " Enter headcount on Corporate Billing → Daily Plates to unlock the per-head check (was today's draw too much for the people who ate?)."}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
              <Download className="w-4 h-4 mr-1.5" /> Export CSV
            </Button>
            {/* Issuing stock is the store keeper's duty — the chef may read
                the register but never take material out of it. */}
            {canIssueStock && (
              <Button size="sm" onClick={() => setUsageOpen(true)} disabled={date !== todayIst()}>
                <PackageMinus className="w-4 h-4 mr-1.5" /> Enter Daily Usage
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="border-none shadow-sm">
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Item</TableHead>
                <TableHead className="text-xs text-right">Opening</TableHead>
                <TableHead className="text-xs text-right">Purchased</TableHead>
                <TableHead className="text-xs text-right">Used</TableHead>
                <TableHead className="text-xs text-right">Used ₹</TableHead>
                <TableHead className="text-xs text-right">Per Head</TableHead>
                <TableHead className="text-xs text-right">vs Normal</TableHead>
                <TableHead className="text-xs text-right">Adjust ±</TableHead>
                <TableHead className="text-xs text-right">Closing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {movedRows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-sm font-medium">{r.name} <span className="text-xs text-muted-foreground">({r.unit})</span></TableCell>
                  <TableCell className="text-sm text-right">{n(r.opening)}</TableCell>
                  <TableCell className="text-sm text-right text-success">{r.purchased ? `+${n(r.purchased)}` : "—"}</TableCell>
                  <TableCell className="text-sm text-right">{r.used ? `−${n(r.used)}` : "—"}</TableCell>
                  <TableCell className="text-sm text-right font-medium">{r.usedValue ? `₹${Math.round(r.usedValue).toLocaleString()}` : "—"}</TableCell>
                  <TableCell className="text-sm text-right">
                    {r.todayPerHead ? `${n(r.todayPerHead)}` : "—"}
                    {r.todayPerHead && r.normalPerHead ? <span className="text-[10px] text-muted-foreground block">normal {n(r.normalPerHead)}</span> : null}
                  </TableCell>
                  <TableCell className="text-sm text-right">
                    {r.deviation === null ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : r.deviation > 20 ? (
                      <span className="font-bold text-destructive">+{Math.round(r.deviation)}% ⚠</span>
                    ) : r.deviation < -20 ? (
                      <span className="text-blue-500">{Math.round(r.deviation)}%</span>
                    ) : (
                      <span className="text-success">{r.deviation > 0 ? "+" : ""}{Math.round(r.deviation)}% ✓</span>
                    )}
                  </TableCell>
                  <TableCell className={`text-sm text-right ${r.adjust < 0 ? "text-destructive" : ""}`}>{r.adjust ? n(r.adjust) : "—"}</TableCell>
                  <TableCell className="text-sm text-right font-semibold">{n(r.closing)}</TableCell>
                </TableRow>
              ))}
              {movedRows.length === 0 && (
                <TableRow><TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                  No stock movement on {date}. Use "Enter Daily Usage" after the day's cooking.
                </TableCell></TableRow>
              )}
              {movedRows.length > 0 && (
                <TableRow className="bg-muted/40">
                  <TableCell className="text-sm font-bold" colSpan={4}>TOTAL CONSUMPTION VALUE{todayHeads > 0 ? ` · ${todayHeads} heads · ₹${(totalUsedValue / todayHeads).toFixed(1)}/head` : ""}</TableCell>
                  <TableCell className="text-sm text-right font-bold">₹{Math.round(totalUsedValue).toLocaleString()}</TableCell>
                  <TableCell colSpan={4} />
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Daily usage entry — the "Used" column of the Excel register */}
      <Dialog open={usageOpen} onOpenChange={setUsageOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Daily Usage — what went to the kitchen today</DialogTitle>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input placeholder="Search item..." value={usageSearch} onChange={(e) => setUsageSearch(e.target.value)} className="pl-8 h-9" />
          </div>
          <div className="space-y-1.5 max-h-[45vh] overflow-y-auto pr-1">
            {usageItems.map((i: any) => {
              const qty = Number(usageQty[i.id]) || 0;
              const cost = rateOf(i.id, i.cost_per_unit);
              return (
                <div key={i.id} className="flex items-center gap-2">
                  <span className="flex-1 text-sm truncate">{i.name} <span className="text-xs text-muted-foreground">({i.unit} · stock {Number(i.current_stock)})</span></span>
                  <Input
                    type="number" min={0} placeholder="0" className="w-24 h-8 text-right"
                    value={usageQty[i.id] ?? ""}
                    onChange={(e) => setUsageQty((p) => ({ ...p, [i.id]: e.target.value }))}
                  />
                  <span className="w-20 text-right text-xs text-muted-foreground">{qty > 0 ? `₹${Math.round(qty * cost).toLocaleString()}` : ""}</span>
                </div>
              );
            })}
          </div>
          <DialogFooter className="items-center gap-3 sm:justify-between">
            <p className="text-sm font-semibold">{usageEntries.length} items · ₹{Math.round(usageTotal).toLocaleString()}</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setUsageOpen(false)}>Cancel</Button>
              <Button onClick={saveUsage} disabled={recordUsage.isPending || usageEntries.length === 0}>
                {recordUsage.isPending ? "Saving…" : "Save Usage"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
