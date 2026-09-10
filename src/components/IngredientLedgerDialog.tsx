import { useMemo, useState } from "react";
import { useIngredientLedger, useIngredientUsageByDish, useUserDirectory } from "@/hooks/useSupabaseData";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowDownToLine, ArrowUpFromLine, ClipboardCheck, Wrench } from "lucide-react";
import { fmtDateTime } from "@/lib/date";

// Item-wise stock passbook: "100 kg rice came in on the 3rd — which dishes
// ate it, what did the audits find, and what's left" in one screen.

interface Props {
  ingredient: { id: string; name: string; unit: string; avg_daily_usage?: number | null } | null;
  onClose: () => void;
}

function daysAgoIso(days: number) {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().split("T")[0];
}

const MOVEMENT_LABELS: Record<string, { label: string; icon: any; className: string }> = {
  purchase: { label: "Purchase IN", icon: ArrowDownToLine, className: "bg-success/10 text-success border-success/20" },
  recipe: { label: "Used in kitchen", icon: ArrowUpFromLine, className: "bg-accent/10 text-accent border-accent/20" },
  issue: { label: "Daily usage", icon: ArrowUpFromLine, className: "bg-accent/10 text-accent border-accent/20" },
  audit: { label: "Audit", icon: ClipboardCheck, className: "bg-warning/10 text-warning border-warning/20" },
  manual: { label: "Manual adjust", icon: Wrench, className: "bg-muted text-muted-foreground border-border" },
};

