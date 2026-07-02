import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { KitchenOrder, useSettleQROrder, useUnsettledQROrders } from "@/hooks/useKitchenOrders";
import { Banknote, CreditCard, QrCode, Smartphone } from "lucide-react";
import { toast } from "sonner";

const STATUS_LABEL: Record<string, string> = {
  new: "In queue",
  preparing: "Cooking",
  ready: "Ready",
  served: "Served",
};

function SettleCard({ order }: { order: KitchenOrder }) {
  const settle = useSettleQROrder();
  const settling = settle.isPending;

  const handleSettle = (mode: string) => {
    settle.mutate(
      { id: order.id, payment_mode: mode },
      {
        onSuccess: () => toast.success(`Token #${order.order_number} settled — ₹${Number(order.total_amount)} via ${mode}`),
        onError: (e: any) => toast.error(e.message),
      }
    );
  };

  return (
    <div className="rounded-xl border bg-card p-3.5 space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-extrabold tabular-nums">#{order.order_number}</span>
          {order.customer_name && <span className="text-xs text-muted-foreground truncate max-w-[9rem]">{order.customer_name}</span>}
        </div>
        <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${
          order.kitchen_status === "ready" || order.kitchen_status === "served"
            ? "bg-emerald-500/15 text-emerald-600"
            : "bg-amber-500/15 text-amber-600"
        }`}>
          {STATUS_LABEL[order.kitchen_status] || order.kitchen_status}
        </span>
      </div>

      <ul className="text-xs text-muted-foreground space-y-0.5">
        {order.order_items?.map((it) => (
          <li key={it.id}>{it.quantity}× {it.item_name}</li>
        ))}
      </ul>

      <div className="flex items-center justify-between border-t pt-2">
        <span className="text-sm font-bold tabular-nums">₹{Number(order.total_amount)}</span>
        <div className="flex gap-1.5">
          <Button variant="outline" size="sm" className="h-8 text-xs gap-1" disabled={settling} onClick={() => handleSettle("cash")}>
            <Banknote className="w-3.5 h-3.5" /> Cash
          </Button>
          <Button variant="outline" size="sm" className="h-8 text-xs gap-1" disabled={settling} onClick={() => handleSettle("card")}>
            <CreditCard className="w-3.5 h-3.5" /> Card
          </Button>
          <Button variant="outline" size="sm" className="h-8 text-xs gap-1" disabled={settling} onClick={() => handleSettle("upi")}>
            <Smartphone className="w-3.5 h-3.5" /> UPI
          </Button>
        </div>
      </div>
    </div>
  );
}

export function QRSettleDrawer({ canteenId, open, onOpenChange }: {
  canteenId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: orders } = useUnsettledQROrders(canteenId);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <QrCode className="w-4 h-4" /> QR orders to settle
          </SheetTitle>
          <SheetDescription>
            Self-service orders waiting to be paid at the counter. Take payment on pickup and settle with the mode used.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-3">
          {(orders?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">No unpaid QR orders right now.</p>
          ) : (
            orders!.map((o) => <SettleCard key={o.id} order={o} />)
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// Compact trigger for the POS toolbar — shows a live count badge.
export function QRSettleButton({ canteenId }: { canteenId?: string }) {
  const [open, setOpen] = useState(false);
  const { data: orders } = useUnsettledQROrders(canteenId);
  const count = orders?.length ?? 0;

  return (
    <>
      <Button variant={count > 0 ? "default" : "outline"} className="h-10 gap-1.5 relative shrink-0" onClick={() => setOpen(true)}>
        <QrCode className="w-4 h-4" />
        <span className="text-xs font-semibold">QR orders</span>
        {count > 0 && (
          <span className="ml-0.5 inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-full bg-background text-foreground text-[11px] font-bold tabular-nums">
            {count}
          </span>
        )}
      </Button>
      <QRSettleDrawer canteenId={canteenId} open={open} onOpenChange={setOpen} />
    </>
  );
}
