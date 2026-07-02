import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Copy, Check, Database } from "lucide-react";
import { toast } from "sonner";
// Vite raw imports — ship BOTH migrations so the copy button applies the
// complete setup (lifecycle columns + deduction fix / cancel restock).
import lifecycleSql from "../../supabase/migrations/20260702072533_order_lifecycle_kds_qr.sql?raw";
import restockSql from "../../supabase/migrations/20260702101213_cancel_order_restock.sql?raw";

const migrationSql = `${lifecycleSql}\n\n${restockSql}`;

export default function KdsSetupBanner({ feature }: { feature: string }) {
  const [copied, setCopied] = useState(false);

  const copySql = async () => {
    try {
      await navigator.clipboard.writeText(migrationSql);
      setCopied(true);
      toast.success("SQL copied — paste it in the Supabase SQL Editor");
      setTimeout(() => setCopied(false), 3000);
    } catch {
      toast.error("Could not copy. Open supabase/migrations/20260702072533_order_lifecycle_kds_qr.sql manually.");
    }
  };

  return (
    <Card className="border-dashed border-2 max-w-2xl mx-auto mt-12">
      <CardContent className="p-8 text-center space-y-4">
        <div className="w-12 h-12 rounded-xl bg-accent/15 text-accent flex items-center justify-center mx-auto">
          <Database className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-semibold">One-time database setup needed</h2>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          {feature} needs new order-lifecycle columns that aren't in your Supabase database yet.
          Copy the setup SQL below, open your Supabase Dashboard → SQL Editor, paste it and press Run.
          It is safe to run more than once.
        </p>
        <div className="flex items-center justify-center gap-2">
          <Button onClick={copySql} className="gap-1.5">
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copied ? "Copied" : "Copy setup SQL"}
          </Button>
          <Button variant="outline" onClick={() => window.location.reload()}>I ran it — refresh</Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Source: supabase/migrations/20260702072533 + 20260702101213
        </p>
      </CardContent>
    </Card>
  );
}
