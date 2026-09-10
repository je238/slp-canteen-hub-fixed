import { useState } from "react";
import { AlertTriangle, CalendarDays, IndianRupee, PackageCheck, Pencil, ShoppingCart, Target, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { useBudgetVsActual, useSaveBudget, useSiteBudgets } from "@/hooks/useSrsData";
import { fmtMonth } from "@/lib/date";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const currentMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const money = (n: any) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
function tone(pct: number | null) {
  if (pct == null) return { text: "Budget set nahi", color: "bg-muted-foreground" };
  if (pct >= 100) return { text: "Budget cross", color: "bg-destructive" };
  if (pct >= 80) return { text: "Attention", color: "bg-warning" };
  return { text: "On track", color: "bg-success" };
}
function BudgetMeter({ title, used, budget, projected }: { title: string; used: number; budget: number; projected?: number }) {
  const pct = budget > 0 ? used * 100 / budget : null;
  const state = tone(pct);
  const remaining = budget - used;
  return <div className="rounded-xl border p-4 space-y-3">
    <div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{title}</p><p className="text-xs text-muted-foreground">{money(used)} used of {budget ? money(budget) : "budget not set"}</p></div><Badge variant="outline">{state.text}</Badge></div>
    <div className="h-2.5 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full ${state.color}`} style={{ width: `${Math.min(100, pct || 0)}%` }} /></div>
    <div className="grid grid-cols-3 gap-2 text-center">
      <div><p className="text-[11px] text-muted-foreground">Used</p><p className="text-sm font-bold">{pct == null ? "—" : `${pct.toFixed(1)}%`}</p></div>
      <div><p className="text-[11px] text-muted-foreground">Remaining</p><p className={`text-sm font-bold ${remaining < 0 ? "text-destructive" : ""}`}>{budget ? money(remaining) : "—"}</p></div>
      <div><p className="text-[11px] text-muted-foreground">Month projection</p><p className={`text-sm font-bold ${budget && Number(projected) > budget ? "text-destructive" : ""}`}>{projected ? money(projected) : "—"}</p></div>
    </div>
  </div>;
}

export default function BudgetPage() {
  const { selectedCanteen } = useAppContext();
  const { rank } = useAuth();
  const canEdit = rank >= 50;
  const [month, setMonth] = useState(currentMonth());
  const budgetsQuery = useSiteBudgets(selectedCanteen);
  const actualQuery = useBudgetVsActual(selectedCanteen, month);
  const saveBudget = useSaveBudget();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<any>({});
  const a: any = actualQuery.data || {};
  const budgets: any[] = budgetsQuery.data || [];

  const openEditor = (budget?: any) => {
    const existing = budget || budgets.find((b) => b.canteen_id === selectedCanteen && String(b.budget_month).slice(0, 7) === month);
    setForm(existing ? { ...existing } : { food_budget: "", purchase_budget: "", labour_budget: "", food_cost_pct: "" });
    setOpen(true);
  };
  const submit = async () => {
    if (selectedCanteen === "all") return toast.error("Pehle ek site select karein");
    try {
      await saveBudget.mutateAsync({
        id: form.id, canteen_id: selectedCanteen, budget_month: `${month}-01`,
        food_budget: Number(form.food_budget) || 0, purchase_budget: Number(form.purchase_budget) || 0,
        labour_budget: Number(form.labour_budget) || 0,
        food_cost_pct: form.food_cost_pct === "" ? undefined : Number(form.food_cost_pct),
      });
      toast.success("Monthly budget save ho gaya"); setOpen(false);
    } catch (e: any) { toast.error(e.message); }
  };
  const worst = Math.max(Number(a.food_used_pct || 0), Number(a.purchase_used_pct || 0));

  return <AppLayout title="Budgets">
    <div className="space-y-4 animate-fade-in">
      <Card className="border-none shadow-sm"><CardContent className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div><h2 className="text-lg font-bold">Monthly budget control</h2><p className="text-sm text-muted-foreground">Kitna spend hua, kitna bacha aur month-end tak kitna ho sakta hai.</p></div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end"><div><Label>Month</Label><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></div>{canEdit && <Button disabled={selectedCanteen === "all"} onClick={() => openEditor()}><Target className="mr-2 h-4 w-4" />Set budget</Button>}</div>
        </div>
      </CardContent></Card>

      {selectedCanteen === "all" ? <Card><CardContent className="p-10 text-center text-sm text-muted-foreground">Budget dekhne ke liye sidebar se ek site select karein.</CardContent></Card>
        : actualQuery.isLoading ? <p className="py-10 text-center text-sm text-muted-foreground">Budget calculate ho raha hai…</p>
        : actualQuery.error ? <Card><CardContent className="p-8 text-center text-sm text-destructive">{(actualQuery.error as Error).message}</CardContent></Card>
        : <>
          {worst >= 80 && <Card className="border-warning/40 bg-warning/5"><CardContent className="p-4 flex gap-3"><AlertTriangle className="h-5 w-5 shrink-0 text-warning" /><div><p className="font-semibold">{worst >= 100 ? "Monthly budget cross ho gaya" : "Budget 80% se upar hai"}</p><p className="text-sm text-muted-foreground">Projection check karke purchase/consumption action lein.</p></div></CardContent></Card>}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: "Revenue billed", value: a.revenue, icon: IndianRupee, sub: "final / provisional plates clearly counted" },
              { label: "Food consumed", value: a.actual_consumption, icon: PackageCheck, sub: "FIFO issue minus accepted returns" },
              { label: "Purchases", value: a.actual_purchase, icon: ShoppingCart, sub: "confirmed supplier bills" },
              { label: "Gross margin", value: Number(a.revenue) - Number(a.actual_consumption), icon: TrendingUp, sub: "revenue minus food consumed" },
            ].map((x) => <Card key={x.label} className="border-none shadow-sm"><CardContent className="p-4"><x.icon className="mb-2 h-4 w-4 text-accent" /><p className="text-xs text-muted-foreground">{x.label}</p><p className="text-xl font-bold">{money(x.value)}</p><p className="mt-1 text-[11px] text-muted-foreground">{x.sub}</p></CardContent></Card>)}
          </div>
          <Card className="border-none shadow-sm"><CardHeader><CardTitle className="text-base">Budget vs actual</CardTitle></CardHeader><CardContent className="grid gap-4 xl:grid-cols-2">
            <BudgetMeter title="Food consumption budget" used={Number(a.actual_consumption) || 0} budget={Number(a.food_budget) || 0} projected={Number(a.projected_food) || 0} />
            <BudgetMeter title="Purchase budget" used={Number(a.actual_purchase) || 0} budget={Number(a.purchase_budget) || 0} projected={Number(a.projected_purchase) || 0} />
          </CardContent></Card>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="border-none shadow-sm"><CardContent className="p-4"><p className="text-xs text-muted-foreground">Food cost %</p><p className="text-2xl font-bold">{a.food_cost_pct == null ? "—" : `${a.food_cost_pct}%`}</p><p className="text-xs text-muted-foreground">Target: {a.target_food_cost_pct == null ? "not set" : `${a.target_food_cost_pct}%`}</p></CardContent></Card>
            <Card className="border-none shadow-sm"><CardContent className="p-4"><p className="text-xs text-muted-foreground">Other expenses</p><p className="text-2xl font-bold">{money(a.actual_expense)}</p><p className="text-xs text-muted-foreground">Expense register entries</p></CardContent></Card>
            <Card className="border-none shadow-sm"><CardContent className="p-4"><p className="text-xs text-muted-foreground">Labour budget</p><p className="text-2xl font-bold">{money(a.labour_budget)}</p><p className="text-xs text-muted-foreground">Actual labour attendance/payroll integration ke baad aayega</p></CardContent></Card>
          </div>
          <p className="text-xs text-muted-foreground"><CalendarDays className="mr-1 inline h-3.5 w-3.5" />Projection {a.days_elapsed || 0} reported days ki daily average ko poore {a.days_in_month || "—"}-day month par lagati hai.</p>
        </>}

      <Card className="border-none shadow-sm"><CardHeader><CardTitle className="text-base">Saved site budgets</CardTitle></CardHeader><CardContent>
        {budgets.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">Abhi koi budget save nahi hai.</p>
          : <div className="grid gap-3 xl:grid-cols-2">{budgets.map((b: any) => <div key={b.id} className="rounded-xl border p-4">
            <div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{b.canteens?.name || "Site"}</p><p className="text-xs text-muted-foreground">{fmtMonth(b.budget_month)}</p></div>{canEdit && b.canteen_id === selectedCanteen && String(b.budget_month).slice(0, 7) === month && <Button variant="ghost" size="icon" onClick={() => openEditor(b)}><Pencil className="h-4 w-4" /></Button>}</div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4"><div><p className="text-xs text-muted-foreground">Food</p><p className="font-semibold">{money(b.food_budget)}</p></div><div><p className="text-xs text-muted-foreground">Purchase</p><p className="font-semibold">{money(b.purchase_budget)}</p></div><div><p className="text-xs text-muted-foreground">Labour</p><p className="font-semibold">{money(b.labour_budget)}</p></div><div><p className="text-xs text-muted-foreground">Target FC</p><p className="font-semibold">{b.food_cost_pct == null ? "—" : `${b.food_cost_pct}%`}</p></div></div>
          </div>)}</div>}
      </CardContent></Card>
    </div>

    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{month} budget</DialogTitle></DialogHeader><div className="grid grid-cols-2 gap-3">
      {[["food_budget","Food consumption ₹"],["purchase_budget","Purchases ₹"],["labour_budget","Labour ₹"],["food_cost_pct","Target food cost %"]].map(([key,label]) => <div key={key}><Label>{label}</Label><Input type="number" min="0" value={form[key] ?? ""} onChange={(e) => setForm({ ...form, [key]: e.target.value })} /></div>)}
    </div><DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={saveBudget.isPending} onClick={submit}>{saveBudget.isPending ? "Saving…" : "Save budget"}</Button></DialogFooter></DialogContent></Dialog>
  </AppLayout>;
}

