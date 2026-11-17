import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { CheckCircle2, MapPin, Users } from "lucide-react";
import AppLayout from "@/components/AppLayout";
import MenuUnitWastage from "@/components/MenuUnitWastage";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useMenuPlans, MEAL_PERIODS } from "@/hooks/useSrsData";
import { todayIst, yesterdayIst } from "@/lib/date";
import { unitValue } from "@/lib/unitCounts";

// A Unit Supervisor's screen: one Eicher unit's plates (actual served and
// Eicher punch) and dish-wise wastage for the day's published meals, plus
// the way to their own attendance. A saved figure is corrected by the
// manager, so each box locks once it is in.

const WASTAGE_MEALS = ["breakfast", "lunch", "evening_snacks", "dinner", "night_snacks"];

export default function UnitEntryPage() {
  const { roleData } = useAuth();
  const site = roleData.canteen_id || "";
  const qc = useQueryClient();
  const [date, setDate] = useState(todayIst());
  const [input, setInput] = useState<Record<string, { actual?: string; punch?: string }>>({});
  const [busy, setBusy] = useState("");

  const { data: unit } = useQuery({
    queryKey: ["mySupervisedUnit"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_supervised_unit" as any);
      if (error) throw error;
      return (data as string | null) || null;
    },
  });
  const unitNo = unit ? Number(unit.replace(/\D/g, "")) : undefined;
  const { data: plans, isLoading } = useMenuPlans(site, date, date);
  const meals = (plans || []).filter((p: any) => p.status !== "draft");

  const save = async (plan: any) => {
    const v = input[plan.id] || {};
    const toNum = (s?: string) => (s == null || s.trim() === "" ? null : Number(s));
    const actual = toNum(v.actual), punch = toNum(v.punch);
    if (actual == null && punch == null) { toast.error("Plates ki ginti daalo"); return; }
    if ([actual, punch].some((n) => n != null && (!Number.isInteger(n) || n < 0))) {
      toast.error("Ginti 0 ya usse zyada poora number hona chahiye"); return;
    }
    setBusy(plan.id);
    const { error } = await supabase.rpc("record_my_unit_plates" as any, {
      p_menu_plan_id: plan.id, p_actual: actual, p_punch: punch,
    });
    setBusy("");
    if (error) { toast.error(error.message); return; }
    toast.success(`${unit} ki plates save ho gayi`);
    setInput((o) => ({ ...o, [plan.id]: {} }));
    qc.invalidateQueries({ queryKey: ["menuPlans"] });
  };

  return (
    <AppLayout title={unit ? `${unit} · Plates aur Wastage` : "Meri Unit"}>
      <div className="mx-auto max-w-xl space-y-3 animate-fade-in">
        <Card className="border-none shadow-sm">
          <CardContent className="flex flex-wrap items-center gap-2 p-3">
            <Button size="sm" variant={date === todayIst() ? "default" : "outline"} onClick={() => setDate(todayIst())}>Aaj</Button>
            <Button size="sm" variant={date === yesterdayIst() ? "default" : "outline"} onClick={() => setDate(yesterdayIst())}>Kal (beeta hua)</Button>
            <Input type="date" value={date} max={todayIst()} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-9 w-40" />
            <Button asChild size="sm" variant="secondary" className="ml-auto">
              <Link to="/attendance"><MapPin className="mr-1 h-4 w-4" /> Meri attendance</Link>
            </Button>
          </CardContent>
        </Card>

        {!unit ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Load ho raha hai…</p>
        ) : isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Load ho raha hai…</p>
        ) : meals.length === 0 ? (
          <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">Is din ka koi menu publish nahi hua.</CardContent></Card>
        ) : meals.map((plan: any) => {
          const label = MEAL_PERIODS.find((m: any) => m.value === plan.meal_period)?.label || plan.meal_period;
          const actual = unitValue(plan.unit_counts, unit, "actual");
          const punch = unitValue(plan.unit_counts, unit, "punch");
          const v = input[plan.id] || {};
          return (
            <Card key={plan.id} className="border-none shadow-sm">
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center justify-between">
                  <p className="font-semibold">{label}</p>
                  <p className="flex items-center gap-1 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" /> Site expected {plan.expected_headcount ?? "—"}</p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">{unit} · plates served</Label>
                    {actual != null ? (
                      <p className="flex items-center gap-1 rounded-md bg-success/10 px-2 py-2 text-sm font-semibold text-success"><CheckCircle2 className="h-4 w-4" /> {actual}</p>
                    ) : (
                      <Input inputMode="numeric" className="h-10" placeholder="ginti" value={v.actual || ""}
                        onChange={(e) => setInput((o) => ({ ...o, [plan.id]: { ...v, actual: e.target.value.replace(/\D/g, "") } }))} />
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{unit} · Eicher punch</Label>
                    {punch != null ? (
                      <p className="flex items-center gap-1 rounded-md bg-success/10 px-2 py-2 text-sm font-semibold text-success"><CheckCircle2 className="h-4 w-4" /> {punch}</p>
                    ) : (
                      <Input inputMode="numeric" className="h-10" placeholder="ginti" value={v.punch || ""}
                        onChange={(e) => setInput((o) => ({ ...o, [plan.id]: { ...v, punch: e.target.value.replace(/\D/g, "") } }))} />
                    )}
                  </div>
                </div>
                {(actual == null || punch == null) && (
                  <Button className="w-full" disabled={busy === plan.id} onClick={() => save(plan)}>
                    {busy === plan.id ? "Save ho raha hai…" : "Plates save karo"}
                  </Button>
                )}
                {actual != null && punch != null && (
                  <p className="text-[11px] text-muted-foreground">Galti ho to Manager se correct karwao.</p>
                )}

                {WASTAGE_MEALS.includes(plan.meal_period) && (plan.menu_plan_items || []).map((item: any) => (
                  <MenuUnitWastage key={item.id} plan={plan} item={item} canteenId={site} onlyUnit={unitNo}
                    onSaved={() => qc.invalidateQueries({ queryKey: ["menuPlans"] })} />
                ))}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </AppLayout>
  );
}
