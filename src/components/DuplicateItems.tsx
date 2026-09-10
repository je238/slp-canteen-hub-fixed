import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useSimilarIngredients, useMergeIngredients } from "@/hooks/useSrsData";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Merge, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type MergeChoice = {
  from: string;
  into: string;
  fromName: string;
  intoName: string;
  fromStock: number;
  intoStock: number;
};

// Stock is matched to an item by its exact name, so a bill read or typed as
// "Rose" when it meant "Rice" opens a second item instead of topping up the
// first. Nothing looks wrong on any screen: the store holds 100 kg under one
// name and 50 under another, no total shows 150, and a physical count agrees
// with neither. Their own purchase reports already carry this — Atta at
// 28.60 and Aata at 29.48, the same flour twice.
//
// Names within two letters of each other are surfaced here so an admin can
// look, rather than waiting for a count to disagree months later.

export default function DuplicateItems({ canteenId }: { canteenId: string }) {
  const { isOwner: isAdmin, roleData } = useAuth();
  const canMerge = isAdmin || String(roleData?.role).toLowerCase() === "store_keeper";
  const { data: pairs } = useSimilarIngredients(canteenId);
  const merge = useMergeIngredients();
  const [busy, setBusy] = useState("");
  const [choice, setChoice] = useState<MergeChoice | null>(null);

  if (!canMerge || !pairs || pairs.length === 0) return null;

  const doMerge = async (from: string, into: string, fromName: string, intoName: string) => {
    setBusy(from + into);
    try {
      const r = await merge.mutateAsync({ from, into });
      setChoice(null);
      toast.success(
        `"${fromName}" merged into "${intoName}" — ${r.new_balance} in stock, ` +
        `${r.ledger_rows} ledger rows and ${r.bill_lines} bill lines carried across`
      );
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(""); }
  };

  return (
    <Card className="border-none shadow-sm bg-warning/5">
      <CardContent className="p-3 space-y-2">
        <p className="text-xs font-semibold flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-warning" />
          {pairs.length} pair{pairs.length > 1 ? "s" : ""} of items look like the same thing
        </p>
        <p className="text-[11px] text-muted-foreground">
          Dono same item hain to final naam chuniye. Merge stock ko jodega aur
          ledger, bills, recipes aur purane orders final item mein le jayega.
        </p>
        {pairs.map((p: any) => (
          <div key={p.a_id + p.b_id}
               className="rounded-md border bg-background p-2 flex items-center gap-2 flex-wrap">
            <div className="flex-1 min-w-[180px] text-xs">
              <b>{p.a_name}</b> ({Number(p.a_stock)}) &nbsp;vs&nbsp; <b>{p.b_name}</b> ({Number(p.b_stock)})
            </div>
            <Button size="sm" variant="outline" className="h-8 text-[11px]"
                    disabled={!!busy}
                    onClick={() => setChoice({
                      from: p.b_id, into: p.a_id, fromName: p.b_name, intoName: p.a_name,
                      fromStock: Number(p.b_stock), intoStock: Number(p.a_stock),
                    })}>
              <Merge className="w-3 h-3 mr-1" /> Merge into {p.a_name}
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-[11px]"
                    disabled={!!busy}
                    onClick={() => setChoice({
                      from: p.a_id, into: p.b_id, fromName: p.a_name, intoName: p.b_name,
                      fromStock: Number(p.a_stock), intoStock: Number(p.b_stock),
                    })}>
              <Merge className="w-3 h-3 mr-1" /> Merge into {p.b_name}
            </Button>
          </div>
        ))}
        <AlertDialog open={!!choice} onOpenChange={(open) => !open && !busy && setChoice(null)}>
          <AlertDialogContent className="max-w-md">
            <AlertDialogHeader>
              <AlertDialogTitle>Items merge karein?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3 text-sm">
                  <p>
                    <b className="text-foreground">{choice?.fromName}</b> ko{" "}
                    <b className="text-foreground">{choice?.intoName}</b> mein merge kiya jayega.
                    Final item ka naam <b className="text-foreground">{choice?.intoName}</b> rahega.
                  </p>
                  <div className="rounded-md border bg-muted/40 p-3 text-foreground">
                    Stock: {choice?.intoStock ?? 0} + {choice?.fromStock ?? 0} ={" "}
                    <b>{(choice?.intoStock ?? 0) + (choice?.fromStock ?? 0)}</b>
                  </div>
                  <p className="text-destructive">
                    Merge ke baad dono items ko alag automatically nahi kiya ja sakta.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={!!busy}>Cancel</AlertDialogCancel>
              <Button
                disabled={!choice || !!busy}
                onClick={() => choice && doMerge(
                  choice.from, choice.into, choice.fromName, choice.intoName,
                )}
              >
                <Merge className="mr-2 h-4 w-4" />
                {busy ? "Merging…" : `Yes, merge into ${choice?.intoName ?? "item"}`}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
