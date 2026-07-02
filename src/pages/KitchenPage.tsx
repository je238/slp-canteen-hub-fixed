import { useEffect, useMemo, useRef, useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import {
  KitchenOrder,
  useKdsSchemaReady,
  useKitchenQueue,
  useServedToday,
  useUpdateKitchenStatus,
} from "@/hooks/useKitchenOrders";
import KdsSetupBanner from "@/components/KdsSetupBanner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChefHat, Flame, CheckCheck, Bell, BellOff, Maximize2, Minimize2, QrCode, ReceiptText, X } from "lucide-react";
import { toast } from "sonner";

// Re-render every second so elapsed timers tick.
function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function elapsed(from: string, now: number) {
  const secs = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function elapsedMinutes(from: string, now: number) {
  return (now - new Date(from).getTime()) / 60_000;
}

function playNewOrderChime() {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = "sine";
      const t = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.start(t);
      osc.stop(t + 0.4);
    });
    setTimeout(() => ctx.close(), 1200);
  } catch {
    // audio unavailable — silent fallback
  }
}

const LANES: { key: "new" | "preparing" | "ready"; label: string; icon: typeof ChefHat; accent: string }[] = [
  { key: "new", label: "New", icon: ReceiptText, accent: "border-t-blue-500" },
  { key: "preparing", label: "Cooking", icon: Flame, accent: "border-t-amber-500" },
  { key: "ready", label: "Ready", icon: CheckCheck, accent: "border-t-emerald-500" },
];

const NEXT_ACTION: Record<string, { to: "preparing" | "ready" | "served"; label: string }> = {
  new: { to: "preparing", label: "Start cooking" },
  preparing: { to: "ready", label: "Mark ready" },
  ready: { to: "served", label: "Served" },
};

