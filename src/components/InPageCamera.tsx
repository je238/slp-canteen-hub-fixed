import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Camera, RotateCcw, X } from "lucide-react";

// A camera that lives inside the page, rather than handing off to the phone's
// camera app.
//
// This is the difference between the bill scanner working and the menu
// scanner not. `<input type="file" capture>` sends the user out to the
// camera or gallery app, and Android is free to destroy the browser or
// WebView behind it to free memory. Coming back, the page reloads from
// scratch: the photo is gone, no error is raised, and it looks exactly like
// tapping OK did nothing. Devices with "Don't keep activities" switched on
// in developer options do this every single time.
//
// getUserMedia keeps everything on the page. Nothing is backgrounded, so
// nothing can be thrown away.

interface Props {
  /** Called with the JPEG base64 (no data: prefix). */
  onCapture: (base64: string) => void;
  disabled?: boolean;
}

export default function InPageCamera({ onCapture, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (stream && videoRef.current) videoRef.current.srcObject = stream;
  }, [stream, open]);

  // Never leave the torch on when the user walks away from the screen.
  useEffect(() => () => { stream?.getTracks().forEach((t) => t.stop()); }, [stream]);

  const start = async () => {
    setError(""); setShot(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      setStream(s); setOpen(true);
    } catch (e: any) {
      setError(
        e?.name === "NotAllowedError"
          ? "Camera permission is off. Allow it for this site, then tap again."
          : e?.name === "NotFoundError"
          ? "No camera found on this device."
          : "Could not open the camera. Use the upload button instead."
      );
    }
  };

  const stop = () => {
    stream?.getTracks().forEach((t) => t.stop());
    setStream(null); setOpen(false); setShot(null);
  };

  const snap = () => {
    const v = videoRef.current, c = canvasRef.current;
    if (!v || !c) return;
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0);
    setShot(c.toDataURL("image/jpeg", 0.92));
    stream?.getTracks().forEach((t) => t.stop());
    setStream(null); setOpen(false);
  };

  const use = () => {
    if (!shot) return;
    onCapture(shot.split(",")[1]);
    setShot(null);
  };

  return (
    <div className="space-y-2">
      {!open && !shot && (
        <Button onClick={start} disabled={disabled}
                className="bg-accent text-accent-foreground hover:bg-accent/90 gap-2">
          <Camera className="w-4 h-4" /> Take photo of menu
        </Button>
      )}

      {open && (
        <div className="space-y-2">
          <div className="rounded-lg overflow-hidden border bg-black">
            <video ref={videoRef} autoPlay playsInline muted className="w-full max-h-80 object-cover" />
          </div>
          <div className="flex gap-2">
            <Button onClick={snap} className="bg-accent text-accent-foreground hover:bg-accent/90 gap-2">
              <Camera className="w-4 h-4" /> Capture
            </Button>
            <Button variant="outline" onClick={stop}><X className="w-4 h-4 mr-1" /> Cancel</Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Hold the sheet flat and fill the frame. Good light, straight on.
          </p>
        </div>
      )}

      {shot && (
        <div className="space-y-2">
          <img src={shot} alt="menu" className="w-full max-h-80 object-contain rounded-lg border" />
          <div className="flex gap-2">
            <Button onClick={use} disabled={disabled}
                    className="bg-accent text-accent-foreground hover:bg-accent/90">
              Read this menu
            </Button>
            <Button variant="outline" onClick={start}>
              <RotateCcw className="w-4 h-4 mr-1" /> Retake
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
