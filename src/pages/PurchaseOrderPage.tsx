import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { usePurchases, useSuppliers, useCanteens, useAddSupplier, useCreatePurchase, useConfirmPurchase } from "@/hooks/useSupabaseData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Truck, Check, Clock, Package, Building2, ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface PurchaseItemForm {
  item_name: string;
  quantity: number;
  unit: string;
  rate: number;
  total: number;
}

export default function PurchaseOrderPage() {
  const { selectedCanteen } = useAppContext();
  const { data: purchases, isLoading } = usePurchases(selectedCanteen);
  const { data: suppliers } = useSuppliers(selectedCanteen);
  const { data: canteens } = useCanteens();
  const addSupplier = useAddSupplier();
  const createPurchase = useCreatePurchase();
  const confirmPurchase = useConfirmPurchase();

  const [orderDialog, setOrderDialog] = useState(false);
  const [supplierDialog, setSupplierDialog] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [notes, setNotes] = useState("");
  const [canteenId, setCanteenId] = useState(selectedCanteen === "all" ? "" : selectedCanteen);
  const [items, setItems] = useState<PurchaseItemForm[]>([
    { item_name: "", quantity: 0, unit: "kg", rate: 0, total: 0 }
  ]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Supplier form
  const [sName, setSName] = useState("");
  const [sContact, setSContact] = useState("");
  const [sPhone, setSPhone] = useState("");

  const updateItem = (idx: number, updates: Partial<PurchaseItemForm>) => {
    setItems(items.map((item, i) => {
      if (i !== idx) return item;
      const updated = { ...item, ...updates };
      updated.total = updated.quantity * updated.rate;
      return updated;
    }));
  };

  const handleCreateOrder = async () => {
    const targetCanteen = canteenId || selectedCanteen;
    if (!targetCanteen || targetCanteen === "all") { toast.error("Select a canteen"); return; }
    if (!supplierId) { toast.error("Select a supplier"); return; }
    const validItems = items.filter(i => i.item_name.trim());
    if (!validItems.length) { toast.error("Add at least one item"); return; }
    try {
      await createPurchase.mutateAsync({
        canteen_id: targetCanteen,
        supplier_id: supplierId,
        items: validItems,
        notes,
      });
      toast.success("Purchase order raised!");
      setOrderDialog(false);
      setSupplierId(""); setNotes(""); setCanteenId("");
      setItems([{ item_name: "", quantity: 0, unit: "kg", rate: 0, total: 0 }]);
    } catch (err: any) { toast.error(err.message); }
  };

  const handleAddSupplier = async () => {
    if (!sName) { toast.error("Supplier name required"); return; }
    try {
      await addSupplier.mutateAsync({
        name: sName, contact_person: sContact, phone: sPhone,
        canteen_id: selectedCanteen === "all" ? null : selectedCanteen,
      });
      toast.success("Supplier added!");
      setSupplierDialog(false);
      setSName(""); setSContact(""); setSPhone("");
    } catch (err: any) { toast.error(err.message); }
  };

  const getCanteenName = (id: string) => canteens?.find((c: any) => c.id === id)?.name || "Unknown";
  const getSupplierName = (id: string) => suppliers?.find((s: any) => s.id === id)?.name || "No supplier";

  const draft = purchases?.filter((p: any) => p.status === "draft") || [];
  const confirmed = purchases?.filter((p: any) => p.status === "confirmed") || [];

  // Frequently ordered items per supplier
  const freqItems: Record<string, Record<string, number>> = {};
  purchases?.forEach((p: any) => {
    if (!p.supplier_id) return;
    p.purchase_items?.forEach((item: any) => {
      if (!freqItems[p.supplier_id]) freqItems[p.supplier_id] = {};
      freqItems[p.supplier_id][item.item_name] = (freqItems[p.supplier_id][item.item_name] || 0) + 1;
    });
  });

  return (
    <AppLayout title="Purchase Orders">
      <div className="space-y-4 animate-fade-in">

        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-muted-foreground">Raise and manage purchase orders from suppliers</p>
          <div className="flex gap-2">
            <Dialog open={supplierDialog} onOpenChange={setSupplierDialog}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  <Truck className="w-4 h-4" /> Add Supplier
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Add Supplier</DialogTitle></DialogHeader>
                <div className="space-y-3 mt-2">
                  <div><Label className="text-xs">Supplier Name *</Label><Input value={sName} onChange={e => setSName(e.target.value)} placeholder="ABC Traders" /></div>
                  <div><Label className="text-xs">Contact Person</Label><Input value={sContact} onChange={e => setSContact(e.target.value)} placeholder="John" /></div>
                  <div><Label className="text-xs">Phone</Label><Input value={sPhone} onChange={e => setSPhone(e.target.value)} placeholder="9876543210" /></div>
                  <Button className="w-full bg-accent text-accent-foreground" onClick={handleAddSupplier} disabled={addSupplier.isPending}>
                    {addSupplier.isPending ? "Adding..." : "Add Supplier"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>

            <Dialog open={orderDialog} onOpenChange={setOrderDialog}>
              <DialogTrigger asChild>
                <Button className="bg-accent text-accent-foreground hover:bg-accent/90 gap-1.5" size="sm">
                  <Plus className="w-4 h-4" /> Raise Order
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader><DialogTitle>Raise Purchase Order</DialogTitle></DialogHeader>
                <div className="space-y-4 mt-2">
                  {selectedCanteen === "all" && (
                    <div>
                      <Label className="text-xs">Canteen *</Label>
                      <Select value={canteenId} onValueChange={setCanteenId}>
                        <SelectTrigger><SelectValue placeholder="Select canteen..." /></SelectTrigger>
                        <SelectContent>
                          {canteens?.map((c: any) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div>
                    <Label className="text-xs">Supplier *</Label>
                    <Select value={supplierId} onValueChange={setSupplierId}>
                      <SelectTrigger><SelectValue placeholder="Select supplier..." /></SelectTrigger>
                      <SelectContent>
                        {suppliers?.map((s: any) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Frequently ordered items hint */}
                  {supplierId && freqItems[supplierId] && (
                    <div className="bg-accent/5 rounded-lg p-3">
                      <p className="text-xs font-medium mb-2">📦 Frequently ordered from this supplier:</p>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(freqItems[supplierId])
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 6)
                          .map(([name, count]) => (
                            <button
                              key={name}
                              onClick={() => setItems(prev => [...prev, { item_name: name, quantity: 0, unit: "kg", rate: 0, total: 0 }])}
                              className="text-xs bg-accent/10 text-accent px-2 py-1 rounded hover:bg-accent/20"
                            >
                              + {name} ({count}x)
                            </button>
                          ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <Label className="text-xs">Items *</Label>
                      <Button variant="outline" size="sm" onClick={() => setItems(prev => [...prev, { item_name: "", quantity: 0, unit: "kg", rate: 0, total: 0 }])}>
                        <Plus className="w-3 h-3 mr-1" /> Add Item
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {items.map((item, idx) => (
                        <div key={idx} className="flex gap-2 items-end">
                          <div className="flex-1">
                            <Input className="h-8 text-xs" placeholder="Item name" value={item.item_name} onChange={e => updateItem(idx, { item_name: e.target.value })} />
                          </div>
                          <div className="w-16">
                            <Input type="number" className="h-8 text-xs" placeholder="Qty" value={item.quantity || ""} onChange={e => updateItem(idx, { quantity: Number(e.target.value) })} />
                          </div>
                          <div className="w-16">
                            <Input className="h-8 text-xs" placeholder="Unit" value={item.unit} onChange={e => updateItem(idx, { unit: e.target.value })} />
                          </div>
                          <div className="w-20">
                            <Input type="number" className="h-8 text-xs" placeholder="Rate ₹" value={item.rate || ""} onChange={e => updateItem(idx, { rate: Number(e.target.value) })} />
                          </div>
                          <div className="w-20">
                            <Input className="h-8 text-xs bg-muted" readOnly value={`₹${item.total}`} />
                          </div>
                          {items.length > 1 && (
                            <button onClick={() => setItems(items.filter((_, i) => i !== idx))} className="text-destructive hover:bg-destructive/10 p-1 rounded">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <Label className="text-xs">Notes</Label>
                    <Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Any special instructions..." />
                  </div>

                  <div className="flex justify-between items-center pt-2 border-t">
                    <span className="text-sm font-semibold">Total: ₹{items.reduce((s, i) => s + i.total, 0).toLocaleString()}</span>
                    <Button className="bg-accent text-accent-foreground hover:bg-accent/90" onClick={handleCreateOrder} disabled={createPurchase.isPending}>
                      {createPurchase.isPending ? "Raising..." : "Raise Order"}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          <Card className="border-none shadow-sm">
            <CardContent className="p-3 flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-yellow-500/10 flex items-center justify-center">
                <Clock className="w-4 h-4 text-yellow-600" />
              </div>
              <div>
                <p className="text-lg font-bold">{draft.length}</p>
                <p className="text-xs text-muted-foreground">Pending Orders</p>
              </div>
            </CardContent>
          </Card>
          <Card className="border-none shadow-sm">
            <CardContent className="p-3 flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-green-500/10 flex items-center justify-center">
                <Check className="w-4 h-4 text-green-600" />
              </div>
              <div>
                <p className="text-lg font-bold">{confirmed.length}</p>
                <p className="text-xs text-muted-foreground">Confirmed Orders</p>
              </div>
            </CardContent>
          </Card>
          <Card className="border-none shadow-sm">
            <CardContent className="p-3 flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center">
                <Truck className="w-4 h-4 text-accent" />
              </div>
              <div>
                <p className="text-lg font-bold">{suppliers?.length || 0}</p>
                <p className="text-xs text-muted-foreground">Suppliers</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Orders list */}
        <Tabs defaultValue="pending">
          <TabsList>
            <TabsTrigger value="pending">Pending ({draft.length})</TabsTrigger>
            <TabsTrigger value="confirmed">Confirmed ({confirmed.length})</TabsTrigger>
            <TabsTrigger value="suppliers">Suppliers ({suppliers?.length || 0})</TabsTrigger>
          </TabsList>

          <TabsContent value="pending" className="space-y-2 mt-3">
            {draft.length === 0 ? (
              <Card className="border-none shadow-sm"><CardContent className="p-8 text-center text-sm text-muted-foreground">No pending orders</CardContent></Card>
            ) : draft.map((p: any) => (
              <Card key={p.id} className="border-none shadow-sm">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-yellow-500/10 flex items-center justify-center">
                        <Clock className="w-4 h-4 text-yellow-600" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{getSupplierName(p.supplier_id)}</p>
                        <p className="text-xs text-muted-foreground">{getCanteenName(p.canteen_id)} • {new Date(p.created_at).toLocaleDateString("en-IN")}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">₹{Number(p.total_amount || 0).toLocaleString()}</span>
                      <Button size="sm" className="bg-green-500 text-white hover:bg-green-600 gap-1 h-7 text-xs"
                        onClick={() => confirmPurchase.mutate(p.id)}>
                        <Check className="w-3 h-3" /> Accept
                      </Button>
                      <button onClick={() => setExpandedId(expandedId === p.id ? null : p.id)} className="p-1 text-muted-foreground">
                        {expandedId === p.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  {expandedId === p.id && p.purchase_items && (
                    <div className="mt-3 pt-3 border-t space-y-1">
                      {p.purchase_items.map((item: any, i: number) => (
                        <div key={i} className="flex justify-between text-xs text-muted-foreground">
                          <span>{item.item_name} — {item.quantity} {item.unit}</span>
                          <span>₹{item.total}</span>
                        </div>
                      ))}
                      {p.notes && <p className="text-xs text-muted-foreground mt-2">📝 {p.notes}</p>}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </TabsContent>

          <TabsContent value="confirmed" className="space-y-2 mt-3">
            {confirmed.length === 0 ? (
              <Card className="border-none shadow-sm"><CardContent className="p-8 text-center text-sm text-muted-foreground">No confirmed orders</CardContent></Card>
            ) : confirmed.map((p: any) => (
              <Card key={p.id} className="border-none shadow-sm">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-green-500/10 flex items-center justify-center">
                        <Check className="w-4 h-4 text-green-600" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{getSupplierName(p.supplier_id)}</p>
                        <p className="text-xs text-muted-foreground">{getCanteenName(p.canteen_id)} • {new Date(p.created_at).toLocaleDateString("en-IN")}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/20 text-xs">Confirmed</Badge>
                      <span className="text-sm font-semibold">₹{Number(p.total_amount || 0).toLocaleString()}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </TabsContent>

          <TabsContent value="suppliers" className="space-y-2 mt-3">
            {!suppliers?.length ? (
              <Card className="border-none shadow-sm"><CardContent className="p-8 text-center text-sm text-muted-foreground">No suppliers yet. Add your first supplier!</CardContent></Card>
            ) : suppliers.map((s: any) => (
              <Card key={s.id} className="border-none shadow-sm">
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center">
                      <Truck className="w-4 h-4 text-accent" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium">{s.name}</p>
                      <p className="text-xs text-muted-foreground">{s.contact_person} • {s.phone}</p>
                    </div>
                    {freqItems[s.id] && (
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Top item:</p>
                        <p className="text-xs font-medium">
                          {Object.entries(freqItems[s.id]).sort((a, b) => b[1] - a[1])[0]?.[0]}
                        </p>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
