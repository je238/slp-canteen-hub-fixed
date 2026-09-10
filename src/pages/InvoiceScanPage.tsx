import { useState, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useIngredients, useCreatePurchase, useSuppliers } from "@/hooks/useSupabaseData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScanLine, Upload, Check, AlertTriangle, Camera, CameraOff, ZoomIn, Trash2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { compressImage, toCompressedBase64 } from "@/lib/image";
import ScanProgress from "@/components/ScanProgress";
import { scanBase64 } from "@/lib/scan";
import FilePickButton from "@/components/FilePickButton";
import { saveDraft, loadDraft, clearDraft } from "@/lib/draft";

// One bill at a time per person, so a draft cannot be mistaken for another.
const DRAFT_KEY = "invoice-scan";

interface ScannedItem {
  item_name: string;
  original_name?: string;   // as handwritten on the bill, kept for checking
  quantity: number;
  unit: string;
  rate: number;
  total: number;
  matched: boolean;
  ingredient_id?: string;
  confidence_score: number;
  stock_quantity?: number;
  stock_unit?: string;
  conversion_confirmed?: boolean;
  conversion_note?: string;
}

const canonicalUnit = (unit?: string) => {
  const u = (unit || "").trim().toLowerCase();
  if (!u || u === "unsure") return "";
  if (["kg", "kgs", "kilogram", "kilograms"].includes(u)) return "kg";
  if (["l", "lt", "ltr", "ltrs", "liter", "liters", "litre", "litres"].includes(u)) return "litre";
  if (["pc", "pcs", "pec", "piece", "pieces"].includes(u)) return "pcs";
  if (["box", "boxes"].includes(u)) return "box";
  if (["pkt", "pkts", "pack", "packs", "packet", "packets"].includes(u)) return "packet";
  return u;
};

// Header fields extracted by the ocr-invoice function (all nullable —
// older deployments of the function don't return `invoice` at all).
interface InvoiceMeta {
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  gstin: string | null;
  subtotal: number | null;
  tax_amount: number | null;
  other_charges: number | null;
  grand_total: number | null;
}

const blankInvoiceMeta = (): InvoiceMeta => ({
  vendor_name: null,
  invoice_number: null,
  invoice_date: null,
  gstin: null,
  subtotal: null,
  tax_amount: null,
  other_charges: null,
  grand_total: null,
});

// How many single-letter edits separate two names. Substring matching
// alone never catches the dangerous case: Rose and Rice share no run of
// letters, so a typo silently opens a second item and the stock splits in
// two. Two edits apart is almost never two real ingredients.
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1, cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** An existing item this name is probably a misspelling of. */
function nearMiss(name: string, ingredients: any[]): any | null {
  const n = name.toLowerCase().trim();
  if (n.length < 3) return null;
  let best: any = null, bestD = 99;
  for (const ing of ingredients || []) {
    const other = ing.name.toLowerCase().trim();
    if (other === n) return null;                 // exact — nothing to warn about
    const d = editDistance(n, other);
    if (d <= 2 && d < bestD) { best = ing; bestD = d; }
  }
  return best;
}

