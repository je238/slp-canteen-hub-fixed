import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
  useReturnableItems, useKitchenReturns, useReturnToStore, useAcceptReturn,
  useStoreTakeBack, useIssueExtraToKitchen,
} from "@/hooks/useSrsData";
import { useIngredients } from "@/hooks/useSupabaseData";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Undo2, PackageCheck, PackagePlus, X } from "lucide-react";
import { fmtDateTime } from "@/lib/date";
import VoiceReasonInput from "@/components/VoiceReasonInput";
import { toast } from "sonner";

// What the kitchen drew but did not cook goes back on the shelf. The chef
// says what is coming, the store keeper accepts it when the sacks are
// physically handed over — same as receiving a delivery. Nothing moves on
// the chef's word alone, because a return that only exists on paper would
// surface later as a store shortage against the store keeper.

export function ReturnButton({ requisition, full = false }: { requisition: any; full?: boolean }) {
  const { isChef } = useAuth();
  const [open, setOpen] = useState(false);
  const { data: items } = useReturnableItems(open ? requisition.id : undefined);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const send = useReturnToStore();

  const hasIssuedStock = (requisition.requisition_items || [])
    .some((line: any) => Number(line.issued_qty || 0) > 0);
  if (!isChef || !["approved", "issued"].includes(requisition.status) || !hasIssuedStock) return null;

  const lines = (items || []).filter((i: any) => Number(i.can_return) > 0);
  const chosen = lines
    .map((i: any) => ({ ...i, q: Number(qty[i.ingredient_id]) || 0 }))
    .filter((i: any) => i.q > 0);

  const submit = async () => {
    const tooMuch = chosen.find((i: any) => i.q > Number(i.can_return) + 1e-9);
    if (tooMuch) {
      toast.error(`You can send back at most ${tooMuch.can_return} ${tooMuch.unit} of ${tooMuch.name}`);
      return;
    }
    if (chosen.length === 0) { toast.error("Enter what is going back"); return; }
    try {
      await send.mutateAsync({
        requisition_id: requisition.id,
        items: chosen.map((i: any) => ({ ingredient_id: i.ingredient_id, qty: i.q })),
        reason: reason || undefined,
      });
      toast.success("Store Keeper ko wapas lene ke liye bhej diya");
      setOpen(false); setQty({}); setReason("");
    } catch (e: any) { toast.error(e.message); }
  };

  return (
    <>
      <Button variant="outline" className={`h-11 text-sm ${full ? "w-full" : ""}`} onClick={() => setOpen(true)}>
        <Undo2 className="mr-2 h-4 w-4" /> Bacha saman wapas karo
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="h-[calc(100dvh-0.75rem)] max-h-[calc(100dvh-0.75rem)] w-[calc(100vw-0.75rem)] max-w-[calc(100vw-0.75rem)] overflow-y-auto p-4 sm:h-auto sm:max-h-[90vh] sm:max-w-lg sm:p-6">
          <DialogHeader><DialogTitle>Bacha saman wapas karo</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            Jo saman kitchen mein bach gaya hai uski quantity bharo. Stock tab badhega
            jab Store Keeper saman lekar confirm karega.
          </p>

          {lines.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              Is order mein ab kuch wapas karne ke liye nahi bacha.
            </p>
          ) : (
            <div className="space-y-2">
              {lines.map((i: any) => (
                <div key={i.ingredient_id} className="rounded-lg border p-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-base font-semibold truncate">{i.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Mila: {i.issued} {i.unit}
                      {Number(i.already_returned) > 0 && ` · Pehle wapas: ${i.already_returned} ${i.unit}`}
                    </p>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <Label className="text-sm">Wapas kitna?</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number" min={0} max={Number(i.can_return)} step="any"
                        className="h-11 w-28 text-right text-base" placeholder="0"
                        value={qty[i.ingredient_id] || ""}
                        onChange={(e) => setQty((p) => ({ ...p, [i.ingredient_id]: e.target.value }))}
                      />
                      <span className="w-12 text-sm">{i.unit}</span>
                    </div>
                  </div>
                  <p className="mt-1 text-right text-[11px] text-muted-foreground">
                    Zyada se zyada {i.can_return} {i.unit}
                  </p>
                </div>
              ))}
              <VoiceReasonInput value={reason} onChange={setReason}
                label="Kyun wapas kar rahe ho? (optional)" placeholder="Jaise: log kam aaye" />
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button className="h-11" variant="outline" onClick={() => setOpen(false)}>Band karo</Button>
            <Button className="h-11" onClick={submit} disabled={send.isPending || chosen.length === 0}>
              {send.isPending ? "Bhej rahe hain…" : "Store Keeper ko bhejo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// The store keeper's side: sacks arriving back from the kitchen, waiting to
// be put on the shelf. Stock only moves when this is accepted.
export function PendingReturns({ canteenId }: { canteenId: string }) {
  const { canIssueStock } = useAuth();
  const { data: rows } = useKitchenReturns(canteenId, "pending");
  const act = useAcceptReturn();

  if (!canIssueStock || !rows || rows.length === 0) return null;

  const decide = async (id: string, accept: boolean, name: string, qty: number, unit: string) => {
    try {
      await act.mutateAsync({ id, accept });
      toast.success(accept ? `${qty} ${unit} ${name} back on the shelf` : "Return rejected");
    } catch (e: any) { toast.error(e.message); }
  };

  return (
    <Card className="border-none shadow-sm bg-accent/5">
      <CardContent className="p-3 space-y-2">
        <p className="text-xs font-semibold">
          Kitchen se {rows.length} saman wapas aa raha hai
        </p>
        {rows.map((r: any) => (
          <div key={r.id} className="flex items-center gap-2 rounded-md border bg-background p-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {r.ingredients?.name} — {r.qty} {r.unit || r.ingredients?.unit}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {r.requisitions?.req_no ? `Order #${r.requisitions.req_no} · ` : ""}
                {fmtDateTime(r.created_at)}
                {r.reason ? ` · ${r.reason}` : ""}
              </p>
            </div>
            <Button size="sm" className="h-7 text-xs" disabled={act.isPending}
                    onClick={() => decide(r.id, true, r.ingredients?.name, r.qty, r.unit || "")}>
              <PackageCheck className="w-3.5 h-3.5 mr-1" /> Wapas le liya
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={act.isPending}
                    onClick={() => decide(r.id, false, r.ingredients?.name, r.qty, r.unit || "")}>
              <X className="mr-1 h-3.5 w-3.5 text-muted-foreground" /> Nahi mila
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ---------------- The store's own entries ----------------
// Store Keeper / Manager record, on an order already handed over:
//   · Bacha saman wapas liya: straight back on the shelf (they are receiving it)
//   · Extra saman diya: more given to the kitchen than the order, with a reason;
//     booked on the same order so that meal's consumption is right, manager told.

const dialogClass = "h-[calc(100dvh-0.75rem)] max-h-[calc(100dvh-0.75rem)] w-[calc(100vw-0.75rem)] max-w-[calc(100vw-0.75rem)] overflow-y-auto p-4 sm:h-auto sm:max-h-[90vh] sm:max-w-lg sm:p-6";

function StoreTakeBackDialog({ requisition, open, onOpenChange }: { requisition: any; open: boolean; onOpenChange: (o: boolean) => void }) {
  const fullyIssued = requisition.status === "issued";
  const { data: items } = useReturnableItems(open && fullyIssued ? requisition.id : undefined);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const send = useStoreTakeBack();

  // A partly issued order is not listed by returnable_items; the server still
  // caps every line at what was issued less what already came back.
  const lines: any[] = fullyIssued
    ? (items || []).filter((i: any) => Number(i.can_return) > 0)
    : Object.values((requisition.requisition_items || [])
        .filter((l: any) => Number(l.issued_qty || 0) > 0)
        .reduce((acc: Record<string, any>, l: any) => {
          const prev = acc[l.ingredient_id];
          const issued = (prev?.issued || 0) + Number(l.issued_qty || 0);
          acc[l.ingredient_id] = {
            ingredient_id: l.ingredient_id, name: l.ingredients?.name || "—",
            unit: l.unit || l.ingredients?.unit || "", issued, already_returned: 0, can_return: issued,
          };
          return acc;
        }, {}));
  const chosen = lines.map((i: any) => ({ ...i, q: Number(qty[i.ingredient_id]) || 0 })).filter((i: any) => i.q > 0);

  const submit = async () => {
    const tooMuch = chosen.find((i: any) => i.q > Number(i.can_return) + 1e-9);
    if (tooMuch) { toast.error(`${tooMuch.name}: zyada se zyada ${tooMuch.can_return} ${tooMuch.unit} wapas ho sakta hai`); return; }
    if (!chosen.length) { toast.error("Kitna wapas aaya wo bharo"); return; }
    try {
      const res = await send.mutateAsync({
        requisition_id: requisition.id,
        items: chosen.map((i: any) => ({ ingredient_id: i.ingredient_id, qty: i.q })),
        reason: reason || undefined,
      });
      toast.success(`${res?.returned_lines || chosen.length} item wapas stock mein chadh gaye`);
      onOpenChange(false); setQty({}); setReason("");
    } catch (e: any) { toast.error(e.message); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogClass}>
        <DialogHeader><DialogTitle>Kitchen se bacha saman wapas liya · REQ-{requisition.req_no}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Jo saman kitchen ne wapas diya uski quantity bharo. Save karte hi stock mein wapas chadh jayega.
        </p>
        {lines.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Is order mein ab kuch wapas lene ke liye nahi bacha.</p>
        ) : (
          <div className="space-y-2">
            {lines.map((i: any) => (
              <div key={i.ingredient_id} className="rounded-lg border p-3">
                <p className="truncate text-base font-semibold">{i.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Diya: {i.issued} {i.unit}
                  {Number(i.already_returned) > 0 && ` · Pehle wapas: ${i.already_returned} ${i.unit}`}
                </p>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <Label className="text-sm">Wapas kitna aaya?</Label>
                  <div className="flex items-center gap-2">
                    <Input type="number" min={0} max={Number(i.can_return)} step="any" placeholder="0"
                      className="h-11 w-28 text-right text-base" value={qty[i.ingredient_id] || ""}
                      onChange={(e) => setQty((p) => ({ ...p, [i.ingredient_id]: e.target.value }))} />
                    <span className="w-12 text-sm">{i.unit}</span>
                  </div>
                </div>
              </div>
            ))}
            <VoiceReasonInput value={reason} onChange={setReason}
              label="Kyun bacha? (optional)" placeholder="Jaise: log kam aaye" />
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button className="h-11" variant="outline" onClick={() => onOpenChange(false)}>Band karo</Button>
          <Button className="h-11" onClick={submit} disabled={send.isPending || chosen.length === 0}>
            {send.isPending ? "Save ho raha hai…" : "Stock mein wapas chadhao"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StoreExtraDialog({ requisition, open, onOpenChange }: { requisition: any; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data: ingredients } = useIngredients(open ? requisition.canteen_id : undefined);
  const [search, setSearch] = useState("");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const send = useIssueExtraToKitchen();

  const onOrder = new Set((requisition.requisition_items || []).map((l: any) => l.ingredient_id));
  const all = (ingredients || []) as any[];
  const byId = new Map(all.map((i) => [i.id, i]));
  const term = search.trim().toLowerCase();
  const shown = all
    .filter((i) => qty[i.id] !== undefined || (term ? String(i.name).toLowerCase().includes(term) : onOrder.has(i.id)))
    .slice(0, 40);
  const chosen = Object.entries(qty)
    .map(([id, v]) => ({ id, q: Number(v) || 0, ing: byId.get(id) }))
    .filter((c) => c.q > 0 && c.ing);

  const submit = async () => {
    if (!chosen.length) { toast.error("Kam se kam ek item ki quantity bharo"); return; }
    const over = chosen.find((c) => c.q > Number(c.ing.current_stock || 0) + 1e-9);
    if (over) { toast.error(`${over.ing.name} stock mein sirf ${over.ing.current_stock} ${over.ing.unit || ""} hai`); return; }
    if (reason.trim().length < 3) { toast.error("Extra saman kyun diya, wo reason likho"); return; }
    try {
      const res = await send.mutateAsync({
        requisition_id: requisition.id,
        items: chosen.map((c) => ({ ingredient_id: c.id, qty: c.q })),
        reason: reason.trim(),
      });
      toast.success(`Extra saman darj · ₹${Math.round(Number(res?.fifo_value || 0)).toLocaleString("en-IN")}`);
      onOpenChange(false); setQty({}); setReason(""); setSearch("");
    } catch (e: any) { toast.error(e.message); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogClass}>
        <DialogHeader><DialogTitle>Kitchen ko extra saman diya · REQ-{requisition.req_no}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Order se zyada jo saman kitchen ko diya wo yahan bharo. Stock se turant ghatega, isi order ke
          khane mein judega, aur Manager ko message jayega.
        </p>
        <Input className="h-11" placeholder="Item dhundho (order ke item neeche hain)…" value={search}
          onChange={(e) => setSearch(e.target.value)} />
        <div className="space-y-2">
          {shown.length === 0 && <p className="py-2 text-sm text-muted-foreground">Koi item nahi mila.</p>}
          {shown.map((i) => (
            <div key={i.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{i.name}</p>
                <p className="text-xs text-muted-foreground">Stock: {Number(i.current_stock || 0)} {i.unit || ""}</p>
              </div>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} step="any" placeholder="0" className="h-11 w-24 text-right text-base"
                  value={qty[i.id] || ""}
                  onChange={(e) => setQty((p) => ({ ...p, [i.id]: e.target.value }))} />
                <span className="w-10 text-sm">{i.unit}</span>
              </div>
            </div>
          ))}
        </div>
        <VoiceReasonInput value={reason} onChange={setReason}
          label="Extra kyun diya? (zaroori)" placeholder="Jaise: log zyada aaye, dal kam padi" />
        <DialogFooter className="gap-2">
          <Button className="h-11" variant="outline" onClick={() => onOpenChange(false)}>Band karo</Button>
          <Button className="h-11" onClick={submit} disabled={send.isPending || chosen.length === 0}>
            {send.isPending ? "Save ho raha hai…" : `Extra darj karo${chosen.length ? ` (${chosen.length})` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StoreKitchenActions({ requisition }: { requisition: any }) {
  const { canIssueStock, isChef } = useAuth();
  const [backOpen, setBackOpen] = useState(false);
  const [extraOpen, setExtraOpen] = useState(false);
  const hasIssued = (requisition.requisition_items || []).some((l: any) => Number(l.issued_qty || 0) > 0);
  if (!canIssueStock || isChef || !["approved", "issued"].includes(requisition.status) || !hasIssued) return null;
  return (
    <>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button variant="outline" className="h-11 text-sm" onClick={() => setBackOpen(true)}>
          <Undo2 className="mr-2 h-4 w-4" /> Bacha saman wapas liya
        </Button>
        <Button variant="outline" className="h-11 text-sm" onClick={() => setExtraOpen(true)}>
          <PackagePlus className="mr-2 h-4 w-4" /> Extra saman diya
        </Button>
      </div>
      {backOpen && <StoreTakeBackDialog requisition={requisition} open={backOpen} onOpenChange={setBackOpen} />}
      {extraOpen && <StoreExtraDialog requisition={requisition} open={extraOpen} onOpenChange={setExtraOpen} />}
    </>
  );
}