function OrderCard({ order, now, onAdvance, onCancel }: {
  order: KitchenOrder;
  now: number;
  onAdvance: (order: KitchenOrder) => void;
  onCancel: (order: KitchenOrder) => void;
}) {
  const mins = elapsedMinutes(order.created_at, now);
  const timeTone = mins >= 10 ? "text-red-500" : mins >= 5 ? "text-amber-500" : "text-muted-foreground";
  const action = NEXT_ACTION[order.kitchen_status];

  return (
    <Card className="p-3 space-y-2.5 shadow-sm border-none animate-fade-in">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-2xl font-extrabold tabular-nums leading-none">#{order.order_number}</span>
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${
            order.order_type === "qr" ? "bg-violet-500/15 text-violet-600" : "bg-blue-500/15 text-blue-600"
          }`}>
            {order.order_type === "qr" ? <QrCode className="w-3 h-3" /> : <ReceiptText className="w-3 h-3" />}
            {order.order_type === "qr" ? "QR" : "POS"}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`text-sm font-semibold tabular-nums ${timeTone}`}>{elapsed(order.created_at, now)}</span>
          <button
            onClick={() => onCancel(order)}
            className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            aria-label={`Cancel order ${order.order_number}`}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {order.customer_name && (
        <p className="text-xs font-medium text-muted-foreground truncate">{order.customer_name}</p>
      )}

      <ul className="space-y-1">
        {order.order_items?.map((it) => (
          <li key={it.id} className="flex items-baseline gap-2 text-sm">
            <span className="font-bold tabular-nums shrink-0">{it.quantity}×</span>
            <span className="truncate">{it.item_name}</span>
          </li>
        ))}
      </ul>

      {order.special_instructions && (
        <p className="text-xs rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400 px-2 py-1.5 font-medium">
          “{order.special_instructions}”
        </p>
      )}

      {action && (
        <Button className="w-full h-10 text-sm font-semibold" onClick={() => onAdvance(order)}>
          {action.label}
        </Button>
      )}
    </Card>
  );
}

export default function KitchenPage() {
  const { selectedCanteen } = useAppContext();
  useRealtimeSubscription(["orders"]);
  const { data: schemaReady, isLoading: schemaLoading } = useKdsSchemaReady();
  const enabled = schemaReady === true;
  const { data: queue, isLoading } = useKitchenQueue(selectedCanteen, enabled);
  const { data: served } = useServedToday(selectedCanteen, enabled);
  const updateStatus = useUpdateKitchenStatus();
  const now = useNow();

  const [soundOn, setSoundOn] = useState(() => localStorage.getItem("kds-sound") !== "off");
  const [fullscreen, setFullscreen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<KitchenOrder | null>(null);
  const seenIds = useRef<Set<string> | null>(null);

  // Chime when a brand-new order appears (skip the initial load).
  useEffect(() => {
    if (!queue) return;
    if (seenIds.current === null) {
      seenIds.current = new Set(queue.map((o) => o.id));
      return;
    }
    const fresh = queue.filter((o) => !seenIds.current!.has(o.id));
    if (fresh.length > 0) {
      fresh.forEach((o) => seenIds.current!.add(o.id));
      if (soundOn) playNewOrderChime();
    }
  }, [queue, soundOn]);

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    localStorage.setItem("kds-sound", next ? "on" : "off");
  };

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        setFullscreen(true);
      } else {
        await document.exitFullscreen();
        setFullscreen(false);
      }
    } catch {
      toast.error("Fullscreen not available");
    }
  };

  const lanes = useMemo(() => {
    const q = queue || [];
    return {
      new: q.filter((o) => o.kitchen_status === "new"),
      preparing: q.filter((o) => o.kitchen_status === "preparing"),
      ready: q.filter((o) => o.kitchen_status === "ready"),
    };
  }, [queue]);

  const avgPrepMins = useMemo(() => {
    const done = (served || []).filter((o) => o.ready_at);
    if (done.length === 0) return null;
    const total = done.reduce(
      (s, o) => s + (new Date(o.ready_at!).getTime() - new Date(o.created_at).getTime()) / 60_000,
      0
    );
    return total / done.length;
  }, [served]);

  const advance = (order: KitchenOrder) => {
    const action = NEXT_ACTION[order.kitchen_status];
    if (!action) return;
    updateStatus.mutate(
      { id: order.id, kitchen_status: action.to },
      { onError: (e: any) => toast.error(e.message) }
    );
  };

  const confirmCancel = () => {
    if (!cancelTarget) return;
    updateStatus.mutate(
      { id: cancelTarget.id, kitchen_status: "cancelled" },
      {
        onSuccess: () => toast.success(`Order #${cancelTarget.order_number} cancelled`),
        onError: (e: any) => toast.error(e.message),
      }
    );
    setCancelTarget(null);
  };

  if (!schemaLoading && schemaReady === false) {
    return (
      <AppLayout title="Kitchen Display">
        <KdsSetupBanner feature="The Kitchen Display System" />
      </AppLayout>
    );
  }

  return (
    <AppLayout title="Kitchen Display">
      <div className="space-y-4 animate-fade-in">
        {/* KPI strip + controls */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 flex-1 flex-wrap">
            {[
              { label: "In queue", value: lanes.new.length },
              { label: "Cooking", value: lanes.preparing.length },
              { label: "Ready", value: lanes.ready.length },
              { label: "Served today", value: served?.length ?? 0 },
              { label: "Avg prep", value: avgPrepMins === null ? "—" : `${avgPrepMins.toFixed(1)}m` },
            ].map((kpi) => (
              <div key={kpi.label} className="px-3 py-1.5 rounded-lg bg-card border shadow-sm">
                <span className="text-xs text-muted-foreground mr-2">{kpi.label}</span>
                <span className="text-sm font-bold tabular-nums">{kpi.value}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="icon" className="h-9 w-9" onClick={toggleSound} aria-label="Toggle new-order sound">
              {soundOn ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
            </Button>
            <Button variant="outline" size="icon" className="h-9 w-9" onClick={toggleFullscreen} aria-label="Toggle fullscreen">
              {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </Button>
          </div>
        </div>

        {/* Board */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
          {LANES.map((lane) => {
            const orders = lanes[lane.key];
            return (
              <div key={lane.key} className={`rounded-xl bg-secondary/50 border-t-4 ${lane.accent} min-h-[50vh]`}>
                <div className="flex items-center gap-2 px-4 py-3">
                  <lane.icon className="w-4 h-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">{lane.label}</h3>
                  <span className="ml-auto text-xs font-bold tabular-nums bg-card border rounded-full px-2 py-0.5">
                    {orders.length}
                  </span>
                </div>
                <div className="px-3 pb-3 space-y-3">
                  {isLoading ? (
                    <p className="text-xs text-muted-foreground text-center py-8">Loading…</p>
                  ) : orders.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-8">
                      {lane.key === "new" ? "No new orders — all caught up" : "Nothing here"}
                    </p>
                  ) : (
                    orders.map((o) => (
                      <OrderCard key={o.id} order={o} now={now} onAdvance={advance} onCancel={setCancelTarget} />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Served history */}
        {(served?.length ?? 0) > 0 && (
          <div className="rounded-xl border bg-card p-4">
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
              <ChefHat className="w-4 h-4 text-muted-foreground" /> Served today
            </h3>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {served!.map((o) => (
                <div key={o.id} className="shrink-0 px-3 py-2 rounded-lg bg-secondary text-center min-w-[72px]">
                  <p className="text-sm font-bold tabular-nums">#{o.order_number}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {o.served_at ? new Date(o.served_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : ""}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <AlertDialog open={!!cancelTarget} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel order #{cancelTarget?.order_number}?</AlertDialogTitle>
            <AlertDialogDescription>
              The order will be removed from the kitchen queue and marked cancelled.
              {cancelTarget?.order_type === "qr" ? " The customer's tracking screen will show it as cancelled." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep order</AlertDialogCancel>
            <AlertDialogAction onClick={confirmCancel} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Cancel order
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
