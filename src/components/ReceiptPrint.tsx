import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Printer } from "lucide-react";

interface ReceiptItem {
  name: string;
  qty: number;
  price: number;
}

interface ReceiptData {
  orderNumber: string;
  canteenName: string;
  items: ReceiptItem[];
  total: number;
  paymentMode: string;
  date: string;
}

export default function ReceiptPrint({ receipt, onClose }: { receipt: ReceiptData; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  const handlePrint = () => {
    const content = ref.current;
    if (!content) return;
    const win = window.open("", "_blank", "width=320,height=600");
    if (!win) return;
    win.document.write(`
      <html><head><title>Receipt</title>
      <style>
        body { font-family: 'Courier New', monospace; width: 280px; margin: 0 auto; padding: 12px; font-size: 12px; color: #000; }
        .center { text-align: center; }
        .bold { font-weight: bold; }
        .line { border-top: 1px dashed #000; margin: 6px 0; }
        .row { display: flex; justify-content: space-between; }
        .total-row { font-size: 14px; font-weight: bold; }
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
        <div ref={ref} style={{ fontFamily: "'Courier New', monospace", fontSize: 12, color: "#000", background: "#fff", padding: 16 }}>
          <div style={{ textAlign: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: "bold", fontSize: 16 }}>{receipt.canteenName}</div>
            <div style={{ fontSize: 10, color: "#666" }}>Receipt</div>
          </div>
          <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10 }}>
            <span>Order: {receipt.orderNumber}</span>
            <span>{receipt.date}</span>
          </div>
          <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: "bold", fontSize: 10, marginBottom: 4 }}>
            <span style={{ flex: 2 }}>Item</span>
            <span style={{ flex: 0.5, textAlign: "center" }}>Qty</span>
            <span style={{ flex: 1, textAlign: "right" }}>Amt</span>
          </div>
          {receipt.items.map((item, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "2px 0" }}>
              <span style={{ flex: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
              <span style={{ flex: 0.5, textAlign: "center" }}>{item.qty}</span>
              <span style={{ flex: 1, textAlign: "right" }}>₹{item.price * item.qty}</span>
            </div>
          ))}
          <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: "bold", fontSize: 14 }}>
            <span>TOTAL</span>
            <span>₹{receipt.total}</span>
          </div>
          <div style={{ fontSize: 10, textAlign: "center", marginTop: 4 }}>
            Paid via: {receipt.paymentMode.toUpperCase()}
          </div>
          <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />
          <div style={{ textAlign: "center", fontSize: 9, color: "#666" }}>Thank you! Visit again.</div>
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
