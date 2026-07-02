import { useMemo, useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useSuppliers, usePurchases, useAddSupplier, useUpdateSupplier, useVendorPurchases } from "@/hooks/useSupabaseData";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Store, Plus, Search, Phone, Mail, Pencil, IndianRupee, Clock, PackageOpen } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

interface VendorForm {
  name: string;
  contact_person: string;
  phone: string;
  email: string;
  address: string;
}

const EMPTY_FORM: VendorForm = { name: "", contact_person: "", phone: "", email: "", address: "" };

// NOTE: the parent remounts this dialog via the `key` prop whenever the
// target vendor changes, so seeding useState from props here is safe.
function VendorFormDialog({ open, onOpenChange, initial, vendorId, canteenId }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: VendorForm;
  vendorId?: string;
  canteenId?: string;
}) {
  const [form, setForm] = useState<VendorForm>(initial);
  const addVendor = useAddSupplier();
  const updateVendor = useUpdateSupplier();
  const editing = !!vendorId;

  const set = (field: keyof VendorForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const save = () => {
    if (!form.name.trim()) { toast.error("Vendor name is required"); return; }
    const payload = {
      name: form.name.trim(),
      contact_person: form.contact_person.trim() || undefined,
      phone: form.phone.trim() || undefined,
      email: form.email.trim() || undefined,
      address: form.address.trim() || undefined,
    };
    const done = {
      onSuccess: () => { toast.success(editing ? "Vendor updated" : "Vendor added"); onOpenChange(false); },
      onError: (e: any) => toast.error(e.message),
    };
    if (editing) updateVendor.mutate({ id: vendorId!, ...payload }, done);
    else addVendor.mutate({ ...payload, canteen_id: canteenId !== "all" ? canteenId : undefined }, done);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit vendor" : "Add vendor"}</DialogTitle>
          <DialogDescription>Supplier details used on purchases and invoice matching.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Vendor name *</label>
            <Input value={form.name} onChange={set("name")} placeholder="e.g. Gupta Vegetables" className="mt-1" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Contact person</label>
              <Input value={form.contact_person} onChange={set("contact_person")} className="mt-1" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Phone</label>
              <Input value={form.phone} onChange={set("phone")} inputMode="tel" className="mt-1" />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Email</label>
            <Input value={form.email} onChange={set("email")} type="email" className="mt-1" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Address</label>
            <Textarea value={form.address} onChange={set("address")} rows={2} className="mt-1" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={addVendor.isPending || updateVendor.isPending}>
            {editing ? "Save changes" : "Add vendor"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VendorDetailDialog({ vendor, onClose, onEdit }: { vendor: any; onClose: () => void; onEdit: () => void }) {
  const { data: purchases, isLoading } = useVendorPurchases(vendor?.id);

  return (
    <Dialog open={!!vendor} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2 pr-6">
            {vendor?.name}
            <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={onEdit}>
              <Pencil className="w-3 h-3" /> Edit
            </Button>
          </DialogTitle>
          <DialogDescription className="space-y-0.5">
            {vendor?.contact_person && <span className="block">{vendor.contact_person}</span>}
            {vendor?.phone && <span className="block">{vendor.phone}</span>}
            {vendor?.email && <span className="block">{vendor.email}</span>}
            {vendor?.address && <span className="block">{vendor.address}</span>}
          </DialogDescription>
        </DialogHeader>

        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Purchase history</h4>
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
          ) : (purchases?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No purchases from this vendor yet.</p>
          ) : (
            <div className="space-y-2">
              {purchases!.map((p: any) => (
                <div key={p.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-muted-foreground">
                      {new Date(p.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                    </span>
                    <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${
                      p.status === "confirmed" ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/15 text-amber-600"
                    }`}>{p.status}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      {(p.purchase_items || []).length} item{(p.purchase_items || []).length === 1 ? "" : "s"}
                    </span>
                    <span className="text-sm font-bold tabular-nums">₹{Number(p.total_amount)}</span>
                  </div>
                  {(p.purchase_items || []).length > 0 && (
                    <ul className="mt-1.5 pt-1.5 border-t text-xs text-muted-foreground space-y-0.5">
                      {p.purchase_items.slice(0, 4).map((it: any) => (
                        <li key={it.id} className="flex justify-between">
                          <span className="truncate">{it.item_name}</span>
                          <span className="tabular-nums shrink-0 ml-2">{Number(it.quantity)} {it.unit} @ ₹{Number(it.rate)}</span>
                        </li>
                      ))}
                      {p.purchase_items.length > 4 && <li>+ {p.purchase_items.length - 4} more…</li>}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function VendorsPage() {
  const { selectedCanteen } = useAppContext();
  const { data: vendors, isLoading } = useSuppliers(selectedCanteen);
  const { data: purchases } = usePurchases(selectedCanteen);
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editVendor, setEditVendor] = useState<any>(null);
  const [detailVendor, setDetailVendor] = useState<any>(null);

  const stats = useMemo(() => {
    const byVendor: Record<string, { count: number; spend: number; pending: number; last: string | null }> = {};
    for (const p of purchases || []) {
      if (!p.supplier_id) continue;
      const s = (byVendor[p.supplier_id] ||= { count: 0, spend: 0, pending: 0, last: null });
      s.count += 1;
      if (p.status === "confirmed") s.spend += Number(p.total_amount || 0);
      else s.pending += Number(p.total_amount || 0);
      if (!s.last || p.created_at > s.last) s.last = p.created_at;
    }
    return byVendor;
  }, [purchases]);

  const filtered = (vendors || []).filter((v: any) =>
    v.name.toLowerCase().includes(search.toLowerCase()) ||
    (v.contact_person || "").toLowerCase().includes(search.toLowerCase())
  );

  const openAdd = () => { setEditVendor(null); setFormOpen(true); };
  const openEdit = (v: any) => { setDetailVendor(null); setEditVendor(v); setFormOpen(true); };

  return (
    <AppLayout title="Vendors">
      <div className="space-y-4 animate-fade-in">
        <div className="flex gap-2">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search vendors…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-10" />
          </div>
          <Button className="h-10 gap-1.5" onClick={openAdd}>
            <Plus className="w-4 h-4" /> Add vendor
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground py-8">Loading vendors…</p>
        ) : filtered.length === 0 ? (
          <Card className="border-dashed border-2">
            <CardContent className="p-10 text-center space-y-3">
              <Store className="w-8 h-8 text-muted-foreground mx-auto" />
              <p className="text-sm text-muted-foreground">
                {search ? "No vendors match your search." : "No vendors yet. Add your suppliers to track purchases, pending bills and price history."}
              </p>
              {!search && (
                <Button variant="outline" size="sm" onClick={openAdd} className="gap-1.5">
                  <Plus className="w-3.5 h-3.5" /> Add your first vendor
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map((v: any) => {
              const s = stats[v.id] || { count: 0, spend: 0, pending: 0, last: null };
              return (
                <button key={v.id} onClick={() => setDetailVendor(v)} className="text-left">
                  <Card className="border-none shadow-sm hover:shadow-md transition-shadow h-full">
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate">{v.name}</p>
                          {v.contact_person && <p className="text-xs text-muted-foreground truncate">{v.contact_person}</p>}
                        </div>
                        <div className="w-8 h-8 rounded-lg bg-accent/15 text-accent flex items-center justify-center shrink-0">
                          <Store className="w-4 h-4" />
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {v.phone && <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" />{v.phone}</span>}
                        {v.email && <span className="inline-flex items-center gap-1 truncate"><Mail className="w-3 h-3" />{v.email}</span>}
                      </div>

                      <div className="grid grid-cols-3 gap-2 border-t pt-3">
                        <div>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide flex items-center gap-1"><PackageOpen className="w-3 h-3" /> Orders</p>
                          <p className="text-sm font-bold tabular-nums">{s.count}</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide flex items-center gap-1"><IndianRupee className="w-3 h-3" /> Spend</p>
                          <p className="text-sm font-bold tabular-nums">{formatCurrency(s.spend)}</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide flex items-center gap-1"><Clock className="w-3 h-3" /> Pending</p>
                          <p className={`text-sm font-bold tabular-nums ${s.pending > 0 ? "text-amber-600" : ""}`}>{s.pending > 0 ? formatCurrency(s.pending) : "—"}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <VendorFormDialog
        key={`${editVendor?.id ?? "new"}-${formOpen}`}
        open={formOpen}
        onOpenChange={setFormOpen}
        vendorId={editVendor?.id}
        canteenId={selectedCanteen}
        initial={editVendor ? {
          name: editVendor.name || "",
          contact_person: editVendor.contact_person || "",
          phone: editVendor.phone || "",
          email: editVendor.email || "",
          address: editVendor.address || "",
        } : EMPTY_FORM}
      />
      <VendorDetailDialog vendor={detailVendor} onClose={() => setDetailVendor(null)} onEdit={() => openEdit(detailVendor)} />
    </AppLayout>
  );
}
