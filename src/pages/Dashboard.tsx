import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useOrders, useIngredients, useExpenses, usePurchases, useCanteens } from "@/hooks/useSupabaseData";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { IndianRupee, ShoppingCart, AlertTriangle, TrendingUp, ArrowUpRight } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

function formatCurrency(val: number) {
  if (val >= 100000) return `₹${(val / 100000).toFixed(1)}L`;
  if (val >= 1000) return `₹${(val / 1000).toFixed(1)}K`;
  return `₹${val}`;
}

export default function Dashboard() {
  const { selectedCanteen } = useAppContext();
  useRealtimeSubscription(["orders", "ingredients", "expenses", "purchases"]);
  const { data: orders } = useOrders(selectedCanteen);
  const { data: ingredients } = useIngredients(selectedCanteen);
  const { data: expenses } = useExpenses(selectedCanteen);
  const { data: purchases } = usePurchases(selectedCanteen);
  const { data: canteens } = useCanteens();

  const totalSales = orders?.reduce((s: number, o: any) => s + Number(o.total_amount), 0) || 0;
  const totalOrders = orders?.length || 0;
  const lowStockItems = ingredients?.filter((i: any) => Number(i.current_stock) < Number(i.minimum_stock)) || [];
  const totalExpenses = expenses?.reduce((s: number, e: any) => s + Number(e.amount), 0) || 0;
  const totalPurchaseCost = purchases?.filter((p: any) => p.status === "confirmed").reduce((s: number, p: any) => s + Number(p.total_amount), 0) || 0;
  const estimatedProfit = totalSales - totalExpenses - totalPurchaseCost;

  const kpiCards = [
    { label: "Total Sales", value: formatCurrency(totalSales), icon: IndianRupee, color: "bg-primary text-primary-foreground" },
    { label: "Total Orders", value: totalOrders.toString(), icon: ShoppingCart, color: "bg-accent text-accent-foreground" },
    { label: "Low Stock Alerts", value: lowStockItems.length.toString(), icon: AlertTriangle, color: "bg-destructive text-destructive-foreground" },
    { label: "Est. Profit", value: formatCurrency(estimatedProfit), icon: TrendingUp, color: "bg-success text-success-foreground" },
  ];

  // Per canteen sales
  const salesByCanteen = orders?.reduce((acc: Record<string, number>, o: any) => {
    acc[o.canteen_id] = (acc[o.canteen_id] || 0) + Number(o.total_amount);
    return acc;
  }, {} as Record<string, number>) || {};

  const canteenSalesData = canteens?.map((c: any) => ({
    name: c.name.replace(" Canteen", "").replace(" Dining", ""),
    sales: salesByCanteen[c.id] || 0,
  })) || [];

  return (
    <AppLayout title="Owner Dashboard">
      <div className="space-y-6 animate-fade-in">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {kpiCards.map((kpi) => (
            <Card key={kpi.label} className="border-none shadow-sm">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-muted-foreground">{kpi.label}</span>
                  <div className={`w-8 h-8 rounded-lg ${kpi.color} flex items-center justify-center`}>
                    <kpi.icon className="w-4 h-4" />
                  </div>
                </div>
                <p className="text-2xl font-bold text-foreground">{kpi.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2 border-none shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Sales by Canteen</CardTitle>
            </CardHeader>
            <CardContent>
              {canteenSalesData.length > 0 && canteenSalesData.some((d: any) => d.sales > 0) ? (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={canteenSalesData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} angle={-30} textAnchor="end" height={60} />
                    <YAxis tickFormatter={(v) => formatCurrency(v)} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} />
                    <Tooltip formatter={(value: number) => [formatCurrency(value), "Sales"]} contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="sales" fill="hsl(var(--accent))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-12">No sales data yet. Create orders via POS to see data here.</p>
              )}
            </CardContent>
          </Card>

          <Card className="border-none shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-destructive" />
                Low Stock Alerts
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {lowStockItems.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">All items well stocked ✓</p>
              ) : (
                lowStockItems.slice(0, 8).map((item: any) => (
                  <div key={item.id} className="flex items-center justify-between py-2 border-b last:border-0">
                    <div>
                      <p className="text-sm font-medium">{item.name}</p>
                      <p className="text-[11px] text-muted-foreground">{item.category}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-destructive">{Number(item.current_stock)} {item.unit}</p>
                      <p className="text-[10px] text-muted-foreground">Min: {Number(item.minimum_stock)}</p>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        {/* Quick summary */}
        <Card className="border-none shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Financial Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div><p className="text-xs text-muted-foreground">Total Sales</p><p className="text-lg font-bold">{formatCurrency(totalSales)}</p></div>
              <div><p className="text-xs text-muted-foreground">Purchase Cost</p><p className="text-lg font-bold">{formatCurrency(totalPurchaseCost)}</p></div>
              <div><p className="text-xs text-muted-foreground">Expenses</p><p className="text-lg font-bold">{formatCurrency(totalExpenses)}</p></div>
              <div><p className="text-xs text-muted-foreground">Est. Profit</p><p className={`text-lg font-bold ${estimatedProfit >= 0 ? "text-success" : "text-destructive"}`}>{formatCurrency(estimatedProfit)}</p></div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
