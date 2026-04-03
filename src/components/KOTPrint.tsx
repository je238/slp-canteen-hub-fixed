import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Printer } from "lucide-react";

interface KOTItem {
  name: string;
  qty: number;
  counter: string;
}

interface KOTData {
  orderNumber: string;
  canteenName: string;
  items: KOTItem[];
  date: string;
  tokenNumber: string;
}

export default function KOTPrint({ kot, onClose }: { kot: KOTData; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  // Group items by counter
  const counters = Array.from(new Set(kot.items.map(i => i.counter)));

  const handlePrint = () => {
    const content = ref.current;
    if (!content) return;
    const win = window.open("", "_blank", "width=320,height=600");
    if (!win) return;
    win.document.write(`
      <html><head><title>KOT - Token #${kot.tokenNumber}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Courier New', monospace; width: 280px; margin: 0 auto; padding: 12px; font-size: 13px; color: #000; }
        .center { text-align: center; }
        .counter-header { background: #000; color: #fff; padding: 4px 8px; font-size: 12px; font-weight: bold; margin: 8px 0 4px; letter-spacing: 1px; }
        .item-row { display: flex; justify-content: space-between; padding: 5px 0; font-size: 15px; font-weight: bold; border-bottom: 1px dotted #999; }
        @media print { body { margin: 0; } }
      </style></head><body>
      ${content.innerHTML}
      <script>window.print(); window.close();<\/script>
      </body></html>
    `);
    win.document.close();
  };

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card rounded-lg shadow-lg max-w-sm w-full p-6 space-y-4">
        <div ref={ref} style={{ fontFamily: "'Courier New', monospace", fontSize: 13, color: "#000", background: "#fff", padding: 16 }}>

          {/* KOT Header */}
          <div style={{ textAlign: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: "bold", fontSize: 18, letterSpacing: 2 }}>*** KOT ***</div>
            <div style={{ fontWeight: "bold", fontSize: 14, marginTop: 4 }}>{kot.canteenName}</div>
          </div>

          <div style={{ borderTop: "2px dashed #000", margin: "8px 0" }} />

          {/* Token + Order info */}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
            <span>Order: {kot.orderNumber}</span>
            <span>{kot.date}</span>
          </div>
          <div style={{ textAlign: "center", fontSize: 22, fontWeight: "bold", margin: "6px 0", letterSpacing: 3 }}>
            TOKEN #{kot.tokenNumber}
          </div>

          <div style={{ borderTop: "2px dashed #000", margin: "8px 0" }} />

          {/* Items grouped by counter */}
          {counters.map(counter => (
            <div key={counter}>
              <div style={{ background: "#000", color: "#fff", padding: "3px 8px", fontSize: 11, fontWeight: "bold", letterSpacing: 1, marginBottom: 4 }}>
                ▶ {counter.toUpperCase()}
              </div>
              {kot.items.filter(i => i.counter === counter).map((item, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 15, fontWeight: "bold", borderBottom: "1px dotted #999" }}>
                  <span>{item.name}</span>
                  <span>×{item.qty}</span>
                </div>
              ))}
            </div>
          ))}

          <div style={{ borderTop: "2px dashed #000", margin: "8px 0" }} />
          <div style={{ textAlign: "center", fontSize: 10, color: "#666" }}>Kitchen Copy — Do Not Discard</div>
        </div>

        <div className="flex gap-2">
          <Button onClick={handlePrint} className="flex-1 gap-1.5">
            <Printer className="w-4 h-4" /> Print KOT
          </Button>
          <Button variant="outline" onClick={onClose} className="flex-1">Close</Button>
        </div>
      </div>
    </div>
  );
}
