import { useState, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useIngredients, useCreatePurchase } from "@/hooks/useSupabaseData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScanLine, Upload, Check, AlertTriangle, Camera, CameraOff, ZoomIn } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

interface ScannedItem {
  item_name: string;
  quantity: number;
  unit: string;
  rate: number;
  total: number;
  matched: boolean;
  ingredient_id?: string;
  confidence_score: number;
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
  const createPurchase = useCreatePurchase();
  const navigate = useNavigate();

  const [step, setStep] = useState<"upload" | "review" | "done">("upload");
  const [fileName, setFileName] = useState("");
  const [scannedItems, setScannedItems] = useState<ScannedItem[]>([]);
  const [processing, setProcessing] = useState(false);
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

  const processBase64 = async (name: string, imageBase64: string, mimeType: string) => {
    setFileName(name);
    const { data, error } = await supabase.functions.invoke("ocr-invoice", {
      body: { imageBase64, mimeType },
    });
    if (error) throw new Error(error.message || "OCR failed");
    if (data?.error) throw new Error(data.error);
    const rawItems: any[] = data?.items || [];
    const matched = rawItems.map(item => {
      const match = fuzzyMatch(item.item_name, ingredients || []);
      return {
        item_name: item.item_name,
        quantity: Number(item.quantity) || 0,
        unit: item.unit || "kg",
        rate: Number(item.rate) || 0,
        total: Number(item.total) || 0,
        matched: !!match,
        ingredient_id: match?.ingredient_id,
        confidence_score: match?.confidence || 0,
      };
    });
    if (matched.length === 0) { toast.warning("No items extracted. Try a clearer photo."); setProcessing(false); return; }
    setScannedItems(matched);
    setStep("review");
    toast.success(`Extracted ${matched.length} items!`);
    setProcessing(false);
  };

  const processCameraImage = async () => {
    if (!capturedImage) return;
    setProcessing(true);
    try {
      await processBase64("camera-capture.jpg", capturedImage.split(",")[1], "image/jpeg");
    } catch (err: any) {
      toast.error(err.message || "Failed to process image");
      setProcessing(false);
    }
  };

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setProcessing(true);
    try {
      const imageBase64 = await fileToBase64(file);
      await processBase64(file.name, imageBase64, file.type);
    } catch (err: any) {
      toast.error(err.message || "Failed to process invoice");
      setProcessing(false);
    }
  }, [ingredients]);

  const updateScannedItem = (idx: number, updates: Partial<ScannedItem>) => {
    setScannedItems(prev => prev.map((item, i) => i === idx ? { ...item, ...updates } : item));
  };

  const handleConfirmDraft = async () => {
    if (selectedCanteen === "all") { toast.error("Select a canteen first"); return; }
    try {
      await createPurchase.mutateAsync({
        canteen_id: selectedCanteen,
        items: scannedItems.map(item => ({
          item_name: item.item_name, quantity: item.quantity, unit: item.unit,
          rate: item.rate, total: item.total, ingredient_id: item.ingredient_id,
          confidence_score: item.confidence_score, matched: item.matched,
        })),
        notes: `Scanned from invoice: ${fileName}`,
      });
      toast.success("Draft purchase created!");
      setStep("done");
    } catch (err: any) { toast.error(err.message); }
  };

  const reset = () => { setStep("upload"); setFileName(""); setScannedItems([]); setCapturedImage(null); stopCamera(); };

  return (
    <AppLayout title="Invoice Scan">
      <div className="max-w-4xl mx-auto space-y-4 animate-fade-in">
        {/* Steps */}
        <div className="flex items-center gap-4 mb-6">
          {["Upload Invoice", "Review & Match", "Create Draft"].map((label, i) => {
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
                <p className="text-sm text-muted-foreground">Upload a JPG, PNG or PDF invoice</p>
                <label className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-secondary text-secondary-foreground cursor-pointer hover:bg-muted transition-colors">
                  <Upload className="w-4 h-4" />
                  <span className="text-sm font-medium">Choose File</span>
                  <input type="file" accept="image/*,.pdf" className="hidden" onChange={handleUpload} />
                </label>
                {processing && <p className="text-sm text-muted-foreground animate-pulse">🤖 AI is reading your invoice...</p>}
              </CardContent>
            </Card>
          </div>
        )}

        {step === "review" && (
          <>
            <Card className="border-none shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <ScanLine className="w-4 h-4" /> Extracted Items — {fileName}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {scannedItems.map((item, idx) => (
                    <div key={idx} className={`p-3 rounded-lg border ${item.matched ? "border-green-500/30 bg-green-500/5" : "border-yellow-500/30 bg-yellow-500/5"}`}>
                      <div className="flex items-center gap-2 mb-2">
                        {item.matched ? (
                          <Badge variant="secondary" className="bg-green-500/10 text-green-600 text-[10px] border-green-500/20">✓ Matched {(item.confidence_score * 100).toFixed(0)}%</Badge>
                        ) : (
                          <Badge variant="secondary" className="bg-yellow-500/10 text-yellow-600 text-[10px] border-yellow-500/20"><AlertTriangle className="w-3 h-3 mr-1" />Unmatched</Badge>
                        )}
                      </div>
                      <div className="flex gap-2 items-end flex-wrap">
                        <div className="flex-1 min-w-[120px]">
                          <Label className="text-[10px]">Item Name</Label>
                          <Input className="h-8 text-xs" value={item.item_name} onChange={e => updateScannedItem(idx, { item_name: e.target.value })} />
                        </div>
                        <div className="w-16"><Label className="text-[10px]">Qty</Label><Input type="number" className="h-8 text-xs" value={item.quantity} onChange={e => updateScannedItem(idx, { quantity: Number(e.target.value), total: Number(e.target.value) * item.rate })} /></div>
                        <div className="w-16"><Label className="text-[10px]">Unit</Label><Input className="h-8 text-xs" value={item.unit} onChange={e => updateScannedItem(idx, { unit: e.target.value })} /></div>
                        <div className="w-20"><Label className="text-[10px]">Rate (₹)</Label><Input type="number" className="h-8 text-xs" value={item.rate} onChange={e => updateScannedItem(idx, { rate: Number(e.target.value), total: item.quantity * Number(e.target.value) })} /></div>
                        <div className="w-20"><Label className="text-[10px]">Total</Label><Input className="h-8 text-xs" value={`₹${item.total}`} readOnly /></div>
                        {!item.matched && (
                          <div className="flex-1 max-w-[160px]">
                            <Label className="text-[10px]">Match ingredient</Label>
                            <select className="w-full h-8 text-xs border rounded px-2 bg-card" value={item.ingredient_id || ""} onChange={e => { const id = e.target.value; updateScannedItem(idx, { ingredient_id: id || undefined, matched: !!id, confidence_score: id ? 1.0 : 0 }); }}>
                              <option value="">— Select —</option>
                              {ingredients?.map((ing: any) => <option key={ing.id} value={ing.id}>{ing.name}</option>)}
                            </select>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <div className="flex justify-between items-center">
              <Button variant="outline" onClick={reset}>Start Over</Button>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold">Total: ₹{scannedItems.reduce((s, i) => s + i.total, 0).toLocaleString()}</span>
                <Button onClick={handleConfirmDraft} disabled={createPurchase.isPending} className="bg-accent text-accent-foreground hover:bg-accent/90 gap-1.5">
                  <Check className="w-4 h-4" /> Create Draft Purchase
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