export default function IngredientLedgerDialog({ ingredient, onClose }: Props) {
  const [from, setFrom] = useState(daysAgoIso(30));
  const [to, setTo] = useState(daysAgoIso(0));
  const { data: ledger, isLoading } = useIngredientLedger(ingredient?.id, from, to);
  const { data: usage } = useIngredientUsageByDish(ingredient?.id, from, to);
  const { data: userDir } = useUserDirectory();
  const who = (id?: string | null) => (id && userDir?.[id] ? userDir[id].split("@")[0] : "—");

  const rows = ledger || [];
  const summary = useMemo(() => {
    const s = { opening: 0, purchased: 0, consumed: 0, audit: 0, manual: 0, closing: 0 };
    if (rows.length > 0) {
      s.opening = Number(rows[0].balance_after) - Number(rows[0].change_qty);
      s.closing = Number(rows[rows.length - 1].balance_after);
    }
    for (const r of rows as any[]) {
      const q = Number(r.change_qty);
      if (r.reference_type === "purchase") s.purchased += q;
      else if (r.reference_type === "recipe" || r.reference_type === "issue") s.consumed += q; // negative = out, positive = restock on cancel
      else if (r.reference_type === "audit") s.audit += q;
      else s.manual += q;
    }
    return s;
  }, [rows]);

  const byDish = useMemo(() => {
    const m: Record<string, { qty: number; times: number }> = {};
    for (const u of (usage || []) as any[]) {
      const dish = u.menu_items?.name || "(unknown dish)";
      m[dish] = m[dish] || { qty: 0, times: 0 };
      m[dish].qty += Number(u.quantity_used);
      m[dish].times += 1;
    }
    return Object.entries(m).sort((a, b) => b[1].qty - a[1].qty);
  }, [usage]);

  if (!ingredient) return null;
  const unit = ingredient.unit;
  const fmt = (n: number) => `${Number(n.toFixed(3))} ${unit}`;

  // Leak check against the owner's stated average ("rice runs 100 kg/day"):
  // actual outflow per day = kitchen usage + audit shortages over the period.
  const periodDays = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400_000) + 1);
  // summary.consumed is signed (negative = out); outflow needs the magnitude
  const actualOut = Math.max(0, -summary.consumed) + Math.max(0, -summary.audit);
  const actualPerDay = actualOut / periodDays;
  const expectedAvg = ingredient.avg_daily_usage || null;
  const burnRatio = expectedAvg ? actualPerDay / expectedAvg : null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{ingredient.name} — Item Ledger</DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap gap-3 items-end">
          <div className="space-y-1">
            <Label className="text-xs">From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-38 h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">To</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-38 h-8 text-xs" />
          </div>
        </div>

        {/* Summary strip: opening + in − out ± corrections = closing */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center">
          {[
            { label: "Opening", value: fmt(summary.opening), cls: "" },
            { label: "Purchased", value: `+${fmt(summary.purchased)}`, cls: "text-success" },
            { label: "Used in dishes", value: fmt(summary.consumed), cls: "text-accent" },
            { label: "Audit ± / Manual ±", value: `${fmt(summary.audit)} / ${fmt(summary.manual)}`, cls: summary.audit < 0 ? "text-destructive" : "" },
            { label: "Closing", value: fmt(summary.closing), cls: "font-bold" },
          ].map((s) => (
            <div key={s.label} className="rounded-lg border p-2">
              <p className="text-[11px] text-muted-foreground">{s.label}</p>
              <p className={`text-sm font-semibold ${s.cls}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Burn-rate leak check: "1000 kg was 10 days of ration — is it lasting 10 days?" */}
        {expectedAvg && actualOut > 0 && (
          <div className={`rounded-lg border p-3 text-sm ${burnRatio! > 1.2 ? "border-destructive/40 bg-destructive/5" : "bg-muted/40"}`}>
            <p>
              <b>Burn rate:</b> going at <b>{fmt(actualPerDay)}/day</b> against your average of {fmt(expectedAvg)}/day
              {burnRatio! > 1.2 ? (
                <span className="text-destructive font-semibold"> — {Math.round((burnRatio! - 1) * 100)}% faster than normal. Stock that should last {Math.round(summary.closing / expectedAvg)}+ days will finish in ~{actualPerDay > 0 ? Math.round(summary.closing / actualPerDay) : "—"} days. Check for a leak.</span>
              ) : burnRatio! < 0.8 ? (
                <span className="text-muted-foreground"> — slower than normal ({Math.round(burnRatio! * 100)}%).</span>
              ) : (
                <span className="text-muted-foreground"> — normal. At this rate the current stock lasts ~{actualPerDay > 0 ? Math.round(summary.closing / actualPerDay) : "—"} more days.</span>
              )}
            </p>
          </div>
        )}

        {/* Where it went, dish by dish */}
        {byDish.length > 0 && (
          <div>
            <p className="text-sm font-semibold mb-1.5">Where it was used (dish-wise)</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Dish</TableHead>
                  <TableHead className="text-xs text-right">Times cooked</TableHead>
                  <TableHead className="text-xs text-right">Total used</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byDish.map(([dish, d]) => (
                  <TableRow key={dish}>
                    <TableCell className="text-sm font-medium">{dish}</TableCell>
                    <TableCell className="text-sm text-right">{d.times}</TableCell>
                    <TableCell className="text-sm text-right font-semibold">{fmt(d.qty)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Every movement, oldest first, with running balance */}
        <div>
          <p className="text-sm font-semibold mb-1.5">All movements ({rows.length})</p>
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-4">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No movements in this period. Purchases, kitchen usage (needs recipes) and audits will appear here.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Date</TableHead>
                  <TableHead className="text-xs">Type</TableHead>
                  <TableHead className="text-xs text-right">Change</TableHead>
                  <TableHead className="text-xs text-right">Balance</TableHead>
                  <TableHead className="text-xs">Reason</TableHead>
                  <TableHead className="text-xs">By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...rows].reverse().map((r: any) => {
                  const cfg = MOVEMENT_LABELS[r.reference_type] || MOVEMENT_LABELS.manual;
                  const q = Number(r.change_qty);
                  return (
                    <TableRow key={r.id} className={r.reference_type === "audit" && q < 0 ? "bg-destructive/5" : ""}>
                      <TableCell className="text-xs whitespace-nowrap">{fmtDateTime(r.created_at)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-[10px] ${cfg.className}`}>{cfg.label}</Badge>
                      </TableCell>
                      <TableCell className={`text-sm text-right font-medium ${q < 0 ? "text-destructive" : "text-success"}`}>
                        {q > 0 ? "+" : ""}{Number(q.toFixed(3))}
                      </TableCell>
                      <TableCell className="text-sm text-right">{Number(Number(r.balance_after).toFixed(3))}</TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[220px] truncate">{r.reason}</TableCell>
                      <TableCell className="text-xs font-medium whitespace-nowrap">{who(r.created_by)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
