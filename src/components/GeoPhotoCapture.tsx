import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Camera, Check, MapPin, RefreshCw, Video, X } from "lucide-react";
import { toast } from "sonner";
import { compressImage } from "@/lib/image";
import FilePickButton from "@/components/FilePickButton";

// A photo (or short video) that carries where and when it was taken.
// The device camera is opened directly with capture="environment" so a phone
// takes a fresh shot rather than offering the gallery — an old photo from the
// roll is exactly what this is meant to stop.

export interface GeoCapture {
  file: File;
  kind: "image" | "video";
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  capturedAt: string;
}

interface Props {
  value: GeoCapture | null;
  onChange: (c: GeoCapture | null) => void;
  label?: string;
  allowVideo?: boolean;
  /** Location is required — refuse the capture if the device won't give one. */
  requireLocation?: boolean;
}

function readLocation(): Promise<GeolocationPosition | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

export default function GeoPhotoCapture({
  value, onChange, label = "Photo", allowVideo = false, requireLocation = false,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [camOpen, setCamOpen] = useState(false);
  const [camError, setCamError] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopCam = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamOpen(false);
  };

  useEffect(() => () => stopCam(), []);

  const openCam = async () => {
    setCamError("");
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = s;
      setCamOpen(true);
      setTimeout(() => { if (videoRef.current) videoRef.current.srcObject = s; }, 0);
    } catch (e: any) {
      setCamError(
        e?.name === "NotAllowedError"
          ? "Camera permission denied. Allow the camera to record this."
          : "No camera available on this device."
      );
    }
  };

  const shoot = async () => {
    const video = videoRef.current, canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.9));
    if (!blob) return;
    stopCam();
    await handleFile(new File([blob], `capture-${Date.now()}.jpg`, { type: "image/jpeg" }));
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      // Shrink before anything else: a raw phone photo is several megabytes
      // and uploads of that size fail on canteen wifi.
      file = await compressImage(file);
      // Ask for the fix while the picture is still fresh in the user's hand
      const pos = await readLocation();
      if (!pos && requireLocation) {
        toast.error("Location is off. Turn on GPS and allow location, then take the photo again.");
        setBusy(false);
        return;
      }
      if (!pos) {
        toast.warning("Saved without a location — the device didn't provide one.");
      }
      onChange({
        file,
        kind: file.type.startsWith("video") ? "video" : "image",
        latitude: pos?.coords.latitude ?? null,
        longitude: pos?.coords.longitude ?? null,
        accuracy: pos?.coords.accuracy ?? null,
        capturedAt: new Date().toISOString(),
      });
    } finally {
      setBusy(false);
    }
  };

  const inputId = `geo-capture-${label.replace(/\s+/g, "-")}`;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{label}</span>
        {value?.latitude != null && (
          <Badge variant="outline" className="text-[10px] gap-1 bg-success/10 text-success border-success/20">
            <MapPin className="w-3 h-3" /> geo-tagged
            {value.accuracy != null ? ` ±${Math.round(value.accuracy)}m` : ""}
          </Badge>
        )}
        {value && value.latitude == null && (
          <Badge variant="outline" className="text-[10px] gap-1 bg-warning/10 text-warning border-warning/20">
            <MapPin className="w-3 h-3" /> no location
          </Badge>
        )}
      </div>

      {value ? (
        <div className="flex items-center gap-2 rounded-lg border p-2">
          {value.kind === "video"
            ? <Video className="w-4 h-4 text-accent" />
            : <Check className="w-4 h-4 text-success" />}
          <div className="flex-1 min-w-0">
            <p className="text-xs truncate">{value.file.name || "capture"}</p>
            <p className="text-[11px] text-muted-foreground">
              {new Date(value.capturedAt).toLocaleTimeString("en-IN")}
              {value.latitude != null
                ? ` · ${value.latitude.toFixed(5)}, ${value.longitude!.toFixed(5)}`
                : ""}
            </p>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive"
            onClick={() => onChange(null)}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      ) : (
        <>
          {/* The camera runs inside the app: there is deliberately no file
              picker, so an old picture from the gallery cannot be passed off
              as today's delivery. */}
          {camOpen ? (
            <div className="space-y-2">
              <video ref={videoRef} autoPlay playsInline muted
                className="w-full rounded-lg bg-black aspect-video object-cover" />
              <canvas ref={canvasRef} className="hidden" />
              <div className="flex gap-2">
                <Button type="button" size="sm" className="flex-1 text-xs" onClick={shoot} disabled={busy}>
                  <Camera className="w-3.5 h-3.5 mr-1.5" /> Capture
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={stopCam}>Cancel</Button>
              </div>
            </div>
          ) : (
            <>
              <Button
                type="button" variant="outline" size="sm" className="w-full text-xs gap-1.5"
                disabled={busy}
                onClick={openCam}
              >
                {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
                {busy ? "Getting location…" : "Open camera"}
              </Button>
              {camError && <p className="text-[11px] text-destructive">{camError}</p>}

              {/* The live camera is the intended route — an old picture from
                  the gallery proves nothing. But on a laptop, or when the
                  camera is blocked, refusing everything just stops the work,
                  so a file is allowed and clearly marked as such. */}
              <FilePickButton
                onPick={handleFile}
                accept="*/*"
                disabled={busy}
                className="w-full text-[11px] text-muted-foreground underline decoration-dotted py-1"
              >
                Camera not working? Choose a file instead
              </FilePickButton>
              <p className="text-[11px] text-muted-foreground">
                A live photo is preferred — it proves the goods were here, now.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

// Upload a capture to a private bucket and return the row you can store
// alongside whatever it is evidence for.
export async function uploadGeoCapture(
  supabase: any,
  bucket: string,
  path: string,
  cap: GeoCapture
): Promise<{ image_path: string; media_kind: string; latitude: number | null;
             longitude: number | null; geo_accuracy: number | null; captured_at: string }> {
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, cap.file, { contentType: cap.file.type || "image/jpeg" });
  if (error) throw error;
  return {
    image_path: path,
    media_kind: cap.kind,
    latitude: cap.latitude,
    longitude: cap.longitude,
    geo_accuracy: cap.accuracy,
    captured_at: cap.capturedAt,
  };
}
