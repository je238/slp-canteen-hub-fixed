import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { usePurchases, useSuppliers, useAddSupplier, useCreatePurchase, useConfirmPurchase } from "@/hooks/useSupabaseData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Truck, Check, Clock, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface PurchaseItemForm {
  item_name: string;
  quantity: number;
  unit: string;
  rate: number;
  total: number;
}

export default function PurchasesPage() {
  const { selectedCanteen } = useAppContext();
  const { data: purchases, isLoading } = usePurchases(selectedCanteen);
  const { data: suppliers } = useSuppliers(selectedCanteen);
  const addSupplier = useAddSupplier();
  const createPurchase = useCreatePurchase();
  const confirmPurchase = useConfirmPurchase();

  const [purchaseDialog, setPurchaseDialog] = useState(false);
  const [supplierDialog, setSupplierDialog] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<PurchaseItemForm[]>([{ item_name: "", quantity: 0, unit: "kg", rate: 0, total: 0 }]);

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

  const handleCreatePurchase = async () => {
    if (selectedCanteen === "all") { toast.error("Select a canteen first"); return; }
    const validItems = items.filter(i => i.item_name && i.quantity > 0);
    if (validItems.length === 0) { toast.error("Add at least one item"); return; }

    try {
      await createPurchase.mutateAsync({
        canteen_id: selectedCanteen,
        supplier_id: supplierId || undefined,
        items: validItems,
        notes: notes || undefined,
      });
      toast.success("Purchase draft created!");
      setPurchaseDialog(false);
      setItems([{ item_name: "", quantity: 0, unit: "kg", rate: 0, total: 0 }]);
      setNotes("");
      setSupplierId("");
    } catch (err: any) { toast.error(err.message); }
  };

  const handleAddSupplier = async () => {
    if (!sName) return;
    try {
      await addSupplier.mutateAsync({
        name: sName,
        contact_person: sContact || undefined,
        phone: sPhone || undefined,
        canteen_id: selectedCanteen !== "all" ? selectedCanteen : undefined,
      });
      toast.success("Supplier added!");
      setSupplierDialog(false);
      setSName(""); setSContact(""); setSPhone("");
    } catch (err: any) { toast.error(err.message); }
  };

  const handleConfirm = async (id: string) => {
    try {
      await confirmPurchase.mutateAsync(id);
      toast.success("Purchase confirmed & stock updated!");
    } catch (err: any) { toast.error(err.message); }
  };

  const drafts = purchases?.filter((p: any) => p.status === "draft") || [];
  const confirmed = purchases?.filter((p: any) => p.status === "confirmed") || [];

  return (
    <AppLayout title="Purchases & Suppliers">
      <div className="space-y-4 animate-fade-in">
        <div className="flex items-center gap-2 justify-end">
          <Dialog open={supplierDialog} onOpenChange={setSupplierDialog}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 text-xs"><Plus className="w-3 h-3" /> Add Supplier</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Add Supplier</DialogTitle></DialogHeader>
              <div className="space-y-3 mt-2">
                <div><Label className="text-xs">Name</Label><Input value={sName} onChange={e => setSName(e.target.value)} /></div>
                <div><Label className="text-xs">Contact Person</Label><Input value={sContact} onChange={e => setSContact(e.target.value)} /></div>
                <div><Label className="text-xs">Phone</Label><Input value={sPhone} onChange={e => setSPhone(e.target.value)} /></div>
                <Button onClick={handleAddSupplier} className="w-full bg-accent text-accent-foreground hover:bg-accent/90">Add Supplier</Button>
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={purchaseDialog} onOpenChange={setPurchaseDialog}>
            <DialogTrigger asChild>
              <Button className="bg-accent text-accent-foreground hover:bg-accent/90 gap-1.5" size="sm"><Plus className="w-4 h-4" /> New Purchase</Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
              <DialogHeader><DialogTitle>Create Purchase Entry</DialogTitle></DialogHeader>
              <div className="space-y-4 mt-2">
                <div>
                  <Label className="text-xs">Supplier</Label>
                  <Select value={supplierId} onValueChange={setSupplierId}>
                    <SelectTrigger><SelectValue placeholder="Select supplier..." /></SelectTrigger>
                    <SelectContent>
                      {suppliers?.map((s: any) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <Label className="text-sm font-semibold">Items</Label>
                    <Button variant="outline" size="sm" className="text-xs" onClick={() => setItems([...items, { item_name: "", quantity: 0, unit: "kg", rate: 0, total: 0 }])}>
                      <Plus className="w-3 h-3 mr-1" /> Add Row
                    </Button>
                  </div>
                  {items.map((item, idx) => (
                    <div key={idx} className="flex gap-2 items-end mb-2 p-2 bg-muted rounded">
                      <div className="flex-1"><Label className="text-[10px]">Item</Label><Input className="h-8 text-xs" value={item.item_name} onChange={e => updateItem(idx, { item_name: e.target.value })} /></div>
                      <div className="w-16"><Label className="text-[10px]">Qty</Label><Input type="number" className="h-8 text-xs" value={item.quantity} onChange={e => updateItem(idx, { quantity: Number(e.target.value) })} /></div>
                      <div className="w-16"><Label className="text-[10px]">Unit</Label><Input className="h-8 text-xs" value={item.unit} onChange={e => updateItem(idx, { unit: e.target.value })} /></div>
                      <div className="w-20"><Label className="text-[10px]">Rate (₹)</Label><Input type="number" className="h-8 text-xs" value={item.rate} onChange={e => updateItem(idx, { rate: Number(e.target.value) })} /></div>
                      <div className="w-20"><Label className="text-[10px]">Total</Label><Input className="h-8 text-xs" value={`₹${item.total}`} readOnly /></div>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setItems(items.filter((_, i) => i !== idx))}><Trash2 className="w-3 h-3" /></Button>
                    </div>
                  ))}
                </div>
                <div><Label className="text-xs">Notes</Label><Input value={notes} onChange={e => setNotes(e.target.value)} /></div>
                <div className="flex justify-between items-center border-t pt-3">
                  <span className="font-semibold">Total: ₹{items.reduce((s, i) => s + i.total, 0)}</span>
                  <Button onClick={handleCreatePurchase} disabled={createPurchase.isPending} className="bg-accent text-accent-foreground hover:bg-accent/90">
                    Save as Draft
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        <Tabs defaultValue="draft">
          <TabsList><TabsTrigger value="draft">Drafts ({drafts.length})</TabsTrigger><TabsTrigger value="confirmed">Confirmed ({confirmed.length})</TabsTrigger></TabsList>
          <TabsContent value="draft" className="space-y-2 mt-3">
            {drafts.length === 0 && <p className="text-sm text-muted-foreground text-center py-8">No draft purchases</p>}
            {drafts.map((p: any) => (
              <Card key={p.id} className="border-none shadow-sm">
                <CardContent className="p-4 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-warning" />
                      <span className="text-sm font-medium">₹{p.total_amount}</span>
                      <span className="text-xs text-muted-foreground">• {p.suppliers?.name || "No supplier"}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{new Date(p.created_at).toLocaleDateString()}</p>
                  </div>
                  <Button size="sm" onClick={() => handleConfirm(p.id)} disabled={confirmPurchase.isPending} className="bg-success text-success-foreground hover:bg-success/90 gap-1">
                    <Check className="w-3 h-3" /> Confirm & Update Stock
                  </Button>
                </CardContent>
              </Card>
            ))}
          </TabsContent>
          <TabsContent value="confirmed" className="space-y-2 mt-3">
            {confirmed.length === 0 && <p className="text-sm text-muted-foreground text-center py-8">No confirmed purchases</p>}
            {confirmed.map((p: any) => (
              <Card key={p.id} className="border-none shadow-sm">
                <CardContent className="p-4 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-success" />
                      <span className="text-sm font-medium">₹{p.total_amount}</span>
                      <span className="text-xs text-muted-foreground">• {p.suppliers?.name || "No supplier"}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Confirmed {p.approved_at ? new Date(p.approved_at).toLocaleDateString() : ""}</p>
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
