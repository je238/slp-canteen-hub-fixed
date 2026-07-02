import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useMenuItems } from "@/hooks/useSupabaseData";
import { useCreateQROrder, useTrackOrder, isSchemaMissingError } from "@/hooks/useKitchenOrders";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Search, Plus, Minus, ShoppingBag, ChevronLeft, ChefHat, CheckCircle2, Clock, UtensilsCrossed, XCircle } from "lucide-react";
import { toast } from "sonner";
import { orderTotals } from "@/lib/pricing";

interface CartLine {
  id: string;
  name: string;
  price: number;
  qty: number;
}

function activeOrderKey(canteenId: string) {
  return `qr-active-order-${canteenId}`;
}

// ---------- Tracking view ----------

const TRACK_STEPS = [
  { key: "new", label: "Order placed", desc: "The kitchen has your order", icon: CheckCircle2 },
  { key: "preparing", label: "Cooking", desc: "Your food is being prepared", icon: ChefHat },
  { key: "ready", label: "Ready for pickup", desc: "Collect it at the counter", icon: UtensilsCrossed },
] as const;

function TrackingView({ orderId, canteenName, onNewOrder }: { orderId: string; canteenName: string; onNewOrder: () => void }) {
  const { data: order, isLoading } = useTrackOrder(orderId);

  // A finished order from a previous day is history, not something to keep
  // showing — clear it so scanning the poster tomorrow lands on the menu.
  const isStale =
    !!order &&
    (order.kitchen_status === "served" || order.kitchen_status === "cancelled") &&
    new Date(order.created_at) < new Date(new Date().setHours(0, 0, 0, 0));
  useEffect(() => {
    if (isStale) onNewOrder();
  }, [isStale, onNewOrder]);

  if (isLoading) {
    return <p className="text-center text-sm text-muted-foreground py-16">Loading your order…</p>;
  }
  if (!order) {
    return (
      <div className="text-center py-16 space-y-4">
        <p className="text-sm text-muted-foreground">We couldn't find that order anymore.</p>
        <Button onClick={onNewOrder}>Start a new order</Button>
      </div>
    );
  }

  const cancelled = order.kitchen_status === "cancelled";
  const served = order.kitchen_status === "served";
  const stepIndex = order.kitchen_status === "new" ? 0 : order.kitchen_status === "preparing" ? 1 : 2;

  return (
    <div className="max-w-md mx-auto px-4 py-8 space-y-6 animate-fade-in">
      <div className="text-center space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{canteenName} · Your token</p>
        <p className="text-6xl font-extrabold tabular-nums">#{order.order_number}</p>
        {order.customer_name && <p className="text-sm text-muted-foreground">for {order.customer_name}</p>}
      </div>

      {cancelled ? (
        <div className="rounded-xl border bg-destructive/5 p-5 text-center space-y-1">
          <XCircle className="w-8 h-8 text-destructive mx-auto" />
          <p className="font-semibold">Order cancelled</p>
          <p className="text-xs text-muted-foreground">Please ask at the counter if this is unexpected.</p>
        </div>
      ) : (
        <div className="rounded-xl border bg-card p-5 space-y-5">
          {TRACK_STEPS.map((step, i) => {
            const done = served || i < stepIndex || (i === stepIndex && step.key === "ready" && order.kitchen_status === "ready");
            const current = !served && i === stepIndex;
            return (
              <div key={step.key} className="flex items-start gap-3">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                  done ? "bg-emerald-500 text-white" : current ? "bg-accent text-accent-foreground animate-pulse" : "bg-secondary text-muted-foreground"
                }`}>
                  <step.icon className="w-[18px] h-[18px]" />
                </div>
                <div className="pt-1">
                  <p className={`text-sm font-semibold ${done || current ? "" : "text-muted-foreground"}`}>{step.label}</p>
                  <p className="text-xs text-muted-foreground">{step.desc}</p>
                </div>
              </div>
            );
          })}
          {served && (
            <p className="text-center text-sm font-medium text-emerald-600">Enjoy your meal! 🎉</p>
          )}
        </div>
      )}

      <div className="rounded-xl border bg-card p-4 space-y-2">
        {order.order_items?.map((it) => (
          <div key={it.id} className="flex justify-between text-sm">
            <span>{it.quantity}× {it.item_name}</span>
            <span className="tabular-nums">₹{Number(it.total_price)}</span>
          </div>
        ))}
        <div className="border-t pt-2 flex justify-between text-sm font-bold">
          <span>Total (incl. 5% GST)</span>
          <span className="tabular-nums">₹{Number(order.total_amount)}</span>
        </div>
        {!cancelled && order.payment_status === "unpaid" && (
          <p className="text-xs rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400 px-2 py-1.5 font-medium text-center">
            Pay ₹{Number(order.total_amount)} at the counter when you collect your food
          </p>
        )}
      </div>

      <Button variant="outline" className="w-full" onClick={onNewOrder}>Order something else</Button>
    </div>
  );
}

// ---------- Menu + cart view ----------

export default function QROrderPage() {
  const { canteenId = "" } = useParams();
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [activeOrderId, setActiveOrderId] = useState<string | null>(() => localStorage.getItem(activeOrderKey(canteenId)));
  const [setupNeeded, setSetupNeeded] = useState(false);

  const { data: canteen, isLoading: canteenLoading } = useQuery({
    queryKey: ["qrCanteen", canteenId],
    enabled: !!canteenId,
    queryFn: async () => {
      const { data, error } = await supabase.from("canteens").select("id, name, location").eq("id", canteenId).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const { data: menuItems, isLoading: menuLoading } = useMenuItems(canteenId);
  const createOrder = useCreateQROrder();

  useEffect(() => {
    setActiveOrderId(localStorage.getItem(activeOrderKey(canteenId)));
  }, [canteenId]);

  const available = useMemo(
    () => (menuItems || []).filter((i: any) => i.available),
    [menuItems]
  );
  const categories = useMemo(
    () => ["All", ...Array.from(new Set(available.map((i: any) => i.category)))],
    [available]
  );
  const filtered = available.filter((item: any) => {
    const matchCat = activeCategory === "All" || item.category === activeCategory;
    return matchCat && item.name.toLowerCase().includes(search.toLowerCase());
  });

  const qtyOf = (id: string) => cart.find((c) => c.id === id)?.qty ?? 0;
  const changeQty = (item: any, delta: number) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.id === item.id);
      if (!existing && delta > 0) return [...prev, { id: item.id, name: item.name, price: Number(item.price), qty: 1 }];
      return prev
        .map((c) => (c.id === item.id ? { ...c, qty: c.qty + delta } : c))
        .filter((c) => c.qty > 0);
    });
  };

  const { subtotal, gst, total } = orderTotals(cart.reduce((s, c) => s + c.price * c.qty, 0));
  const itemCount = cart.reduce((s, c) => s + c.qty, 0);

  const placeOrder = async () => {
    try {
      const { order } = await createOrder.mutateAsync({
        canteen_id: canteenId,
        items: cart.map((c) => ({ menu_item_id: c.id, quantity: c.qty })),
        customer_name: customerName.trim() || undefined,
        special_instructions: instructions.trim() || undefined,
      });
      localStorage.setItem(activeOrderKey(canteenId), order.id);
      setActiveOrderId(order.id);
      setCart([]);
      setCheckoutOpen(false);
      setCustomerName("");
      setInstructions("");
    } catch (err: any) {
      if (isSchemaMissingError(err)) setSetupNeeded(true);
      else toast.error(err.message || "Could not place the order. Please try again.");
    }
  };

  const startNewOrder = () => {
    localStorage.removeItem(activeOrderKey(canteenId));
    setActiveOrderId(null);
  };

  // ---------- Render ----------

  if (!canteenLoading && !canteen) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <UtensilsCrossed className="w-10 h-10 text-muted-foreground mx-auto" />
          <h1 className="font-semibold">Canteen not found</h1>
          <p className="text-sm text-muted-foreground">This QR code doesn't match an active canteen. Please ask the staff for a new code.</p>
        </div>
      </div>
    );
  }

  if (setupNeeded) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="text-center space-y-2 max-w-sm">
          <Clock className="w-10 h-10 text-muted-foreground mx-auto" />
          <h1 className="font-semibold">QR ordering is being set up</h1>
          <p className="text-sm text-muted-foreground">Self-service ordering isn't switched on yet for this canteen. Please order at the counter for now.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-background/95 backdrop-blur border-b">
        <div className="max-w-md mx-auto px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center shrink-0">
              <UtensilsCrossed className="w-4 h-4 text-accent-foreground" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-bold truncate">{canteen?.name || "…"}</h1>
              <p className="text-[10px] text-muted-foreground">Order here · Pay at counter</p>
            </div>
          </div>
        </div>
      </header>

      {activeOrderId ? (
        <TrackingView orderId={activeOrderId} canteenName={canteen?.name || ""} onNewOrder={startNewOrder} />
      ) : checkoutOpen ? (
        /* Checkout */
        <div className="max-w-md mx-auto px-4 py-4 space-y-4 animate-fade-in pb-28">
          <button onClick={() => setCheckoutOpen(false)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeft className="w-4 h-4" /> Back to menu
          </button>

          <div className="rounded-xl border bg-card p-4 space-y-2">
            {cart.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{c.name}</p>
                  <p className="text-xs text-muted-foreground">₹{c.price} each</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => changeQty(c, -1)} className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center"><Minus className="w-3.5 h-3.5" /></button>
                  <span className="text-sm font-bold w-5 text-center tabular-nums">{c.qty}</span>
                  <button onClick={() => changeQty(c, 1)} className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center"><Plus className="w-3.5 h-3.5" /></button>
                </div>
              </div>
            ))}
            <div className="border-t pt-2 space-y-1 text-sm">
              <div className="flex justify-between text-muted-foreground"><span>Subtotal</span><span className="tabular-nums">₹{subtotal}</span></div>
              <div className="flex justify-between text-muted-foreground"><span>GST (5%)</span><span className="tabular-nums">₹{gst}</span></div>
              <div className="flex justify-between font-bold text-base"><span>Total</span><span className="tabular-nums">₹{total}</span></div>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label htmlFor="qr-name" className="text-xs font-medium text-muted-foreground">Your name (optional)</label>
              <Input id="qr-name" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="So we can call you" className="mt-1 h-11" maxLength={60} />
            </div>
            <div>
              <label htmlFor="qr-notes" className="text-xs font-medium text-muted-foreground">Special instructions (optional)</label>
              <Textarea id="qr-notes" value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Less spicy, no onions…" className="mt-1" rows={2} maxLength={200} />
            </div>
          </div>

          <Button className="w-full h-12 text-base font-semibold" disabled={cart.length === 0 || createOrder.isPending} onClick={placeOrder}>
            {createOrder.isPending ? "Placing order…" : `Place order · ₹${total}`}
          </Button>
          <p className="text-[11px] text-center text-muted-foreground">You'll get a token number and pay at the counter on pickup.</p>
        </div>
      ) : (
        /* Menu */
        <div className="max-w-md mx-auto px-4 py-4 space-y-3 pb-28">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search the menu…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-11" />
          </div>

          <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-4 px-4">
            {categories.map((cat: any) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-3.5 py-2 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                  activeCategory === cat ? "bg-accent text-accent-foreground" : "bg-secondary text-secondary-foreground"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {menuLoading ? (
            <p className="text-sm text-muted-foreground text-center py-12">Loading menu…</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-12">No items match your search.</p>
          ) : (
            <div className="space-y-2">
              {filtered.map((item: any) => {
                const qty = qtyOf(item.id);
                return (
                  <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border bg-card p-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{item.name}</p>
                      <p className="text-xs text-muted-foreground">{item.category}</p>
                      <p className="text-sm font-bold mt-0.5 tabular-nums">₹{Number(item.price)}</p>
                    </div>
                    {qty === 0 ? (
                      <Button variant="outline" size="sm" className="h-9 px-4 font-semibold shrink-0" onClick={() => changeQty(item, 1)}>
                        Add
                      </Button>
                    ) : (
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => changeQty(item, -1)} className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center"><Minus className="w-4 h-4" /></button>
                        <span className="text-sm font-bold w-5 text-center tabular-nums">{qty}</span>
                        <button onClick={() => changeQty(item, 1)} className="w-9 h-9 rounded-lg bg-accent text-accent-foreground flex items-center justify-center"><Plus className="w-4 h-4" /></button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Sticky cart bar */}
      {!activeOrderId && !checkoutOpen && itemCount > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-40 p-4 bg-gradient-to-t from-background via-background to-transparent">
          <div className="max-w-md mx-auto">
            <Button className="w-full h-12 text-base font-semibold gap-2 shadow-lg" onClick={() => setCheckoutOpen(true)}>
              <ShoppingBag className="w-4 h-4" />
              View order · {itemCount} item{itemCount > 1 ? "s" : ""} · ₹{total}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
