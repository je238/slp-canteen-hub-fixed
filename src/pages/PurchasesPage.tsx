import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import {
  usePurchases, useSuppliers, useAddSupplier, useConfirmPurchase, useIngredients,
  useReceiveStockWithoutBill, useAttachPurchaseInvoice, useCorrectPurchaseLine,
} from "@/hooks/useSupabaseData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Check, Clock, Trash2, ImageIcon, Camera, CalendarDays, Building2, ChevronDown, Paperclip, ReceiptText, X, Pencil } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import GeoPhotoCapture, { GeoCapture, uploadGeoCapture } from "@/components/GeoPhotoCapture";
import { useAddStockPhoto } from "@/hooks/useSrsData";
import { DialogFooter } from "@/components/ui/dialog";
import { fmtDate } from "@/lib/date";
import FilePickButton from "@/components/FilePickButton";
import { compressImage } from "@/lib/image";

// The invoice photo is the purchase's evidence trail (private bucket, so a
// short-lived signed URL is minted on demand).
function InvoiceImageButton({ path, label = "Invoice" }: { path?: string | null; label?: string }) {
  if (!path) return null;
  const open = async () => {
    const { data, error } = await supabase.storage.from("invoices").createSignedUrl(path, 300);
    if (error || !data?.signedUrl) { toast.error("Could not open invoice image"); return; }
    window.open(data.signedUrl, "_blank");
  };
  return (
    <Button variant="ghost" size="sm" className="w-full justify-center gap-1 text-xs sm:w-auto" onClick={open}>
      <ImageIcon className="w-3.5 h-3.5" /> {label}
    </Button>
  );
}

