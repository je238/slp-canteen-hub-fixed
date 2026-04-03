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

  // For Dt and Time parsing based on short format "DD/MM/YYYY, HH:MM"
  const dateParts = receipt.date.split(",");
  const dtStr = dateParts[0]?.trim() || receipt.date;
  const timeStr = dateParts[1]?.trim() || "";
  const dtFormatted = dtStr.replace(/\//g, "-");

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
        <div ref={ref} style={{ fontFamily: "'Courier New', monospace", fontSize: 12, color: "#000", background: "#fff", padding: "16px 10px" }}>

          {/* Header */}
          <div style={{ textAlign: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: "bold", fontSize: 13, textTransform: "uppercase" }}>SHRI SANKALPA FOOD AND HOSPITALITY PVT LTD</div>
            <div style={{ fontSize: 12 }}>Vadodara</div>
            <div style={{ fontSize: 12 }}>Cash Memo</div>
            <div style={{ border: "1px dashed #000", padding: "4px", margin: "6px auto", display: "inline-block", fontWeight: "bold" }}>Token: {receipt.tokenNumber}</div>
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />

          {/* Order info */}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
            <span>Date : {dtFormatted}</span>
            <span>Bill No. : {receipt.orderNumber}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
            <span>T.No.: 1</span>
            <span>Emp. No. : COUNTER</span>
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />

          {/* Items header */}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
            <span style={{ flex: 2.5 }}>Particulars</span>
            <span style={{ flex: 0.6, textAlign: "center" }}>Qty</span>
            <span style={{ flex: 1, textAlign: "right" }}>Rate</span>
            <span style={{ flex: 1.2, textAlign: "right" }}>Amount</span>
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />

          {/* Items */}
          {receipt.items.map((item, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "2px 0" }}>
              <span style={{ flex: 2.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textTransform: "uppercase" }}>{item.name}</span>
              <span style={{ flex: 0.6, textAlign: "center" }}>{item.qty}</span>
              <span style={{ flex: 1, textAlign: "right" }}>{item.price}</span>
              <span style={{ flex: 1.2, textAlign: "right" }}>{item.price * item.qty}</span>
            </div>
          ))}

          <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />

          {/* Totals */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", fontSize: 11, padding: "2px 0" }}>
            <span>Sub Total :</span>
            <span style={{ width: "60px", textAlign: "right" }}>{(receipt.subtotal).toFixed(2)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", fontSize: 11, padding: "2px 0" }}>
            <span>IGST @{receipt.gstRate}% On {receipt.subtotal} :</span>
            <span style={{ width: "60px", textAlign: "right" }}>{(receipt.gstAmount).toFixed(2)}</span>
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", fontSize: 12, padding: "2px 0" }}>
            <span>Food Total :</span>
            <span style={{ width: "60px", textAlign: "right" }}>{(receipt.total).toFixed(2)}</span>
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />

          {/* Footer Totals */}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: "bold", padding: "2px 0" }}>
            <span style={{ fontWeight: "normal" }}>2/2/1</span>
            <span style={{ flex: 1, textAlign: "right", paddingRight: "10px" }}>Total Rs :</span>
            <span>{receipt.total}</span>
          </div>

          {/* Footer Info */}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginTop: "8px" }}>
            <span>27AAGCS8824L1ZN</span>
            <span>({timeStr || new Date().toLocaleString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true })})</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginTop: "2px" }}>
            <span>E.&O.E.</span>
            <span>Thank You</span>
            <span>Visit Again</span>
          </div>
          <div style={{ textAlign: "center", fontSize: 10, marginTop: 8 }}>
            Paid via: {receipt.paymentMode.toUpperCase()}
          </div>
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
