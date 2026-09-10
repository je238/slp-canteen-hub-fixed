import { useNavigate } from "react-router-dom";
import { AlertTriangle, ClipboardCheck } from "lucide-react";
import { useHistoricalUnitReview } from "@/hooks/useSrsData";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function HistoricalUnitReview({ canteenId }: { canteenId: string }) {
  const { data: rows } = useHistoricalUnitReview(canteenId);
  const navigate = useNavigate();
  if (!rows?.length) return null;

  return (
    <Card className="border-warning/30 bg-warning/5 shadow-sm">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-2 flex-wrap">
          <AlertTriangle className="w-4 h-4 text-warning mt-0.5" />
          <div className="flex-1 min-w-[220px]">
            <p className="text-sm font-semibold">{rows.length} old bill lines need unit checking</p>
            <p className="text-xs text-muted-foreground">
              Bill और master unit अलग हैं. Paper bill/box label देखकर verify करें; stock अंदाज़े से नहीं बढ़ेगा. सही shelf quantity “Stock Verification” में physical count से जाएगी.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => navigate("/stock-audit")}>
            <ClipboardCheck className="w-4 h-4 mr-1.5" /> Physical count
          </Button>
        </div>
        <details>
          <summary className="text-xs font-medium cursor-pointer">Show old unit mismatches</summary>
          <div className="mt-2 max-h-56 overflow-auto rounded-md border bg-background">
            {rows.map((r: any) => (
              <div key={r.purchase_item_id} className="grid grid-cols-[minmax(130px,1fr)_1fr] gap-2 px-3 py-2 border-b last:border-0 text-xs">
                <div>
                  <b>{r.item_name}</b>
                  <p className="text-[10px] text-muted-foreground">{new Date(r.created_at).toLocaleDateString("en-IN")}</p>
                </div>
                <div>
                  Bill: <b>{Number(r.bill_quantity)} {r.bill_unit}</b> → Master: <b>{r.ingredient_name} ({r.master_unit})</b>
                  {r.stock_quantity != null && <p className="text-[10px] text-muted-foreground">Confirmed stock qty: {Number(r.stock_quantity)} {r.stock_unit || r.master_unit}</p>}
                </div>
              </div>
            ))}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
