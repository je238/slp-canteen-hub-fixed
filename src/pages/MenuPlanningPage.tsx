import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { useMenuPlans, useSaveMenuPlan, useUpdateMenuPlanItem, useRecordMealCounts, useUncountedMeals, useDueToPublish, MEAL_PERIODS } from "@/hooks/useSrsData";
import { todayIst } from "@/lib/date";
import { useRecipes } from "@/hooks/useSupabaseData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { CalendarDays, ChefHat, Plus, Send, Trash2, Users } from "lucide-react";
import { saveDraft, loadDraft, clearDraft } from "@/lib/draft";
import PlanningWindow from "@/components/PlanningWindow";
import MenuUnitWastage from "@/components/MenuUnitWastage";

const DRAFT_KEY = "menu-plan";
import { toast } from "sonner";

// Head Supervisor plans each day's menu per meal period with an expected
// headcount, then publishes it — publishing is what puts it on the Chef's
// screen and lets the chef raise a raw-material requisition against it.

export default function MenuPlanningPage() {
  const { selectedCanteen, setSelectedCanteen } = useAppContext();
  const { isManagerOrAbove, isHeadSupervisor, isChef, isOwner } = useAuth();
  const canEnterMenuData = isHeadSupervisor || isManagerOrAbove;
  const canDoInitialDataEntry = isHeadSupervisor || isOwner;
  const [params] = useSearchParams();
  // Arriving from the "menu published" notification, which names the day and
  // the unit it was published for. Without this the chef landed on today, on
  // whichever unit they happened to be on, and found an empty screen.
  const [date, setDate] = useState(params.get("date") || todayIst());
  const requestedMeal = params.get("meal");
  const [activeMeal, setActiveMeal] = useState(
    MEAL_PERIODS.some((meal) => meal.value === requestedMeal)
      ? requestedMeal!
      : "breakfast",
  );
  const linkedSite = params.get("site");
  useEffect(() => {
    if (linkedSite && linkedSite !== selectedCanteen) setSelectedCanteen(linkedSite);
  }, [linkedSite, selectedCanteen, setSelectedCanteen]);
  const { data: plans, isLoading } = useMenuPlans(selectedCanteen, date, date);
  const { data: recipes } = useRecipes(selectedCanteen);
  const savePlan = useSaveMenuPlan();
  const updateItem = useUpdateMenuPlanItem();
  const recordCounts = useRecordMealCounts();
  const { data: uncounted } = useUncountedMeals(selectedCanteen, 7);
  const { data: due } = useDueToPublish(selectedCanteen);
  const qc = useQueryClient();

  const [editor, setEditor] = useState<any>(null);
  const [dishes, setDishes] = useState<any[]>([]);
  const [headcount, setHeadcount] = useState("");
  const [restored, setRestored] = useState(false);
  const loadedDraft = useRef(false);

  // A menu half typed into this dialog lives nowhere but the screen until
  // Save is pressed. Backgrounding the app no longer wipes it, but a phone
  // is still free to kill the app outright, so the dialog is written down as
  // it stands and reopened on the exact day and meal it was left on.
  useEffect(() => {
    (async () => {
      const d = await loadDraft<any>(DRAFT_KEY);
      loadedDraft.current = true;
      if (!d?.dishes?.length) return;
      setDate(d.date);
      setEditor({ period: d.period, id: d.id, status: d.status });
      setDishes(d.dishes);
      setHeadcount(d.headcount ?? "");
      setRestored(true);
    })();
  }, []);

  useEffect(() => {
    if (!loadedDraft.current) return;                       // don`t clobber before reading
    if (editor && dishes.some((x: any) => x.dish_name?.trim())) {
      saveDraft(DRAFT_KEY, { date, period: editor.period, id: editor.id, status: editor.status, dishes, headcount });
    }
  }, [editor, dishes, headcount, date]);

  const closeEditor = () => { clearDraft(DRAFT_KEY); setRestored(false); setEditor(null); };

  const planFor = (period: string) => (plans || []).find((p: any) => p.meal_period === period);

  const openEditor = (period: string) => {
    const existing = planFor(period);
    setEditor({ period, id: existing?.id, status: existing?.status || "draft" });
    setHeadcount(existing ? String(existing.expected_headcount ?? "") : "");
    setDishes(existing?.menu_plan_items?.length
      ? existing.menu_plan_items.map((i: any) => ({ dish_name: i.dish_name, recipe_id: i.recipe_id, planned_qty: i.planned_qty, unit: i.unit }))
      : [{ dish_name: "", recipe_id: null, planned_qty: "", unit: "kg" }]);
  };

  const isPast = date < todayIst();

  const submit = async (publish: boolean) => {
    if (selectedCanteen === "all") { toast.error("Select a site first"); return; }
    // You cannot decide today what the kitchen should have cooked last week.
    // Reading a past day stays open — that is how plates get recorded — but
    // writing a menu into it does not.
    if (isPast) {
      toast.error("That day has already passed. A menu can only be planned for today or later.");
      return;
    }
    const clean = dishes.filter((d) => d.dish_name?.trim());
    if (clean.length === 0) { toast.error("Add at least one dish"); return; }
    // Typed per day, never carried over: this is the number the company is
    // billed on and the one every per-head check divides by. A menu published
    // without it costs nothing per head and drags every average it touches.
    if (publish && !(Number(headcount) > 0)) {
      toast.error("Enter the expected headcount for this day before publishing");
      return;
    }
    try {
      await savePlan.mutateAsync({
        id: editor.id,
        canteen_id: selectedCanteen,
        menu_date: date,
        meal_period: editor.period,
        expected_headcount: Number(headcount) || 0,
        status: publish ? "published" : "draft",
        published_at: publish ? new Date().toISOString() : null,
        items: clean.map((d) => ({
          dish_name: d.dish_name.trim(),
          recipe_id: d.recipe_id || null,
          planned_qty: d.planned_qty === "" ? null : Number(d.planned_qty),
          unit: d.unit || null,
        })),
      });
      toast.success(publish ? "Menu published — the chef can see it now" : "Menu saved as draft");
      closeEditor();
    } catch (e: any) {
      if (e?.code === "MENU_ALREADY_EXISTS") {
        closeEditor();
        await qc.invalidateQueries({ queryKey: ["menuPlans"] });
        toast.info(e.message);
        return;
      }
      toast.error(e.message);
    }
  };

  const recordProduction = async (itemId: string, produced: string) => {
    try {
      await updateItem.mutateAsync({
        id: itemId,
        produced_qty: produced === "" ? null : Number(produced),
        produced_at: new Date().toISOString(),
      });
      toast.success("Production recorded");
    } catch (e: any) { toast.error(e.message); }
  };

  const saveCounts = async (plan: any, actualValue: string, punchValue: string, reason: string) => {
    const actual = actualValue === "" ? null : Number(actualValue);
    const punch = punchValue === "" ? null : Number(punchValue);
    if ((actual != null && (!Number.isFinite(actual) || actual < 0)) ||
        (punch != null && (!Number.isFinite(punch) || punch < 0))) {
      toast.error("Count 0 ya usse zyada hona chahiye");
      return;
    }
    const correctingActual = plan.actual_headcount != null && actual !== Number(plan.actual_headcount);
    const correctingPunch = plan.company_punch_count != null && punch !== Number(plan.company_punch_count);
    if ((correctingActual || correctingPunch) && !reason.trim()) {
      toast.error("Recorded count correct karne ke liye reason likhna zaroori hai");
      return;
    }
    try {
      await recordCounts.mutateAsync({ id: plan.id, actual, companyPunch: punch, reason });
      toast.success(punch != null
        ? `${punch} Eicher punch save hua — billing ab FINAL hai`
        : actual != null ? `${actual} actual served save hua — Eicher punch pending hai` : "Counts saved");
    } catch (e: any) { toast.error(e.message); }
  };

  return (
    <AppLayout title="Menu & Production Planning">
      <div className="space-y-4 animate-fade-in">
        <Card className="border-none shadow-sm">
          <CardContent className="p-4 flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Menu date</Label>
              {/* No min here on purpose: a past day still has to be opened to
                  record the plates that were served on it. Planning INTO the
                  past is what gets blocked, on the action rather than here. */}
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
            </div>
            <p className="text-xs text-muted-foreground flex-1 min-w-[240px]">
              HS har meal ka menu aur expected headcount dalega. <b>Publish</b> karne par Chef ko menu milega,
              phir Chef raw-material requisition raise karega.
            </p>
          </CardContent>
        </Card>

        {/* A meal served but never counted is a meal the company is never
            billed for, so it is chased here rather than left to be noticed. */}
        {canDoInitialDataEntry && (uncounted?.length ?? 0) > 0 && (
          <Card className="border-none shadow-sm bg-amber-500/10">
            <CardContent className="p-3">
              <p className="text-xs font-semibold mb-1.5">
                {uncounted!.length} meal{uncounted!.length > 1 ? "s" : ""} in the last 7 days have no plate count
              </p>
              <div className="flex flex-wrap gap-1.5">
                {uncounted!.slice(0, 12).map((m: any) => (
                  <Button
                    key={m.id} size="sm" variant="outline" className="h-7 text-[11px]"
                    onClick={() => setDate(m.menu_date)}
                  >
                    {m.menu_date} · {MEAL_PERIODS.find((x) => x.value === m.meal_period)?.label || m.meal_period}
                    {m.issued ? " · stock issued" : ""}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Tomorrow is the only day that can go to the chef, so it is the one
            thing on this screen that is actually due. Left to a list of thirty
            green and grey boxes, the evening's job disappears into it. */}
        {canDoInitialDataEntry && (due?.length ?? 0) > 0 &&
         due!.some((d: any) => d.status !== "published") && (
          <Card className="border-none shadow-sm bg-accent/10">
            <CardContent className="p-3 flex items-center gap-2 flex-wrap">
              <Send className="w-4 h-4 text-accent shrink-0" />
              <p className="text-xs flex-1 min-w-[240px]">
                <b>Tomorrow ({due![0].menu_date.split("-").reverse().join("/")})</b> —{" "}
                {due!.filter((d: any) => d.status === "published").length} of {due!.length} meals
                sent to the chef. Add each meal's headcount and publish it; only
                tomorrow can be sent.
              </p>
              <Button size="sm" variant="outline" className="h-7 text-[11px]"
                onClick={() => setDate(due![0].menu_date)}>
                open tomorrow
              </Button>
            </CardContent>
          </Card>
        )}

        {canDoInitialDataEntry && selectedCanteen !== "all" && (
          <PlanningWindow canteenId={selectedCanteen} current={date} onPick={setDate} />
        )}

        {selectedCanteen === "all" ? (
          <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Select a site to plan its menu.</CardContent></Card>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-3">
            <div
              className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"
              role="tablist"
              aria-label="Meal select karein"
            >
              {MEAL_PERIODS.map((meal) => {
                const mealPlan = planFor(meal.value);
                const dishCount = mealPlan?.menu_plan_items?.length ?? 0;
                const selected = activeMeal === meal.value;
                return (
                  <Button
                    key={meal.value}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`meal-panel-${meal.value}`}
                    variant={selected ? "default" : "outline"}
                    className="h-auto min-h-14 justify-start px-3 py-2 text-left"
                    onClick={() => setActiveMeal(meal.value)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{meal.label}</span>
                      <span className={`block text-[10px] ${selected ? "text-primary-foreground/80" : "text-muted-foreground"}`}>
                        {mealPlan
                          ? `${dishCount} item${dishCount === 1 ? "" : "s"} · ${mealPlan.status}`
                          : "Menu pending"}
                      </span>
                    </span>
                  </Button>
                );
              })}
            </div>

            <p className="text-xs text-muted-foreground">
              Sirf selected meal khula hai. Doosra meal dekhne ke liye upar uske naam par click karein.
            </p>

            <div className="grid gap-3">
            {MEAL_PERIODS.filter((mp) => mp.value === activeMeal).map((mp) => {
              const plan = planFor(mp.value);
              const items = plan?.menu_plan_items || [];
              return (
                <Card
                  key={mp.value}
                  id={`meal-panel-${mp.value}`}
                  role="tabpanel"
                  className="border-none shadow-sm"
                >
                  <CardHeader className="pb-2 flex flex-row items-center justify-between">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <CalendarDays className="w-4 h-4" /> {mp.label}
                    </CardTitle>
                    {plan ? (
                      <Badge variant={plan.status === "published" ? "secondary" : "outline"} className="text-[10px] uppercase">
                        {plan.status}
                      </Badge>
                    ) : null}
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {plan ? (
                      <>
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <Users className="w-3 h-3" /> Expected: <b>{plan.expected_headcount}</b>
                          {plan.actual_headcount != null && <span className="text-accent">· Actual <b>{plan.actual_headcount}</b></span>}
                          {plan.company_punch_count != null && <span className="text-success">· Eicher final <b>{plan.company_punch_count}</b></span>}
                        </p>
                        {items.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No dishes listed.</p>
                        ) : items.map((i: any) => (
                          <div key={i.id} className="text-sm border-b last:border-0 py-1.5">
                            <div className="flex justify-between gap-2">
                              <span className="font-medium">{i.dish_name}</span>
                              <span className="text-xs text-muted-foreground">
                                {i.planned_qty ? `${i.planned_qty} ${i.unit || ""}` : "—"}
                              </span>
                            </div>
                            {/* How much was cooked is the kitchen's to say.
                                What was thrown away is not — it moved to the
                                manager, weighed and photographed. */}
                            {isChef && plan.status !== "draft" && (
                              <div className="flex items-center gap-1.5 mt-1">
                                <Input
                                  type="number" placeholder="produced" className="h-7 text-xs w-24"
                                  defaultValue={i.produced_qty ?? ""}
                                  onBlur={(e) => {
                                    if (e.target.value !== String(i.produced_qty ?? "")) {
                                      recordProduction(i.id, e.target.value);
                                    }
                                  }}
                                />
                                {i.wastage_qty != null && (
                                  <span className="text-[11px] text-muted-foreground">
                                    wastage {Number(i.wastage_qty)} {i.unit || ""} — recorded by the manager
                                  </span>
                                )}
                              </div>
                            )}
                            {canEnterMenuData && plan.status !== "draft" &&
                             selectedCanteen !== "all" &&
                             ["breakfast", "lunch", "evening_snacks", "dinner", "night_snacks"].includes(plan.meal_period) && (
                              <MenuUnitWastage
                                plan={plan}
                                item={i}
                                canteenId={selectedCanteen}
                                onSaved={() => qc.invalidateQueries({ queryKey: ["menuPlans"] })}
                              />
                            )}
                            {!isChef && !isManagerOrAbove && (i.produced_qty != null) && (
                              <p className="text-[11px] text-muted-foreground">
                                Produced {i.produced_qty}{i.wastage_qty ? ` · wastage ${i.wastage_qty}` : ""}
                              </p>
                            )}
                          </div>
                        ))}
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">Not planned yet.</p>
                    )}
                    {/* Three separate numbers prevent an estimate or a manual
                        counter from silently becoming the customer's bill. */}
                    {plan && plan.status !== "draft" &&
                     (canDoInitialDataEntry || (isManagerOrAbove && (plan.actual_headcount != null || plan.company_punch_count != null))) && (
                      <div className="rounded-md border bg-muted/30 p-2 space-y-1.5">
                        <div className="grid grid-cols-3 gap-1 text-center text-[10px]">
                          <div className="rounded border bg-background p-1"><span className="text-muted-foreground">EXPECTED</span><b className="block text-xs">{plan.expected_headcount}</b></div>
                          <div className="rounded border bg-background p-1"><span className="text-muted-foreground">ACTUAL</span><b className="block text-xs">{plan.actual_headcount ?? "Pending"}</b></div>
                          <div className={`rounded border p-1 ${plan.company_punch_count == null ? "bg-warning/10" : "bg-success/10"}`}><span className="text-muted-foreground">EICHER FINAL</span><b className="block text-xs">{plan.company_punch_count ?? "Pending"}</b></div>
                        </div>
                        <div className="grid grid-cols-2 gap-1.5">
                          <div><Label className="text-[10px]">Actual served</Label>
                          <Input
                            type="number" min={0} className="h-8 text-xs"
                            placeholder={`Expected ${plan.expected_headcount}`}
                            defaultValue={plan.actual_headcount ?? ""}
                            key={`actual-${plan.id}-${plan.actual_headcount ?? ""}`}
                            readOnly={isManagerOrAbove && !isOwner
                              ? plan.actual_headcount == null
                              : plan.actual_headcount != null && !isManagerOrAbove}
                            id={`actual-${plan.id}`}
                          /></div>
                          <div><Label className="text-[10px]">Eicher punch (Final)</Label>
                          <Input type="number" min={0} className="h-8 text-xs"
                            placeholder="Official punching count"
                            defaultValue={plan.company_punch_count ?? ""}
                            key={`punch-${plan.id}-${plan.company_punch_count ?? ""}`}
                            readOnly={isManagerOrAbove && !isOwner
                              ? plan.company_punch_count == null
                              : plan.company_punch_count != null && !isManagerOrAbove}
                            id={`punch-${plan.id}`}
                          /></div>
                        </div>
                        {(plan.actual_headcount != null || plan.company_punch_count != null) && isManagerOrAbove && (
                          <Input className="h-8 text-xs" placeholder="Correction reason (count badalne par mandatory)" id={`count-reason-${plan.id}`} />
                        )}
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[10px] text-muted-foreground">
                            {plan.company_punch_count != null ? "Final billing Eicher punch se" : plan.actual_headcount != null ? "Provisional billing actual served se" : "Provisional billing expected se"}
                          </p>
                          <Button
                            size="sm" variant="secondary" className="h-8 text-xs"
                            disabled={recordCounts.isPending}
                            onClick={() => {
                              const actual = document.getElementById(`actual-${plan.id}`) as HTMLInputElement | null;
                              const punch = document.getElementById(`punch-${plan.id}`) as HTMLInputElement | null;
                              const reason = document.getElementById(`count-reason-${plan.id}`) as HTMLInputElement | null;
                              saveCounts(plan, actual?.value ?? "", punch?.value ?? "", reason?.value ?? "");
                            }}
                          >
                            Save counts
                          </Button>
                        </div>
                      </div>
                    )}
                    {!isPast && ((isHeadSupervisor && (!plan || plan.status === "draft")) || (isManagerOrAbove && !!plan)) && (
                      <Button variant="outline" size="sm" className="w-full text-xs" onClick={() => openEditor(mp.value)}>
                        {plan ? (plan.status === "published" ? "Manager correction" : "Edit menu") : "Plan this meal"}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              );
            })}
            </div>
          </div>
        )}
      </div>

      <Dialog open={!!editor} onOpenChange={(o) => { if (!o) closeEditor(); }}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {MEAL_PERIODS.find((m) => m.value === editor?.period)?.label} — {date}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {/* Reopened from where it was left, and said so — the date in the
                title above is the one this menu will be saved against. */}
            {restored && (
              <p className="text-[11px] rounded-md bg-accent/10 px-2 py-1.5">
                Picked up where you left off — nothing was lost. It still has
                to be saved.
              </p>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">Expected headcount</Label>
              <Input type="number" min={0} value={headcount} onChange={(e) => setHeadcount(e.target.value)} placeholder="e.g. 250" />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Dishes</Label>
              {/* The dish name gets a line to itself. All five controls on one
                  row left about twenty pixels for the name on a phone, which
                  is why the box could not be read or typed into — the recipe
                  picker, quantity and unit had eaten the width. */}
              {dishes.map((d, idx) => (
                <div key={idx} className="space-y-1.5 border rounded-md p-2">
                  <div className="flex gap-1.5 items-center">
                    <Input
                      className="flex-1 h-9 text-sm" placeholder="Dish name"
                      value={d.dish_name}
                      onChange={(e) => setDishes((p) => p.map((x, i) => i === idx ? { ...x, dish_name: e.target.value } : x))}
                    />
                    <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-destructive"
                      onClick={() => setDishes((p) => p.filter((_, i) => i !== idx))}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  <div className="flex gap-1.5 items-center">
                  <Select
                    value={d.recipe_id || "none"}
                    onValueChange={(v) => setDishes((p) => p.map((x, i) => i === idx ? { ...x, recipe_id: v === "none" ? null : v } : x))}
                  >
                    <SelectTrigger className="flex-1 h-8 text-xs"><SelectValue placeholder="Recipe" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No recipe</SelectItem>
                      {(recipes || []).map((r: any) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number" className="w-16 h-8 text-sm" placeholder="qty"
                    value={d.planned_qty}
                    onChange={(e) => setDishes((p) => p.map((x, i) => i === idx ? { ...x, planned_qty: e.target.value } : x))}
                  />
                  <Select
                    value={d.unit || "kg"}
                    onValueChange={(v) => setDishes((p) => p.map((x, i) => i === idx ? { ...x, unit: v } : x))}
                  >
                    <SelectTrigger className="w-20 h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["kg", "litre", "pcs", "plate"].map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  </div>
                </div>
              ))}
              <Button variant="outline" size="sm" className="text-xs"
                onClick={() => setDishes((p) => [...p, { dish_name: "", recipe_id: null, planned_qty: "", unit: "kg" }])}>
                <Plus className="w-3 h-3 mr-1" /> Add dish
              </Button>
            </div>
          </div>
          <DialogFooter className="gap-2">
            {editor?.status !== "published" && (
              <Button variant="outline" onClick={() => submit(false)} disabled={savePlan.isPending}>Save draft</Button>
            )}
            <Button onClick={() => submit(true)} disabled={savePlan.isPending}>
              <Send className="w-4 h-4 mr-1.5" /> {editor?.status === "published" ? "Save correction" : "Publish to Chef"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
