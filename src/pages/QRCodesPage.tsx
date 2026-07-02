import { useRef } from "react";
import AppLayout from "@/components/AppLayout";
import { useCanteens } from "@/hooks/useSupabaseData";
import { QRCodeSVG } from "qrcode.react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Copy, Printer, QrCode } from "lucide-react";
import { toast } from "sonner";

function orderUrl(canteenId: string) {
  return `${window.location.origin}/order/${canteenId}`;
}

// Canteen names are user-entered and end up in document.write'd HTML.
function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function CanteenQRCard({ canteen }: { canteen: { id: string; name: string; location?: string | null } }) {
  const posterRef = useRef<HTMLDivElement>(null);
  const url = orderUrl(canteen.id);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Ordering link copied");
    } catch {
      toast.error("Could not copy link");
    }
  };

  const printPoster = () => {
    const content = posterRef.current;
    if (!content) return;
    const win = window.open("", "_blank", "width=500,height=700");
    if (!win) {
      toast.error("Allow pop-ups to print the poster");
      return;
    }
    win.document.write(`
      <html><head><title>QR Poster — ${escapeHtml(canteen.name)}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .poster { text-align: center; padding: 48px 40px; border: 2px solid #000; border-radius: 24px; margin: 24px; }
        .poster h1 { font-size: 26px; margin-bottom: 4px; }
        .poster h2 { font-size: 15px; font-weight: 500; color: #555; margin-bottom: 28px; }
        .poster svg { width: 260px; height: 260px; }
        .poster .steps { margin-top: 28px; font-size: 14px; color: #333; line-height: 1.9; text-align: left; display: inline-block; }
        @media print { body { margin: 0; } .poster { border-width: 3px; } }
      </style></head><body>
      ${content.innerHTML}
      <script>window.print(); window.close();<\/script>
      </body></html>
    `);
    win.document.close();
  };

  return (
    <Card className="border-none shadow-sm">
      <CardContent className="p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">{canteen.name}</h3>
          {canteen.location && <p className="text-xs text-muted-foreground">{canteen.location}</p>}
        </div>

        <div className="flex justify-center rounded-xl bg-white p-4 border">
          <QRCodeSVG value={url} size={168} level="M" includeMargin={false} />
        </div>

        <p className="text-[11px] text-muted-foreground break-all text-center">{url}</p>

        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={copyLink}>
            <Copy className="w-3.5 h-3.5" /> Copy link
          </Button>
          <Button size="sm" className="gap-1.5 text-xs" onClick={printPoster}>
            <Printer className="w-3.5 h-3.5" /> Print poster
          </Button>
        </div>

        {/* Hidden print poster */}
        <div className="hidden">
          <div ref={posterRef}>
            <div className="poster">
              <h1>{canteen.name}</h1>
              <h2>Scan to order — skip the queue</h2>
              <QRCodeSVG value={url} size={260} level="M" includeMargin={false} />
              <div className="steps">
                1. Scan this code with your phone camera<br />
                2. Pick your food and place the order<br />
                3. Watch your token — pay at the counter on pickup
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function QRCodesPage() {
  const { data: canteens, isLoading } = useCanteens();

  return (
    <AppLayout title="QR Ordering Codes">
      <div className="space-y-4 animate-fade-in">
        <p className="text-sm text-muted-foreground max-w-2xl">
          Print a poster for each canteen and place it on tables or at the entrance.
          Employees scan the code, order from their phone, and pick up with a token — no app install needed.
        </p>

        {isLoading ? (
          <p className="text-sm text-muted-foreground py-8">Loading canteens…</p>
        ) : (canteens?.length ?? 0) === 0 ? (
          <Card className="border-dashed border-2">
            <CardContent className="p-10 text-center space-y-2">
              <QrCode className="w-8 h-8 text-muted-foreground mx-auto" />
              <p className="text-sm text-muted-foreground">No canteens yet. Create a canteen first, then its QR code will appear here.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {canteens!.map((c: any) => (
              <CanteenQRCard key={c.id} canteen={c} />
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