function fuzzyMatch(scannedName: string, ingredients: any[]): { ingredient_id: string; confidence: number } | null {
  if (!ingredients?.length) return null;
  const name = scannedName.toLowerCase().trim();
  let best: { ingredient_id: string; confidence: number } | null = null;
  for (const ing of ingredients) {
    const ingName = ing.name.toLowerCase();
    if (ingName === name) return { ingredient_id: ing.id, confidence: 1.0 };
    if (ingName.includes(name) || name.includes(ingName)) {
      const conf = 0.7 + (Math.min(ingName.length, name.length) / Math.max(ingName.length, name.length)) * 0.2;
      if (!best || conf > best.confidence) best = { ingredient_id: ing.id, confidence: conf };
    }
    const ingWords = ingName.split(/\s+/);
    const nameWords = name.split(/\s+/);
    const overlap = nameWords.filter(w => ingWords.some(iw => iw.includes(w) || w.includes(iw))).length;
    if (overlap > 0) {
      const conf = 0.3 + (overlap / Math.max(ingWords.length, nameWords.length)) * 0.5;
      if (!best || conf > best.confidence) best = { ingredient_id: ing.id, confidence: conf };
    }
  }
  return best && best.confidence > 0.3 ? best : null;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { resolve((reader.result as string).split(",")[1]); };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function InvoiceScanPage() {
  const { selectedCanteen } = useAppContext();
  const { data: ingredients } = useIngredients(selectedCanteen);
  const { data: suppliers } = useSuppliers(selectedCanteen);
  const createPurchase = useCreatePurchase();
  const navigate = useNavigate();

  const [step, setStep] = useState<"upload" | "review" | "done">("upload");
  const [fileName, setFileName] = useState("");
  const [scannedItems, setScannedItems] = useState<ScannedItem[]>([]);
  const [invoiceMeta, setInvoiceMeta] = useState<InvoiceMeta | null>(null);
  const [supplierId, setSupplierId] = useState<string>("");
  const [processing, setProcessing] = useState(false);
  const [scanStage, setScanStage] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const startCamera = async () => {
    setCameraError("");
    setCapturedImage(null);
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      setStream(mediaStream);
      setCameraOpen(true);
    } catch (err: any) {
      if (err.name === "NotAllowedError") {
        setCameraError("Camera permission denied. Please allow camera access in your browser settings.");
      } else if (err.name === "NotFoundError") {
        setCameraError("No camera found on this device.");
      } else {
        setCameraError("Could not access camera. Try uploading an image instead.");
      }
    }
  };

  useEffect(() => {
    if (stream && videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream, cameraOpen]);

  const stopCamera = () => {
    if (stream) { stream.getTracks().forEach(t => t.stop()); setStream(null); }
    setCameraOpen(false);
    setCapturedImage(null);
  };

  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    setCapturedImage(canvas.toDataURL("image/jpeg", 0.95));
    if (stream) { stream.getTracks().forEach(t => t.stop()); setStream(null); }
    setCameraOpen(false);
  };

  // Keep the raw image so the confirmed purchase carries its evidence photo.
  const [pendingImage, setPendingImage] = useState<{ base64: string; mimeType: string } | null>(null);

  // Manual means the store keeper reads the photographed paper and types its
  // lines himself. It no longer means "no bill": every stock receipt carries
  // an immutable invoice photo, whether OCR read it or a person did.
  const [byHand, setByHand] = useState(false);
  // Saving uploads a photo and then books the receipt, which takes seconds.
  // The button's disabled state was tied to a mutation this save does not go
  // through, so it never went grey — and every extra tap booked ANOTHER goods
  // receipt, stock and all. One bill went in four times that way.
  const [saving, setSaving] = useState(false);
  const [restored, setRestored] = useState(false);
  const loadedDraft = useRef(false);

  // A scanned-but-unsaved bill is the most expensive thing on any screen in
  // this app: the photo, the scan and every line read back off it. If the
  // phone kills the app before Save is pressed it all has to be done again,
  // in front of a delivery driver who is waiting. So it is written down as
  // it stands and picked back up on the next open.
  useEffect(() => {
    (async () => {
      const d = await loadDraft<any>(DRAFT_KEY);
      loadedDraft.current = true;
      if (!d || !d.scannedItems?.length) return;
      setStep("review");
      setFileName(d.fileName || "");
      setScannedItems(d.scannedItems);
      setInvoiceMeta(d.invoiceMeta ?? null);
      setSupplierId(d.supplierId || "");
      setPendingImage(d.pendingImage ?? null);
      setByHand(!!d.byHand);
      setRestored(true);
    })();
  }, []);

  useEffect(() => {
    if (!loadedDraft.current) return;          // don't overwrite before reading
    if (step === "review" && scannedItems.length) {
      saveDraft(DRAFT_KEY, { fileName, scannedItems, invoiceMeta, supplierId, pendingImage, byHand });
    }
  }, [step, fileName, scannedItems, invoiceMeta, supplierId, pendingImage, byHand]);

  const beginManualInvoice = (name: string, base64: string, mimeType: string) => {
    setByHand(true);
    setFileName(name || "invoice-photo.jpg");
    setPendingImage({ base64, mimeType });
    setInvoiceMeta(blankInvoiceMeta());
    setSupplierId("");
    setScannedItems([{
      item_name: "", quantity: 0, unit: "", rate: 0,
      total: 0, matched: false, confidence_score: 1,
    }]);
    setStep("review");
    toast.success("Invoice photo attached — ab bill ke items khud bharein");
  };

  const handleManualFile = useCallback(async (file: File) => {
    try {
      const { base64, mimeType } = await toCompressedBase64(file);
      beginManualInvoice(file.name, base64, mimeType || "image/jpeg");
    } catch (err: any) {
      toast.error(err.message || "Invoice photo attach nahi hui");
    }
  }, []);

  const processBase64 = async (name: string, imageBase64: string, mimeType: string) => {
    const scanStartedAt = Date.now();
    const logOcrEvent = (status: "success" | "failed", error?: unknown) => {
      if (!selectedCanteen || selectedCanteen === "all") return;
      const message = error instanceof Error ? error.message : error ? String(error) : null;
      // Scanner UX ko audit insert ke liye wait nahi karna chahiye. RLS user/site
      // ownership enforce karta hai; failed logging scan result ko hide nahi karega.
      void supabase.from("ocr_scan_events" as any).insert({
        canteen_id: selectedCanteen,
        scan_type: "invoice",
        status,
        error_code: status === "failed" ? (/timeout|time/i.test(message || "") ? "timeout" : "scan_failed") : null,
        error_message: message,
        duration_ms: Date.now() - scanStartedAt,
      }).then(() => undefined);
    };
    setFileName(name);
    setPendingImage({ base64: imageBase64, mimeType });
    // Shared with the menu scanner, over a plain fetch: functions.invoke
    // discards the response body and reports every failure as "Edge Function
    // returned a non-2xx status code", so the reason never reached anyone.
    try {
    const data = await scanBase64(imageBase64, mimeType, "invoice", setScanStage, selectedCanteen);
    const rawItems: any[] = data?.items || [];
    // These bills are handwritten, mostly in Hindi — the scan will get names
    // wrong. We keep whatever it read, show it as an editable field, and let
    // the store keeper correct it. Matching to an existing ingredient is a
    // hint (it pre-fills nothing that blocks saving), never a requirement.
    const matched = rawItems.map(item => {
      const match = fuzzyMatch(item.item_name, ingredients || []);
      return {
        item_name: item.item_name,
        original_name: item.original_name || undefined,
        quantity: Number(item.quantity) || 0,
        // Never silently turn an unreadable unit into kilograms.
        unit: item.unit || "UNSURE",
        rate: Number(item.rate) || 0,
        total: Number(item.total) || 0,
        matched: !!match,
        ingredient_id: match?.ingredient_id,
        confidence_score: match?.confidence || 0,
        stock_unit: match
          ? (ingredients || []).find((g: any) => g.id === match.ingredient_id)?.unit
          : undefined,
        conversion_confirmed: false,
      };
    });
    if (matched.length === 0) {
      logOcrEvent("failed", new Error("No invoice items extracted"));
      toast.warning("No items extracted. Try a clearer photo."); setProcessing(false); return;
    }
    setScannedItems(matched);

    // Header fields + vendor auto-match (older function deployments return no `invoice`)
    const meta: InvoiceMeta | null = data?.invoice || null;
    setInvoiceMeta(meta);
    if (meta?.vendor_name && suppliers?.length) {
      const vendorMatch = fuzzyMatch(meta.vendor_name, suppliers);
      setSupplierId(vendorMatch && vendorMatch.confidence >= 0.5 ? vendorMatch.ingredient_id : "");
    } else {
      setSupplierId("");
    }

    setStep("review");
    logOcrEvent("success");
    toast.success(`Extracted ${matched.length} items!`);
    setProcessing(false);
    } catch (error) {
      logOcrEvent("failed", error);
      throw error;
    }
  };

  const processCameraImage = async () => {
    if (!capturedImage) return;
    setProcessing(true);
    setScanStage("Sending the photo to be read");
    try {
      await processBase64("camera-capture.jpg", capturedImage.split(",")[1], "image/jpeg");
    } catch (err: any) {
      toast.error(err.message || "Failed to process image");
      setProcessing(false);
    }
  };

  const handlePickedFile = useCallback(async (file: File) => {
    if (!file) return;
    setProcessing(true);
    setScanStage(`Preparing ${file.name || "the bill"}…`);
    try {
      const { base64, mimeType } = await toCompressedBase64(file);
      setScanStage("Sending it to be read");
      // A gallery photo can arrive with no type at all; scan.ts fills it in.
      await processBase64(file.name, base64, mimeType || (/.pdf$/i.test(file.name) ? "application/pdf" : "image/jpeg"));
    } catch (err: any) {
      toast.error(err.message || "Failed to process invoice");
      setProcessing(false);
    }
  }, [ingredients]);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setProcessing(true);
    setScanStage(`Preparing ${file.name || "the bill"}…`);
    try {
      const { base64, mimeType } = await toCompressedBase64(file);
      setScanStage("Sending it to be read");
      await processBase64(file.name, base64, mimeType);
    } catch (err: any) {
      toast.error(err.message || "Failed to process invoice");
      setProcessing(false);
    }
  }, [ingredients]);

  const updateScannedItem = (idx: number, updates: Partial<ScannedItem>) => {
    setScannedItems(prev => prev.map((item, i) => i === idx ? { ...item, ...updates } : item));
  };

  // A receipt without its bill photo cannot enter stock. The photo is the
  // evidence for every quantity and rate typed below it.
  const uploadInvoiceImage = async (): Promise<string> => {
    if (!pendingImage) throw new Error("Invoice photo lagana zaroori hai");
    const ext = pendingImage.mimeType === "application/pdf" ? "pdf" : pendingImage.mimeType.split("/")[1] || "jpg";
    const path = `${selectedCanteen}/${Date.now()}-${fileName.replace(/[^\w.-]+/g, "_") || "invoice"}.${ext}`;
    const bytes = Uint8Array.from(atob(pendingImage.base64), (c) => c.charCodeAt(0));
    const { error } = await supabase.storage.from("invoices").upload(path, bytes, { contentType: pendingImage.mimeType });
    if (error) throw error;
    return path;
  };

  const handleConfirmDraft = async () => {
    if (selectedCanteen === "all") { toast.error("Select a canteen first"); return; }
    if (saving) return;              // a second tap is not a second delivery
    if (!pendingImage) { toast.error("Pehle invoice ki photo lagayein"); return; }
    const lines = scannedItems.filter(i => i.item_name?.trim() && i.quantity > 0);
    if (!lines.length) { toast.error("Invoice ka kam se kam ek item bharein"); return; }
    const unresolved = lines.find(i => !canonicalUnit(i.unit));
    if (unresolved) {
      toast.error(`${unresolved.item_name}: bill ki unit clear nahi hai — kg, litre, box, packet ya pcs likhein`);
      return;
    }
    const badConversion = lines.find((i) => {
      const master = (ingredients || []).find((g: any) => g.id === i.ingredient_id)?.unit;
      return master && canonicalUnit(master) !== canonicalUnit(i.unit) &&
        (!(Number(i.stock_quantity) > 0) || canonicalUnit(i.stock_unit) !== canonicalUnit(master) || !i.conversion_confirmed);
    });
    if (badConversion) {
      const master = (ingredients || []).find((g: any) => g.id === badConversion.ingredient_id)?.unit;
      toast.error(`${badConversion.item_name}: bill ${badConversion.unit} mein hai, stock ${master} mein — total ${master} aur confirmation bharein`);
      return;
    }
    setSaving(true);
    try {
      const invoice_image_url = await uploadInvoiceImage();
      const metaBits = [
        invoiceMeta?.invoice_number ? `Invoice ${invoiceMeta.invoice_number}` : null,
        invoiceMeta?.invoice_date || null,
        invoiceMeta?.gstin ? `GSTIN ${invoiceMeta.gstin}` : null,
        invoiceMeta?.grand_total ? `Grand total ₹${invoiceMeta.grand_total}` : null,
      ].filter(Boolean).join(" · ");
      // Straight into stock under the names as corrected on screen. An item
      // the site has never seen is created; one it already knows is topped up.
      const { data, error } = await supabase.rpc("add_stock_from_invoice" as any, {
        p_canteen_id: selectedCanteen,
        p_supplier_id: supplierId || null,
        p_items: lines
          .map(i => ({
            name: i.item_name.trim(), quantity: i.quantity, unit: i.unit,
            rate: i.rate, total: i.total,
            stock_quantity: i.stock_quantity, stock_unit: i.stock_unit,
            conversion_confirmed: i.conversion_confirmed,
            conversion_note: i.conversion_note,
          })),
        p_notes: metaBits
          ? `${metaBits} · ${byHand ? "Typed manually from" : "Scanned from"} ${fileName}`
          : `${byHand ? "Typed manually from invoice photo" : "Scanned from invoice"}: ${fileName}`,
        p_image_path: invoice_image_url,
        p_total: invoiceMeta?.grand_total ?? null,
      });
      if (error) throw error;
      const res = data as any;
      toast.success(
        `Stock added — ${res?.existing_items ?? 0} existing item(s) topped up, ${res?.new_items ?? 0} new item(s) created`
      );
      // The lines are what went into stock, so the lines are what the receipt
      // is worth. If the paper claimed a different total, that is worth
      // knowing at the counter — a bill that does not add up is either a
      // mistake or a charge for goods that never came off the truck.
      if (res?.mismatch) {
        toast.warning(
          `The paper said ₹${Number(res.stated_total).toLocaleString()} but the lines add to ` +
          `₹${Number(res.total).toLocaleString()} — a gap of ₹${Math.abs(Number(res.mismatch)).toLocaleString()}. ` +
          `Stock is recorded from the lines. Check the bill.`,
          { duration: 12000 }
        );
      }
      await clearDraft(DRAFT_KEY);   // it is in the books now
      setStep("done");
    } catch (err: any) { toast.error(err.message); }
    finally { setSaving(false); }
  };

  const reset = () => { clearDraft(DRAFT_KEY); setRestored(false); setByHand(false); setStep("upload"); setFileName(""); setScannedItems([]); setInvoiceMeta(null); setSupplierId(""); setCapturedImage(null); setPendingImage(null); stopCamera(); };

  return (
    <AppLayout title="Invoice Scan">
      <ScanProgress busy={processing} status={scanStage} />
      <div className="max-w-4xl mx-auto space-y-4 animate-fade-in">
        {/* Steps */}
        <div className="flex items-center gap-4 mb-6">
          {["Bill photo", "Check / type items", "Stock added"].map((label, i) => {
            const currentIdx = step === "upload" ? 0 : step === "review" ? 1 : 2;
            return (
              <div key={label} className="flex items-center gap-2">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${i <= currentIdx ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground"}`}>
                  {i < currentIdx ? <Check className="w-4 h-4" /> : i + 1}
                </div>
                <span className={`text-sm ${i <= currentIdx ? "font-medium" : "text-muted-foreground"}`}>{label}</span>
                {i < 2 && <div className={`w-8 h-0.5 ${i < currentIdx ? "bg-accent" : "bg-muted"}`} />}
              </div>
            );
          })}
        </div>

        {step === "upload" && (
          <div className="space-y-4">
            {/* Camera Card */}
            <Card className="border-none shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Camera className="w-4 h-4 text-accent" /> Scan with Camera
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!cameraOpen && !capturedImage && (
                  <div className="text-center space-y-3 py-4">
                    <div className="w-16 h-16 rounded-2xl bg-accent/10 flex items-center justify-center mx-auto">
                      <Camera className="w-8 h-8 text-accent" />
                    </div>
                    <p className="text-sm text-muted-foreground">Point your camera at the invoice for instant AI scanning</p>
                    {cameraError && <p className="text-xs text-destructive bg-destructive/10 rounded p-2">{cameraError}</p>}
                    <Button onClick={startCamera} className="bg-accent text-accent-foreground hover:bg-accent/90 gap-2">
                      <Camera className="w-4 h-4" /> Open Camera
                    </Button>
                    <div className="pt-1">
                      <FilePickButton
                        onPick={handleManualFile}
                        accept="image/*"
                        className="px-3 py-2 border bg-card hover:bg-muted text-xs"
                      >
                        <Pencil className="w-3.5 h-3.5" /> Photo lagao, invoice khud bharo
                      </FilePickButton>
                    </div>
                  </div>
                )}
                {cameraOpen && !capturedImage && (
                  <div className="space-y-3">
                    <div className="relative rounded-lg overflow-hidden bg-black">
                      <video ref={videoRef} autoPlay playsInline muted className="w-full max-h-80 object-cover" />
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <div className="border-2 border-accent rounded-lg w-3/4 h-3/4 opacity-60" />
                      </div>
                      <p className="absolute bottom-2 left-0 right-0 text-center text-xs text-white bg-black/40 py-1">
                        Position invoice inside the box
                      </p>
                    </div>
                    <canvas ref={canvasRef} className="hidden" />
                    <div className="flex gap-2 justify-center">
                      <Button onClick={capturePhoto} className="bg-accent text-accent-foreground hover:bg-accent/90 gap-2">
                        <ZoomIn className="w-4 h-4" /> Capture Photo
                      </Button>
                      <Button variant="outline" onClick={stopCamera} className="gap-2">
                        <CameraOff className="w-4 h-4" /> Cancel
                      </Button>
                    </div>
                  </div>
                )}
                {capturedImage && !cameraOpen && (
                  <div className="space-y-3">
                    <img src={capturedImage} alt="Captured invoice" className="w-full max-h-80 object-contain bg-black rounded-lg" />
                    <div className="flex gap-2 justify-center">
                      <Button onClick={processCameraImage} disabled={processing} className="bg-accent text-accent-foreground hover:bg-accent/90 gap-2">
                        <ScanLine className="w-4 h-4" /> {processing ? "Scanning with AI..." : "Scan This Invoice"}
                      </Button>
                      <Button variant="outline" className="gap-2"
                        onClick={() => beginManualInvoice("camera-invoice.jpg", capturedImage.split(",")[1], "image/jpeg")}>
                        <Pencil className="w-4 h-4" /> Details khud bharo
                      </Button>
                      <Button variant="outline" onClick={() => setCapturedImage(null)}>Retake</Button>
                    </div>
                    {processing && <p className="text-center text-sm text-muted-foreground animate-pulse">🤖 AI is reading your invoice...</p>}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Upload Card */}
            <Card className="border-none shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Upload className="w-4 h-4" /> Or Upload Invoice File
                </CardTitle>
              </CardHeader>
              <CardContent className="text-center py-4 space-y-3">
                <p className="text-sm text-muted-foreground">
                  On a phone the camera above is the reliable one. Choosing a
                  file works on a computer; on Android the picker often
                  returns nothing at all.
                </p>
                {/* Pasting the picture avoids the file picker entirely: long-press
                    the bill photo in WhatsApp, Copy, then paste in here. */}
                <div
                  tabIndex={0}
                  onPaste={(e) => {
                    const img = Array.from(e.clipboardData?.items || [])
                      .find((i) => i.type.startsWith("image/"));
                    const file = img?.getAsFile();
                    if (!file) return;
                    e.preventDefault();
                    handlePickedFile(file);
                  }}
                  className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground focus:outline-none focus:border-accent"
                >
                  Or tap here and paste a copied bill photo
                </div>
                {/* Goes through FilePickButton so the installed app uses the
                    native picker instead of the WebView file chooser, which
                    can open nothing at all and say nothing about it. */}
                <FilePickButton
                  onPick={handlePickedFile}
                  accept="image/*,application/pdf,.pdf"
                  disabled={processing}
                  className="px-6 py-3 bg-secondary text-secondary-foreground hover:bg-muted"
                >
                  <Upload className="w-4 h-4" />
                  <span className="text-sm font-medium">Choose File</span>
                </FilePickButton>
                {processing && <p className="text-sm text-muted-foreground animate-pulse">🤖 AI is reading your invoice...</p>}
              </CardContent>
            </Card>
          </div>
        )}

        {step === "review" && (
          <>
            {/* The store's own spelling, offered as you type. Picking from
                here is what keeps one ingredient under one name instead of
                quietly opening a second one that holds its own stock. */}
            <datalist id="known-items">
              {(ingredients || []).map((g: any) => <option key={g.id} value={g.name} />)}
            </datalist>
            {/* Picked up from a previous session. Said plainly, because a bill
                restored from yesterday must not be saved as today's without
                the person noticing what they are looking at. */}
            {restored && (
              <Card className="border-none shadow-sm bg-accent/10">
                <CardContent className="p-3 flex items-center gap-2 flex-wrap">
                  <Check className="w-4 h-4 text-accent shrink-0" />
                  <p className="text-xs flex-1 min-w-[200px]">
                    This bill was still open from before — nothing was lost.
                    Check it is the right one, then save.
                  </p>
                  <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={reset}>
                    <Trash2 className="w-3 h-3 mr-1" /> start again
                  </Button>
                </CardContent>
              </Card>
            )}

            {byHand && (
              <Card className="border border-accent/30 bg-accent/5 shadow-sm">
                <CardContent className="p-3 text-xs">
                  Invoice photo attached hai. Paper dekhkar vendor, invoice number/date aur har item ki quantity, unit aur rate bharein.
                </CardContent>
              </Card>
            )}

            {/* Invoice header details (only when the function returned them) */}
            {invoiceMeta && (
              <Card className="border-none shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">Invoice Details</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="col-span-2">
                      <Label className="text-[10px]">Vendor {invoiceMeta.vendor_name ? `— read as "${invoiceMeta.vendor_name}"` : ""}</Label>
                      <select
                        className="w-full h-8 text-xs border rounded px-2 bg-card mt-1"
                        value={supplierId}
                        onChange={e => setSupplierId(e.target.value)}
                      >
                        <option value="">— No vendor linked —</option>
                        {suppliers?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                      {invoiceMeta.vendor_name && !supplierId && (
                        <p className="text-[10px] text-muted-foreground mt-1">
                          No matching vendor found — add "{invoiceMeta.vendor_name}" on the Vendors page to auto-match next time.
                        </p>
                      )}
                    </div>
                    <div>
                      <Label className="text-[10px]">Invoice No.</Label>
                      <Input className="h-8 text-xs mt-1" value={invoiceMeta.invoice_number || ""} onChange={e => setInvoiceMeta({ ...invoiceMeta, invoice_number: e.target.value })} />
                    </div>
                    <div>
                      <Label className="text-[10px]">Date</Label>
                      <Input className="h-8 text-xs mt-1" value={invoiceMeta.invoice_date || ""} onChange={e => setInvoiceMeta({ ...invoiceMeta, invoice_date: e.target.value })} />
                    </div>
                  </div>
                  {(invoiceMeta.tax_amount || invoiceMeta.other_charges || invoiceMeta.grand_total) && (
                    <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 pt-3 border-t text-xs text-muted-foreground">
                      {invoiceMeta.subtotal != null && <span>Taxable: ₹{invoiceMeta.subtotal.toLocaleString()}</span>}
                      {invoiceMeta.tax_amount != null && invoiceMeta.tax_amount > 0 && <span>GST: ₹{invoiceMeta.tax_amount.toLocaleString()}</span>}
                      {invoiceMeta.other_charges != null && invoiceMeta.other_charges > 0 && <span>Freight/other: ₹{invoiceMeta.other_charges.toLocaleString()}</span>}
                      {invoiceMeta.grand_total != null && <span className="font-semibold text-foreground">Payable: ₹{invoiceMeta.grand_total.toLocaleString()}</span>}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <Card className="border-none shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  {byHand ? <Pencil className="w-4 h-4" /> : <ScanLine className="w-4 h-4" />}
                  {byHand ? "Invoice ke items khud bharein" : "Extracted Items"} — {fileName}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {scannedItems.map((item, idx) => (
                    <div key={idx} className="p-3 rounded-lg border">
                      <div className="flex items-center gap-2 mb-2">
                        {item.matched ? (
                          <Badge variant="secondary" className="bg-green-500/10 text-green-600 text-[10px] border-green-500/20">
                            already in stock
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="bg-accent/10 text-accent text-[10px] border-accent/20">
                            new item — will be created
                          </Badge>
                        )}
                        {/* A name a letter or two off an item already in stock
                            is a typo far more often than it is a new thing.
                            Left alone it opens a second item and the stock for
                            one ingredient sits in two places. */}
                        {!item.matched && (() => {
                          const near = nearMiss(item.item_name, ingredients || []);
                          if (!near) return null;
                          return (
                            <button
                              className="text-[10px] px-2 py-0.5 rounded-full border border-warning/40 bg-warning/10 text-warning hover:bg-warning/20"
                              onClick={() => updateScannedItem(idx, {
                                item_name: near.name, matched: true, ingredient_id: near.id,
                                stock_unit: near.unit, stock_quantity: undefined,
                                conversion_confirmed: false,
                              })}
                            >
                              did you mean <b>{near.name}</b>? · tap to use it
                            </button>
                          );
                        })()}
                      </div>
                      <div className="flex gap-2 items-end flex-wrap">
                        <div className="flex-1 min-w-[120px]">
                          <Label className="text-[10px]">Item name — correct it if the scan misread it{item.original_name && item.original_name !== item.item_name ? <span className="text-muted-foreground"> · bill says "{item.original_name}"</span> : null}</Label>
                          <Input className="h-8 text-xs" value={item.item_name} list="known-items"
                            onChange={e => {
                              const name = e.target.value;
                              // Re-check against existing stock as they type, so the
                              // badge tells them whether this will top up or create.
                              const hit = (ingredients || []).find(
                                (g: any) => g.name.trim().toLowerCase() === name.trim().toLowerCase()
                              );
                              updateScannedItem(idx, {
                                item_name: name, matched: !!hit, ingredient_id: hit?.id,
                                stock_unit: hit?.unit, stock_quantity: undefined,
                                conversion_confirmed: false,
                              });
                            }} />
                        </div>
                        <div className="w-16"><Label className="text-[10px]">Qty</Label><Input type="number" className="h-8 text-xs" value={item.quantity} onChange={e => updateScannedItem(idx, { quantity: Number(e.target.value), total: Number(e.target.value) * item.rate })} /></div>
                        <div className="w-16"><Label className="text-[10px]">Unit</Label><Input className="h-8 text-xs" value={item.unit} onChange={e => updateScannedItem(idx, { unit: e.target.value })} /></div>
                        <div className="w-20"><Label className="text-[10px]">Rate (₹)</Label><Input type="number" className="h-8 text-xs" value={item.rate} onChange={e => updateScannedItem(idx, { rate: Number(e.target.value), total: item.quantity * Number(e.target.value) })} /></div>
                        <div className="w-20"><Label className="text-[10px]">Total</Label><Input className="h-8 text-xs" value={`₹${item.total}`} readOnly /></div>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive"
                          onClick={() => setScannedItems(prev => prev.filter((_, i) => i !== idx))}
                          title="Remove this line">
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                      {(() => {
                        const master = (ingredients || []).find((g: any) => g.id === item.ingredient_id)?.unit;
                        const unresolved = !canonicalUnit(item.unit);
                        const needsConversion = !!master && !!canonicalUnit(item.unit) &&
                          canonicalUnit(master) !== canonicalUnit(item.unit);
                        if (!unresolved && !needsConversion) return null;
                        if (unresolved) return (
                          <p className="mt-2 text-xs font-semibold text-destructive">
                            Unit read nahi hui. Bill dekhkar Unit box mein kg, litre, box, packet ya pcs likhein.
                          </p>
                        );
                        return (
                          <div className="mt-3 rounded-md border border-warning/40 bg-warning/5 p-3 space-y-2">
                            <p className="text-xs font-semibold text-warning">
                              Bill: {item.quantity} {item.unit} · Shelf: {master}. Conversion confirm karna zaroori hai.
                            </p>
                            <div className="flex items-end gap-2 flex-wrap">
                              <div className="w-36">
                                <Label className="text-[10px]">Total stock received ({master})</Label>
                                <Input type="number" min="0" step="any" className="h-8 text-xs"
                                  value={item.stock_quantity ?? ""}
                                  onChange={(e) => updateScannedItem(idx, {
                                    stock_quantity: Number(e.target.value), stock_unit: master,
                                    conversion_confirmed: false,
                                  })} />
                              </div>
                              <label className="flex items-center gap-2 h-8 text-xs font-medium">
                                <input type="checkbox" checked={!!item.conversion_confirmed}
                                  onChange={(e) => updateScannedItem(idx, {
                                    conversion_confirmed: e.target.checked,
                                    stock_unit: master,
                                    conversion_note: e.target.checked
                                      ? `${item.quantity} ${item.unit} checked as ${item.stock_quantity || 0} ${master}`
                                      : undefined,
                                  })} />
                                Maine box/packet ka total {master} check kiya
                              </label>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  ))}
                </div>

                {/* A typed receipt starts with one blank line; a scanned one
                    sometimes misses a line the camera could not see. Both
                    need a way to add another. */}
                <Button variant="outline" size="sm" className="mt-3 h-8 text-xs gap-1"
                  onClick={() => setScannedItems([...scannedItems, {
                    item_name: "", quantity: 0, unit: "", rate: 0,
                    total: 0, matched: false, confidence_score: 1,
                  }])}>
                  <Plus className="w-3.5 h-3.5" /> Add another item
                </Button>
              </CardContent>
            </Card>
            <div className="flex justify-between items-center">
              <Button variant="outline" onClick={reset}>Start Over</Button>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold">
                  {invoiceMeta?.grand_total
                    ? <>Payable: ₹{invoiceMeta.grand_total.toLocaleString()}</>
                    : <>Total: ₹{scannedItems.reduce((s, i) => s + i.total, 0).toLocaleString()}</>}
                </span>
                <Button onClick={handleConfirmDraft} disabled={saving}
                        className="bg-accent text-accent-foreground hover:bg-accent/90 gap-1.5">
                  <Check className="w-4 h-4" /> {saving ? "Saving…" : "Add to stock"}
                </Button>
              </div>
            </div>
          </>
        )}

        {step === "done" && (
          <Card className="border-none shadow-sm">
            <CardContent className="p-8 text-center">
              <div className="w-16 h-16 rounded-2xl bg-green-500/10 flex items-center justify-center mx-auto mb-4">
                <Check className="w-8 h-8 text-green-600" />
              </div>
              <h3 className="text-lg font-semibold mb-2">Draft Purchase Created!</h3>
              <p className="text-sm text-muted-foreground mb-4">Go to Purchases to review and confirm.</p>
              <div className="flex gap-2 justify-center">
                <Button variant="outline" onClick={reset}>Scan Another</Button>
                <Button className="bg-accent text-accent-foreground hover:bg-accent/90" onClick={() => navigate("/purchases")}>Go to Purchases</Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}
