import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useMenuItems, useCreateOrder, useCanteens } from "@/hooks/useSupabaseData";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Plus, Minus, Trash2, CreditCard, Banknote, Smartphone } from "lucide-react";
import { toast } from "sonner";
import ReceiptPrint from "@/components/ReceiptPrint";
import KOTPrint from "@/components/KOTPrint";

interface CartItem {
  id: string;
  name: string;
  price: number;
  qty: number;
}

export default function POSPage() {
  const { selectedCanteen } = useAppContext();
  useRealtimeSubscription(["orders", "ingredients"]);
  const { data: dbMenuItems, isLoading } = useMenuItems(selectedCanteen);
  const { data: canteens } = useCanteens();
  const createOrder = useCreateOrder();
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [receiptData, setReceiptData] = useState<any>(null);
  const [kotData, setKotData] = useState<any>(null);

  const menuItems = dbMenuItems || [];
  const categories = ["All", ...Array.from(new Set(menuItems.map((i: any) => i.category)))];

  const filtered = menuItems.filter((item: any) => {
    const matchCat = activeCategory === "All" || item.category === activeCategory;
    const matchSearch = item.name.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch && item.available;
  });

  const addToCart = (item: any) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.id === item.id);
      if (existing) return prev.map((c) => (c.id === item.id ? { ...c, qty: c.qty + 1 } : c));
      return [...prev, { id: item.id, name: item.name, price: Number(item.price), qty: 1 }];
    });
  };

  const updateQty = (id: string, delta: number) => {
    setCart((prev) =>
      prev.map((c) => (c.id === id ? { ...c, qty: Math.max(0, c.qty + delta) } : c)).filter((c) => c.qty > 0)
    );
  };

  const total = cart.reduce((sum, c) => sum + c.price * c.qty, 0);

  const handleCheckout = async (paymentMode: string) => {
    if (selectedCanteen === "all") { toast.error("Select a canteen first"); return; }
    if (cart.length === 0) return;

    try {
      const order = await createOrder.mutateAsync({
        canteen_id: selectedCanteen,
        payment_mode: paymentMode,
        total_amount: total,
        items: cart.map((c) => ({
          menu_item_id: c.id,
          item_name: c.name,
          quantity: c.qty,
          unit_price: c.price,
          total_price: c.price * c.qty,
        })),
      });

      const canteenName = canteens?.find((c: any) => c.id === selectedCanteen)?.name || "Canteen";
      const dateStr = new Date().toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" });
      const cartItems = cart.map(c => ({ name: c.name, qty: c.qty, price: c.price }));

      setReceiptData({
        orderNumber: order.order_number,
        canteenName,
        items: cartItems,
        total,
        paymentMode,
        date: dateStr,
      });
      setKotData({
        orderNumber: order.order_number,
        canteenName,
        items: cartItems,
        date: dateStr,
      });

      toast.success(`Order completed! ₹${total} via ${paymentMode}`);
      setCart([]);
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  return (
    <AppLayout title="POS Billing">
      <div className="flex flex-col lg:flex-row gap-4 animate-fade-in" style={{ minHeight: "calc(100vh - 8rem)" }}>
        {/* Menu */}
        <div className="flex-1 space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search menu..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-10" />
          </div>

          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {categories.map((cat: any) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                  activeCategory === cat ? "bg-accent text-accent-foreground" : "bg-secondary text-secondary-foreground hover:bg-muted"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading menu...</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-12">No menu items. Add items via the database or create recipes first.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2.5">
              {filtered.map((item: any) => (
                <button
                  key={item.id}
                  onClick={() => addToCart(item)}
                  className="p-3 rounded-lg bg-card border hover:border-accent hover:shadow-md transition-all text-left group"
                >
                  <p className="text-sm font-medium group-hover:text-accent transition-colors">{item.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{item.category}</p>
                  <p className="text-sm font-bold mt-2">₹{Number(item.price)}</p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Cart */}
        <Card className="lg:w-80 xl:w-96 border-none shadow-sm flex flex-col">
          <div className="px-4 py-3 border-b">
            <h3 className="font-semibold text-sm">Current Order</h3>
          </div>
          <CardContent className="flex-1 p-0 flex flex-col">
            {cart.length === 0 ? (
              <div className="flex-1 flex items-center justify-center p-8">
                <p className="text-sm text-muted-foreground">Tap items to add</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {cart.map((item) => (
                  <div key={item.id} className="flex items-center justify-between py-2 border-b last:border-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{item.name}</p>
                      <p className="text-xs text-muted-foreground">₹{item.price} × {item.qty}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => updateQty(item.id, -1)} className="w-6 h-6 rounded bg-secondary flex items-center justify-center hover:bg-muted"><Minus className="w-3 h-3" /></button>
                      <span className="text-sm font-medium w-6 text-center">{item.qty}</span>
                      <button onClick={() => updateQty(item.id, 1)} className="w-6 h-6 rounded bg-secondary flex items-center justify-center hover:bg-muted"><Plus className="w-3 h-3" /></button>
                      <button onClick={() => updateQty(item.id, -item.qty)} className="w-6 h-6 rounded flex items-center justify-center text-destructive hover:bg-destructive/10"><Trash2 className="w-3 h-3" /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="border-t p-4 space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium text-muted-foreground">Total</span>
                <span className="text-xl font-bold">₹{total}</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Button variant="outline" size="sm" className="text-xs gap-1.5" disabled={cart.length === 0} onClick={() => handleCheckout("cash")}>
                  <Banknote className="w-3.5 h-3.5" /> Cash
                </Button>
                <Button variant="outline" size="sm" className="text-xs gap-1.5" disabled={cart.length === 0} onClick={() => handleCheckout("card")}>
                  <CreditCard className="w-3.5 h-3.5" /> Card
                </Button>
                <Button variant="outline" size="sm" className="text-xs gap-1.5" disabled={cart.length === 0} onClick={() => handleCheckout("upi")}>
                  <Smartphone className="w-3.5 h-3.5" /> UPI
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      {kotData && (
        <KOTPrint kot={kotData} onClose={() => setKotData(null)} />
      )}
      {receiptData && !kotData && <ReceiptPrint receipt={receiptData} onClose={() => setReceiptData(null)} />}
    </AppLayout>
  );
}
