import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useOrders, useExpenses, useIngredients, usePurchases } from "@/hooks/useSupabaseData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

const COLORS = ["hsl(var(--accent))", "hsl(var(--primary))", "hsl(var(--success))", "hsl(var(--info))", "hsl(var(--destructive))", "hsl(var(--warning))"];

export default function ReportsPage() {
  const { selectedCanteen } = useAppContext();
  const { data: orders } = useOrders(selectedCanteen);
  const { data: expenses } = useExpenses(selectedCanteen);
  const { data: ingredients } = useIngredients(selectedCanteen);
  const { data: purchases } = usePurchases(selectedCanteen);

  // Daily sales
  const todayOrders = orders?.filter((o: any) => new Date(o.created_at).toDateString() === new Date().toDateString()) || [];
  const todaySales = todayOrders.reduce((s: number, o: any) => s + Number(o.total_amount), 0);
  const totalSales = orders?.reduce((s: number, o: any) => s + Number(o.total_amount), 0) || 0;
  const totalExpenses = expenses?.reduce((s: number, e: any) => s + Number(e.amount), 0) || 0;
  const totalPurchases = purchases?.filter((p: any) => p.status === "confirmed").reduce((s: number, p: any) => s + Number(p.total_amount), 0) || 0;
  const estimatedProfit = totalSales - totalExpenses - totalPurchases;

  // Stock status
  const okCount = ingredients?.filter((i: any) => Number(i.current_stock) >= Number(i.minimum_stock)).length || 0;
  const lowCount = ingredients?.filter((i: any) => Number(i.current_stock) < Number(i.minimum_stock) && Number(i.current_stock) > 0).length || 0;
  const critCount = ingredients?.filter((i: any) => Number(i.current_stock) <= 0).length || 0;

  const stockPieData = [
    { name: "In Stock", value: okCount },
    { name: "Low Stock", value: lowCount },
    { name: "Out of Stock", value: critCount },
  ].filter(d => d.value > 0);

  // Expense by category
  const expByCat = expenses?.reduce((acc: Record<string, number>, e: any) => {
    acc[e.category] = (acc[e.category] || 0) + Number(e.amount);
    return acc;
  }, {} as Record<string, number>) || {};
  const expCatData = Object.entries(expByCat).map(([name, value]) => ({ name, value }));

  // Payment mode breakdown
  const paymentModes = orders?.reduce((acc: Record<string, number>, o: any) => {
    acc[o.payment_mode] = (acc[o.payment_mode] || 0) + Number(o.total_amount);
    return acc;
  }, {} as Record<string, number>) || {};
  const paymentData = Object.entries(paymentModes).map(([name, value]) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), value }));

  return (
    <AppLayout title="Reports">
      <div className="space-y-4 animate-fade-in">
        {/* Summary KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {[
            { label: "Today's Sales", value: `₹${todaySales.toLocaleString()}` },
            { label: "Total Sales", value: `₹${totalSales.toLocaleString()}` },
            { label: "Total Purchases", value: `₹${totalPurchases.toLocaleString()}` },
            { label: "Total Expenses", value: `₹${totalExpenses.toLocaleString()}` },
            { label: "Est. Profit", value: `₹${estimatedProfit.toLocaleString()}`, highlight: true },
          ].map((kpi) => (
            <Card key={kpi.label} className="border-none shadow-sm">
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">{kpi.label}</p>
                <p className={`text-xl font-bold ${kpi.highlight ? (estimatedProfit >= 0 ? "text-success" : "text-destructive") : ""}`}>{kpi.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Tabs defaultValue="sales">
          <TabsList>
            <TabsTrigger value="sales">Sales</TabsTrigger>
            <TabsTrigger value="stock">Stock</TabsTrigger>
            <TabsTrigger value="expenses">Expenses</TabsTrigger>
            <TabsTrigger value="purchases">Purchases</TabsTrigger>
          </TabsList>

          <TabsContent value="sales" className="mt-3">
            <div className="grid lg:grid-cols-2 gap-4">
              <Card className="border-none shadow-sm">
                <CardHeader className="pb-2"><CardTitle className="text-sm">Orders ({orders?.length || 0})</CardTitle></CardHeader>
                <CardContent>
                  {orders?.length ? (
                    <table className="w-full text-sm">
                      <thead><tr className="border-b text-muted-foreground">
                        <th className="text-left py-2 font-medium">Order #</th>
                        <th className="text-right py-2 font-medium">Amount</th>
                        <th className="text-right py-2 font-medium">Mode</th>
                        <th className="text-right py-2 font-medium">Time</th>
                      </tr></thead>
                      <tbody>
                        {orders.slice(0, 20).map((o: any) => (
                          <tr key={o.id} className="border-b last:border-0">
                            <td className="py-2 font-mono text-xs">{o.order_number}</td>
                            <td className="py-2 text-right font-medium">₹{Number(o.total_amount).toLocaleString()}</td>
                            <td className="py-2 text-right text-muted-foreground capitalize">{o.payment_mode}</td>
                            <td className="py-2 text-right text-xs text-muted-foreground">{new Date(o.created_at).toLocaleTimeString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="text-sm text-muted-foreground text-center py-6">No orders yet</p>}
                </CardContent>
              </Card>
              <Card className="border-none shadow-sm">
                <CardHeader className="pb-2"><CardTitle className="text-sm">Payment Modes</CardTitle></CardHeader>
                <CardContent>
                  {paymentData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie data={paymentData} cx="50%" cy="50%" outerRadius={80} dataKey="value" label={({ name, value }) => `${name}: ₹${value}`}>
                          {paymentData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : <p className="text-sm text-muted-foreground text-center py-12">No data</p>}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="stock" className="mt-3">
            <div className="grid lg:grid-cols-2 gap-4">
              <Card className="border-none shadow-sm">
                <CardHeader className="pb-2"><CardTitle className="text-sm">Stock Status</CardTitle></CardHeader>
                <CardContent>
                  {stockPieData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie data={stockPieData} cx="50%" cy="50%" outerRadius={80} dataKey="value" label={({ name, value }) => `${name}: ${value}`}>
                          {stockPieData.map((_, i) => <Cell key={i} fill={["hsl(var(--success))", "hsl(var(--warning))", "hsl(var(--destructive))"][i]} />)}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : <p className="text-sm text-muted-foreground text-center py-12">No inventory data</p>}
                </CardContent>
              </Card>
              <Card className="border-none shadow-sm">
                <CardHeader className="pb-2"><CardTitle className="text-sm">Low Stock Items</CardTitle></CardHeader>
                <CardContent>
                  {ingredients?.filter((i: any) => Number(i.current_stock) < Number(i.minimum_stock)).map((i: any) => (
                    <div key={i.id} className="flex justify-between py-1.5 border-b last:border-0 text-sm">
                      <span>{i.name}</span>
                      <span className="text-destructive font-medium">{i.current_stock} {i.unit}</span>
                    </div>
                  ))}
                  {ingredients?.filter((i: any) => Number(i.current_stock) < Number(i.minimum_stock)).length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-6">All items well stocked</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="expenses" className="mt-3">
            <Card className="border-none shadow-sm">
              <CardHeader className="pb-2"><CardTitle className="text-sm">Expenses by Category</CardTitle></CardHeader>
              <CardContent>
                {expCatData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={expCatData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                      <YAxis tickFormatter={v => `₹${v}`} tick={{ fontSize: 12 }} />
                      <Tooltip formatter={(v: number) => [`₹${v.toLocaleString()}`, "Amount"]} />
                      <Bar dataKey="value" fill="hsl(var(--accent))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : <p className="text-sm text-muted-foreground text-center py-12">No expense data</p>}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="purchases" className="mt-3">
            <Card className="border-none shadow-sm">
              <CardHeader className="pb-2"><CardTitle className="text-sm">Purchase History</CardTitle></CardHeader>
              <CardContent>
                {purchases?.length ? (
                  <table className="w-full text-sm">
                    <thead><tr className="border-b text-muted-foreground">
                      <th className="text-left py-2 font-medium">Date</th>
                      <th className="text-left py-2 font-medium">Supplier</th>
                      <th className="text-right py-2 font-medium">Amount</th>
                      <th className="text-center py-2 font-medium">Status</th>
                    </tr></thead>
                    <tbody>
                      {purchases.map((p: any) => (
                        <tr key={p.id} className="border-b last:border-0">
                          <td className="py-2">{new Date(p.created_at).toLocaleDateString()}</td>
                          <td className="py-2">{p.suppliers?.name || "—"}</td>
                          <td className="py-2 text-right font-medium">₹{Number(p.total_amount).toLocaleString()}</td>
                          <td className="py-2 text-center">
                            <span className={`text-xs px-2 py-0.5 rounded-full ${p.status === "confirmed" ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}>
                              {p.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <p className="text-sm text-muted-foreground text-center py-6">No purchases yet</p>}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
