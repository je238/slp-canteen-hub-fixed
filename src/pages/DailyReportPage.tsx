import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useCanteens, useOrders, useExpenses } from "@/hooks/useSupabaseData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MessageCircle, TrendingUp, TrendingDown, ShoppingCart, Wallet } from "lucide-react";
import { toast } from "sonner";

export default function DailyReportPage() {
  const { selectedCanteen } = useAppContext();
  const { data: canteens } = useCanteens();
  const { data: orders } = useOrders(selectedCanteen);
  const { data: expenses } = useExpenses(selectedCanteen);
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [reportDate, setReportDate] = useState(new Date().toISOString().split("T")[0]);

  const canteenName = selectedCanteen === "all" ? "All Canteens" : canteens?.find((c: any) => c.id === selectedCanteen)?.name || "Canteen";
  const dateOrders = orders?.filter((o: any) => o.created_at?.startsWith(reportDate)) || [];
  const dateExpenses = expenses?.filter((e: any) => e.expense_date === reportDate) || [];
  const totalSales = dateOrders.reduce((s: number, o: any) => s + Number(o.total_amount || 0), 0);
  const totalExpenses = dateExpenses.reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
  const netProfit = totalSales - totalExpenses;
  const totalBills = dateOrders.length;

  const itemCount: Record<string, { count: number; amount: number }> = {};
  dateOrders.forEach((o: any) => {
    o.order_items?.forEach((item: any) => {
      if (!itemCount[item.name]) itemCount[item.name] = { count: 0, amount: 0 };
      itemCount[item.name].count += item.quantity || 1;
      itemCount[item.name].amount += Number(item.total || 0);
    });
  });
  const topItems = Object.entries(itemCount).sort((a, b) => b[1].amount - a[1].amount).slice(0, 5);

  const paymentBreakdown = dateOrders.reduce((acc: Record<string, number>, o: any) => {
    const mode = o.payment_mode || "cash";
    acc[mode] = (acc[mode] || 0) + Number(o.total_amount || 0);
    return acc;
  }, {});

  const sendWhatsApp = () => {
    const topItemsText = topItems.length ? topItems.map(([name, d], i) => `  ${i+1}. ${name} - Rs.${d.amount} (${d.count} sold)`).join("\n") : "  No items sold";
    const paymentText = Object.entries(paymentBreakdown).map(([mode, amount]) => `  ${mode.toUpperCase()}: Rs.${amount}`).join("\n");
    const report = `Daily Sales Report\n${canteenName}\n${new Date(reportDate).toLocaleDateString("en-IN",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}\n\nSales Summary\n  Total Sales: Rs.${totalSales.toLocaleString()}\n  Total Bills: ${totalBills}\n  Avg Bill: Rs.${totalBills?Math.round(totalSales/totalBills):0}\n\nPayment Breakdown\n${paymentText||"  No payments"}\n\nTop Selling Items\n${topItemsText}\n\nExpenses: Rs.${totalExpenses.toLocaleString()}\n\nNet Profit: Rs.${netProfit.toLocaleString()}\n\nSent from SLP Canteen Hub`;
    const number = whatsappNumber.replace(/\D/g, "");
    window.open(`https://wa.me/${number||""}?text=${encodeURIComponent(report)}`, "_blank");
    toast.success("Opening WhatsApp!");
  };

  return (
    <AppLayout title="Daily Sales Report">
      <div className="max-w-2xl space-y-4 animate-fade-in">
        <p className="text-sm text-muted-foreground">Generate and send daily sales summary via WhatsApp</p>
        <Card className="border-none shadow-sm">
          <CardContent className="p-4 flex gap-4 items-end flex-wrap">
            <div className="flex-1 min-w-[160px]">
              <Label className="text-xs">Report Date</Label>
              <Input type="date" value={reportDate} onChange={e => setReportDate(e.target.value)} />
            </div>
            <div className="flex-1 min-w-[160px]">
              <Label className="text-xs">WhatsApp Number (optional)</Label>
              <Input placeholder="91XXXXXXXXXX" value={whatsappNumber} onChange={e => setWhatsappNumber(e.target.value)} />
            </div>
          </CardContent>
        </Card>
        <div className="grid grid-cols-2 gap-3">
          <Card className="border-none shadow-sm"><CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center"><TrendingUp className="w-5 h-5 text-green-600"/></div>
            <div><p className="text-xs text-muted-foreground">Total Sales</p><p className="text-xl font-bold">Rs.{totalSales.toLocaleString()}</p><p className="text-xs text-muted-foreground">{totalBills} bills</p></div>
          </CardContent></Card>
          <Card className="border-none shadow-sm"><CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center"><TrendingDown className="w-5 h-5 text-red-600"/></div>
            <div><p className="text-xs text-muted-foreground">Total Expenses</p><p className="text-xl font-bold">Rs.{totalExpenses.toLocaleString()}</p></div>
          </CardContent></Card>
          <Card className="border-none shadow-sm"><CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center"><ShoppingCart className="w-5 h-5 text-accent"/></div>
            <div><p className="text-xs text-muted-foreground">Avg Bill Value</p><p className="text-xl font-bold">Rs.{totalBills?Math.round(totalSales/totalBills):0}</p></div>
          </CardContent></Card>
          <Card className={`border-none shadow-sm ${netProfit>=0?"bg-green-500/5":"bg-red-500/5"}`}><CardContent className="p-4 flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${netProfit>=0?"bg-green-500/10":"bg-red-500/10"}`}><Wallet className={`w-5 h-5 ${netProfit>=0?"text-green-600":"text-red-600"}`}/></div>
            <div><p className="text-xs text-muted-foreground">Net Profit</p><p className={`text-xl font-bold ${netProfit>=0?"text-green-600":"text-red-600"}`}>Rs.{netProfit.toLocaleString()}</p></div>
          </CardContent></Card>
        </div>
        <Card className="border-none shadow-sm">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">Top Selling Items</CardTitle></CardHeader>
          <CardContent>
            {topItems.length===0?<p className="text-sm text-muted-foreground text-center py-4">No sales data for this date</p>:topItems.map(([name,data],i)=>(
              <div key={name} className="flex items-center justify-between py-2 border-b last:border-0">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-accent/10 text-accent text-xs flex items-center justify-center font-bold">{i+1}</span>
                  <span className="text-sm">{name}</span>
                </div>
                <div className="text-right"><p className="text-sm font-semibold">Rs.{data.amount}</p><p className="text-xs text-muted-foreground">{data.count} sold</p></div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Button onClick={sendWhatsApp} className="w-full gap-2 bg-green-600 hover:bg-green-700 text-white" size="lg">
          <MessageCircle className="w-5 h-5"/> Send Report via WhatsApp
        </Button>
      </div>
    </AppLayout>
  );
}
