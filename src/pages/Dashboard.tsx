import { useMemo, useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useOrdersSince, useIngredients, useExpenses, usePurchases, useCanteens, useFraudAlerts } from "@/hooks/useSupabaseData";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { IndianRupee, ShoppingCart, AlertTriangle, TrendingUp, ArrowUpRight, ShieldAlert } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { formatCurrency } from "@/lib/utils";

type Period = "today" | "7d" | "30d";
const PERIODS: { key: Period; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
];

function periodStart(period: Period): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (period === "7d") d.setDate(d.getDate() - 6);
  if (period === "30d") d.setDate(d.getDate() - 29);
  return d.toISOString();
}

export default function Dashboard() {
  const { selectedCanteen } = useAppContext();
  useRealtimeSubscription(["orders", "ingredients", "expenses", "purchases"]);
  const [period, setPeriod] = useState<Period>("today");
  const since = useMemo(() => periodStart(period), [period]);
  const { data: orders } = useOrdersSince(selectedCanteen, since);
  const { data: ingredients } = useIngredients(selectedCanteen);
  const { data: expenses } = useExpenses(selectedCanteen);
  const { data: purchases } = usePurchases(selectedCanteen);
  const { data: canteens } = useCanteens();
  const { data: fraudAlerts } = useFraudAlerts(selectedCanteen);

  const activeFraudAlerts = fraudAlerts?.filter(a => a.status === 'open') || [];

  // Only settled sales count as revenue — unpaid QR orders and cancellations are excluded.
  // Expenses and purchases are filtered to the same period so profit compares like with like.
  const settledOrders = orders?.filter((o: any) => (o.status ?? "completed") === "completed") || [];
  const totalSales = settledOrders.reduce((s: number, o: any) => s + Number(o.total_amount), 0);
  const totalOrders = settledOrders.length;
  const lowStockItems = ingredients?.filter((i: any) => Number(i.current_stock) < Number(i.minimum_stock)) || [];
  const sinceDate = since.slice(0, 10);
  const totalExpenses = expenses?.filter((e: any) => e.expense_date >= sinceDate).reduce((s: number, e: any) => s + Number(e.amount), 0) || 0;
  const totalPurchaseCost = purchases?.filter((p: any) => p.status === "confirmed" && p.created_at >= since).reduce((s: number, p: any) => s + Number(p.total_amount), 0) || 0;
  const estimatedProfit = totalSales - totalExpenses - totalPurchaseCost;

  const kpiCards = [
    { label: "Total Sales", value: formatCurrency(totalSales), icon: IndianRupee, color: "bg-primary text-primary-foreground" },
    { label: "Total Orders", value: totalOrders.toString(), icon: ShoppingCart, color: "bg-accent text-accent-foreground" },
    { label: "Low Stock Alerts", value: lowStockItems.length.toString(), icon: AlertTriangle, color: "bg-destructive text-destructive-foreground" },
    { label: "Est. Profit", value: formatCurrency(estimatedProfit), icon: TrendingUp, color: "bg-success text-success-foreground" },
  ];

  // Per canteen sales
  const salesByCanteen = settledOrders.reduce((acc: Record<string, number>, o: any) => {
    acc[o.canteen_id] = (acc[o.canteen_id] || 0) + Number(o.total_amount);
    return acc;
  }, {} as Record<string, number>);

  const canteenSalesData = canteens?.map((c: any) => ({
    name: c.name.replace(" Canteen", "").replace(" Dining", ""),
    sales: salesByCanteen[c.id] || 0,
  })) || [];

  return (
    <AppLayout title="Owner Dashboard">
      <div className="space-y-6 animate-fade-in">
        <div className="flex gap-1.5">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                period === p.key ? "bg-accent text-accent-foreground" : "bg-secondary text-secondary-foreground hover:bg-muted"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

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

          {/* Fraud Detection Widget */}
          <Card className="border-none shadow-sm outline outline-1 outline-destructive/20 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-16 h-16 bg-gradient-to-bl from-destructive/10 to-transparent pointer-events-none" />
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-destructive" />
                  Fraud & Loss Alerts
                </span>
                {activeFraudAlerts.length > 0 && (
                  <span className="text-xs bg-destructive text-destructive-foreground px-2 py-0.5 rounded-full font-bold">
                    {activeFraudAlerts.length}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {activeFraudAlerts.length === 0 ? (
                <div className="text-center py-6">
                  <ShieldAlert className="w-8 h-8 mx-auto text-success opacity-50 mb-2" />
                  <p className="text-sm text-success">No active fraud alerts ✓</p>
                  <p className="text-xs text-muted-foreground mt-1">System is healthy</p>
                </div>
              ) : (
                <>
                  {activeFraudAlerts.slice(0, 3).map((alert: any) => (
                    <div key={alert.id} className="flex gap-3 py-2 border-b border-border/50 last:border-0 items-start">
                      <div className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${alert.severity === 'critical' ? 'bg-destructive' : 'bg-orange-500'}`} />
                      <div className="flex-1">
                        <p className="text-sm font-semibold leading-none mb-1">{alert.title}</p>
                        <p className="text-[11px] text-muted-foreground line-clamp-1">{alert.description}</p>
                        {alert.loss_value && (
                          <p className="text-xs font-bold text-destructive mt-1">
                            Est. Loss: {formatCurrency(Number(alert.loss_value))}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                  {activeFraudAlerts.length > 3 && (
                    <p className="text-xs text-center text-muted-foreground pt-1 hover:underline cursor-pointer">
                      +{activeFraudAlerts.length - 3} more alerts detected
                    </p>
                  )}
                </>
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
