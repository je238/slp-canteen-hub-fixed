import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useIngredients, useAddIngredient, useUpdateIngredientStock } from "@/hooks/useSupabaseData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, Package, AlertTriangle, AlertCircle, Plus, Edit2 } from "lucide-react";
import { toast } from "sonner";

const ingredientCategories = ["Grains", "Vegetables", "Meat", "Dairy", "Oils", "Spices", "Staples", "Beverages", "Other"];
const units = ["kg", "gram", "litre", "ml", "piece", "dozen", "packet"];

export default function InventoryPage() {
  const { selectedCanteen } = useAppContext();
  const { data: ingredients, isLoading } = useIngredients(selectedCanteen);
  const addIngredient = useAddIngredient();
  const updateStock = useUpdateIngredientStock();
  const [search, setSearch] = useState("");
  const [addDialog, setAddDialog] = useState(false);
  const [adjustDialog, setAdjustDialog] = useState<{ id: string; name: string; current: number; canteen_id: string } | null>(null);

  // Add form
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Grains");
  const [unit, setUnit] = useState("kg");
  const [currentStock, setCurrentStock] = useState(0);
  const [minimumStock, setMinimumStock] = useState(0);
  const [costPerUnit, setCostPerUnit] = useState(0);

  // Adjust form
  const [newStock, setNewStock] = useState(0);
  const [reason, setReason] = useState("");

  const filtered = (ingredients || []).filter((i: any) =>
    i.name.toLowerCase().includes(search.toLowerCase()) || i.category.toLowerCase().includes(search.toLowerCase())
  );

  const getStatus = (i: any) => {
    if (Number(i.current_stock) <= 0) return "critical";
    if (Number(i.current_stock) < Number(i.minimum_stock)) return "low";
    return "ok";
  };

  const okCount = filtered.filter((i: any) => getStatus(i) === "ok").length;
  const lowCount = filtered.filter((i: any) => getStatus(i) === "low").length;
  const critCount = filtered.filter((i: any) => getStatus(i) === "critical").length;

  const handleAdd = async () => {
    if (selectedCanteen === "all") { toast.error("Select a canteen first"); return; }
    if (!name) { toast.error("Enter ingredient name"); return; }
    try {
      await addIngredient.mutateAsync({ canteen_id: selectedCanteen, name, category, unit, current_stock: currentStock, minimum_stock: minimumStock, cost_per_unit: costPerUnit });
      toast.success("Ingredient added!");
      setAddDialog(false);
      setName(""); setCurrentStock(0); setMinimumStock(0); setCostPerUnit(0);
    } catch (err: any) { toast.error(err.message); }
  };

  const handleAdjust = async () => {
    if (!adjustDialog || !reason) { toast.error("Reason is required"); return; }
    try {
      await updateStock.mutateAsync({ id: adjustDialog.id, current_stock: newStock, reason, canteen_id: adjustDialog.canteen_id });
      toast.success("Stock updated!");
      setAdjustDialog(null);
      setReason("");
    } catch (err: any) { toast.error(err.message); }
  };

  const statusConfig = {
    ok: { label: "In Stock", className: "bg-success/10 text-success border-success/20" },
    low: { label: "Low", className: "bg-warning/10 text-warning border-warning/20" },
    critical: { label: "Critical", className: "bg-destructive/10 text-destructive border-destructive/20" },
  };

  return (
    <AppLayout title="Inventory Management">
      <div className="space-y-4 animate-fade-in">
        <div className="grid grid-cols-3 gap-3">
          <Card className="border-none shadow-sm"><CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-success/10 flex items-center justify-center"><Package className="w-4 h-4 text-success" /></div>
            <div><p className="text-xl font-bold">{okCount}</p><p className="text-xs text-muted-foreground">In Stock</p></div>
          </CardContent></Card>
          <Card className="border-none shadow-sm"><CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-warning/10 flex items-center justify-center"><AlertTriangle className="w-4 h-4 text-warning" /></div>
            <div><p className="text-xl font-bold">{lowCount}</p><p className="text-xs text-muted-foreground">Low Stock</p></div>
          </CardContent></Card>
          <Card className="border-none shadow-sm"><CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-destructive/10 flex items-center justify-center"><AlertCircle className="w-4 h-4 text-destructive" /></div>
            <div><p className="text-xl font-bold">{critCount}</p><p className="text-xs text-muted-foreground">Critical</p></div>
          </CardContent></Card>
        </div>

        <Card className="border-none shadow-sm">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-semibold">Ingredients</CardTitle>
            <div className="flex items-center gap-2">
              <div className="relative w-48">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8 h-8 text-xs" />
              </div>
              <Dialog open={addDialog} onOpenChange={setAddDialog}>
                <DialogTrigger asChild>
                  <Button size="sm" className="bg-accent text-accent-foreground hover:bg-accent/90 gap-1 text-xs"><Plus className="w-3 h-3" /> Add</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>Add Ingredient</DialogTitle></DialogHeader>
                  <div className="space-y-3 mt-2">
                    <div><Label className="text-xs">Name</Label><Input value={name} onChange={e => setName(e.target.value)} /></div>
                    <div className="grid grid-cols-2 gap-3">
                      <div><Label className="text-xs">Category</Label>
                        <Select value={category} onValueChange={setCategory}><SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>{ingredientCategories.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                      <div><Label className="text-xs">Unit</Label>
                        <Select value={unit} onValueChange={setUnit}><SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>{units.map(u => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div><Label className="text-xs">Current Stock</Label><Input type="number" value={currentStock} onChange={e => setCurrentStock(Number(e.target.value))} /></div>
                      <div><Label className="text-xs">Min Stock</Label><Input type="number" value={minimumStock} onChange={e => setMinimumStock(Number(e.target.value))} /></div>
                      <div><Label className="text-xs">Cost/Unit (₹)</Label><Input type="number" value={costPerUnit} onChange={e => setCostPerUnit(Number(e.target.value))} /></div>
                    </div>
                    <Button onClick={handleAdd} disabled={addIngredient.isPending} className="w-full bg-accent text-accent-foreground hover:bg-accent/90">Add Ingredient</Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? <p className="text-sm text-muted-foreground">Loading...</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b text-muted-foreground">
                    <th className="text-left py-2.5 font-medium">Item</th>
                    <th className="text-left py-2.5 font-medium">Category</th>
                    <th className="text-right py-2.5 font-medium">Stock</th>
                    <th className="text-right py-2.5 font-medium">Minimum</th>
                    <th className="text-center py-2.5 font-medium">Status</th>
                    <th className="text-center py-2.5 font-medium">Adjust</th>
                  </tr></thead>
                  <tbody>
                    {filtered.map((item: any) => {
                      const status = getStatus(item);
                      const cfg = statusConfig[status];
                      return (
                        <tr key={item.id} className="border-b last:border-0 hover:bg-muted/50">
                          <td className="py-2.5 font-medium">{item.name}</td>
                          <td className="py-2.5 text-muted-foreground">{item.category}</td>
                          <td className="py-2.5 text-right font-medium">{Number(item.current_stock)} {item.unit}</td>
                          <td className="py-2.5 text-right text-muted-foreground">{Number(item.minimum_stock)} {item.unit}</td>
                          <td className="py-2.5 text-center">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${cfg.className}`}>{cfg.label}</span>
                          </td>
                          <td className="py-2.5 text-center">
                            <button
                              onClick={() => { setAdjustDialog({ id: item.id, name: item.name, current: Number(item.current_stock), canteen_id: item.canteen_id }); setNewStock(Number(item.current_stock)); }}
                              className="p-1 rounded hover:bg-muted"
                            >
                              <Edit2 className="w-3.5 h-3.5 text-muted-foreground" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {filtered.length === 0 && (
                      <tr><td colSpan={6} className="py-8 text-center text-muted-foreground">No ingredients. Add your first ingredient!</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Adjust Dialog */}
        <Dialog open={!!adjustDialog} onOpenChange={(open) => { if (!open) setAdjustDialog(null); }}>
          <DialogContent>
            <DialogHeader><DialogTitle>Adjust Stock: {adjustDialog?.name}</DialogTitle></DialogHeader>
            <div className="space-y-3 mt-2">
              <p className="text-sm text-muted-foreground">Current: {adjustDialog?.current}</p>
              <div><Label className="text-xs">New Stock Level</Label><Input type="number" value={newStock} onChange={e => setNewStock(Number(e.target.value))} /></div>
              <div><Label className="text-xs">Reason (required)</Label><Input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Physical count adjustment" /></div>
              <Button onClick={handleAdjust} disabled={updateStock.isPending || !reason} className="w-full bg-accent text-accent-foreground hover:bg-accent/90">
                Update Stock
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}
