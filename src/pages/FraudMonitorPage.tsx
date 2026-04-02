import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useFraudAlerts, useIngredientUsageLogs } from "@/hooks/useSupabaseData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, ShieldAlert, TrendingDown, ReceiptText, Flame } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

function formatCurrency(val: number) {
    return `₹${val.toFixed(2)}`;
}

export default function FraudMonitorPage() {
    const { selectedCanteen } = useAppContext();
    const { data: alerts } = useFraudAlerts(selectedCanteen);
    const { data: usageLogs } = useIngredientUsageLogs(selectedCanteen);
    const qc = useQueryClient();
    const [resolvingId, setResolvingId] = useState<string | null>(null);

    const activeAlerts = alerts?.filter(a => a.status === 'open') || [];
    const resolvedAlerts = alerts?.filter(a => a.status !== 'open') || [];

    const totalLossValue = activeAlerts.reduce((acc, alert) => acc + (Number(alert.loss_value) || 0), 0);
    const stockDiscrepancies = activeAlerts.filter(a => a.alert_type === 'stock_discrepancy').length;
    const suspiciousInvoices = activeAlerts.filter(a => a.alert_type === 'suspicious_invoice').length;

    const resolveAlert = async (id: string) => {
        setResolvingId(id);
        try {
            const { error } = await supabase.from('fraud_alerts').update({ status: 'resolved' }).eq('id', id);
            if (error) throw error;
            qc.invalidateQueries({ queryKey: ["fraudAlerts"] });
            toast.success("Alert resolved successfully");
        } catch (e: any) {
            toast.error("Failed to resolve alert: " + e.message);
        } finally {
            setResolvingId(null);
        }
    };

    return (
        <AppLayout title="AI Fraud & Loss Monitor">
            <div className="space-y-6 animate-fade-in">

                {/* KPI Summary Cards */}
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                    <Card className="border-none shadow-sm bg-gradient-to-br from-destructive/10 to-transparent">
                        <CardContent className="p-4 flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-destructive/20 flex items-center justify-center">
                                <ShieldAlert className="w-5 h-5 text-destructive" />
                            </div>
                            <div>
                                <p className="text-xs text-muted-foreground font-medium">Active Alerts</p>
                                <p className="text-2xl font-bold text-destructive">{activeAlerts.length}</p>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="border-none shadow-sm">
                        <CardContent className="p-4 flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">
                                <Flame className="w-5 h-5 text-accent" />
                            </div>
                            <div>
                                <p className="text-xs text-muted-foreground font-medium">Est. Potential Loss</p>
                                <p className="text-2xl font-bold">{formatCurrency(totalLossValue)}</p>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="border-none shadow-sm">
                        <CardContent className="p-4 flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-orange-500/10 flex items-center justify-center">
                                <TrendingDown className="w-5 h-5 text-orange-500" />
                            </div>
                            <div>
                                <p className="text-xs text-muted-foreground font-medium">Stock Discrepancies</p>
                                <p className="text-xl font-bold">{stockDiscrepancies}</p>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="border-none shadow-sm">
                        <CardContent className="p-4 flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                                <ReceiptText className="w-5 h-5 text-blue-500" />
                            </div>
                            <div>
                                <p className="text-xs text-muted-foreground font-medium">Suspicious Invoices</p>
                                <p className="text-xl font-bold">{suspiciousInvoices}</p>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                <Tabs defaultValue="active" className="w-full">
                    <TabsList className="grid w-full grid-cols-3 max-w-md">
                        <TabsTrigger value="active">Active Alerts ({activeAlerts.length})</TabsTrigger>
                        <TabsTrigger value="resolved">Resolved</TabsTrigger>
                        <TabsTrigger value="usage">Live Ingredient Usage</TabsTrigger>
                    </TabsList>

                    {/* Active Alerts */}
                    <TabsContent value="active" className="mt-4">
                        <Card>
                            <CardHeader className="pb-3 border-b">
                                <CardTitle className="text-base flex items-center gap-2">
                                    <AlertTriangle className="w-4 h-4 text-destructive" /> Needs Attention
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="p-0">
                                {activeAlerts.length === 0 ? (
                                    <div className="p-8 text-center text-muted-foreground">
                                        <ShieldAlert className="w-10 h-10 mx-auto opacity-20 mb-3" />
                                        <p>No active fraud alerts detected.</p>
                                    </div>
                                ) : (
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>Date</TableHead>
                                                <TableHead>Alert Type</TableHead>
                                                <TableHead>Details</TableHead>
                                                <TableHead>Affected Item</TableHead>
                                                <TableHead className="text-right">Est. Loss</TableHead>
                                                <TableHead className="text-right">Action</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {activeAlerts.map(alert => (
                                                <TableRow key={alert.id} className="bg-destructive/5 hover:bg-destructive/10">
                                                    <TableCell className="text-xs font-medium whitespace-nowrap">
                                                        {new Date(alert.created_at).toLocaleDateString()}
                                                    </TableCell>
                                                    <TableCell>
                                                        <Badge variant={alert.severity === 'critical' ? 'destructive' : 'secondary'} className="text-[10px] uppercase">
                                                            {alert.alert_type.replace('_', ' ')}
                                                        </Badge>
                                                    </TableCell>
                                                    <TableCell className="max-w-xs">
                                                        <p className="text-sm font-semibold">{alert.title}</p>
                                                        <p className="text-xs text-muted-foreground line-clamp-2">{alert.description}</p>
                                                    </TableCell>
                                                    <TableCell className="text-sm font-medium">
                                                        {alert.ingredients?.name || "Multiple/Unknown"}
                                                    </TableCell>
                                                    <TableCell className="text-right font-bold text-destructive">
                                                        {alert.loss_value ? formatCurrency(Number(alert.loss_value)) : '-'}
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            onClick={() => resolveAlert(alert.id)}
                                                            disabled={resolvingId === alert.id}
                                                        >
                                                            Resolve
                                                        </Button>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                )}
                            </CardContent>
                        </Card>
                    </TabsContent>

                    {/* Resolved Alerts */}
                    <TabsContent value="resolved" className="mt-4">
                        <Card>
                            <CardContent className="p-0">
                                {resolvedAlerts.length === 0 ? (
                                    <div className="p-8 text-center text-muted-foreground">
                                        <p>No resolved alerts.</p>
                                    </div>
                                ) : (
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>Date</TableHead>
                                                <TableHead>Type</TableHead>
                                                <TableHead>Details</TableHead>
                                                <TableHead>Item</TableHead>
                                                <TableHead className="text-right">Loss Value</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {resolvedAlerts.map(alert => (
                                                <TableRow key={alert.id} className="opacity-70">
                                                    <TableCell className="text-xs">{new Date(alert.created_at).toLocaleDateString()}</TableCell>
                                                    <TableCell>
                                                        <Badge variant="outline" className="text-[10px] uppercase">{alert.alert_type.replace('_', ' ')}</Badge>
                                                    </TableCell>
                                                    <TableCell className="max-w-xs">
                                                        <p className="text-sm">{alert.title}</p>
                                                        <p className="text-xs text-muted-foreground line-clamp-1">{alert.description}</p>
                                                    </TableCell>
                                                    <TableCell className="text-sm">{alert.ingredients?.name}</TableCell>
                                                    <TableCell className="text-right text-sm">
                                                        {alert.loss_value ? formatCurrency(Number(alert.loss_value)) : '-'}
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                )}
                            </CardContent>
                        </Card>
                    </TabsContent>

                    {/* Ingredient Usage Log */}
                    <TabsContent value="usage" className="mt-4">
                        <Card>
                            <CardHeader className="pb-3 border-b">
                                <CardTitle className="text-base">Live Recipe Deductions</CardTitle>
                                <p className="text-xs text-muted-foreground mt-1">This log shows exact ingredient quantities automatically deducted during POS sales.</p>
                            </CardHeader>
                            <CardContent className="p-0">
                                {(!usageLogs || usageLogs.length === 0) ? (
                                    <div className="p-8 text-center text-muted-foreground">
                                        <p>No live usage logs yet. Ingredients will appear here when orders are placed.</p>
                                    </div>
                                ) : (
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>Time</TableHead>
                                                <TableHead>Menu Item Sold</TableHead>
                                                <TableHead>Ingredient Deducted</TableHead>
                                                <TableHead className="text-right">Quantity Used</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {usageLogs.map(log => (
                                                <TableRow key={log.id}>
                                                    <TableCell className="text-xs">
                                                        {new Date(log.created_at).toLocaleString()}
                                                    </TableCell>
                                                    <TableCell className="text-sm font-medium">{log.menu_items?.name}</TableCell>
                                                    <TableCell className="text-sm">{log.ingredients?.name}</TableCell>
                                                    <TableCell className="text-right font-semibold">
                                                        {Number(log.quantity_used).toFixed(3)} {log.unit}
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                )}
                            </CardContent>
                        </Card>
                    </TabsContent>
                </Tabs>

            </div>
        </AppLayout>
    );
}