function PurchaseLineDetails({ purchase, onCorrect }: { purchase: any; onCorrect?: (line: any) => void }) {
  const lines: any[] = purchase.purchase_items || [];
  const corrections: any[] = purchase.purchase_line_corrections || [];
  return (
    <div className="mt-3 border-t pt-3">
      <p className="text-xs font-semibold mb-2">Invoice mein add kiya saman ({lines.length})</p>
      {lines.length === 0 ? (
        <p className="text-xs text-muted-foreground">Is purchase mein item lines nahi mili.</p>
      ) : (
        <div className="space-y-1.5">
          {lines.map((line) => (
            <div key={line.id} className="grid grid-cols-1 gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto]">
              <div className="min-w-0">
                <p className="font-medium truncate">{line.item_name}</p>
                <p className="text-muted-foreground">
                  {Number(line.quantity)} {line.unit || ""} × ₹{Number(line.rate || 0).toLocaleString("en-IN")}
                </p>
                {corrections.some((row) => row.purchase_item_id === line.id) && (
                  <p className="mt-1 text-[10px] font-semibold text-amber-700">Sudhari hui entry · purani entry audit me safe hai</p>
                )}
              </div>
              <div className="flex items-center justify-between gap-1.5 sm:justify-end">
                <p className="font-semibold whitespace-nowrap">₹{Number(line.total || 0).toLocaleString("en-IN")}</p>
                {onCorrect && (
                  <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-[10px]" onClick={() => onCorrect(line)}>
                    <Pencil className="h-3 w-3" /> Galat entry sudharo
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {purchase.notes && <p className="text-[11px] text-muted-foreground mt-2">{purchase.notes}</p>}
    </div>
  );
}

const CORRECTION_UNITS = ["kg", "litre", "packet", "box", "piece", "crate", "bag", "bottle", "tray", "dozen"];

function PurchaseCorrectionDialog({ purchase, line, ingredients, onClose }: {
  purchase: any | null;
  line: any | null;
  ingredients: any[];
  onClose: () => void;
}) {
  const correctLine = useCorrectPurchaseLine();
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [ingredientId, setIngredientId] = useState("");
  const [newName, setNewName] = useState("");
  const [category, setCategory] = useState("Uncategorised");
  const [unit, setUnit] = useState("kg");
  const [quantity, setQuantity] = useState("");
  const [rate, setRate] = useState("");
  const [reason, setReason] = useState("");

  const open = !!purchase && !!line;
  const initialise = () => {
    if (!line) return;
    setMode("existing");
    setIngredientId(line.ingredient_id || "");
    setNewName("");
    setCategory("Uncategorised");
    setUnit(line.stock_unit || line.unit || "kg");
    setQuantity(String(line.stock_quantity ?? line.quantity ?? ""));
    setRate(String(line.rate ?? ""));
    setReason("");
  };

  const chooseExisting = (id: string) => {
    setIngredientId(id);
    const item = ingredients.find((row) => row.id === id);
    if (item) setUnit(item.unit || "kg");
  };

  const save = async () => {
    const qty = Number(quantity);
    const itemRate = Number(rate);
    if (mode === "existing" && !ingredientId) { toast.error("Correct inventory item chuno"); return; }
    if (mode === "new" && !newName.trim()) { toast.error("Naye item ka naam likho"); return; }
    if (!Number.isFinite(qty) || qty <= 0) { toast.error("Correct quantity bharo"); return; }
    if (!Number.isFinite(itemRate) || itemRate < 0) { toast.error("Correct rate bharo"); return; }
    if (!reason.trim()) { toast.error("Galti ka reason likhna zaroori hai"); return; }
    try {
      await correctLine.mutateAsync({
        purchase_item_id: line.id,
        ingredient_id: mode === "existing" ? ingredientId : null,
        new_item_name: mode === "new" ? newName.trim() : null,
        new_category: category,
        new_unit: unit,
        new_quantity: qty,
        new_rate: itemRate,
        reason: reason.trim(),
      });
      toast.success("Invoice entry, stock aur lot teeno sahi ho gaye");
      onClose();
    } catch (error: any) {
      toast.error(error.message || "Entry sudhar nahi payi");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !correctLine.isPending) onClose(); }}>
      <DialogContent className="sm:max-w-xl max-h-[92vh] overflow-y-auto" onOpenAutoFocus={initialise}>
        <DialogHeader><DialogTitle>Galat invoice entry sudharo</DialogTitle></DialogHeader>
        {line && (
          <>
            <div className="rounded-lg border bg-muted/50 p-3 text-sm">
              <p className="text-xs text-muted-foreground">Abhi kya chadha hai</p>
              <p className="font-semibold">{line.item_name} · {Number(line.quantity)} {line.unit} × ₹{Number(line.rate || 0).toLocaleString("en-IN")}</p>
            </div>
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
              Invoice photo delete/change nahi hogi. Old aur new dono audit me rahenge. Agar is lot ka kuch saman kitchen ja chuka hai, app correction rok kar Admin review bolega.
            </div>

            <Tabs value={mode} onValueChange={(value) => setMode(value as "existing" | "new")}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="existing">Inventory me hai</TabsTrigger>
                <TabsTrigger value="new">Bilkul naya item</TabsTrigger>
              </TabsList>
              <TabsContent value="existing" className="space-y-2 pt-2">
                <Label>Correct item</Label>
                <Select value={ingredientId} onValueChange={chooseExisting}>
                  <SelectTrigger><SelectValue placeholder="Inventory item chuno" /></SelectTrigger>
                  <SelectContent>
                    {[...(ingredients || [])].sort((a, b) => a.name.localeCompare(b.name)).map((item) => (
                      <SelectItem key={item.id} value={item.id}>{item.name} · {item.unit}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TabsContent>
              <TabsContent value="new" className="space-y-3 pt-2">
                <div><Label>Naye item ka exact naam</Label><Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Dum Potato" /></div>
                <div><Label>Category</Label><Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Vegetables / Dairy / Uncategorised" /></div>
                <div>
                  <Label>Unit</Label>
                  <Select value={unit} onValueChange={setUnit}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{CORRECTION_UNITS.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </TabsContent>
            </Tabs>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div><Label>Correct quantity ({unit})</Label><Input type="number" inputMode="decimal" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></div>
              <div><Label>Correct rate (₹/{unit})</Label><Input type="number" inputMode="decimal" min="0" step="any" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
            </div>
            <div className="rounded-md bg-slate-50 px-3 py-2 text-sm">
              Correct amount: <span className="font-bold">₹{(Number(quantity || 0) * Number(rate || 0)).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
            </div>
            <div><Label>Galti kyu hui? (zaroori)</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. bill me Amul Doodh tha, correct inventory item Amul Gold hai" /></div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={correctLine.isPending}>Cancel</Button>
              <Button onClick={save} disabled={correctLine.isPending}>{correctLine.isPending ? "Sudhar raha hai…" : "Correction save karo"}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface PurchaseItemForm {
  ingredient_id: string;
  item_name: string;
  quantity: number;
  unit: string;
  rate: number;
  total: number;
}

interface PendingBillFile {
  file: File;
  amount: string;
  bill_number: string;
  bill_date: string;
}

function LateBillsDialog({ purchase, onClose }: { purchase: any | null; onClose: () => void }) {
  const attachInvoice = useAttachPurchaseInvoice();
  const [files, setFiles] = useState<PendingBillFile[]>([]);
  const [saving, setSaving] = useState(false);
  const existing: any[] = purchase?.purchase_invoice_files || [];
  const slots = Math.max(0, 4 - existing.length);

  const addFile = (file: File) => {
    if (files.length >= slots) { toast.error("Ek receiving par maximum 4 bill hi lag sakte hain"); return; }
    setFiles((prev) => [...prev, { file, amount: "", bill_number: "", bill_date: "" }]);
  };

  const update = (index: number, patch: Partial<PendingBillFile>) =>
    setFiles((prev) => prev.map((row, i) => i === index ? { ...row, ...patch } : row));

  const save = async () => {
    if (!purchase || files.length === 0) { toast.error("Kam se kam ek bill photo lagao"); return; }
    setSaving(true);
    try {
      for (let index = 0; index < files.length; index += 1) {
        const row = files[index];
        const small = await compressImage(row.file);
        const safe = small.name.replace(/[^\w.-]+/g, "_") || `bill-${index + 1}.jpg`;
        const path = `${purchase.canteen_id}/${purchase.id}/${Date.now()}-${index + 1}-${safe}`;
        const { error } = await supabase.storage.from("invoices").upload(path, small, { contentType: small.type });
        if (error) throw error;
        await attachInvoice.mutateAsync({
          purchase_id: purchase.id,
          image_path: path,
          amount: row.amount.trim() === "" ? null : Number(row.amount),
          bill_number: row.bill_number.trim(),
          bill_date: row.bill_date || undefined,
        });
      }
      toast.success(`${files.length} bill attach ho gaye — stock dobara add nahi hua`);
      setFiles([]);
      onClose();
    } catch (err: any) {
      toast.error(err.message || "Bill attach nahi hua");
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={!!purchase} onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Bill baad mein attach karo</DialogTitle></DialogHeader>
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          Saman pehle hi stock mein aa chuka hai. Yahan bill lagane se stock dobara nahi badhega.
          Ek receiving par total 4 bill laga sakte ho.
        </div>

        {existing.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold">Pehle se lage bill ({existing.length}/4)</p>
            {existing.map((bill, index) => (
              <div key={bill.id} className="flex items-center justify-between rounded-md bg-muted px-3 py-2">
                <span className="text-xs">Bill {index + 1}{bill.bill_number ? ` · ${bill.bill_number}` : ""}</span>
                <div className="flex items-center gap-2">
                  {bill.amount != null && <span className="text-xs font-semibold">₹{Number(bill.amount).toLocaleString("en-IN")}</span>}
                  <InvoiceImageButton path={bill.image_path} label="Dekho" />
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-3">
          {files.map((row, index) => (
            <div key={`${row.file.name}-${index}`} className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold truncate">{row.file.name}</p>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => setFiles((prev) => prev.filter((_, i) => i !== index))}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div><Label className="text-[10px]">Bill amount</Label><Input inputMode="decimal" type="number" value={row.amount} onChange={(e) => update(index, { amount: e.target.value })} placeholder="₹" /></div>
                <div><Label className="text-[10px]">Bill number</Label><Input value={row.bill_number} onChange={(e) => update(index, { bill_number: e.target.value })} placeholder="optional" /></div>
                <div><Label className="text-[10px]">Bill date</Label><Input type="date" value={row.bill_date} onChange={(e) => update(index, { bill_date: e.target.value })} /></div>
              </div>
            </div>
          ))}
        </div>

        {files.length < slots && (
          <FilePickButton onPick={addFile} accept="image/*,application/pdf,.pdf" disabled={saving} className="h-11 px-4 border border-dashed border-accent text-accent">
            <Paperclip className="h-4 w-4" /> Bill photo/PDF lagao ({existing.length + files.length}/4)
          </FilePickButton>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Baad mein</Button>
          <Button onClick={save} disabled={saving || files.length === 0}>
            {saving ? "Upload ho raha hai…" : `${files.length || ""} bill save karo`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// When a vendor drops stock at the canteen the store keeper records it with
// a photo or short video and the location. Managers, admins and super admins
// are notified so they can look without being there.
function DeliveryEvidence({ canteenId }: { canteenId: string }) {
  const [open, setOpen] = useState(false);
  const [cap, setCap] = useState<GeoCapture | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const addPhoto = useAddStockPhoto();

  const save = async () => {
    if (!cap) { toast.error("Take a photo or video of the delivery"); return; }
    setBusy(true);
    try {
      const path = `${canteenId}/receipt/${Date.now()}-${cap.file.name || "delivery.jpg"}`
        .replace(/[^\w./-]+/g, "_");
      const meta = await uploadGeoCapture(supabase, "stock-photos", path, cap);
      await addPhoto.mutateAsync({
        canteen_id: canteenId,
        photo_type: "receipt",
        note: note || "Vendor delivery received",
        ...meta,
      });
      toast.success("Delivery recorded — manager and admin have been notified");
      setOpen(false); setCap(null); setNote("");
    } catch (e: any) {
      toast.error(e.message);
    } finally { setBusy(false); }
  };

  return (
    <>
      <Button variant="outline" size="sm" className="w-full justify-center gap-1.5 text-xs sm:w-auto" onClick={() => setOpen(true)}>
        <Camera className="w-3.5 h-3.5" /> Record Delivery
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Stock received from vendor</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">
            Photograph or film the goods as they arrive. The capture carries the canteen's
            location and time, and goes straight to the manager, admin and super admin.
          </p>
          <GeoPhotoCapture
            value={cap} onChange={setCap}
            label="Delivery photo / video (required)"
            allowVideo requireLocation
          />
          <Input placeholder="What arrived? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={!cap || busy}>{busy ? "Saving…" : "Record delivery"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function PurchasesPage() {
  const { selectedCanteen } = useAppContext();
  const { roleData } = useAuth();
  const role = String(roleData?.role ?? "").toLowerCase();
  const canManagePurchases = role === "store_keeper"
    || ["admin", "super_admin", "owner"].includes(role);
  const { data: purchases, isLoading } = usePurchases(selectedCanteen);
  const { data: suppliers } = useSuppliers(selectedCanteen);
  const { data: ingredients } = useIngredients(selectedCanteen);
  const addSupplier = useAddSupplier();
  const receiveWithoutBill = useReceiveStockWithoutBill();
  const confirmPurchase = useConfirmPurchase();

  const [purchaseDialog, setPurchaseDialog] = useState(false);
  const [supplierDialog, setSupplierDialog] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [notes, setNotes] = useState("");
  const blankItem = (): PurchaseItemForm => ({ ingredient_id: "", item_name: "", quantity: 0, unit: "kg", rate: 0, total: 0 });
  const [items, setItems] = useState<PurchaseItemForm[]>([blankItem()]);
  const [expandedPurchase, setExpandedPurchase] = useState<string | null>(null);
  const [confirmedView, setConfirmedView] = useState<"date" | "vendor">("date");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [billPurchase, setBillPurchase] = useState<any | null>(null);
  const [correctionTarget, setCorrectionTarget] = useState<{ purchase: any; line: any } | null>(null);

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

  const chooseIngredient = (idx: number, ingredientId: string) => {
    const ingredient = (ingredients || []).find((row: any) => row.id === ingredientId);
    if (!ingredient) return;
    updateItem(idx, {
      ingredient_id: ingredient.id,
      item_name: ingredient.name,
      unit: ingredient.unit,
      rate: Number(ingredient.cost_per_unit || 0),
    });
  };

  const handleReceiveWithoutBill = async () => {
    if (selectedCanteen === "all") { toast.error("Select a canteen first"); return; }
    const validItems = items.filter(i => i.ingredient_id && i.quantity > 0);
    if (validItems.length === 0) { toast.error("Kam se kam ek inventory item aur quantity bharo"); return; }

    try {
      await receiveWithoutBill.mutateAsync({
        canteen_id: selectedCanteen,
        supplier_id: supplierId || undefined,
        items: validItems.map((item) => ({ ingredient_id: item.ingredient_id, quantity: item.quantity })),
        notes: notes || undefined,
      });
      toast.success("Saman stock mein aa gaya — bill pending list mein rakha hai");
      setPurchaseDialog(false);
      setItems([blankItem()]);
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
  type PurchaseGroup = {key:string;label:string;purchases:any[];total:number};
  const groupMap = new Map<string,PurchaseGroup>();
  for (const purchase of confirmed) {
    const label = confirmedView === "date"
      ? fmtDate(purchase.approved_at || purchase.created_at)
      : (purchase.suppliers?.name || "No supplier");
    const key = `${confirmedView}-${confirmedView === "date" ? label : (purchase.supplier_id || "none")}`;
    const group = groupMap.get(key) || { key, label, purchases: [], total: 0 };
    group.purchases.push(purchase);
    group.total += Number(purchase.total_amount || 0);
    groupMap.set(key, group);
  }
  const confirmedGroups = Array.from(groupMap.values());

  return (
    <AppLayout title="Purchases & Suppliers">
      <div className="min-w-0 space-y-4 overflow-x-hidden animate-fade-in">
        {canManagePurchases && <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end">
          {selectedCanteen !== "all" && <DeliveryEvidence canteenId={selectedCanteen} />}
          <Dialog open={supplierDialog} onOpenChange={setSupplierDialog}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="w-full justify-center gap-1.5 text-xs sm:w-auto"><Plus className="w-3 h-3" /> Add Supplier</Button>
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
              <Button className="col-span-2 w-full gap-1.5 bg-accent text-accent-foreground hover:bg-accent/90 sm:w-auto" size="sm"><ReceiptText className="w-4 h-4" /> Saman aaya — bill nahi</Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
              <DialogHeader><DialogTitle>Bill ke bina saman receive karo</DialogTitle></DialogHeader>
              <div className="space-y-4 mt-2">
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                  Save karte hi saman stock mein judega. Bill aane par isi entry mein 1 se 4 photos/PDF attach karna—stock dobara nahi judega.
                </div>
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
                    <Button variant="outline" size="sm" className="text-xs" onClick={() => setItems([...items, blankItem()])}>
                      <Plus className="w-3 h-3 mr-1" /> Add Row
                    </Button>
                  </div>
                  {items.map((item, idx) => (
                    <div key={idx} className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_90px_80px_42px] gap-2 items-end mb-2 p-2 bg-muted rounded">
                      <div><Label className="text-[10px]">Inventory ka saman</Label><Select value={item.ingredient_id} onValueChange={(value) => chooseIngredient(idx, value)}><SelectTrigger className="h-9"><SelectValue placeholder="Saman chuno" /></SelectTrigger><SelectContent>{(ingredients || []).map((ingredient: any) => <SelectItem key={ingredient.id} value={ingredient.id}>{ingredient.name} · stock {Number(ingredient.current_stock)} {ingredient.unit}</SelectItem>)}</SelectContent></Select></div>
                      <div><Label className="text-[10px]">Kitna aaya?</Label><Input inputMode="decimal" type="number" min="0" step="any" className="h-9 text-xs" value={item.quantity || ""} onChange={e => updateItem(idx, { quantity: Number(e.target.value) })} /></div>
                      <div><Label className="text-[10px]">Unit</Label><Input className="h-9 text-xs" value={item.unit} readOnly /></div>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setItems(items.filter((_, i) => i !== idx))}><Trash2 className="w-3 h-3" /></Button>
                    </div>
                  ))}
                </div>
                <div><Label className="text-xs">Notes</Label><Input value={notes} onChange={e => setNotes(e.target.value)} /></div>
                <div className="flex justify-between items-center border-t pt-3">
                  <span className="text-xs text-muted-foreground">Value last known rate se provisional rahegi, bill baad mein attach hoga.</span>
                  <Button onClick={handleReceiveWithoutBill} disabled={receiveWithoutBill.isPending} className="bg-accent text-accent-foreground hover:bg-accent/90">
                    {receiveWithoutBill.isPending ? "Stock add ho raha hai…" : "Receive karke stock mein jodo"}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>}

        {!canManagePurchases && (
          <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            View only — aap purchases, bills aur item details dekh sakte hain. Receiving aur correction Store Keeper/Admin karega.
          </div>
        )}

        <Tabs defaultValue="draft">
          <TabsList className="grid w-full grid-cols-2 sm:inline-grid sm:w-auto"><TabsTrigger value="draft">Drafts ({drafts.length})</TabsTrigger><TabsTrigger value="confirmed">Confirmed ({confirmed.length})</TabsTrigger></TabsList>
          <TabsContent value="draft" className="space-y-2 mt-3">
            {drafts.length === 0 && <p className="text-sm text-muted-foreground text-center py-8">No draft purchases</p>}
            {drafts.map((p: any) => (
              <Card key={p.id} className="border-none shadow-sm">
                <CardContent className="p-4">
                  <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Clock className="w-4 h-4 text-warning" />
                      <button
                        className="text-sm font-semibold text-accent inline-flex items-center gap-1 hover:underline"
                        onClick={() => setExpandedPurchase(expandedPurchase === p.id ? null : p.id)}
                        aria-expanded={expandedPurchase === p.id}
                      >
                        ₹{Number(p.total_amount || 0).toLocaleString("en-IN")}
                        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expandedPurchase === p.id ? "rotate-180" : ""}`} />
                      </button>
                      <span className="min-w-0 break-words text-xs text-muted-foreground">• {p.suppliers?.name || "No supplier"}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{fmtDate(p.created_at)}</p>
                    </div>
                    <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center">
                    <InvoiceImageButton path={p.invoice_image_url} />
                    {canManagePurchases && <Button size="sm" onClick={() => handleConfirm(p.id)} disabled={confirmPurchase.isPending} className="w-full justify-center gap-1 bg-success text-success-foreground hover:bg-success/90 sm:w-auto">
                      <Check className="w-3 h-3" /> Confirm & Update Stock
                    </Button>}
                    </div>
                  </div>
                  {expandedPurchase === p.id && <PurchaseLineDetails purchase={p} />}
                </CardContent>
              </Card>
            ))}
          </TabsContent>
          <TabsContent value="confirmed" className="space-y-2 mt-3">
            {confirmed.length === 0 && <p className="text-sm text-muted-foreground text-center py-8">No confirmed purchases</p>}
            {confirmed.length > 0 && <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
              <span className="px-1 text-xs font-semibold text-muted-foreground">Purchases dekhein:</span>
              <Button size="sm" variant={confirmedView === "date" ? "default" : "outline"} className="gap-1.5" onClick={() => setConfirmedView("date")}>
                <CalendarDays className="h-4 w-4" /> Date-wise
              </Button>
              <Button size="sm" variant={confirmedView === "vendor" ? "default" : "outline"} className="gap-1.5" onClick={() => setConfirmedView("vendor")}>
                <Building2 className="h-4 w-4" /> Vendor-wise
              </Button>
            </div>}
            {confirmedGroups.map((group) => {
              const groupOpen=expandedGroups.has(group.key);
              return <div key={group.key} className="overflow-hidden rounded-xl border bg-card shadow-sm">
              <button type="button" className="flex w-full cursor-pointer items-center justify-between gap-3 p-4 text-left" aria-expanded={groupOpen} onClick={()=>setExpandedGroups(previous=>{const next=new Set(previous);next.has(group.key)?next.delete(group.key):next.add(group.key);return next;})}>
                <div className="min-w-0">
                  <p className="truncate font-semibold">{confirmedView === "date" ? `Purchase date: ${group.label}` : group.label}</p>
                  <p className="text-xs text-muted-foreground">{group.purchases.length} purchase{group.purchases.length === 1 ? "" : "s"}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <div className="text-right"><p className="text-[10px] uppercase text-muted-foreground">Total</p><p className="font-bold text-accent">₹{group.total.toLocaleString("en-IN")}</p></div>
                  <ChevronDown className={`h-5 w-5 transition-transform ${groupOpen?"rotate-180":""}`} />
                </div>
              </button>
              {groupOpen&&<div className="space-y-2 border-t bg-muted/20 p-2 sm:p-3">
              {group.purchases.map((p: any) => {
              const billFiles: any[] = p.purchase_invoice_files || [];
              const billPending = p.bill_status === "pending" || (!p.invoice_image_url && billFiles.length === 0);
              return (
              <Card key={p.id} className="border-none shadow-sm">
                <CardContent className="p-4">
                  <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Check className="w-4 h-4 text-success" />
                      <button
                        className="text-sm font-semibold text-accent inline-flex items-center gap-1 hover:underline"
                        onClick={() => setExpandedPurchase(expandedPurchase === p.id ? null : p.id)}
                        aria-expanded={expandedPurchase === p.id}
                      >
                        ₹{Number(p.total_amount || 0).toLocaleString("en-IN")}
                        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expandedPurchase === p.id ? "rotate-180" : ""}`} />
                      </button>
                      <span className="min-w-0 break-words text-xs text-muted-foreground">• {p.suppliers?.name || "No supplier"}</span>
                      {billPending
                        ? <span className="rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-[10px] font-semibold">BILL PENDING</span>
                        : <span className="rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-[10px] font-semibold">{Math.max(1, billFiles.length)} BILL</span>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Confirmed {p.approved_at ? fmtDate(p.approved_at) : ""}</p>
                    </div>
                    <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center">
                      {billFiles.length === 0 && <InvoiceImageButton path={p.invoice_image_url} />}
                      {canManagePurchases && (billPending || billFiles.length < 4) && (
                        <Button size="sm" variant={billPending ? "default" : "outline"} className="w-full justify-center gap-1 text-xs sm:w-auto" onClick={() => setBillPurchase(p)}>
                          <Paperclip className="h-3.5 w-3.5" /> {billPending ? "Bill aaya — upload" : "Aur bill lagao"}
                        </Button>
                      )}
                    </div>
                  </div>
                  {expandedPurchase === p.id && (
                    <div>
                      <PurchaseLineDetails
                        purchase={p}
                        onCorrect={canManagePurchases ? (line) => setCorrectionTarget({ purchase: p, line }) : undefined}
                      />
                      {billFiles.length > 0 && (
                        <div className="mt-3 border-t pt-3 space-y-1">
                          <p className="text-xs font-semibold">Attached bills ({billFiles.length}/4)</p>
                          {billFiles.map((bill, index) => (
                            <div key={bill.id} className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
                              <span className="text-xs">Bill {index + 1}{bill.bill_number ? ` · ${bill.bill_number}` : ""}{bill.bill_date ? ` · ${fmtDate(bill.bill_date)}` : ""}</span>
                              <div className="flex items-center gap-2">
                                {bill.amount != null && <span className="text-xs font-semibold">₹{Number(bill.amount).toLocaleString("en-IN")}</span>}
                                <InvoiceImageButton path={bill.image_path} label="Photo" />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )})}
              </div>}
            </div>})}
          </TabsContent>
        </Tabs>
      </div>
      {canManagePurchases && <LateBillsDialog purchase={billPurchase} onClose={() => setBillPurchase(null)} />}
      {canManagePurchases && (
        <PurchaseCorrectionDialog
          purchase={correctionTarget?.purchase || null}
          line={correctionTarget?.line || null}
          ingredients={(ingredients || []) as any[]}
          onClose={() => setCorrectionTarget(null)}
        />
      )}
    </AppLayout>
  );
}
