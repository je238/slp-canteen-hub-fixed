import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Printer, MessageCircle } from "lucide-react";

interface ReceiptItem { name: string; qty: number; price: number; }
interface ReceiptData {
  orderNumber: string; canteenName: string; canteenAddress?: string;
  gstNumber?: string; tableNumber?: string; items: ReceiptItem[];
  total: number; paymentMode: string; date: string;
}

export default function ReceiptPrint({ receipt, onClose }: { receipt: ReceiptData; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const gstRate = 5;
  const subtotal = Math.round(receipt.total / 1.05);
  const gstAmount = receipt.total - subtotal;

  const handlePrint = () => {
    const content = ref.current;
    if (!content) return;
    const win = window.open("", "_blank", "width=320,height=700");
    if (!win) return;
    win.document.write(`<html><head><title>Receipt</title><style>body{font-family:'Courier New',monospace;width:280px;margin:0 auto;padding:12px;font-size:12px;color:#000;}@media print{body{margin:0;}}</style></head><body>${content.innerHTML}<script>window.print();window.close();<\/script></body></html>`);
    win.document.close();
  };

  const handleWhatsApp = () => {
    const items = receipt.items.map(i => `  ${i.name} x${i.qty} = Rs.${i.price * i.qty}`).join("\n");
    const msg = `Receipt - ${receipt.canteenName}\nOrder: ${receipt.orderNumber}\nDate: ${receipt.date}\n${receipt.tableNumber ? "Table: " + receipt.tableNumber + "\n" : ""}\nItems:\n${items}\n\n${receipt.gstNumber ? "GST: " + receipt.gstNumber + "\nSubtotal: Rs." + subtotal + "\nGST(" + gstRate + "%): Rs." + gstAmount + "\n" : ""}Total: Rs.${receipt.total}\nPayment: ${receipt.paymentMode.toUpperCase()}\n\nThank you! Visit again`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank");
  };

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card rounded-lg shadow-lg max-w-sm w-full p-6 space-y-4">
        <div ref={ref} style={{fontFamily:"'Courier New',monospace",fontSize:12,color:"#000",background:"#fff",padding:16}}>
          <div style={{textAlign:"center",marginBottom:8}}>
            <div style={{fontWeight:"bold",fontSize:16}}>{receipt.canteenName}</div>
            {receipt.canteenAddress && <div style={{fontSize:10}}>{receipt.canteenAddress}</div>}
            {receipt.gstNumber && <div style={{fontSize:10}}>GST: {receipt.gstNumber}</div>}
            <div style={{fontSize:10,color:"#666"}}>TAX INVOICE</div>
          </div>
          <div style={{borderTop:"1px dashed #000",margin:"6px 0"}}/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10}}>
            <span>Order: #{receipt.orderNumber}</span><span>{receipt.date}</span>
          </div>
          {receipt.tableNumber && <div style={{fontSize:10}}>Table: {receipt.tableNumber}</div>}
          <div style={{borderTop:"1px dashed #000",margin:"6px 0"}}/>
          <div style={{display:"flex",justifyContent:"space-between",fontWeight:"bold",fontSize:10,marginBottom:4}}>
            <span style={{flex:2}}>Item</span><span style={{flex:0.5,textAlign:"center"}}>Qty</span>
            <span style={{flex:0.5,textAlign:"right"}}>Rate</span><span style={{flex:1,textAlign:"right"}}>Amt</span>
          </div>
          {receipt.items.map((item,i) => (
            <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:11,padding:"2px 0"}}>
              <span style={{flex:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}</span>
              <span style={{flex:0.5,textAlign:"center"}}>{item.qty}</span>
              <span style={{flex:0.5,textAlign:"right"}}>Rs.{item.price}</span>
              <span style={{flex:1,textAlign:"right"}}>Rs.{item.price*item.qty}</span>
            </div>
          ))}
          <div style={{borderTop:"1px dashed #000",margin:"6px 0"}}/>
          {receipt.gstNumber && <>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:11}}><span>Subtotal</span><span>Rs.{subtotal}</span></div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:11}}><span>GST ({gstRate}%)</span><span>Rs.{gstAmount}</span></div>
          </>}
          <div style={{display:"flex",justifyContent:"space-between",fontWeight:"bold",fontSize:14,marginTop:4}}>
            <span>TOTAL</span><span>Rs.{receipt.total}</span>
          </div>
          <div style={{fontSize:10,textAlign:"center",marginTop:4}}>Paid via: {receipt.paymentMode.toUpperCase()}</div>
          <div style={{borderTop:"1px dashed #000",margin:"6px 0"}}/>
          <div style={{textAlign:"center",fontSize:9,color:"#666"}}>Thank you! Visit again</div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={handlePrint} className="gap-1.5 bg-accent text-accent-foreground hover:bg-accent/90"><Printer className="w-4 h-4"/> Print</Button>
          <Button onClick={handleWhatsApp} variant="outline" className="gap-1.5 text-green-600 border-green-500/30 hover:bg-green-500/10"><MessageCircle className="w-4 h-4"/> WhatsApp</Button>
        </div>
        <Button variant="ghost" onClick={onClose} className="w-full">Close</Button>
      </div>
    </div>
  );
}
