import { Loader2 } from "lucide-react";

// Reading a bill or a menu chart takes 20–40 seconds. The progress line used
// to sit at the bottom of the card, below the buttons and the paste box —
// off the bottom of a phone screen. So the manager tapped Upload, saw
// nothing change, and reported that the app "does nothing", when in fact it
// was working the whole time. Some tapped again and started a second scan.
//
// This sits over the screen and cannot be missed, and it blocks a second tap
// while the first is still running.

export default function ScanProgress({ busy, status }: { busy: boolean; status?: string }) {
  if (!busy) return null;
  return (
    <div className="fixed inset-0 z-[60] bg-background/85 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="w-full max-w-xs rounded-xl border bg-card shadow-lg p-6 text-center space-y-3">
        <Loader2 className="w-8 h-8 animate-spin text-accent mx-auto" />
        <p className="text-sm font-semibold">Reading it…</p>
        <p className="text-xs text-muted-foreground min-h-[32px]">
          {status || "Sending the picture to be read"}
        </p>
        <p className="text-[11px] text-muted-foreground">
          This takes up to a minute. Keep the app open.
        </p>
      </div>
    </div>
  );
}
