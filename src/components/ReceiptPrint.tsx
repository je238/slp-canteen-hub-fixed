import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Printer } from "lucide-react";

interface ReceiptItem {
  name: string;
  qty: number;
  price: number;
  counter: string;
}

interface ReceiptData {
  orderNumber: string;
  canteenName: string;
  items: ReceiptItem[];
  subtotal: number;
  gstAmount: number;
  gstRate: number;
  total: number;
  paymentMode: string;
  date: string;
  tokenNumber: string;
}

export default function ReceiptPrint({ receipt, onClose }: { receipt: ReceiptData; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  // Group items by counter
  const counters = Array.from(new Set(receipt.items.map(i => i.counter)));

  const handlePrint = () => {
    const content = ref.current;
    if (!content) return;
    const win = window.open("", "_blank", "width=340,height=700");
    if (!win) return;
    win.document.write(`
      <html><head><title>Receipt - Token #${receipt.tokenNumber}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Courier New', monospace; width: 300px; margin: 0 auto; padding: 12px; font-size: 12px; color: #000; }
        .token-box { border: 2px solid #000; text-align: center; padding: 8px; margin: 8px 0; border-radius: 4px; }
        .token-num { font-size: 36px; font-weight: bold; letter-spacing: 4px; }
        .counter-label { background: #000; color: #fff; padding: 2px 6px; font-size: 10px; font-weight: bold; margin: 6px 0 3px; }
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
      <div className="bg-card rounded-lg shadow-lg max-w-sm w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div ref={ref} style={{ fontFamily: "'Courier New', monospace", fontSize: 12, color: "#000", background: "#fff", padding: 16 }}>

          {/* Header */}
          <div style={{ textAlign: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: "bold", fontSize: 16 }}>{receipt.canteenName}</div>
            <div style={{ fontSize: 10, color: "#666" }}>SLP Campus — Canteen Hub</div>
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />

          {/* Token Number */}
          <div style={{ border: "2px solid #000", textAlign: "center", padding: "10px 8px", margin: "8px 0", borderRadius: 4 }}>
            <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>Token Number</div>
            <div style={{ fontSize: 40, fontWeight: "bold", letterSpacing: 6, lineHeight: 1 }}>#{receipt.tokenNumber}</div>
            <div style={{ fontSize: 9, color: "#666", marginTop: 4 }}>Show this at counter for pickup</div>
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />

          {/* Order info */}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10 }}>
            <span>Order: {receipt.orderNumber}</span>
            <span>{receipt.date}</span>
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />

          {/* Items header */}
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: "bold", fontSize: 10, marginBottom: 4 }}>
            <span style={{ flex: 2 }}>Item</span>
            <span style={{ flex: 0.5, textAlign: "center" }}>Qty</span>
            <span style={{ flex: 1, textAlign: "right" }}>Amt</span>
          </div>

          {/* Items grouped by counter */}
          {counters.map(counter => (
            <div key={counter}>
              <div style={{ background: "#000", color: "#fff", padding: "2px 6px", fontSize: 10, fontWeight: "bold", letterSpacing: 0.5, margin: "5px 0 3px" }}>
                ▶ {counter.toUpperCase()}
              </div>
              {receipt.items.filter(i => i.counter === counter).map((item, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "2px 0" }}>
                  <span style={{ flex: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
                  <span style={{ flex: 0.5, textAlign: "center" }}>{item.qty}</span>
                  <span style={{ flex: 1, textAlign: "right" }}>₹{item.price * item.qty}</span>
                </div>
              ))}
            </div>
          ))}

          <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />

          {/* Subtotal + GST + Total */}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
            <span>Subtotal</span><span>₹{receipt.subtotal}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
            <span>GST ({receipt.gstRate}%)</span><span>₹{receipt.gstAmount}</span>
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />

          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: "bold", fontSize: 14 }}>
            <span>TOTAL</span><span>₹{receipt.total}</span>
          </div>
          <div style={{ fontSize: 10, textAlign: "center", marginTop: 4 }}>
            Paid via: {receipt.paymentMode.toUpperCase()}
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />
          <div style={{ textAlign: "center", fontSize: 9, color: "#666" }}>Thank you! Visit again 😊</div>
        </div>

        <div className="flex gap-2">
          <Button onClick={handlePrint} className="flex-1 gap-1.5">
            <Printer className="w-4 h-4" /> Print Receipt
          </Button>
          <Button variant="outline" onClick={onClose} className="flex-1">Close</Button>
        </div>
      </div>
    </div>
  );
}
