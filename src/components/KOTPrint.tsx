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

  // For Dt and Time parsing based on short format "DD/MM/YYYY, HH:MM"
  const dateParts = kot.date.split(",");
  const dtStr = dateParts[0]?.trim() || kot.date;
  const timeStr = dateParts[1]?.trim() || "";
  const dtFormatted = dtStr.replace(/\//g, "-");

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
        .ticket { margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px dashed #ccc; }
        @media print { 
          body { margin: 0; } 
          .ticket { margin-bottom: 0; padding-bottom: 0; border-bottom: none; page-break-after: always; } 
        }
      </style></head><body>
      ${content.innerHTML}
      <script>window.print(); window.close();<\/script>
      </body></html>
    `);
    win.document.close();
  };

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card rounded-lg shadow-lg max-w-sm w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto w-[340px]">
        <div ref={ref} style={{ fontFamily: "'Courier New', monospace", fontSize: 13, color: "#000", background: "#fff", padding: "16px 0" }}>

          {/* Render a separate ticket block for each counter */}
          {counters.map((counter, idx) => {
            const counterItems = kot.items.filter(i => i.counter === counter);
            return (
              <div key={counter} className="ticket" style={{ pageBreakAfter: "always", marginBottom: idx < counters.length - 1 ? 24 : 0, paddingBottom: idx < counters.length - 1 ? 16 : 0, borderBottom: idx < counters.length - 1 ? "1px dashed #ccc" : "none" }}>

                <div style={{ textAlign: "center", marginBottom: 8 }}>
                  <div style={{ fontSize: 15, letterSpacing: 0.5 }}>{counter.toUpperCase()}</div>
                  <div style={{ fontSize: 11 }}>COUNTER</div>
                </div>

                <div style={{ border: "1px dashed #000", padding: "2px", margin: "4px auto", textAlign: "center", width: "fit-content", fontSize: "11px", fontWeight: "bold" }}>Token: {kot.tokenNumber}</div>

                <div style={{ fontSize: 11, display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span>T No. 1</span>
                  <span>E: COUNTER</span>
                  <span>T:SANKALP1</span>
                </div>

                <div style={{ fontSize: 11, display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span>Ord No: {kot.orderNumber}</span>
                  <span>Dt:{dtFormatted}</span>
                  <span>Time:{timeStr}</span>
                </div>

                <div style={{ borderTop: "1px dashed #000", margin: "8px 0" }} />

                {/* Items */}
                <div style={{ fontSize: 12 }}>
                  {counterItems.map((item, i) => (
                    <div key={i} style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 11, textTransform: "uppercase" }}>{item.counter}</div>
                      <div style={{ display: "flex", marginTop: 2 }}>
                        <span style={{ width: "24px", textAlign: "right", marginRight: "8px" }}>{item.qty}</span>
                        <span>{item.name.toUpperCase()}</span>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ borderTop: "1px dashed #000", margin: "8px 0 16px 0" }} />

                <div style={{ fontSize: 11, marginBottom: 16 }}>
                  Total Items : {counterItems.length}
                </div>

                <div style={{ textAlign: "center", fontSize: 11 }}>
                  Bill No.: {kot.orderNumber}
                </div>
              </div>
            );
          })}

        </div>

        <div className="flex gap-2 p-2">
          <Button onClick={handlePrint} className="flex-1 gap-1.5">
            <Printer className="w-4 h-4" /> Print KOT
          </Button>
          <Button variant="outline" onClick={onClose} className="flex-1">Close</Button>
        </div>
      </div>
    </div>
  );
}
