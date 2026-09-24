import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { useIngredients, useAddIngredient } from "@/hooks/useSupabaseData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, Package, AlertTriangle, AlertCircle, Plus, Edit2, History, Trash2 } from "lucide-react";
import { toast } from "sonner";
import IngredientLedgerDialog from "@/components/IngredientLedgerDialog";
import DailyRegister from "@/components/DailyRegister";
import DuplicateItems from "@/components/DuplicateItems";
import DeliverySchedule from "@/components/DeliverySchedule";
import HistoricalUnitReview from "@/components/HistoricalUnitReview";
import { useIngredientRates, useSaveInventoryItemEdit, useRenameIngredient, useDeleteIngredient } from "@/hooks/useSrsData";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const ingredientCategories = ["Grains", "Vegetables", "Meat", "Dairy", "Oils", "Spices", "Staples", "Beverages", "Other"];
const units = ["kg", "gram", "litre", "ml", "piece", "dozen", "packet", "box", "bottle", "tin", "bag", "tray"];

export default function InventoryPage() {
  const { selectedCanteen } = useAppContext();
  // Typing a new stock figure is an admin act. The store keeper holds the key
  // to the store; letting them rewrite the store's own record is how a
  // shortage gets written away as spillage by the person it points at.
  const { isOwner: isAdmin, roleData } = useAuth();
  // The store keeper alone, not canIssueStock — that one covers managers too,
  // and the manager approves the orders. Showing them a button the database
  // then refuses is the worst of both.
  const isStoreKeeper = String(roleData?.role).toLowerCase() === "store_keeper";
  const isManager = ["unit_manager", "manager"].includes(String(roleData?.role).toLowerCase());
  // Manual inventory edits are reserved for Admin/Owner. Store Keepers keep
  // the separate receipt, issue, return and delivery-schedule workflows.
  const canAdjustStock = isAdmin;
  const canEditDetails = isAdmin;
  const canAddIngredient = isAdmin || isStoreKeeper;
  const { data: ingredients, isLoading } = useIngredients(selectedCanteen);
  // What a kilo off this shelf is actually worth — the money tied up in the
  // lots on hand, divided by what is on hand. The same figure the chef is
  // quoted and the store is charged, so the inventory page cannot disagree
  // with the order screen.
  const { data: rates } = useIngredientRates(selectedCanteen);
  const rateOf = (id: string) => (rates || []).find((r: any) => r.ingredient_id === id);
  const addIngredient = useAddIngredient();
  const saveInventoryEdit = useSaveInventoryItemEdit();
  const renameIngredient = useRenameIngredient();
  const removeItem = useDeleteIngredient();

  // Admins have full removal control. Traded items are archived instead of
  // physically erased so old bills, issues and consumption remain correct.
  // Store keepers retain the narrower accidental-unused-item action.
  const doDelete = async (item: any) => {
    const message = isAdmin
      ? `"${item.name}" ko inventory se remove karein?\n\nBacha stock write-off hoga. Purani purchase, issue aur consumption history safe rahegi.`
      : `"${item.name}" ko item list se delete karein?\n\nStore Keeper sirf galti se bana, bilkul unused item delete kar sakta hai.`;
    if (!window.confirm(message)) return;

    let deleteReason = "";
    if (isAdmin) {
      deleteReason = window.prompt("Item remove karne ka reason likhein (zaroori):", "")?.trim() || "";
      if (!deleteReason) {
        toast.error("Reason ke bina item remove nahi hoga");
        return;
      }
    }
    try {
      const r = await removeItem.mutateAsync({ id: item.id, reason: deleteReason });
      toast.success(r.archived
        ? `"${r.removed}" inventory se hat gaya; purani history safe hai`
        : `"${r.removed}" item list se delete ho gaya`);
    } catch (e: any) { toast.error(e.message, { duration: 9000 }); }
  };
  const [search, setSearch] = useState("");
  const [addDialog, setAddDialog] = useState(false);
  const [adjustDialog, setAdjustDialog] = useState<{ id: string; name: string; current: number; canteen_id: string; unit?: string; rate?: number } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ id: string; name: string } | null>(null);
  const [renameReason, setRenameReason] = useState("");
  const [newRate, setNewRate] = useState("");
  const [newName, setNewName] = useState("");
  const [newUnit, setNewUnit] = useState("kg");
  const [unitChangeConfirmed, setUnitChangeConfirmed] = useState(false);
  const [ledgerItem, setLedgerItem] = useState<{ id: string; name: string; unit: string; avg_daily_usage?: number | null } | null>(null);

  // Add form
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Grains");
  const [unit, setUnit] = useState("kg");
  const [currentStock, setCurrentStock] = useState(0);
  const [minimumStock, setMinimumStock] = useState(0);
  const [costPerUnit, setCostPerUnit] = useState(0);
  const [newAvgUsage, setNewAvgUsage] = useState("");

  // Adjust form
  const [newStock, setNewStock] = useState(0);
  const [reason, setReason] = useState("");
  const [avgUsage, setAvgUsage] = useState("");
  const [reorderLevel, setReorderLevel] = useState("");
  const [maxStock, setMaxStock] = useState("");

  // "1000 kg at 100 kg/day = 10 days of ration"
  const daysLeft = (i: any): number | null => {
    const avg = Number(i.avg_daily_usage);
    if (!avg || avg <= 0) return null;
    return Number(i.current_stock) / avg;
  };

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
      await addIngredient.mutateAsync({ canteen_id: selectedCanteen, name, category, unit, current_stock: currentStock, minimum_stock: minimumStock, cost_per_unit: costPerUnit, avg_daily_usage: newAvgUsage === "" ? undefined : Number(newAvgUsage) });
      toast.success("Ingredient added!");
      setAddDialog(false);
      setName(""); setCurrentStock(0); setMinimumStock(0); setCostPerUnit(0); setNewAvgUsage("");
    } catch (err: any) { toast.error(err.message); }
  };

  const handleAdjust = async () => {
    if (!canAdjustStock || !canEditDetails) {
      toast.error("Inventory edit ke liye Admin se sampark karein"); return;
    }
    if (!adjustDialog) return;
    const stockChanged = newStock !== adjustDialog.current;
    const unitChanged = newUnit !== (adjustDialog.unit || "kg");
    // The store keeper is going through ninety opening figures inside the
    // setup window; asking for a sentence on each one only teaches him to
    // type "x". The database fills in "Opening count corrected by the store
    // keeper" when it is left blank. For an admin the reason still stands —
    // writing a shortage off months later has to be explained.
    // No blank reasons any more, for anybody. The window's default sentence
    // was a concession to entering ninety opening figures in one week; a
    // standing permission does not get one.
    if ((stockChanged || unitChanged) && !reason.trim()) {
      toast.error("Say why the figure is changing — a count with no reason cannot be checked later"); return;
    }
    if (unitChanged && !unitChangeConfirmed) {
      toast.error("Unit badalne se pehle physical stock ko nayi unit mein count karke confirm karein"); return;
    }
    // A rate carries the whole shelf's value with it, so the sentence is
    // never optional — for either role. The database refuses it blank too;
    // catching it here saves a round trip and says so in plain words.
    const rateChanged = newRate !== "" && Number(newRate) !== Number(adjustDialog.rate ?? 0);
    if (rateChanged && !reason) {
      toast.error("Reason is required for a rate change — say where the price came from"); return;
    }
    try {
      const result = await saveInventoryEdit.mutateAsync({
        id: adjustDialog.id,
        new_stock: newStock,
        avg_daily_usage: avgUsage === "" ? null : Number(avgUsage),
        reorder_level: reorderLevel === "" ? null : Number(reorderLevel),
        maximum_stock: maxStock === "" ? null : Number(maxStock),
        rate: canEditDetails && newRate !== "" ? Number(newRate) : null,
        name: canEditDetails ? newName.trim() : adjustDialog.name,
        unit: canEditDetails ? newUnit : (adjustDialog.unit || "kg"),
        unit_change_confirmed: unitChangeConfirmed,
        reason,
      });
      if (result?.rate?.changed) {
        toast.success(`Rate set to ₹${result.rate.now}${result.rate.lots_repriced ? ` — ${result.rate.lots_repriced} lot(s) re-priced` : ""}`);
      }
      if (result?.rename?.changed) toast.success(`Renamed "${result.rename.was}" to "${result.rename.now}"`);
      if (result?.unit?.changed) toast.success(`Unit ${result.unit.was} se ${result.unit.now} ho gayi`);
      toast.success(stockChanged || unitChanged ? "Inventory updated!" : "Saved");
      setAdjustDialog(null);
      setReason(""); setNewRate(""); setNewName(""); setNewUnit("kg"); setUnitChangeConfirmed(false);
    } catch (err: any) { toast.error(err.message); }
  };

  const handleRename = async () => {
    if (!isManager || !renameDialog) return;
    const nextName = newName.trim();
    if (nextName.length < 2) { toast.error("Item ka poora naam likhein"); return; }
    if (renameReason.trim().length < 3) { toast.error("Naam badalne ka reason likhein"); return; }
    if (nextName === renameDialog.name) { setRenameDialog(null); return; }
    try {
      await renameIngredient.mutateAsync({ id: renameDialog.id, name: nextName, reason: renameReason.trim() });
      toast.success(`"${renameDialog.name}" ka naam "${nextName}" ho gaya`);
      setRenameDialog(null);
      setRenameReason("");
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

        <Tabs defaultValue="items">
          <TabsList>
            <TabsTrigger value="items">Items</TabsTrigger>
            <TabsTrigger value="register">Daily Register</TabsTrigger>
          </TabsList>

          <TabsContent value="register" className="mt-3">
            {selectedCanteen === "all" ? (
              <Card className="border-none shadow-sm"><CardContent className="p-8 text-center text-sm text-muted-foreground">Select a canteen to see its daily register.</CardContent></Card>
            ) : (
              <DailyRegister canteenId={selectedCanteen} readOnly={!canAddIngredient} />
            )}
          </TabsContent>

          <TabsContent value="items" className="mt-3 space-y-3">
        {selectedCanteen !== "all" && <DeliverySchedule canteenId={selectedCanteen} readOnly={!canAddIngredient} />}
        {selectedCanteen !== "all" && <HistoricalUnitReview canteenId={selectedCanteen} showAction={canAddIngredient} />}
        {selectedCanteen !== "all" && <DuplicateItems canteenId={selectedCanteen} />}

        {/* Said out loud. A permission the person holding it does not know is
            watched behaves exactly like one that is not. */}
        {!isAdmin && isStoreKeeper && (
          <Card className="border-none shadow-sm bg-warning/10">
            <CardContent className="p-3">
              <p className="text-xs font-semibold">
                Manual stock edit sirf Admin / Owner kar sakte hain
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Stock, rate, unit ya item name mein correction ke liye Admin se
                sampark karein. Purchase receive, approved issue aur return ka
                normal kaam pehle jaisa chalega.
              </p>
            </CardContent>
          </Card>
        )}
        <Card className="border-none shadow-sm">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-semibold">Ingredients</CardTitle>
            <div className="flex items-center gap-2">
              <div className="relative w-48">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8 h-8 text-xs" />
              </div>
              {canAddIngredient && <Dialog open={addDialog} onOpenChange={setAddDialog}>
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
                    <div><Label className="text-xs">Avg daily usage (optional — e.g. rice 100/day, shows "Days Left")</Label><Input type="number" min={0} value={newAvgUsage} onChange={e => setNewAvgUsage(e.target.value)} placeholder="e.g. 100" /></div>
                    <Button onClick={handleAdd} disabled={addIngredient.isPending} className="w-full bg-accent text-accent-foreground hover:bg-accent/90">Add Ingredient</Button>
                  </div>
                </DialogContent>
              </Dialog>}
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
                    <th className="text-right py-2.5 font-medium">Current Rate</th>
                    <th className="text-right py-2.5 font-medium">Value</th>
                    <th className="text-right py-2.5 font-medium">Minimum</th>
                    <th className="text-right py-2.5 font-medium">Days Left</th>
                    <th className="text-center py-2.5 font-medium">Status</th>
                    <th className="text-center py-2.5 font-medium">History</th>
                    {(canAdjustStock || canEditDetails || isManager) && <th className="text-center py-2.5 font-medium">{isManager ? "Name" : "Edit"}</th>}
                    {(isAdmin || isStoreKeeper) && <th className="text-center py-2.5 font-medium">Delete</th>}
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
                          <td className="py-2.5 text-right text-muted-foreground whitespace-nowrap">
                            {(() => {
                              const r = rateOf(item.id);
                              // cost_per_unit is the current editable rate. stock_rate is
                              // the weighted value of the FIFO lots still on the shelf and
                              // may legitimately stay at an older rate after a correction.
                              const currentRate = Number(item.cost_per_unit ?? r?.latest_rate ?? 0);
                              const shelfRate = Number(r?.stock_rate ?? currentRate);
                              const hasOlderShelfRate = currentRate > 0
                                && Math.abs(shelfRate - currentRate) > 0.0001;
                              return currentRate > 0
                                ? <div>
                                    <div className="text-foreground">₹{currentRate.toFixed(2)}<span className="text-[11px] text-muted-foreground">/{item.unit}</span></div>
                                    {hasOlderShelfRate && (
                                      <div className="text-[10px] text-muted-foreground" title="Current shelf ka FIFO weighted average">
                                        Shelf avg ₹{shelfRate.toFixed(2)}
                                      </div>
                                    )}
                                  </div>
                                : <span className="text-[11px]">—</span>;
                            })()}
                          </td>
                          <td className="py-2.5 text-right font-medium whitespace-nowrap">
                            {(() => {
                              const r = rateOf(item.id);
                              const val = Number(r?.stock_value ?? (Number(item.current_stock) * Number(item.cost_per_unit || 0)));
                              return val > 0 ? <>₹{Math.round(val).toLocaleString("en-IN")}</> : "—";
                            })()}
                          </td>
                          <td className="py-2.5 text-right text-muted-foreground">{Number(item.minimum_stock)} {item.unit}</td>
                          <td className="py-2.5 text-right">
                            {(() => {
                              const d = daysLeft(item);
                              if (d === null) return <span className="text-xs text-muted-foreground">set avg →</span>;
                              const cls = d < 3 ? "text-destructive font-bold" : d < 7 ? "text-warning font-semibold" : "font-medium";
                              return <span className={cls}>{d.toFixed(1)} days</span>;
                            })()}
                          </td>
                          <td className="py-2.5 text-center">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${cfg.className}`}>{cfg.label}</span>
                          </td>
                          <td className="py-2.5 text-center">
                            <button
                              onClick={() => setLedgerItem({ id: item.id, name: item.name, unit: item.unit, avg_daily_usage: item.avg_daily_usage ? Number(item.avg_daily_usage) : null })}
                              className="p-1 rounded hover:bg-muted"
                              title="Full record: purchases, kitchen usage, audits"
                            >
                              <History className="w-3.5 h-3.5 text-muted-foreground" />
                            </button>
                          </td>
                          {(canAdjustStock || canEditDetails || isManager) && <td className="py-2.5 text-center">
                            {isManager ? <button
                              onClick={() => { setRenameDialog({ id: item.id, name: item.name }); setNewName(item.name); setRenameReason(""); }}
                              aria-label={`${item.name} ka naam badlo`}
                              title="Sirf item ka naam badlo"
                              className="p-1 rounded hover:bg-muted"
                            ><Edit2 className="w-3.5 h-3.5 text-muted-foreground" /></button> : <button
                              onClick={() => { setAdjustDialog({ id: item.id, name: item.name, current: Number(item.current_stock), canteen_id: item.canteen_id, unit: item.unit, rate: Number(item.cost_per_unit ?? rateOf(item.id)?.latest_rate ?? 0) }); setNewStock(Number(item.current_stock)); setNewName(item.name); setNewUnit(item.unit || "kg"); setUnitChangeConfirmed(false); setNewRate(""); setAvgUsage(item.avg_daily_usage ? String(Number(item.avg_daily_usage)) : ""); setReorderLevel(item.reorder_level != null ? String(Number(item.reorder_level)) : ""); setMaxStock(item.maximum_stock != null ? String(Number(item.maximum_stock)) : ""); }}
                              aria-label={`${item.name} edit karo`}
                              className="p-1 rounded hover:bg-muted"
                            >
                              <Edit2 className="w-3.5 h-3.5 text-muted-foreground" />
                            </button>}
                          </td>}
                          {(isAdmin || isStoreKeeper) && <td className="py-2.5 text-center">
                            <button
                              onClick={() => doDelete(item)}
                              disabled={removeItem.isPending}
                              title={isAdmin
                                ? "Inventory se remove karein — history safe rahegi"
                                : Number(item.current_stock) !== 0
                                  ? "Stock baaki hai — Store Keeper delete nahi kar sakta"
                                  : "Unused item delete karein"}
                              aria-label={`${item.name} delete karein`}
                              className="p-1 rounded hover:bg-destructive/10 disabled:opacity-40"
                            >
                              <Trash2 className="w-3.5 h-3.5 text-destructive" />
                            </button>
                          </td>}
                        </tr>
                      );
                    })}
                    {filtered.length === 0 && (
                      <tr><td colSpan={11} className="py-8 text-center text-muted-foreground">No ingredients. Add your first ingredient!</td></tr>
                    )}
                    {filtered.length > 0 && (
                      <tr className="border-t-2 bg-muted/40 font-semibold">
                        <td className="py-2.5" colSpan={3}>
                          {filtered.length} item{filtered.length > 1 ? "s" : ""}
                          {search ? " matching" : " on the shelf"}
                        </td>
                        <td className="py-2.5 text-right whitespace-nowrap">
                          ₹{Math.round(filtered.reduce((sum: number, i: any) => {
                            const r = rateOf(i.id);
                            return sum + Number(r?.stock_value
                              ?? (Number(i.current_stock) * Number(i.cost_per_unit || 0)));
                          }, 0)).toLocaleString("en-IN")}
                        </td>
                        <td colSpan={6} />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
          </TabsContent>
        </Tabs>

        <Dialog open={!!renameDialog} onOpenChange={(open) => { if (!open && !renameIngredient.isPending) setRenameDialog(null); }}>
          <DialogContent>
            <DialogHeader><DialogTitle>Item ka naam badlo</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Abhi: {renameDialog?.name}</p>
              <div><Label htmlFor="manager-item-name">Naya naam</Label>
                <Input id="manager-item-name" value={newName} onChange={(e) => setNewName(e.target.value)} /></div>
              <div><Label htmlFor="manager-rename-reason">Reason</Label>
                <Input id="manager-rename-reason" value={renameReason} onChange={(e) => setRenameReason(e.target.value)} placeholder="e.g. spelling correction" /></div>
              <p className="text-xs text-muted-foreground">Naam badalne ka record rahega. Same naam ka item pehle se ho to app merge karne ko bolega.</p>
              <Button className="w-full" onClick={handleRename} disabled={renameIngredient.isPending}>
                {renameIngredient.isPending ? "Saving…" : "Naam save karo"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Adjust Dialog */}
        <Dialog open={!!adjustDialog} onOpenChange={(open) => { if (!open) setAdjustDialog(null); }}>
          <DialogContent className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
            <DialogHeader className="shrink-0 border-b px-5 pb-3 pt-5 pr-12">
              <DialogTitle>Edit: {adjustDialog?.name}</DialogTitle>
            </DialogHeader>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
              {/* The name, so a typo caught at the shelf can be fixed at the
                  shelf. Renaming ONTO a name that already exists is refused by
                  the database — that job is a merge, which carries the stock
                  and the history across instead of leaving one word on two
                  rows with neither total right. */}
              {canEditDetails && <div>
                <Label className="text-xs">Item name</Label>
                <Input value={newName} onChange={e => setNewName(e.target.value)}
                  placeholder={adjustDialog?.name} />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Fixing a spelling. If this item is really the same thing as one
                  already on the list, use Merge instead — renaming onto it is refused.
                </p>
              </div>}
              {canEditDetails && <div>
                <Label className="text-xs">Unit</Label>
                <Select value={newUnit} onValueChange={(value) => { setNewUnit(value); setUnitChangeConfirmed(false); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {units.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                  </SelectContent>
                </Select>
                {newUnit !== (adjustDialog?.unit || "kg") && <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
                  <p className="font-medium">Unit badal rahi hai: {adjustDialog?.unit} → {newUnit}</p>
                  <p className="mt-1">Neeche New Stock Level ko <strong>{newUnit}</strong> mein dobara physical count karke bharein.</p>
                  <label className="mt-2 flex cursor-pointer items-start gap-2">
                    <input type="checkbox" className="mt-0.5 h-4 w-4" checked={unitChangeConfirmed}
                      onChange={(e) => setUnitChangeConfirmed(e.target.checked)} />
                    <span>Maine stock ko {newUnit} mein count karke sahi number bhara hai.</span>
                  </label>
                </div>}
              </div>}
              {canAdjustStock && <>
                <p className="text-sm text-muted-foreground">Current: {adjustDialog?.current} {adjustDialog?.unit}</p>
                <div><Label className="text-xs">New Stock Level ({newUnit})</Label><Input type="number" min={0} value={newStock} onChange={e => setNewStock(Number(e.target.value))} /></div>
              </>}
              {/* The rate comes off the bill, and the store keeper is the one
                  holding it. Both roles are logged — the reason below is what
                  an owner reads six weeks later when the shelf value moved. */}
              {canEditDetails && <div>
                <Label className="text-xs">Rate (₹ per {newUnit || "unit"})</Label>
                <Input type="number" min={0} value={newRate}
                  onChange={e => setNewRate(e.target.value)}
                  placeholder={adjustDialog?.rate ? String(adjustDialog.rate) : "e.g. 52"} />
                <p className="text-[11px] text-muted-foreground mt-1">
                  This also re-prices the lots nothing has been drawn from yet.
                  A lot already issued keeps the rate it was charged at — going
                  back would change what that day's food cost.
                </p>
              </div>}
              <div>
                <Label className="text-xs">Reason (stock, rate ya unit change ke liye zaroori)</Label>
                <Input value={reason} onChange={e => setReason(e.target.value)}
                  placeholder="e.g. physically counted, 2 kg spoiled and thrown" />
                {!isAdmin && isStoreKeeper && (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    The admin is told about every stock correction, with the old
                    figure, the new one and what the difference is worth.
                  </p>
                )}
              </div>
              <div>
                <Label className="text-xs">Avg daily usage (for "Days Left" — e.g. rice 100/day)</Label>
                <Input type="number" min={0} value={avgUsage} onChange={e => setAvgUsage(e.target.value)} placeholder="e.g. 100" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Reorder level</Label>
                  <Input type="number" min={0} value={reorderLevel} onChange={e => setReorderLevel(e.target.value)} placeholder="order when at/below" />
                </div>
                <div>
                  <Label className="text-xs">Maximum level</Label>
                  <Input type="number" min={0} value={maxStock} onChange={e => setMaxStock(e.target.value)} placeholder="don't stock beyond" />
                </div>
              </div>
            </div>
            <div className="grid shrink-0 grid-cols-2 gap-2 border-t bg-background px-5 py-3 shadow-[0_-6px_16px_rgba(0,0,0,0.06)]">
              <Button variant="outline" onClick={() => setAdjustDialog(null)}
                disabled={saveInventoryEdit.isPending}>
                Cancel
              </Button>
              <Button onClick={handleAdjust}
                disabled={saveInventoryEdit.isPending}
                className="w-full bg-accent text-accent-foreground hover:bg-accent/90">
                {saveInventoryEdit.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {ledgerItem && <IngredientLedgerDialog ingredient={ledgerItem} onClose={() => setLedgerItem(null)} />}
      </div>
    </AppLayout>
  );
}
