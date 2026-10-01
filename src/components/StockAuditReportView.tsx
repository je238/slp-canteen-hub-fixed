import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download } from "lucide-react";
import type { StockAuditReport } from "@/hooks/useSrsData";

const money = (v: number) => `₹${Math.round(Math.abs(Number(v) || 0)).toLocaleString("en-IN")}`;
const qty = (v: number) => Number(Number(v || 0).toFixed(3));
const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${qty(Math.abs(v))}`;

function downloadCsv(name: string, rows: (string | number)[][]) {
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

// Totals first — surplus and shortage each as items and rupees, and the net —
// then the two lists side by side in detail, biggest value first.
export function StockAuditReportView({ report, who }: { report: StockAuditReport; who?: string }) {
  const lines = report.lines || [];
  const short = lines.filter((l) => l.difference < 0);
  const surplus = lines.filter((l) => l.difference > 0);
  const day = new Date(report.submitted_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

  const exportIt = () => downloadCsv(`stock-verification-${report.submitted_at.slice(0, 10)}.csv`, [
    ["Stock verification", day, who || ""],
    ["Items gine", report.counted_items, "Sahi mile", report.matched_items],
    ["Zyada (surplus) items", report.surplus_items, "Value", Math.round(report.surplus_value)],
    ["Kam (shortage) items", report.shortage_items, "Value", Math.round(report.shortage_value)],
    ["Net", Math.round(report.net_value)],
    [],
    ["Type", "Item", "Category", "Unit", "App me tha", "Gina", "Farak", "Rate", "Value", "Wajah"],
    ...[...short, ...surplus].map((l) => [l.difference < 0 ? "Kam" : "Zyada", l.item, l.category || "", l.unit,
      qty(l.expected), qty(l.counted), qty(l.difference), l.rate, Math.round(l.value), l.reason]),
  ]);

  const tiles: [string, string, string][] = [
    ["Items gine", String(report.counted_items), `${report.matched_items} sahi mile`],
    ["Zyada nikla (surplus)", money(report.surplus_value), `${report.surplus_items} items`],
    ["Kam nikla (shortage)", money(report.shortage_value), `${report.shortage_items} items`],
    ["Net", `${report.net_value < 0 ? "−" : "+"}${money(report.net_value)}`, report.net_value < 0 ? "nuksaan" : "faayda"],
  ];

  const table = (title: string, rows: typeof lines, tone: string) => (
    <div className="rounded-lg border overflow-hidden">
      <p className={`px-3 py-2 text-xs font-semibold ${tone}`}>{title}</p>
      {rows.length === 0 ? <p className="px-3 pb-3 text-xs text-muted-foreground">Koi nahi.</p> : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead className="text-xs">Item</TableHead>
              <TableHead className="text-xs text-right whitespace-nowrap">App me</TableHead>
              <TableHead className="text-xs text-right">Gina</TableHead>
              <TableHead className="text-xs text-right">Farak</TableHead>
              <TableHead className="text-xs text-right">Rate</TableHead>
              <TableHead className="text-xs text-right">Value</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((l) => (
                <TableRow key={l.ingredient_id}>
                  <TableCell className="text-sm">
                    <span className="font-medium">{l.item}</span>
                    <span className="block text-[10px] text-muted-foreground">
                      {l.category || "—"}{l.reason && l.reason !== "Stock audit" && !l.reason.startsWith("Stock audit —") ? ` · ${l.reason}` : ""}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-right whitespace-nowrap">{qty(l.expected)} {l.unit}</TableCell>
                  <TableCell className="text-xs text-right whitespace-nowrap">{qty(l.counted)} {l.unit}</TableCell>
                  <TableCell className="text-xs text-right whitespace-nowrap font-medium">{signed(l.difference)} {l.unit}</TableCell>
                  <TableCell className="text-xs text-right whitespace-nowrap">{l.rate ? `₹${l.rate}` : <span className="text-warning">rate nahi</span>}</TableCell>
                  <TableCell className="text-sm text-right whitespace-nowrap font-semibold">{money(l.value)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {day}{who ? ` · ${who}` : ""}{report.submissions > 1 ? ` · ${report.submissions} baar me submit` : ""}
          {report.backfilled ? " · purani ginti se banayi report" : ""}
        </p>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={exportIt}>
          <Download className="w-3.5 h-3.5 mr-1" /> CSV
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {tiles.map(([k, v, sub]) => (
          <div key={k} className="rounded-lg border p-2.5">
            <p className="text-[10px] text-muted-foreground">{k}</p>
            <p className={`text-base font-bold ${k.startsWith("Kam") || (k === "Net" && report.net_value < 0) ? "text-destructive" : k.startsWith("Zyada") || k === "Net" ? "text-success" : ""}`}>{v}</p>
            <p className="text-[10px] text-muted-foreground">{sub}</p>
          </div>
        ))}
      </div>
      {report.unpriced_items > 0 && (
        <p className="text-xs text-warning">{report.unpriced_items} item ka purchase rate nahi mila — unki value ₹0 gini gayi hai.</p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {table(`Kam nikla — ${short.length} items · ${money(report.shortage_value)}`, short, "bg-destructive/10 text-destructive")}
        {table(`Zyada nikla — ${surplus.length} items · ${money(report.surplus_value)}`, surplus, "bg-success/10 text-success")}
      </div>
    </div>
  );
}
