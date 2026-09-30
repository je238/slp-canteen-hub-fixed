import { useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, PackagePlus, RotateCcw, Search, Send } from "lucide-react";
import AppLayout from "@/components/AppLayout";
import VoiceReasonInput from "@/components/VoiceReasonInput";
import { useAppContext } from "@/contexts/AppContext";
import { useIngredients } from "@/hooks/useSupabaseData";
import {
  useCentralKitchenTransfers, useReceiveCentralKitchenTransfer, useReturnCentralKitchenTransfer,
  useLendCentralKitchenTransfer, useReceiveBackCentralKitchenTransfer, useIngredientRates,
} from "@/hooks/useSrsData";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { fmtDate, todayIst } from "@/lib/date";

// Udhaar with the Sun Pharma central kitchen, both ways.
//
//   Liya  (direction in)  — their goods on our shelf; we owe them back.
//   Diya  (direction out) — our goods on their shelf; they owe us back.
//
// Neither is a purchase and neither is food cost. Both carry a rupee value:
// borrowed goods used to go in at ₹0, and the kitchen cooked ₹3 lakh of them
// as if they were free. A blank rate now means "what we last paid", never zero.

const PARTY = "Sun Pharma Central Kitchen";
const cleanQty = (n: any) => Number(Number(n || 0).toFixed(3));
const inr = (n: number) => "₹" + Math.round(n || 0).toLocaleString("en-IN");
const pendingOf = (i: any) => Math.max(0, Number(i.qty_received) - Number(i.qty_returned));

type View = "all" | "in" | "out";

