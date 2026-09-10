import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle, ArrowRight, Building2, CheckCircle2, ClipboardCheck,
  ClipboardList, IndianRupee, Package, ReceiptText, ShieldCheck, Users,
} from "lucide-react";
import { useSitePerformance } from "@/hooks/useSrsData";
import { supabase } from "@/integrations/supabase/client";
import { clampToCutover } from "@/lib/cutover";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import ExecutiveControlDashboard from "@/components/ExecutiveControlDashboard";

const money = (value: any) => `₹${Math.round(Number(value) || 0).toLocaleString("en-IN")}`;

function localIso(daysFromToday = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type SeniorData = {
  requisitions: any[];
  menus: any[];
  ingredients: any[];
  purchases: any[];
  notifications: any[];
  users: any[];
  unitReviews: any[];
  corrections: any[];
  logs: any[];
};

function useSeniorControls(role: string, date: string) {
  const isAdmin = role === "admin";
  return useQuery({
    queryKey: ["seniorDashboardControls", role, date],
    refetchInterval: 60_000,
    queryFn: async (): Promise<SeniorData> => {
      const common = await Promise.all([
        supabase.from("requisitions").select("id,canteen_id,status,req_date,meal_period").eq("req_date", date),
        supabase.from("menu_plans").select("id,canteen_id,status,meal_period,expected_headcount,actual_headcount").eq("menu_date", date),
        supabase.from("ingredients").select("id,canteen_id,current_stock,reorder_level,minimum_stock").is("archived_at", null),
        supabase.from("purchases").select("id,canteen_id,total_amount,payment_status,status,created_at")
          .gte("created_at", `${date}T00:00:00+05:30`).lt("created_at", `${localIso(1)}T00:00:00+05:30`),
        supabase.from("notifications").select("id,canteen_id,title,created_at,read_at").is("read_at", null).limit(100),
      ]);

      let admin: any[] = [];
      if (isAdmin) {
        admin = await Promise.all([
          supabase.from("user_roles").select("id,role,canteen_id"),
          supabase.from("historical_unit_review" as any).select("purchase_item_id,canteen_id"),
          supabase.from("purchase_line_corrections" as any).select("id,canteen_id,created_at").order("created_at", { ascending: false }).limit(100),
          supabase.from("action_logs").select("id,action,entity_type,canteen_id,created_at,details")
            .order("created_at", { ascending: false }).limit(12),
        ]);
      }

      const rows = (result: any) => result?.error ? [] : (result?.data || []);
      return {
        requisitions: rows(common[0]), menus: rows(common[1]), ingredients: rows(common[2]),
        purchases: rows(common[3]), notifications: rows(common[4]),
        users: rows(admin[0]), unitReviews: rows(admin[1]), corrections: rows(admin[2]), logs: rows(admin[3]),
      };
    },
  });
}

function useDuplicateCount(siteIds: string[], enabled: boolean) {
  return useQuery({
    queryKey: ["seniorDuplicateCount", ...siteIds],
    enabled: enabled && siteIds.length > 0,
    queryFn: async () => {
      const results = await Promise.all(siteIds.map((id) =>
        supabase.rpc("similar_ingredients" as any, { p_canteen_id: id })));
      return results.reduce((sum, result: any) => sum + (result.error ? 0 : (result.data || []).length), 0);
    },
  });
}

function Metric({ label, value, sub, icon: Icon, danger }: {
  label: string; value: string | number; sub?: string; icon: any; danger?: boolean;
}) {
  return (
    <Card className="border-none shadow-sm">
      <CardContent className="p-4 flex gap-3 items-start">
        <span className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${danger ? "bg-destructive/10" : "bg-accent/10"}`}>
          <Icon className={`w-4 h-4 ${danger ? "text-destructive" : "text-accent"}`} />
        </span>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className={`text-xl font-bold truncate ${danger ? "text-destructive" : ""}`}>{value}</p>
          {sub && <p className="text-[11px] text-muted-foreground leading-snug">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function LinkButton({ children, to }: { children: React.ReactNode; to: string }) {
  const navigate = useNavigate();
  return <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(to)}>{children}<ArrowRight className="w-3.5 h-3.5" /></Button>;
}

export default function SeniorRoleDashboard({ role }: { role: string }) {
  if (["ops_manager", "super_admin", "owner"].includes(role)) {
    return <ExecutiveControlDashboard role={role} />;
  }
  const date = localIso();
  const from = clampToCutover(localIso(-29));
  const { data: sites = [], isLoading: sitesLoading } = useSitePerformance(from, date);
  const { data: controls, isLoading: controlsLoading } = useSeniorControls(role, date);
  const isAdmin = role === "admin";
  const { data: duplicateCount = 0 } = useDuplicateCount(sites.map((s: any) => s.canteen_id), isAdmin);

  if (sitesLoading || controlsLoading || !controls) {
    return <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Dashboard load ho raha hai…</CardContent></Card>;
  }

  const totals = sites.reduce((a: any, s: any) => ({
    revenue: a.revenue + Number(s.revenue || 0), consumption: a.consumption + Number(s.consumption || 0),
    purchase: a.purchase + Number(s.purchase || 0), inventory: a.inventory + Number(s.inventory_value || 0),
    heads: a.heads + Number(s.headcount || 0), alerts: a.alerts + Number(s.open_alerts || 0),
  }), { revenue: 0, consumption: 0, purchase: 0, inventory: 0, heads: 0, alerts: 0 });
  const foodCost = totals.revenue > 0 ? totals.consumption * 100 / totals.revenue : null;
  const pendingApprovals = controls.requisitions.filter((r) => ["submitted", "pending"].includes(r.status)).length;
  const pendingIssues = controls.requisitions.filter((r) => ["approved", "partially_issued"].includes(r.status)).length;
  const missingPlates = controls.menus.filter((m) => m.status === "published" && m.actual_headcount == null).length;
  const lowStock = controls.ingredients.filter((i) => Number(i.current_stock) <= Number(i.reorder_level ?? i.minimum_stock ?? 0)).length;
  const unpaidToday = controls.purchases.filter((p) => p.payment_status !== "paid")
    .reduce((sum, p) => sum + Number(p.total_amount || 0), 0);

  const bySite = sites.map((site: any) => {
    const siteReqs = controls.requisitions.filter((r) => r.canteen_id === site.canteen_id);
    const siteMenus = controls.menus.filter((m) => m.canteen_id === site.canteen_id);
    const siteLow = controls.ingredients.filter((i) => i.canteen_id === site.canteen_id && Number(i.current_stock) <= Number(i.reorder_level ?? i.minimum_stock ?? 0)).length;
    const approval = siteReqs.filter((r) => ["submitted", "pending"].includes(r.status)).length;
    const issue = siteReqs.filter((r) => ["approved", "partially_issued"].includes(r.status)).length;
    const plates = siteMenus.filter((m) => m.status === "published" && m.actual_headcount == null).length;
    const risk = approval + issue + plates + siteLow + Number(site.open_alerts || 0);
    return { ...site, approval, issue, plates, siteLow, meals: siteMenus.length, risk };
  }).sort((a: any, b: any) => b.risk - a.risk);

  if (role === "ops_manager") {
    return <OperationsDashboard sites={bySite} pendingApprovals={pendingApprovals} pendingIssues={pendingIssues}
      missingPlates={missingPlates} lowStock={lowStock} />;
  }
  if (role === "admin") {
    return <AdminDashboard sites={sites} controls={controls} duplicateCount={duplicateCount}
      lowStock={lowStock} pendingApprovals={pendingApprovals} />;
  }
  return <OwnerDashboard sites={bySite} totals={totals} foodCost={foodCost} pendingIssues={pendingIssues}
    missingPlates={missingPlates} lowStock={lowStock} unpaidToday={unpaidToday} />;
}

function OwnerDashboard({ sites, totals, foodCost, pendingIssues, missingPlates, lowStock, unpaidToday }: any) {
  return <div className="space-y-4 animate-fade-in">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h2 className="font-semibold">Owner overview</h2><p className="text-xs text-muted-foreground">Pichhle 30 din ka business aur aaj ke risks</p></div>
      <div className="flex gap-2 flex-wrap"><LinkButton to="/audit-log">Audit & changes</LinkButton><LinkButton to="/site-performance">Site performance</LinkButton><LinkButton to="/reports-center">Reports</LinkButton></div>
    </div>
    <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
      <Metric label="Sale" value={money(totals.revenue)} sub={`${totals.heads.toLocaleString()} plates`} icon={IndianRupee} />
      <Metric label="Consumption" value={money(totals.consumption)} icon={Package} />
      <Metric label="Food cost %" value={foodCost == null ? "—" : `${foodCost.toFixed(1)}%`} sub="consumption ÷ sale" icon={IndianRupee} danger={foodCost != null && foodCost > 40} />
      <Metric label="Purchases" value={money(totals.purchase)} icon={ReceiptText} />
      <Metric label="Stock in hand" value={money(totals.inventory)} icon={Package} />
      <Metric label="Aaj unpaid" value={money(unpaidToday)} icon={ReceiptText} danger={unpaidToday > 0} />
    </div>
    <AttentionCard items={[
      { label: `${pendingIssues} approved order issue hona baaki`, to: "/requisitions", bad: pendingIssues > 0 },
      { label: `${missingPlates} meal ke plates count baaki`, to: "/menu-planning", bad: missingPlates > 0 },
      { label: `${lowStock} item reorder level par/neeche`, to: "/inventory", bad: lowStock > 0 },
      { label: `${totals.alerts} open alert`, to: "/site-performance", bad: totals.alerts > 0 },
    ]} />
    <SiteStatus sites={sites} owner />
  </div>;
}

function OperationsDashboard({ sites, pendingApprovals, pendingIssues, missingPlates, lowStock }: any) {
  const risky = sites.filter((s: any) => s.risk > 0).length;
  return <div className="space-y-4 animate-fade-in">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h2 className="font-semibold">Operations control</h2><p className="text-xs text-muted-foreground">Aaj kis site par kaunsa kaam atka hai</p></div>
      <div className="flex gap-2"><LinkButton to="/requisitions">Orders</LinkButton><LinkButton to="/comparison">Comparison</LinkButton></div>
    </div>
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
      <Metric label="Sites needing action" value={risky} sub={`${sites.length} accessible sites`} icon={Building2} danger={risky > 0} />
      <Metric label="Manager approval" value={pendingApprovals} icon={ClipboardList} danger={pendingApprovals > 0} />
      <Metric label="Store issue baaki" value={pendingIssues} icon={Package} danger={pendingIssues > 0} />
      <Metric label="Plate count baaki" value={missingPlates} icon={ClipboardCheck} danger={missingPlates > 0} />
      <Metric label="Low stock" value={lowStock} icon={AlertTriangle} danger={lowStock > 0} />
    </div>
    <SiteStatus sites={sites} />
  </div>;
}

function AdminDashboard({ sites, controls, duplicateCount, lowStock, pendingApprovals }: any) {
  const dataIssues = controls.unitReviews.length + duplicateCount;
  return <div className="space-y-4 animate-fade-in">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h2 className="font-semibold">Admin control</h2><p className="text-xs text-muted-foreground">Users, data quality, corrections aur audit</p></div>
      <div className="flex gap-2"><LinkButton to="/users">Users</LinkButton><LinkButton to="/stock-audit">Stock check</LinkButton></div>
    </div>
    <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
      <Metric label="Sites" value={sites.length} icon={Building2} />
      <Metric label="User roles" value={controls.users.length} icon={Users} />
      <Metric label="Data checks" value={dataIssues} sub={`${controls.unitReviews.length} unit · ${duplicateCount} duplicate`} icon={AlertTriangle} danger={dataIssues > 0} />
      <Metric label="Invoice corrections" value={controls.corrections.length} sub="latest 100 records" icon={ReceiptText} />
      <Metric label="Low stock" value={lowStock} icon={Package} danger={lowStock > 0} />
      <Metric label="Approval pending" value={pendingApprovals} icon={ClipboardList} danger={pendingApprovals > 0} />
    </div>
    <div className="grid lg:grid-cols-2 gap-4">
      <Card className="border-none shadow-sm">
        <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><ShieldCheck className="w-4 h-4" /> Data controls</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <AdminAction label="Old bill unit mismatch" value={controls.unitReviews.length} to="/inventory" />
          <AdminAction label="Possible duplicate item names" value={duplicateCount} to="/inventory" />
          <AdminAction label="Confirmed invoice corrections" value={controls.corrections.length} to="/purchases" />
          <AdminAction label="Unread system alerts" value={controls.notifications.length} to="/dashboard" />
        </CardContent>
      </Card>
      <Card className="border-none shadow-sm">
        <CardHeader className="pb-2"><CardTitle className="text-sm">Recent audit activity</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {controls.logs.length === 0 ? <p className="text-sm text-muted-foreground py-4 text-center">Recent audit activity nahi hai.</p>
            : controls.logs.map((log: any) => <div key={log.id} className="rounded-lg border p-2.5">
              <div className="flex justify-between gap-2"><p className="text-sm font-medium break-words">{String(log.action).replace(/_/g, " ")}</p><span className="text-[10px] text-muted-foreground shrink-0">{new Date(log.created_at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span></div>
              <p className="text-[11px] text-muted-foreground">{log.entity_type || "system"}</p>
            </div>)}
        </CardContent>
      </Card>
    </div>
  </div>;
}

function AttentionCard({ items }: { items: { label: string; to: string; bad: boolean }[] }) {
  return <Card className="border-none shadow-sm"><CardHeader className="pb-2"><CardTitle className="text-sm">Aaj attention chahiye</CardTitle></CardHeader><CardContent className="grid sm:grid-cols-2 gap-2">
    {items.map((item) => <AdminAction key={item.label} label={item.label} value={item.bad ? "Dekho" : "OK"} to={item.to} good={!item.bad} />)}
  </CardContent></Card>;
}

function AdminAction({ label, value, to, good }: { label: string; value: string | number; to: string; good?: boolean }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(to)} className="w-full rounded-lg border p-3 flex items-center justify-between gap-3 text-left hover:bg-muted/50 transition-colors">
    <span className="text-sm">{label}</span><span className={`font-bold shrink-0 ${good ? "text-success" : Number(value) > 0 || value === "Dekho" ? "text-destructive" : ""}`}>{value}</span>
  </button>;
}

function SiteStatus({ sites, owner = false }: { sites: any[]; owner?: boolean }) {
  return <Card className="border-none shadow-sm"><CardHeader className="pb-2 flex flex-row items-center justify-between"><CardTitle className="text-sm">{owner ? "Site ranking & risk" : "Aaj ka site status"}</CardTitle><Badge variant="outline">{sites.length} sites</Badge></CardHeader>
    <CardContent className="p-0 divide-y">
      {sites.length === 0 ? <p className="p-6 text-center text-sm text-muted-foreground">Aapko koi site assigned nahi hai.</p> : sites.map((site) => <div key={site.canteen_id} className="p-3 sm:p-4 flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="min-w-0 lg:w-64"><div className="flex items-center gap-2"><p className="font-semibold truncate">{site.site_name}</p>{site.risk > 0 ? <Badge variant="destructive">Action</Badge> : <Badge className="bg-success/10 text-success border-success/20"><CheckCircle2 className="w-3 h-3 mr-1" />OK</Badge>}</div>{owner && <p className="text-xs text-muted-foreground">Sale {money(site.revenue)} · FC {site.food_cost_pct == null ? "—" : `${site.food_cost_pct}%`}</p>}</div>
        <div className="grid grid-cols-4 gap-2 flex-1 text-center">
          <Small label="Menu" value={site.meals ?? "—"} />
          <Small label="Approval" value={site.approval ?? 0} bad={site.approval > 0} />
          <Small label="Issue" value={site.issue ?? 0} bad={site.issue > 0} />
          <Small label="Plates" value={site.plates ?? 0} bad={site.plates > 0} />
        </div>
      </div>)}
    </CardContent>
  </Card>;
}

function Small({ label, value, bad }: { label: string; value: any; bad?: boolean }) {
  return <div className="rounded-lg bg-muted/50 px-2 py-2"><p className="text-[10px] text-muted-foreground">{label}</p><p className={`text-sm font-bold ${bad ? "text-destructive" : ""}`}>{value}</p></div>;
}
