import { useMemo, useState } from "react";
import { ArrowLeftRight, ChevronDown, PackagePlus, RotateCcw, Search } from "lucide-react";
import AppLayout from "@/components/AppLayout";
import VoiceReasonInput from "@/components/VoiceReasonInput";
import { useAppContext } from "@/contexts/AppContext";
import { useIngredients } from "@/hooks/useSupabaseData";
import { useCentralKitchenTransfers, useReceiveCentralKitchenTransfer, useReturnCentralKitchenTransfer } from "@/hooks/useSrsData";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { fmtDate } from "@/lib/date";

const today = () => new Date().toISOString().slice(0, 10);
const cleanQty = (n: any) => Number(Number(n || 0).toFixed(3));

export default function CentralKitchenPage() {
  const { selectedCanteen } = useAppContext();
  const { data: ingredients = [] } = useIngredients(selectedCanteen);
  const { data: transfers = [], isLoading } = useCentralKitchenTransfers(selectedCanteen);
  const receive = useReceiveCentralKitchenTransfer();
  const sendBack = useReturnCentralKitchenTransfer();
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [returning, setReturning] = useState<any>(null);
  const [source, setSource] = useState("Sun Pharma Central Kitchen");
  const [transferDate, setTransferDate] = useState(today());
  const [returnDate, setReturnDate] = useState("");
  const [notes, setNotes] = useState("");
  const [search, setSearch] = useState("");
  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({});
  const [rates, setRates] = useState<Record<string, string>>({});
  const [returnQty, setReturnQty] = useState<Record<string, string>>({});
  const [returnReason, setReturnReason] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const found = useMemo(() => (ingredients as any[])
    .filter((i) => !search.trim() || String(i.name).toLowerCase().includes(search.toLowerCase()))
    .slice(0, 60), [ingredients, search]);
  const chosen = (ingredients as any[]).filter((i) => Number(receiveQty[i.id]) > 0);

  const saveReceive = async () => {
    if (!source.trim()) return toast.error("Central Kitchen ka naam likhein");
    if (!chosen.length) return toast.error("Kam se kam ek saman aur quantity bharein");
    try {
      await receive.mutateAsync({
        canteen_id: selectedCanteen, source: source.trim(), transfer_date: transferDate,
        expected_return_date: returnDate || undefined, notes: notes || undefined,
        items: chosen.map((i) => ({ ingredient_id: i.id, qty: Number(receiveQty[i.id]), rate: Number(rates[i.id]) || Number(i.last_purchase_rate) || 0 })),
      });
      toast.success("Central Kitchen ka saman shelf par aa gaya — purchase mein add nahi hua");
      setReceiveOpen(false); setReceiveQty({}); setRates({}); setNotes(""); setSearch("");
    } catch (e: any) { toast.error(e.message); }
  };

  const saveReturn = async () => {
    const items = (returning?.central_kitchen_transfer_items || [])
      .map((i: any) => ({ item_id: i.id, qty: Number(returnQty[i.id]) || 0, max: Number(i.qty_received) - Number(i.qty_returned) }))
      .filter((i: any) => i.qty > 0);
    if (!items.length) return toast.error("Wapas bhejne ki quantity bharein");
    if (items.some((i: any) => i.qty > i.max + 1e-9)) return toast.error("Outstanding se zyada wapas nahi bhej sakte");
    if (!returnReason.trim()) return toast.error("Return ka reason zaroori hai");
    try {
      await sendBack.mutateAsync({ transfer_id: returning.id, items: items.map(({ item_id, qty }: any) => ({ item_id, qty })), reason: returnReason.trim() });
      toast.success("Saman Central Kitchen ko return record ho gaya — consumption se nahi kata");
      setReturning(null); setReturnQty({}); setReturnReason("");
    } catch (e: any) { toast.error(e.message); }
  };

  if (selectedCanteen === "all") return <AppLayout title="Central Kitchen"><Card><CardContent className="p-8 text-center">Pehle ek site select karein.</CardContent></Card></AppLayout>;

  return (
    <AppLayout title="Central Kitchen">
      <div className="space-y-4">
        <Card className="border-none shadow-sm">
          <CardContent className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div><h2 className="text-lg font-bold">Udhar liya saman</h2><p className="text-sm text-muted-foreground">Ye purchase nahi hai. Kitna aaya aur kitna wapas baki hai, dono ka audit rahega.</p></div>
            <Button className="h-12" onClick={() => setReceiveOpen(true)}><PackagePlus className="mr-2 h-5 w-5" /> Central Kitchen se saman lo</Button>
          </CardContent>
        </Card>

        {isLoading ? <Card><CardContent className="p-8 text-center">Loading…</CardContent></Card> : transfers.length === 0 ? (
          <Card><CardContent className="p-8 text-center text-muted-foreground">Abhi Central Kitchen ka koi transfer nahi hai.</CardContent></Card>
        ) : transfers.map((t: any) => {
          const lines = t.central_kitchen_transfer_items || [];
          const pending = lines.reduce((s: number, i: any) => s + Math.max(0, Number(i.qty_received) - Number(i.qty_returned)), 0);
          const isOpen = expanded === t.id;
          return <Card key={t.id} className="border-none shadow-sm">
            <CardHeader className="p-4 cursor-pointer" onClick={() => setExpanded(isOpen ? null : t.id)}>
              <div className="flex items-center gap-3"><ArrowLeftRight className="h-5 w-5 text-accent" /><div className="flex-1 min-w-0"><CardTitle className="text-base truncate">CK-{t.transfer_no} · {t.source_name}</CardTitle><p className="text-xs text-muted-foreground">Aaya {fmtDate(t.transfer_date)}{t.expected_return_date ? ` · Wapas ${fmtDate(t.expected_return_date)}` : ""} · {lines.length} items</p></div><Badge variant={t.status === "returned" ? "secondary" : "outline"}>{t.status === "returned" ? "Sab wapas" : `${cleanQty(pending)} baki`}</Badge><ChevronDown className={`h-4 w-4 transition ${isOpen ? "rotate-180" : ""}`} /></div>
            </CardHeader>
            {isOpen && <CardContent className="space-y-2 pt-0">
              {lines.map((i: any) => <div key={i.id} className="grid grid-cols-[1fr_auto] gap-3 rounded-lg border p-3 text-sm"><div><b>{i.ingredients?.name}</b><p className="text-xs text-muted-foreground">Aaya {cleanQty(i.qty_received)} · Wapas {cleanQty(i.qty_returned)}</p></div><b>{cleanQty(Number(i.qty_received)-Number(i.qty_returned))} {i.unit} baki</b></div>)}
              {t.status !== "returned" && <Button variant="outline" className="h-11 w-full" onClick={() => { setReturning(t); setReturnQty({}); setReturnReason(""); }}><RotateCcw className="mr-2 h-4 w-4" /> Saman wapas bhejo</Button>}
            </CardContent>}
          </Card>;
        })}
      </div>

      <Dialog open={receiveOpen} onOpenChange={setReceiveOpen}><DialogContent className="max-h-[94dvh] w-[calc(100vw-1rem)] max-w-2xl overflow-y-auto p-4 sm:p-6"><DialogHeader><DialogTitle>Central Kitchen se saman lo</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2"><div><Label>Kahan se?</Label><Input className="h-11" value={source} onChange={(e) => setSource(e.target.value)} /></div><div><Label>Aane ki date</Label><Input type="date" className="h-11" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} /></div><div><Label>Wapas kab tak? (optional)</Label><Input type="date" className="h-11" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} /></div><div><Label>Note (optional)</Label><Input className="h-11" value={notes} onChange={(e) => setNotes(e.target.value)} /></div></div>
        <div className="relative"><Search className="absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" /><Input className="h-11 pl-9" placeholder="Saman search karein" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div className="max-h-[48dvh] space-y-2 overflow-y-auto">{found.map((i: any) => <div key={i.id} className="grid grid-cols-[1fr_110px] gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_120px_120px]"><div className="min-w-0"><b className="block truncate">{i.name}</b><span className="text-xs text-muted-foreground">Shelf: {cleanQty(i.current_stock)} {i.unit}</span></div><div><Label className="text-xs">Aaya ({i.unit})</Label><Input type="number" min="0" step="any" value={receiveQty[i.id] || ""} onChange={(e) => setReceiveQty((p) => ({...p,[i.id]:e.target.value}))} /></div><div className="col-start-2 sm:col-start-auto"><Label className="text-xs">Rate (₹)</Label><Input type="number" min="0" step="any" value={rates[i.id] || ""} onChange={(e) => setRates((p) => ({...p,[i.id]:e.target.value}))} /></div></div>)}</div>
        <DialogFooter><Button variant="outline" onClick={() => setReceiveOpen(false)}>Band</Button><Button onClick={saveReceive} disabled={receive.isPending}>{receive.isPending ? "Save ho raha…" : `${chosen.length} item shelf par lo`}</Button></DialogFooter>
      </DialogContent></Dialog>

      <Dialog open={!!returning} onOpenChange={(o) => !o && setReturning(null)}><DialogContent className="max-h-[94dvh] w-[calc(100vw-1rem)] max-w-lg overflow-y-auto p-4 sm:p-6"><DialogHeader><DialogTitle>Central Kitchen ko wapas bhejo</DialogTitle></DialogHeader>
        <div className="space-y-2">{(returning?.central_kitchen_transfer_items || []).filter((i:any)=>Number(i.qty_received)>Number(i.qty_returned)).map((i:any)=>{const max=Number(i.qty_received)-Number(i.qty_returned);return <div key={i.id} className="flex items-center gap-3 rounded-lg border p-3"><div className="flex-1"><b>{i.ingredients?.name}</b><p className="text-xs text-muted-foreground">Baki {cleanQty(max)} {i.unit}</p></div><Input className="w-28" type="number" min="0" max={max} step="any" placeholder="0" value={returnQty[i.id]||""} onChange={(e)=>setReturnQty((p)=>({...p,[i.id]:e.target.value}))}/></div>})}</div>
        <VoiceReasonInput value={returnReason} onChange={setReturnReason} label="Kyun wapas bhej rahe hain?" required />
        <DialogFooter><Button variant="outline" onClick={()=>setReturning(null)}>Band</Button><Button onClick={saveReturn} disabled={sendBack.isPending}>{sendBack.isPending?"Return ho raha…":"Return confirm karo"}</Button></DialogFooter>
      </DialogContent></Dialog>
    </AppLayout>
  );
}
