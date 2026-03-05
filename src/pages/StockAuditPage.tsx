import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useIngredients, useStockLedger } from "@/hooks/useSupabaseData";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, ClipboardCheck, Search, ShieldAlert, TrendingDown } from "lucide-react";
import { toast } from "sonner";

interface AuditEntry {
  ingredientId: string;
  name: string;
  unit: string;
  systemStock: number;
  physicalStock: string;
  variance: number;
  reason: string;
}

export default function StockAuditPage() {
  const { selectedCanteen } = useAppContext();
  const { data: ingredients } = useIngredients(selectedCanteen);
  const { data: ledger } = useStockLedger(selectedCanteen);
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [filterType, setFilterType] = useState<"all" | "mismatch" | "pilferage">("all");

  const items = ingredients || [];

  const startAudit = () => {
    setAuditEntries(
      items.map((i: any) => ({
        ingredientId: i.id,
        name: i.name,
        unit: i.unit,
        systemStock: Number(i.current_stock),
        physicalStock: "",
        variance: 0,
        reason: "",
      }))
    );
  };

  const updateEntry = (idx: number, field: "physicalStock" | "reason", value: string) => {
    setAuditEntries((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      if (field === "physicalStock") {
        const physical = parseFloat(value) || 0;
        next[idx].variance = physical - next[idx].systemStock;
      }
      return next;
    });
  };

  const submitAudit = async () => {
    if (selectedCanteen === "all") { toast.error("Select a canteen first"); return; }
    setSubmitting(true);
    try {
      for (const entry of auditEntries) {
        const physical = parseFloat(entry.physicalStock);
        if (isNaN(physical) || entry.variance === 0) continue;

        const reason = entry.reason || (entry.variance < 0 ? "Stock audit — shortage/pilferage" : "Stock audit — surplus found");

        await supabase.from("ingredients").update({ current_stock: physical }).eq("id", entry.ingredientId);
        await supabase.from("stock_ledger").insert({
          ingredient_id: entry.ingredientId,
          canteen_id: selectedCanteen,
          change_qty: entry.variance,
          balance_after: physical,
          reason,
          reference_type: "audit",
        });
      }
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["stockLedger"] });
      toast.success("Stock audit recorded successfully");
      setAuditEntries([]);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const mismatches = auditEntries.filter((e) => {
    const p = parseFloat(e.physicalStock);
    return !isNaN(p) && e.variance !== 0;
  });
  const pilferageItems = mismatches.filter((e) => e.variance < 0);
  const totalShortageValue = pilferageItems.reduce((s, e) => {
    const ing = items.find((i: any) => i.id === e.ingredientId);
    return s + Math.abs(e.variance) * (Number(ing?.cost_per_unit) || 0);
  }, 0);

  // Recent audit entries from ledger
  const auditLedger = (ledger || []).filter((l: any) => l.reference_type === "audit");

  const filteredEntries = auditEntries.filter((e) => {
    const matchSearch = e.name.toLowerCase().includes(search.toLowerCase());
    if (filterType === "mismatch") return matchSearch && parseFloat(e.physicalStock) >= 0 && e.variance !== 0;
    if (filterType === "pilferage") return matchSearch && e.variance < 0;
    return matchSearch;
  });

  return (
    <AppLayout title="Stock Audit & Pilferage">
      <div className="space-y-4 animate-fade-in">
        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">
                <ClipboardCheck className="w-5 h-5 text-accent" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Items to Audit</p>
                <p className="text-xl font-bold">{items.length}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-destructive/10 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-destructive" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Mismatches Found</p>
                <p className="text-xl font-bold">{mismatches.length}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-destructive/10 flex items-center justify-center">
                <ShieldAlert className="w-5 h-5 text-destructive" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Shortage Value (est.)</p>
                <p className="text-xl font-bold">₹{totalShortageValue.toFixed(0)}</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {auditEntries.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center space-y-4">
              <ClipboardCheck className="w-12 h-12 mx-auto text-muted-foreground" />
              <div>
                <h3 className="font-semibold">Start a Stock Audit</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Count physical stock and compare against system records to detect pilferage, wastage, or data errors.
                </p>
              </div>
              <Button onClick={startAudit} disabled={items.length === 0 || selectedCanteen === "all"}>
                <ClipboardCheck className="w-4 h-4 mr-2" /> Begin Audit ({items.length} items)
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row gap-2 sm:items-center justify-between">
                <CardTitle className="text-base">Physical Stock Count</CardTitle>
                <div className="flex gap-2">
                  <div className="relative flex-1 sm:w-48">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <Input placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8 h-8 text-xs" />
                  </div>
                  <Select value={filterType} onValueChange={(v: any) => setFilterType(v)}>
                    <SelectTrigger className="w-32 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Items</SelectItem>
                      <SelectItem value="mismatch">Mismatches</SelectItem>
                      <SelectItem value="pilferage">Shortages</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Item</TableHead>
                      <TableHead className="text-xs text-right">System Stock</TableHead>
                      <TableHead className="text-xs text-right">Physical Count</TableHead>
                      <TableHead className="text-xs text-right">Variance</TableHead>
                      <TableHead className="text-xs">Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredEntries.map((entry, idx) => {
                      const realIdx = auditEntries.findIndex((e) => e.ingredientId === entry.ingredientId);
                      const hasVariance = entry.physicalStock !== "" && entry.variance !== 0;
                      return (
                        <TableRow key={entry.ingredientId} className={hasVariance && entry.variance < 0 ? "bg-destructive/5" : ""}>
                          <TableCell className="text-sm font-medium">
                            {entry.name}
                            <span className="text-xs text-muted-foreground ml-1">({entry.unit})</span>
                          </TableCell>
                          <TableCell className="text-sm text-right">{entry.systemStock}</TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              value={entry.physicalStock}
                              onChange={(e) => updateEntry(realIdx, "physicalStock", e.target.value)}
                              className="w-24 h-8 text-sm text-right ml-auto"
                              placeholder="0"
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            {entry.physicalStock !== "" && (
                              <Badge variant={entry.variance < 0 ? "destructive" : entry.variance > 0 ? "secondary" : "outline"} className="text-xs">
                                {entry.variance > 0 ? "+" : ""}{entry.variance.toFixed(1)}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            {hasVariance && (
                              <Select value={entry.reason} onValueChange={(v) => updateEntry(realIdx, "reason", v)}>
                                <SelectTrigger className="h-8 text-xs w-36">
                                  <SelectValue placeholder="Select reason" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="Pilferage/Theft">Pilferage/Theft</SelectItem>
                                  <SelectItem value="Wastage/Spoilage">Wastage/Spoilage</SelectItem>
                                  <SelectItem value="Measurement error">Measurement Error</SelectItem>
                                  <SelectItem value="Unrecorded usage">Unrecorded Usage</SelectItem>
                                  <SelectItem value="Surplus found">Surplus Found</SelectItem>
                                  <SelectItem value="Other">Other</SelectItem>
                                </SelectContent>
                              </Select>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <div className="p-4 border-t flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {mismatches.length} mismatch{mismatches.length !== 1 ? "es" : ""} · {pilferageItems.length} shortage{pilferageItems.length !== 1 ? "s" : ""} (₹{totalShortageValue.toFixed(0)})
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setAuditEntries([])}>Cancel</Button>
                  <Button size="sm" onClick={submitAudit} disabled={submitting || mismatches.length === 0}>
                    {submitting ? "Saving..." : "Submit Audit"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Recent Audit History */}
        {auditLedger.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingDown className="w-4 h-4" /> Recent Audit Adjustments
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Date</TableHead>
                    <TableHead className="text-xs">Item</TableHead>
                    <TableHead className="text-xs text-right">Change</TableHead>
                    <TableHead className="text-xs text-right">Balance After</TableHead>
                    <TableHead className="text-xs">Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditLedger.slice(0, 20).map((entry: any) => (
                    <TableRow key={entry.id}>
                      <TableCell className="text-xs">{new Date(entry.created_at).toLocaleDateString("en-IN")}</TableCell>
                      <TableCell className="text-sm">{entry.ingredients?.name || "—"}</TableCell>
                      <TableCell className="text-sm text-right">
                        <Badge variant={entry.change_qty < 0 ? "destructive" : "secondary"} className="text-xs">
                          {entry.change_qty > 0 ? "+" : ""}{entry.change_qty}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-right">{entry.balance_after}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{entry.reason}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}
