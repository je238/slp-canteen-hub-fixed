import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ChevronDown, FileWarning, ReceiptText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useStoreBillDesk, type StoreBillDesk as Desk } from "@/hooks/useSupabaseData";
import { fmtDate } from "@/lib/date";

const money = (v: number) => `₹${Math.round(Number(v) || 0).toLocaleString("en-IN")}`;
const KIND: Record<Desk["mistakes"][number]["kind"], string> = {
  total_mismatch: "Total galat",
  corrected: "Admin ne sudhaara",
  rate_jump: "Rate zyada",
  unmatched: "Item nahi juda",
  no_vendor: "Vendor nahi",
};
const daysText = (d: number) => (d === 0 ? "aaj" : d === 1 ? "1 din" : `${d} din`);

// The store keeper's own list: bills still owed, bills in but not priced,
// and what went wrong on bills this month. Each opens the purchase to fix it.
export default function StoreBillDesk({ canteenId }: { canteenId: string }) {
  const navigate = useNavigate();
  const { data, isLoading, error } = useStoreBillDesk(canteenId);
  const [open, setOpen] = useState<"pending" | "unfinal" | "mistakes" | null>("pending");
  if (isLoading || error || !data) return null;

  const openBill = (id: string) => navigate(`/purchases?bill=${id}`);
  const section = (key: "pending" | "unfinal" | "mistakes", title: string, count: number, tone: string, body: React.ReactNode) => (
    <section className="rounded-xl border overflow-hidden">
      <button type="button" className={`flex w-full items-center gap-2 px-3 py-2.5 text-left ${tone}`}
        onClick={() => setOpen(open === key ? null : key)}>
        <span className="flex-1 text-sm font-semibold">{title}</span>
        <Badge variant="outline" className="bg-background">{count}</Badge>
        <ChevronDown className={`h-4 w-4 transition-transform ${open === key ? "rotate-180" : ""}`} />
      </button>
      {open === key && <div className="divide-y border-t">{body}</div>}
    </section>
  );

  return (
    <Card className={`border-none shadow-sm ${data.pending_over_3_days > 0 ? "ring-1 ring-destructive/30" : ""}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><ReceiptText className="h-5 w-5 text-accent" /> Bill desk</CardTitle>
        <div className="grid grid-cols-3 gap-2 pt-1">
          <div className="rounded-lg bg-muted/60 p-2.5"><p className="text-[10px] text-muted-foreground">Bill nahi aaya</p><p className="text-lg font-bold">{data.pending_count}</p><p className="text-[10px] text-muted-foreground">{money(data.pending_value)}</p></div>
          <div className={`rounded-lg p-2.5 ${data.pending_over_3_days ? "bg-destructive/10" : "bg-muted/60"}`}><p className="text-[10px] text-muted-foreground">3 din se purane</p><p className={`text-lg font-bold ${data.pending_over_3_days ? "text-destructive" : ""}`}>{data.pending_over_3_days}</p><p className="text-[10px] text-muted-foreground">{data.pending_oldest_days != null ? `sabse purana ${daysText(data.pending_oldest_days)}` : "—"}</p></div>
          <div className={`rounded-lg p-2.5 ${data.mistakes.length ? "bg-warning/10" : "bg-muted/60"}`}><p className="text-[10px] text-muted-foreground">Bill ki galtiyan</p><p className="text-lg font-bold">{data.mistakes.length}</p><p className="text-[10px] text-muted-foreground">pichhle 30 din</p></div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {section("pending", "Saman aaya, bill nahi aaya", data.pending_count, data.pending_over_3_days ? "bg-destructive/5" : "bg-muted/50",
          data.pending.length === 0 ? <p className="p-3 text-sm text-muted-foreground">Sab bills aa gaye.</p> :
          data.pending.map((p) => (
            <div key={p.purchase_id} className="flex items-start gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{p.vendor} · {money(p.value)}</p>
                <p className="text-xs text-muted-foreground">{fmtDate(p.date)} · <span className={p.days > 3 ? "font-semibold text-destructive" : ""}>{daysText(p.days)} se pending</span>{p.unpriced ? ` · ${p.unpriced} item ka rate nahi` : ""}</p>
                {p.items && <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{p.items}</p>}
              </div>
              <Button size="sm" variant="outline" className="h-8 shrink-0 text-xs" onClick={() => openBill(p.purchase_id)}>Bill aaya</Button>
            </div>
          )))}
        {data.unfinal.length > 0 && section("unfinal", "Bill aa gaya, rate final nahi kiya", data.unfinal.length, "bg-warning/5",
          data.unfinal.map((p) => (
            <div key={p.purchase_id} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1"><p className="text-sm font-medium">{p.vendor} · {money(p.value)}</p><p className="text-xs text-muted-foreground">{fmtDate(p.date)} · {daysText(p.days)}</p></div>
              <Button size="sm" variant="outline" className="h-8 shrink-0 text-xs" onClick={() => openBill(p.purchase_id)}>Rate final karo</Button>
            </div>
          )))}
        {section("mistakes", "Bill ki galtiyan", data.mistakes.length, data.mistakes.length ? "bg-warning/5" : "bg-muted/50",
          data.mistakes.length === 0 ? <p className="p-3 text-sm text-muted-foreground">Pichhle 30 din mein koi galti nahi mili.</p> :
          data.mistakes.map((m, i) => (
            <button key={`${m.kind}-${m.purchase_id}-${i}`} type="button" className="flex w-full items-start gap-3 p-3 text-left hover:bg-muted/40"
              onClick={() => openBill(m.purchase_id)}>
              {m.kind === "total_mismatch" || m.kind === "corrected" ? <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium"><Badge variant="outline" className="mr-1.5 text-[10px]">{KIND[m.kind]}</Badge>{m.item ? `${m.item} · ` : ""}{m.vendor}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{m.detail}</p>
                <p className="text-[10px] text-muted-foreground">{fmtDate(m.date)}{m.impact ? ` · asar ${money(m.impact)}` : ""}</p>
              </div>
            </button>
          )))}
      </CardContent>
    </Card>
  );
}
