import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, History, Search, UserRound, CalendarClock, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { auditSummary as summarise, bigJumps } from "@/lib/auditText";
import AppLayout from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useAppContext } from "@/contexts/AppContext";
import { useCanteens, useUserDirectory } from "@/hooks/useSupabaseData";
import { supabase } from "@/integrations/supabase/client";
import { clampToCutover, REPORTING_CUTOVER_DATE } from "@/lib/cutover";

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const LABELS: Record<string, string> = {
  chef_closed_pending_quantity: "Chef ne baaki quantity band ki",
  manager_corrected_requisition: "Manager ne order correct kiya",
  admin_corrected_requisition: "Admin ne order correct kiya",
  requisition_cancelled: "Order cancel hua",
  requisition_sent_back: "Order chef ko wapas bheja",
  head_chef_reviewed_requisition: "Head Chef ne order verify kiya",
  head_chef_rejected_requisition: "Head Chef ne order reject kiya",
  stock_adjusted: "Stock physical count se correct hua",
  rate_corrected: "Item rate correct hua",
  ingredient_renamed: "Item ka naam badla",
  ingredient_unit_corrected: "Item unit correct hui",
  purchase_line_corrected: "Confirmed invoice line correct hui",
  purchase_reversed: "Purchase reverse hui",
  plates_recorded: "Plates count record hua",
  item_unit_wastage_recorded: "Wastage record hua",
  item_unit_wastage_corrected: "Manager ne wastage entry correct ki",
  menu_dish_corrected: "Manager ne menu dish correct ki",
  menu_dish_removed: "Manager ne menu dish remove ki",
  kitchen_return_accepted: "Kitchen return accept hua",
  manager_reviewed_requisition: "Manager ne order review kiya",
  head_chef_approved_requisition: "Head Chef ne order approve kiya",
  plates_corrected: "Plates count correct hua",
  company_punch_recorded: "Eicher punch record hua",
  company_punch_corrected: "Eicher punch correct hua",
  unit_count_recorded: "Unit ka plate count record hua",
  unit_count_corrected: "Unit ka plate count correct hua",
};

const human = (value: string) => LABELS[value] || value.replace(/_/g, " ");

const auditSummary = (details: any) => summarise(details, human);

function reasonOf(details: any) {
  if (!details || typeof details !== "object") return "—";
  return details.reason || details.why || details.note || details.notes || "—";
}

export default function AuditLogPage() {
  const { selectedCanteen } = useAppContext();
  const [from, setFrom] = useState(clampToCutover(isoDaysAgo(30)));
  const [search, setSearch] = useState("");
  const PAGE = 500;
  const [limit, setLimit] = useState(PAGE);
  const { data: users = {} } = useUserDirectory();
  const { data: canteens = [] } = useCanteens();
  const { data: logs = [], isLoading, error } = useQuery({
    queryKey: ["fullAuditLog", selectedCanteen, from, limit],
    queryFn: async () => {
      let query = supabase.from("action_logs").select("id,user_id,action,entity_type,entity_id,canteen_id,created_at,details")
        .gte("created_at", `${from}T00:00:00+05:30`).order("created_at", { ascending: false }).limit(limit);
      // RLS accessible units ko secure rakhta hai; global selector un rows
      // me se ek chosen unit ya saari assigned units dikhata hai.
      if (selectedCanteen !== "all") query = query.eq("canteen_id", selectedCanteen);
      const { data, error: queryError } = await query;
      if (queryError) throw queryError;
      return (data || []) as any[];
    },
  });

  const siteNames = useMemo(() => Object.fromEntries(canteens.map((c: any) => [c.id, c.name])), [canteens]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return logs;
    return logs.filter((log: any) => {
      const text = [human(log.action), log.entity_type, users[log.user_id], siteNames[log.canteen_id],
        auditSummary(log.details), reasonOf(log.details)].join(" ").toLowerCase();
      return text.includes(needle);
    });
  }, [logs, search, users, siteNames]);

  return <AppLayout title="Audit & Changes">
    <div className="space-y-4 animate-fade-in">
      <Card className="border-none shadow-sm">
        <CardContent className="p-4 space-y-3">
          <div><p className="font-semibold">Kisne, kya, kab aur kyun badla</p><p className="text-xs text-muted-foreground">Chef, Manager, Store Keeper aur Admin ke audited changes. Record edit/delete nahi hota.</p></div>
          <div className="grid sm:grid-cols-[180px_1fr] gap-2">
            <Input type="date" min={REPORTING_CUTOVER_DATE} value={from} onChange={(e) => setFrom(clampToCutover(e.target.value))} />
            <div className="relative"><Search className="absolute left-3 top-3 w-4 h-4 text-muted-foreground" /><Input className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Reason, item, user ya action search karein" /></div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Card className="border-none shadow-sm"><CardContent className="p-4"><p className="text-xs text-muted-foreground">Changes shown</p><p className="text-xl font-bold">{filtered.length}</p>{logs.length >= limit && <p className="text-[10px] text-muted-foreground">Sirf latest {limit} — neeche se aur load karein</p>}</CardContent></Card>
        <Card className="border-none shadow-sm"><CardContent className="p-4"><p className="text-xs text-muted-foreground">From</p><p className="text-base font-bold">{new Date(`${from}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</p></CardContent></Card>
        <Card className="border-none shadow-sm col-span-2 sm:col-span-1"><CardContent className="p-4"><p className="text-xs text-muted-foreground">Unit</p><p className="text-base font-bold truncate">{selectedCanteen === "all" ? "All accessible units" : siteNames[selectedCanteen] || "Selected unit"}</p></CardContent></Card>
      </div>

      {error ? <Card><CardContent className="p-8 text-center text-sm text-destructive">Audit records load nahi hue. Access check karein.</CardContent></Card>
        : isLoading ? <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Audit load ho raha hai…</CardContent></Card>
        : filtered.length === 0 ? <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Is filter me koi audited change nahi mila.</CardContent></Card>
        : <div className="space-y-2">
          {filtered.map((log: any) => <Card key={log.id} className="border-none shadow-sm"><CardContent className="p-4">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap"><History className="w-4 h-4 text-accent" /><p className="font-semibold text-sm">{human(log.action)}</p><Badge variant="outline" className="text-[10px]">{human(log.entity_type || "system")}</Badge></div>
                <p className="mt-2 text-sm break-words">{auditSummary(log.details)}</p>
                {bigJumps(log.details).map((j) => <p key={j} className="mt-1 flex items-center gap-1 text-xs font-medium text-destructive"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />Check karo — {j}</p>)}
                <div className="mt-2 rounded-lg bg-warning/5 border border-warning/20 px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Reason</p><p className="text-sm font-medium break-words">{reasonOf(log.details)}</p></div>
              </div>
              <div className="sm:text-right text-xs text-muted-foreground shrink-0 space-y-1">
                <p className="flex sm:justify-end items-center gap-1"><UserRound className="w-3 h-3" />{users[log.user_id] || (log.user_id ? "User account" : "System")}</p>
                <p className="flex sm:justify-end items-center gap-1"><CalendarClock className="w-3 h-3" />{new Date(log.created_at).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
                <p className="flex sm:justify-end items-center gap-1"><Building2 className="w-3 h-3" />{siteNames[log.canteen_id] || "All/System"}</p>
              </div>
            </div>
          </CardContent></Card>)}
          {logs.length >= limit && <div className="text-center pt-1"><Button variant="outline" size="sm" onClick={() => setLimit((n) => n + PAGE)}>Aur purane {PAGE} dikhao</Button></div>}
        </div>}
    </div>
  </AppLayout>;
}
