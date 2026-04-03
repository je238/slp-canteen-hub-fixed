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

  const dateParts = kot.date.split(",");
  const dtStr = dateParts[0]?.trim() || kot.date;
  const timeStr = dateParts[1]?.trim() || "";
  const dtFormatted = dtStr.replace(/\//g, "-");

  const printSingle = (counter: string) => {
    return new Promise<void>((resolve) => {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
      const safeId = `ticket-${counter.replace(/\s+/g, '-')}`;
      const ticketHtml = document.getElementById(safeId)?.innerHTML || '';

      iframe.contentWindow?.document.open();
      iframe.contentWindow?.document.write(`
        <html><head><title>KOT - ${counter}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Courier New', monospace; width: 280px; margin: 0 auto; padding: 12px; font-size: 13px; color: #000; }
        </style></head><body>
        ${ticketHtml}
        <script>
          window.onafterprint = () => { window.parent.postMessage('done_print_${safeId}', '*'); };
          window.onload = () => { window.print(); };
        <\/script>
        </body></html>
      `);
      iframe.contentWindow?.document.close();

      const listener = (e: MessageEvent) => {
        if (e.data === `done_print_${safeId}`) {
          window.removeEventListener('message', listener);
          setTimeout(() => { if (document.body.contains(iframe)) document.body.removeChild(iframe); }, 1000);
          resolve();
        }
      };
      window.addEventListener('message', listener);

      // Fallback in case onafterprint fails or takes too long
      setTimeout(() => {
        window.removeEventListener('message', listener);
        if (document.body.contains(iframe)) document.body.removeChild(iframe);
        resolve();
      }, 3000);
    });
  };

  const handlePrintAll = async () => {
    // Print each counter sequentially as a separate print job
    // This forces the thermal printer to hardware-cut the paper between each KOT.
    for (const counter of counters) {
      await printSingle(counter);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card rounded-lg shadow-lg max-w-sm w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto w-[340px]">
        <div ref={ref} style={{ fontFamily: "'Courier New', monospace", fontSize: 13, color: "#000", background: "#fff", padding: "16px 0" }}>

          {counters.map((counter, idx) => {
            const counterItems = kot.items.filter(i => i.counter === counter);
            const safeId = `ticket-${counter.replace(/\s+/g, '-')}`;
            return (
              <div key={counter} id={safeId} className="ticket" style={{ marginBottom: idx < counters.length - 1 ? 24 : 0, paddingBottom: idx < counters.length - 1 ? 16 : 0, borderBottom: idx < counters.length - 1 ? "1px dashed #ccc" : "none" }}>

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
          <Button onClick={handlePrintAll} className="flex-1 gap-1.5 bg-green-600 hover:bg-green-700">
            <Printer className="w-4 h-4" /> Print KOT (Auto-cut)
          </Button>
          <Button variant="outline" onClick={onClose} className="flex-1">Close</Button>
        </div>
      </div>
    </div>
  );
}