export default function CentralKitchenPage() {
  const { selectedCanteen } = useAppContext();
  const { data: ingredients = [] } = useIngredients(selectedCanteen);
  const { data: transfers = [], isLoading } = useCentralKitchenTransfers(selectedCanteen);
  const { data: rateRows = [] } = useIngredientRates(selectedCanteen);
  const receive = useReceiveCentralKitchenTransfer();
  const sendBack = useReturnCentralKitchenTransfer();
  const lend = useLendCentralKitchenTransfer();
  const getBack = useReceiveBackCentralKitchenTransfer();

  const [view, setView] = useState<View>("all");
  const [mode, setMode] = useState<"in" | "out" | null>(null);   // which "new" dialog is open
  const [settling, setSettling] = useState<any>(null);            // transfer being returned / received back
  const [transferDate, setTransferDate] = useState(todayIst());
  const [returnDate, setReturnDate] = useState("");
  const [notes, setNotes] = useState("");
  const [search, setSearch] = useState("");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [rates, setRates] = useState<Record<string, string>>({});
  const [settleQty, setSettleQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const rateOf = useMemo(() => {
    const m: Record<string, { last: number; shelf: number }> = {};
    for (const r of rateRows as any[]) m[r.ingredient_id] = { last: Number(r.latest_rate) || 0, shelf: Number(r.stock_rate) || Number(r.latest_rate) || 0 };
    return m;
  }, [rateRows]);

  const dir = (t: any): "in" | "out" => (t.direction === "out" ? "out" : "in");
  const owed = useMemo(() => {
    const sum = (d: "in" | "out") => (transfers as any[]).filter((t) => dir(t) === d)
      .flatMap((t) => t.central_kitchen_transfer_items || [])
      .reduce((s: number, i: any) => s + pendingOf(i) * Number(i.rate || 0), 0);
    return { weOwe: sum("in"), theyOwe: sum("out") };
  }, [transfers]);

  const shown = (transfers as any[]).filter((t) => view === "all" || dir(t) === view);

  const pool = useMemo(() => (ingredients as any[])
    .filter((i) => mode !== "out" || Number(i.current_stock) > 0)
    .filter((i) => !search.trim() || String(i.name).toLowerCase().includes(search.toLowerCase()))
    .slice(0, 60), [ingredients, search, mode]);
  const chosen = (ingredients as any[]).filter((i) => Number(qty[i.id]) > 0);
  const chosenValue = chosen.reduce((s, i) => {
    const q = Number(qty[i.id]);
    const r = mode === "out" ? rateOf[i.id]?.shelf : (Number(rates[i.id]) || rateOf[i.id]?.last);
    return s + q * (r || 0);
  }, 0);

  const openNew = (m: "in" | "out") => {
    setMode(m); setQty({}); setRates({}); setNotes(""); setSearch(""); setReturnDate(""); setTransferDate(todayIst());
  };

  const saveNew = async () => {
    if (!chosen.length) return toast.error("Kam se kam ek saman aur quantity bharein");
    try {
      if (mode === "in") {
        const r: any = await receive.mutateAsync({
          canteen_id: selectedCanteen, source: PARTY, transfer_date: transferDate,
          expected_return_date: returnDate || undefined, notes: notes || undefined,
          // Blank rate goes as 0 and the database fills in the last paid rate.
          items: chosen.map((i) => ({ ingredient_id: i.id, qty: Number(qty[i.id]), rate: Number(rates[i.id]) || 0 })),
        });
        toast.success(`Sun Pharma se liya — ${inr(Number(r?.value))} ka saman shelf par, wapas dena hai`);
      } else {
        const over = chosen.find((i) => Number(qty[i.id]) > Number(i.current_stock));
        if (over) return toast.error(`${over.name}: shelf par sirf ${cleanQty(over.current_stock)} ${over.unit} hai`);
        const r: any = await lend.mutateAsync({
          canteen_id: selectedCanteen, party: PARTY, transfer_date: transferDate,
          expected_return_date: returnDate || undefined, notes: notes || undefined,
          items: chosen.map((i) => ({ ingredient_id: i.id, qty: Number(qty[i.id]) })),
        });
        toast.success(`Sun Pharma ko diya — ${inr(Number(r?.value))} ka saman, wapas aana hai`);
      }
      setMode(null);
    } catch (e: any) { toast.error(e.message); }
  };

  const saveSettle = async () => {
    const t = settling;
    const items = (t?.central_kitchen_transfer_items || [])
      .map((i: any) => ({ item_id: i.id, qty: Number(settleQty[i.id]) || 0, max: pendingOf(i) }))
      .filter((i: any) => i.qty > 0);
    if (!items.length) return toast.error("Quantity bharein");
    if (items.some((i: any) => i.qty > i.max + 1e-9)) return toast.error("Baki se zyada nahi ho sakta");
    try {
      if (dir(t) === "in") {
        if (!reason.trim()) return toast.error("Wapas bhejne ka reason zaroori hai");
        await sendBack.mutateAsync({ transfer_id: t.id, items: items.map(({ item_id, qty }: any) => ({ item_id, qty })), reason: reason.trim() });
        toast.success("Sun Pharma ko wapas bhej diya — consumption mein nahi juda");
      } else {
        await getBack.mutateAsync({ transfer_id: t.id, items: items.map(({ item_id, qty }: any) => ({ item_id, qty })), note: reason.trim() || undefined });
        toast.success("Sun Pharma se wapas aa gaya — shelf par chadh gaya");
      }
      setSettling(null); setSettleQty({}); setReason("");
    } catch (e: any) { toast.error(e.message); }
  };

  if (selectedCanteen === "all") {
    return <AppLayout title="Sun Pharma Udhaar"><Card><CardContent className="p-8 text-center">Pehle ek site select karein.</CardContent></Card></AppLayout>;
  }

  const busyNew = receive.isPending || lend.isPending;
  const busySettle = sendBack.isPending || getBack.isPending;

  return (
    <AppLayout title="Sun Pharma Udhaar">
      <div className="space-y-4">
        <Card className="border-none shadow-sm">
          <CardContent className="p-4 space-y-4">
            <div>
              <h2 className="text-lg font-bold">Sun Pharma ke saath udhaar</h2>
              <p className="text-sm text-muted-foreground">Ye purchase ya consumption nahi hai. Kya gaya, kya aaya, aur kitna baki hai — dono taraf ka hisaab.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Humein Sun Pharma ko wapas dena hai</p>
                <p className="text-2xl font-bold tabular-nums text-destructive">{inr(owed.weOwe)}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Sun Pharma se wapas aana hai</p>
                <p className="text-2xl font-bold tabular-nums text-success">{inr(owed.theyOwe)}</p>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button className="h-12" onClick={() => openNew("in")}><ArrowDownLeft className="mr-2 h-5 w-5" /> Sun Pharma se liya</Button>
              <Button className="h-12" variant="outline" onClick={() => openNew("out")}><ArrowUpRight className="mr-2 h-5 w-5" /> Sun Pharma ko diya</Button>
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-2" role="tablist">
          {([["all", "Sab"], ["in", "Liya"], ["out", "Diya"]] as [View, string][]).map(([v, l]) => (
            <Button key={v} size="sm" variant={view === v ? "default" : "outline"} onClick={() => setView(v)}>{l}</Button>
          ))}
        </div>

        {isLoading ? <Card><CardContent className="p-8 text-center">Loading…</CardContent></Card> : shown.length === 0 ? (
          <Card><CardContent className="p-8 text-center text-muted-foreground">Abhi koi udhaar nahi hai.</CardContent></Card>
        ) : shown.map((t: any) => {
          const lines = t.central_kitchen_transfer_items || [];
          const pendingValue = lines.reduce((s: number, i: any) => s + pendingOf(i) * Number(i.rate || 0), 0);
          const isOpen = expanded === t.id;
          const isIn = dir(t) === "in";
          return <Card key={t.id} className="border-none shadow-sm">
            <CardHeader className="p-4 cursor-pointer" onClick={() => setExpanded(isOpen ? null : t.id)}>
              <div className="flex items-center gap-3">
                {isIn ? <ArrowDownLeft className="h-5 w-5 text-destructive" /> : <ArrowUpRight className="h-5 w-5 text-success" />}
                <div className="flex-1 min-w-0">
                  <CardTitle className="text-base truncate">{isIn ? "Liya" : "Diya"} · #{t.transfer_no}</CardTitle>
                  <p className="text-xs text-muted-foreground">{isIn ? "Aaya" : "Gaya"} {fmtDate(t.transfer_date)}{t.expected_return_date ? ` · Wapas ${fmtDate(t.expected_return_date)} tak` : ""} · {lines.length} items</p>
                </div>
                <Badge variant={t.status === "returned" ? "secondary" : "outline"}>
                  {t.status === "returned" ? "Sab wapas" : `${inr(pendingValue)} baki`}
                </Badge>
                <ChevronDown className={`h-4 w-4 transition ${isOpen ? "rotate-180" : ""}`} />
              </div>
            </CardHeader>
            {isOpen && <CardContent className="space-y-2 pt-0">
              {lines.map((i: any) => <div key={i.id} className="grid grid-cols-[1fr_auto] gap-3 rounded-lg border p-3 text-sm">
                <div><b>{i.ingredients?.name}</b>
                  <p className="text-xs text-muted-foreground">{isIn ? "Aaya" : "Gaya"} {cleanQty(i.qty_received)} · Wapas {cleanQty(i.qty_returned)} · ₹{Number(i.rate || 0).toFixed(2)}/{i.unit}</p></div>
                <b className="text-right">{cleanQty(pendingOf(i))} {i.unit} baki<br /><span className="text-xs font-normal text-muted-foreground">{inr(pendingOf(i) * Number(i.rate || 0))}</span></b>
              </div>)}
              {t.status !== "returned" && <Button variant="outline" className="h-11 w-full" onClick={() => { setSettling(t); setSettleQty({}); setReason(""); }}>
                {isIn ? <><Send className="mr-2 h-4 w-4" /> Sun Pharma ko wapas bhejo</> : <><RotateCcw className="mr-2 h-4 w-4" /> Sun Pharma se wapas aaya</>}
              </Button>}
            </CardContent>}
          </Card>;
        })}
      </div>

      <Dialog open={!!mode} onOpenChange={(o) => !o && setMode(null)}>
        <DialogContent className="max-h-[94dvh] w-[calc(100vw-1rem)] max-w-2xl overflow-y-auto p-4 sm:p-6">
          <DialogHeader><DialogTitle>{mode === "in" ? "Sun Pharma se liya" : "Sun Pharma ko diya"}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            {mode === "in"
              ? "Saman shelf par aayega aur 'wapas dena hai' mein dikhega. Rate khaali chhodo to aakhri bill ka rate lagega."
              : "Saman shelf se jayega usi daam par jis par kharida tha, aur 'wapas aana hai' mein dikhega. Ye food cost mein nahi judega."}
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div><Label>{mode === "in" ? "Aane ki date" : "Jaane ki date"}</Label><Input type="date" className="h-11" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} /></div>
            <div><Label>Wapas kab tak? (optional)</Label><Input type="date" className="h-11" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} /></div>
            <div><Label>Note (optional)</Label><Input className="h-11" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          </div>
          <div className="relative"><Search className="absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" /><Input className="h-11 pl-9" placeholder="Saman search karein" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <div className="max-h-[46dvh] space-y-2 overflow-y-auto">
            {pool.map((i: any) => {
              const r = rateOf[i.id];
              return <div key={i.id} className={`grid gap-2 rounded-lg border p-3 ${mode === "in" ? "grid-cols-[1fr_100px] sm:grid-cols-[1fr_110px_110px]" : "grid-cols-[1fr_110px]"}`}>
                <div className="min-w-0"><b className="block truncate">{i.name}</b>
                  <span className="text-xs text-muted-foreground">Shelf: {cleanQty(i.current_stock)} {i.unit}{r ? ` · ₹${(mode === "out" ? r.shelf : r.last).toFixed(2)}/${i.unit}` : ""}</span></div>
                <div><Label className="text-xs">{mode === "in" ? "Aaya" : "Diya"} ({i.unit})</Label>
                  <Input type="number" min="0" step="any" max={mode === "out" ? Number(i.current_stock) : undefined} value={qty[i.id] || ""} onChange={(e) => setQty((p) => ({ ...p, [i.id]: e.target.value }))} /></div>
                {mode === "in" && <div className="col-start-2 sm:col-start-auto"><Label className="text-xs">Rate (₹)</Label>
                  <Input type="number" min="0" step="any" placeholder={r?.last ? String(r.last) : "rate"} value={rates[i.id] || ""} onChange={(e) => setRates((p) => ({ ...p, [i.id]: e.target.value }))} /></div>}
              </div>;
            })}
          </div>
          <DialogFooter className="gap-2">
            <span className="mr-auto self-center text-sm text-muted-foreground">{chosen.length} item · lagbhag {inr(chosenValue)}</span>
            <Button variant="outline" onClick={() => setMode(null)}>Band</Button>
            <Button onClick={saveNew} disabled={busyNew}><PackagePlus className="mr-2 h-4 w-4" />{busyNew ? "Save ho raha…" : mode === "in" ? "Shelf par lo" : "Udhaar do"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!settling} onOpenChange={(o) => !o && setSettling(null)}>
        <DialogContent className="max-h-[94dvh] w-[calc(100vw-1rem)] max-w-lg overflow-y-auto p-4 sm:p-6">
          <DialogHeader><DialogTitle>{settling && dir(settling) === "in" ? "Sun Pharma ko wapas bhejo" : "Sun Pharma se wapas aaya"}</DialogTitle></DialogHeader>
          <div className="space-y-2">
            {(settling?.central_kitchen_transfer_items || []).filter((i: any) => pendingOf(i) > 0).map((i: any) => {
              const max = pendingOf(i);
              return <div key={i.id} className="flex items-center gap-3 rounded-lg border p-3">
                <div className="flex-1"><b>{i.ingredients?.name}</b><p className="text-xs text-muted-foreground">Baki {cleanQty(max)} {i.unit}</p></div>
                <Input className="w-28" type="number" min="0" max={max} step="any" placeholder="0" value={settleQty[i.id] || ""} onChange={(e) => setSettleQty((p) => ({ ...p, [i.id]: e.target.value }))} />
              </div>;
            })}
          </div>
          {settling && dir(settling) === "in"
            ? <VoiceReasonInput value={reason} onChange={setReason} label="Kyun wapas bhej rahe hain?" required />
            : <div><Label>Note (optional)</Label><Input className="h-11" value={reason} onChange={(e) => setReason(e.target.value)} /></div>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettling(null)}>Band</Button>
            <Button onClick={saveSettle} disabled={busySettle}>{busySettle ? "Save ho raha…" : "Confirm karo"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
