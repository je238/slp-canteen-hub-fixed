import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { useVendorBills, useSubmitVendorBill, useReviewVendorBill, useConvertVendorBill } from "@/hooks/useSrsData";
import { useCanteens } from "@/hooks/useSupabaseData";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Check, FileUp, ImageIcon, MapPin, Plus, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import GeoPhotoCapture, { GeoCapture } from "@/components/GeoPhotoCapture";
import { fmtDate, fmtDateTime } from "@/lib/date";

// Two faces of the same screen:
//   Vendor       — uploads a bill photo, its line items and total value.
//   Store Keeper — sees the inbox, verifies against the goods, and converts
//                  an accepted bill into a draft purchase (stock still only
//                  moves when that purchase is confirmed).

const STATUS_STYLE: Record<string, string> = {
  submitted: "bg-warning/10 text-warning border-warning/20",
  verified: "bg-success/10 text-success border-success/20",
  rejected: "bg-destructive/10 text-destructive border-destructive/20",
  converted: "bg-accent/10 text-accent border-accent/20",
};

export default function VendorBillsPage() {
  const { selectedCanteen } = useAppContext();
  const { isVendor, roleData, isStoreKeeperOrAbove } = useAuth();
  const { data: canteens } = useCanteens();
  const { data: bills, isLoading } = useVendorBills(
    selectedCanteen,
    isVendor ? roleData.supplier_id || undefined : undefined
  );
  const submitBill = useSubmitVendorBill();
  const reviewBill = useReviewVendorBill();
  const convertBill = useConvertVendorBill();

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<any>({ bill_no: "", bill_date: "", gstin: "", canteen_id: "" });
  const [lines, setLines] = useState<any[]>([{ item_name: "", quantity: "", unit: "kg", rate: "" }]);
  // The bill photo is taken at the delivery point, so it carries a location:
  // that's what turns "here's a bill" into "this was delivered here, then".
  const [capture, setCapture] = useState<GeoCapture | null>(null);
  const [busy, setBusy] = useState(false);
  const file = capture?.file ?? null;

  const total = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.rate) || 0), 0);

  const uploadPhoto = async (): Promise<string | undefined> => {
    if (!file) return undefined;
    try {
      const ext = file.name.split(".").pop() || "jpg";
      const path = `vendor/${roleData.supplier_id || "unknown"}/${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("invoices").upload(path, file, { contentType: file.type });
      if (error) throw error;
      return path;
    } catch (e: any) {
      toast.warning(`Photo could not be attached (${e.message}) — the bill will be saved without it.`);
      return undefined;
    }
  };

  const submit = async () => {
    const siteId = isVendor ? form.canteen_id : selectedCanteen;
    if (!siteId || siteId === "all") { toast.error("Choose which site this bill is for"); return; }
    const clean = lines.filter((l) => l.item_name?.trim() && Number(l.quantity) > 0);
    if (clean.length === 0) { toast.error("Add at least one item"); return; }
    setBusy(true);
    try {
      const image_path = await uploadPhoto();
      await submitBill.mutateAsync({
        supplier_id: roleData.supplier_id,
        canteen_id: siteId,
        bill_no: form.bill_no || null,
        bill_date: form.bill_date || null,
        gstin: form.gstin || null,
        total_value: total,
        image_path,
        latitude: capture?.latitude ?? null,
        longitude: capture?.longitude ?? null,
        geo_accuracy: capture?.accuracy ?? null,
        captured_at: capture?.capturedAt ?? null,
        status: "submitted",
        items: clean.map((l) => ({
          item_name: l.item_name.trim(),
          quantity: Number(l.quantity),
          unit: l.unit || null,
          rate: Number(l.rate) || 0,
          total: (Number(l.quantity) || 0) * (Number(l.rate) || 0),
        })),
      });
      toast.success("Bill submitted — the store keeper will verify it");
      setOpen(false); setLines([{ item_name: "", quantity: "", unit: "kg", rate: "" }]); setCapture(null);
      setForm({ bill_no: "", bill_date: "", gstin: "", canteen_id: "" });
    } catch (e: any) {
      toast.error(e.message);
    } finally { setBusy(false); }
  };

  const viewPhoto = async (path?: string | null) => {
    if (!path) return;
    const { data, error } = await supabase.storage.from("invoices").createSignedUrl(path, 300);
    if (error || !data?.signedUrl) { toast.error("Could not open the photo"); return; }
    window.open(data.signedUrl, "_blank");
  };

  const doConvert = async (id: string) => {
    try {
      await convertBill.mutateAsync(id);
      toast.success("Draft purchase created — confirm it on the Purchases page to update stock");
    } catch (e: any) { toast.error(e.message); }
  };

  return (
    <AppLayout title={isVendor ? "My Bills" : "Vendor Bill Inbox"}>
      <div className="space-y-4 animate-fade-in">
        <Card className="border-none shadow-sm">
          <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground flex-1 min-w-[260px]">
              {isVendor
                ? "Upload each delivery's bill: a photo, the items and the total value. The canteen team verifies it against what actually arrived."
                : "Bills uploaded by vendors. Verify against the goods received, then convert to a draft purchase — stock only moves when that purchase is confirmed."}
            </p>
            {isVendor && (
              <Button size="sm" onClick={() => setOpen(true)}>
                <Plus className="w-4 h-4 mr-1.5" /> Upload bill
              </Button>
            )}
          </CardContent>
        </Card>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (bills || []).length === 0 ? (
          <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
            {isVendor ? "You haven't uploaded any bills yet." : "No vendor bills waiting."}
          </CardContent></Card>
        ) : (
          <div className="space-y-3">
            {(bills || []).map((b: any) => (
              <Card key={b.id} className="border-none shadow-sm">
                <CardHeader className="pb-2 flex flex-row items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-sm">
                      {b.suppliers?.name || "Vendor"} · Bill {b.bill_no || "—"}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">
                      {fmtDate(b.bill_date || b.created_at)}
                      {" · "}₹{Number(b.total_value).toLocaleString()}
                      {b.gstin ? ` · GSTIN ${b.gstin}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={`text-[10px] uppercase ${STATUS_STYLE[b.status] || ""}`}>{b.status}</Badge>
                    {b.image_path && (
                      <Button variant="ghost" size="sm" className="text-xs gap-1" onClick={() => viewPhoto(b.image_path)}>
                        <ImageIcon className="w-3.5 h-3.5" /> Photo
                      </Button>
                    )}
                    {b.latitude != null ? (
                      <a
                        className="inline-flex items-center gap-1 text-xs underline text-accent"
                        href={`https://www.google.com/maps?q=${b.latitude},${b.longitude}`}
                        target="_blank" rel="noreferrer"
                        title={b.captured_at ? `Captured ${fmtDateTime(b.captured_at)}` : undefined}
                      >
                        <MapPin className="w-3.5 h-3.5" /> Location
                      </a>
                    ) : (
                      <Badge variant="outline" className="text-[10px] bg-warning/10 text-warning border-warning/20">
                        no location
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Item</TableHead>
                        <TableHead className="text-xs text-right">Qty</TableHead>
                        <TableHead className="text-xs text-right">Rate</TableHead>
                        <TableHead className="text-xs text-right">Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(b.vendor_bill_items || []).map((i: any) => (
                        <TableRow key={i.id}>
                          <TableCell className="text-sm">{i.item_name}</TableCell>
                          <TableCell className="text-sm text-right">{Number(i.quantity)} {i.unit}</TableCell>
                          <TableCell className="text-sm text-right">₹{Number(i.rate)}</TableCell>
                          <TableCell className="text-sm text-right font-medium">₹{Number(i.total).toLocaleString()}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {b.review_notes && (
                    <p className="px-4 py-2 text-xs text-muted-foreground border-t">Note: {b.review_notes}</p>
                  )}
                  {isStoreKeeperOrAbove && b.status !== "converted" && (
                    <div className="p-3 border-t flex justify-end gap-2">
                      {b.status === "submitted" && (
                        <>
                          <Button variant="outline" size="sm"
                            onClick={() => reviewBill.mutate({ id: b.id, status: "rejected", review_notes: "Did not match goods received" })}>
                            <X className="w-3.5 h-3.5 mr-1" /> Reject
                          </Button>
                          <Button variant="outline" size="sm"
                            onClick={() => reviewBill.mutate({ id: b.id, status: "verified" })}>
                            <Check className="w-3.5 h-3.5 mr-1" /> Verify
                          </Button>
                        </>
                      )}
                      {b.status === "verified" && (
                        <Button size="sm" onClick={() => doConvert(b.id)} disabled={convertBill.isPending}>
                          <FileUp className="w-3.5 h-3.5 mr-1" /> Convert to purchase
                        </Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Upload a bill</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label className="text-xs">Deliver to site *</Label>
              <Select value={form.canteen_id} onValueChange={(v) => setForm({ ...form, canteen_id: v })}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select site" /></SelectTrigger>
                <SelectContent>
                  {(canteens || []).map((c: any) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Bill no.</Label>
              <Input value={form.bill_no} onChange={(e) => setForm({ ...form, bill_no: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Bill date</Label>
              <Input type="date" value={form.bill_date} onChange={(e) => setForm({ ...form, bill_date: e.target.value })} />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label className="text-xs">GSTIN</Label>
              <Input value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value })} />
            </div>
            <div className="col-span-2">
              <GeoPhotoCapture
                value={capture}
                onChange={setCapture}
                label="Bill photo — taken at the delivery point"
                allowVideo
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">Items</Label>
            {lines.map((l, idx) => (
              <div key={idx} className="flex gap-1.5 items-center">
                <Input className="flex-1 h-8 text-sm" placeholder="Item"
                  value={l.item_name}
                  onChange={(e) => setLines((p) => p.map((x, i) => i === idx ? { ...x, item_name: e.target.value } : x))} />
                <Input type="number" className="w-16 h-8 text-sm" placeholder="qty"
                  value={l.quantity}
                  onChange={(e) => setLines((p) => p.map((x, i) => i === idx ? { ...x, quantity: e.target.value } : x))} />
                <Input className="w-14 h-8 text-sm" placeholder="unit"
                  value={l.unit}
                  onChange={(e) => setLines((p) => p.map((x, i) => i === idx ? { ...x, unit: e.target.value } : x))} />
                <Input type="number" className="w-20 h-8 text-sm" placeholder="rate"
                  value={l.rate}
                  onChange={(e) => setLines((p) => p.map((x, i) => i === idx ? { ...x, rate: e.target.value } : x))} />
                <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive"
                  onClick={() => setLines((p) => p.filter((_, i) => i !== idx))}>
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" className="text-xs"
              onClick={() => setLines((p) => [...p, { item_name: "", quantity: "", unit: "kg", rate: "" }])}>
              <Plus className="w-3 h-3 mr-1" /> Add item
            </Button>
          </div>

          <DialogFooter className="items-center sm:justify-between gap-3">
            <p className="text-sm font-semibold">Total: ₹{total.toLocaleString()}</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={submit} disabled={busy || submitBill.isPending}>
                <Upload className="w-4 h-4 mr-1.5" /> {busy ? "Uploading…" : "Submit bill"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
