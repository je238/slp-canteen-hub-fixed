import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Printer } from "lucide-react";

interface KOTItem {
  name: string;
  qty: number;
}

interface KOTData {
  orderNumber: string;
  canteenName: string;
  items: KOTItem[];
  date: string;
}

export default function KOTPrint({ kot, onClose }: { kot: KOTData; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  const handlePrint = () => {
    const content = ref.current;
    if (!content) return;
    const win = window.open("", "_blank", "width=320,height=500");
    if (!win) return;
    win.document.write(`
      <html><head><title>KOT</title>
      <style>
        body { font-family: 'Courier New', monospace; width: 280px; margin: 0 auto; padding: 12px; font-size: 13px; color: #000; }
        .center { text-align: center; }
        .bold { font-weight: bold; }
        .line { border-top: 2px dashed #000; margin: 8px 0; }
        .item-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 15px; font-weight: bold; }
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
          <div style={{ textAlign: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: "bold", fontSize: 18, letterSpacing: 2 }}>*** KOT ***</div>
            <div style={{ fontWeight: "bold", fontSize: 14, marginTop: 4 }}>{kot.canteenName}</div>
          </div>
          <div style={{ borderTop: "2px dashed #000", margin: "8px 0" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
            <span>Order: {kot.orderNumber}</span>
            <span>{kot.date}</span>
          </div>
          <div style={{ borderTop: "2px dashed #000", margin: "8px 0" }} />
          {kot.items.map((item, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 15, fontWeight: "bold", borderBottom: "1px dotted #999" }}>
              <span>{item.name}</span>
              <span>x{item.qty}</span>
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
