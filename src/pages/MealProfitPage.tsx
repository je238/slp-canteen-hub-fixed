import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
import { ChevronDown, CircleAlert, Pencil, Scale, Search } from "lucide-react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useIngredients } from "@/hooks/useSupabaseData";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

const money = (value: unknown) => `₹${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const number = (value: unknown, digits = 1) => Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: digits });
const mealLabel: Record<string, string> = {
  breakfast: "Breakfast", lunch: "Lunch", evening_snacks: "Evening Snacks",
  dinner: "Dinner", night_snacks: "Night Snacks",
};

type NutritionForm = {
  id: string;
  name: string;
  basisQty: string;
  basisUnit: string;
  energy: string;
  protein: string;
  carbs: string;
  fat: string;
  fibre: string;
  source: string;
};

type IngredientNutrition = {
  id: string; name: string; unit: string; nutrition_basis_qty?: number | null;
  nutrition_basis_unit?: string | null; energy_kcal?: number | null; protein_g?: number | null;
  carbohydrate_g?: number | null; fat_g?: number | null; fibre_g?: number | null;
  nutrition_source?: string | null;
};

type DishIngredient = { ingredient_id: string; ingredient: string; qty: number; unit: string; cost: number };
type DishAnalysis = {
  menu_plan_item_id: string; dish_name: string; recipe_id?: string | null; yield_qty?: number | null;
  yield_unit?: string | null; allocated_cost: number; cost_per_person?: number | null;
  kcal_per_person?: number | null; protein_g_per_person?: number | null;
  carbohydrate_g_per_person?: number | null; fat_g_per_person?: number | null;
  wastage_qty?: number | null; production_unit?: string | null; ingredients?: DishIngredient[];
};
type MenuAnalysis = {
  menu_plan_id: string; menu_date: string; meal_period: string; diner_count: number; provisional: boolean;
  revenue: number; actual_food_cost: number; dish_allocated_cost: number; unallocated_cost: number;
  gross_margin: number; cost_per_person?: number | null; margin_per_person?: number | null;
  kcal_per_person?: number | null; protein_g_per_person?: number | null;
  carbohydrate_g_per_person?: number | null; fat_g_per_person?: number | null; fibre_g_per_person?: number | null;
  allocation_pct: number; dishes: DishAnalysis[];
};
type ProfitSummary = { revenue?: number; actual_food_cost?: number; dish_allocated_cost?: number; unallocated_cost?: number };
type ProfitAnalysis = { summary: ProfitSummary; menus: MenuAnalysis[] };
const optionalNumber = (value: string) => value.trim() === "" ? null : Number(value);

function useMealProfitAnalysis(canteenId: string, from: string, to: string) {
  return useQuery({
    queryKey: ["mealProfitAnalysis", canteenId, from, to],
    enabled: !!canteenId && canteenId !== "all" && !!from && !!to,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("meal_profit_analysis", {
        p_canteen_id: canteenId,
        p_start: from,
        p_end: to,
      });
      if (error) throw error;
      return (data || { summary: {}, menus: [] }) as ProfitAnalysis;
    },
  });
}

export default function MealProfitPage() {
  const { selectedCanteen } = useAppContext();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(format(subDays(new Date(), 29), "yyyy-MM-dd"));
  const [to, setTo] = useState(format(new Date(), "yyyy-MM-dd"));
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<NutritionForm | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [menuA, setMenuA] = useState("");
  const [menuB, setMenuB] = useState("");
  const { data: ingredients = [], isLoading: ingredientsLoading } = useIngredients(selectedCanteen);
  const analysis = useMealProfitAnalysis(selectedCanteen, from, to);
  const menus = analysis.data?.menus || [];

  const visibleIngredients = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (ingredients as unknown as IngredientNutrition[]).filter((item) => !term || item.name.toLowerCase().includes(term));
  }, [ingredients, search]);

  const selectedA = menus.find((menu) => menu.menu_plan_id === menuA) || menus[0];
  const selectedB = menus.find((menu) => menu.menu_plan_id === menuB) || menus[1];

  const saveNutrition = useMutation({
    mutationFn: async (form: NutritionForm) => {
      const values = [form.basisQty, form.energy, form.protein, form.carbs, form.fat, form.fibre]
        .filter((value) => value.trim() !== "").map(Number);
      if (!form.basisQty || Number(form.basisQty) <= 0 || values.some((value) => !Number.isFinite(value) || value < 0)) {
        throw new Error("Nutrition values positive numbers honi chahiye.");
      }
      const { error } = await supabase.rpc("set_ingredient_nutrition", {
        p_ingredient_id: form.id,
        p_basis_qty: Number(form.basisQty),
        p_basis_unit: form.basisUnit,
        p_energy_kcal: optionalNumber(form.energy),
        p_protein_g: optionalNumber(form.protein),
        p_carbohydrate_g: optionalNumber(form.carbs),
        p_fat_g: optionalNumber(form.fat),
        p_fibre_g: optionalNumber(form.fibre),
        p_source: form.source || null,
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["ingredients"] }),
        queryClient.invalidateQueries({ queryKey: ["mealProfitAnalysis"] }),
      ]);
      setEdit(null);
      toast.success("Nutrition master update ho gaya");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const beginEdit = (item: IngredientNutrition) => setEdit({
    id: item.id,
    name: item.name,
    basisQty: String(item.nutrition_basis_qty || 100),
    basisUnit: item.nutrition_basis_unit || (/litre|liter|ml/i.test(item.unit) ? "ml" : /pc|piece|nos|unit/i.test(item.unit) ? "pc" : "g"),
    energy: item.energy_kcal == null ? "" : String(item.energy_kcal),
    protein: item.protein_g == null ? "" : String(item.protein_g),
    carbs: item.carbohydrate_g == null ? "" : String(item.carbohydrate_g),
    fat: item.fat_g == null ? "" : String(item.fat_g),
    fibre: item.fibre_g == null ? "" : String(item.fibre_g),
    source: item.nutrition_source || "",
  });

  return (
    <AppLayout title="Meal Profit System">
      <div className="space-y-4">
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-bold">Cost, nutrition aur menu comparison</h2>
            <p className="text-xs text-muted-foreground">Actual FIFO issue cost ÷ actual unique diners. Recipe missing ho to cost unallocated dikhega.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="space-y-1 text-xs"><span className="text-muted-foreground">From</span><Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="h-9" /></label>
            <label className="space-y-1 text-xs"><span className="text-muted-foreground">To</span><Input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="h-9" /></label>
          </div>
        </div>

        {selectedCanteen === "all" ? (
          <Card><CardContent className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><CircleAlert className="h-4 w-4" /> Upar sidebar se ek site select karein.</CardContent></Card>
        ) : (
          <Tabs defaultValue="allocation" className="space-y-4">
            <TabsList className="grid h-auto w-full grid-cols-3">
              <TabsTrigger value="nutrition" className="text-xs sm:text-sm">Nutrition Master</TabsTrigger>
              <TabsTrigger value="allocation" className="text-xs sm:text-sm">Cost Allocation</TabsTrigger>
              <TabsTrigger value="comparison" className="text-xs sm:text-sm">Menu Comparison</TabsTrigger>
            </TabsList>

            {analysis.isError && (
              <Card className="border-destructive/40"><CardContent className="flex items-center gap-2 p-4 text-sm text-destructive"><CircleAlert className="h-4 w-4" />{analysis.error instanceof Error ? analysis.error.message : "Meal profit data load nahi hua."}</CardContent></Card>
            )}

            <TabsContent value="nutrition" className="space-y-3">
              <div className="relative max-w-md"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Ingredient search…" className="pl-9" /></div>
              <Card className="overflow-hidden"><div className="overflow-x-auto">
                <Table className="min-w-[56rem]"><TableHeader><TableRow>
                  <TableHead>Ingredient</TableHead><TableHead>Basis</TableHead><TableHead className="text-right">kcal</TableHead>
                  <TableHead className="text-right">Protein</TableHead><TableHead className="text-right">Carbs</TableHead>
                  <TableHead className="text-right">Fat</TableHead><TableHead className="text-right">Fibre</TableHead><TableHead>Source</TableHead><TableHead />
                </TableRow></TableHeader><TableBody>
                  {ingredientsLoading ? <TableRow><TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">Loading…</TableCell></TableRow> :
                    visibleIngredients.map((item) => <TableRow key={item.id}>
                      <TableCell className="font-medium">{item.name}<span className="ml-2 text-xs text-muted-foreground">({item.unit})</span></TableCell>
                      <TableCell>{item.nutrition_basis_qty || 100} {item.nutrition_basis_unit || "g"}</TableCell>
                      {[item.energy_kcal, item.protein_g, item.carbohydrate_g, item.fat_g, item.fibre_g].map((value, index) => <TableCell key={index} className="text-right">{value == null ? "—" : number(value)}</TableCell>)}
                      <TableCell className="max-w-48 truncate text-xs text-muted-foreground">{item.nutrition_source || "—"}</TableCell>
                      <TableCell><Button size="sm" variant="ghost" aria-label={`${item.name} nutrition edit karein`} onClick={() => beginEdit(item)}><Pencil className="h-4 w-4" /></Button></TableCell>
                    </TableRow>)}
                </TableBody></Table>
              </div></Card>
            </TabsContent>

            <TabsContent value="allocation" className="space-y-3">
              <SummaryCards summary={analysis.data?.summary} />
              {analysis.isLoading ? <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Cost allocation load ho raha hai…</CardContent></Card> :
                !menus.length ? <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Selected dates me published menu nahi hai.</CardContent></Card> :
                menus.map((menu) => {
                  const open = expanded === menu.menu_plan_id;
                  return <Card key={menu.menu_plan_id} className="overflow-hidden">
                    <button type="button" onClick={() => setExpanded(open ? null : menu.menu_plan_id)} className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/40">
                      <div className="min-w-0 flex-1"><p className="font-semibold">{menu.menu_date} · {mealLabel[menu.meal_period] || menu.meal_period}</p><p className="text-xs text-muted-foreground">{number(menu.diner_count, 0)} diners · {menu.provisional ? "expected count" : "actual unique count"}</p></div>
                      <div className="hidden gap-5 text-right sm:flex"><Metric label="ACTUAL COST" value={money(menu.actual_food_cost)} /><Metric label="PER PERSON" value={money(menu.cost_per_person)} /><Metric label="ALLOCATED" value={`${number(menu.allocation_pct)}%`} /></div>
                      <Badge variant={Number(menu.allocation_pct) >= 99.9 ? "default" : "outline"}>{Number(menu.allocation_pct) >= 99.9 ? "Complete" : "Recipe pending"}</Badge>
                      <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
                    </button>
                    {open && <div className="overflow-x-auto border-t"><DishTable dishes={menu.dishes || []} provisional={menu.provisional} /></div>}
                  </Card>;
                })}
            </TabsContent>

            <TabsContent value="comparison" className="space-y-4">
              <Card><CardContent className="grid gap-3 p-4 md:grid-cols-2">
                <MenuSelect label="Menu A" menus={menus} value={menuA || menus[0]?.menu_plan_id || ""} onChange={setMenuA} />
                <MenuSelect label="Menu B" menus={menus} value={menuB || menus[1]?.menu_plan_id || ""} onChange={setMenuB} />
              </CardContent></Card>
              {selectedA && selectedB ? <Comparison a={selectedA} b={selectedB} /> : <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Comparison ke liye date range me kam se kam do menus chahiye.</CardContent></Card>}
            </TabsContent>
          </Tabs>
        )}
      </div>

      <Dialog open={!!edit} onOpenChange={(open) => !open && setEdit(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{edit?.name} nutrition</DialogTitle></DialogHeader>
          {edit && <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Basis quantity" value={edit.basisQty} onChange={(basisQty) => setEdit({ ...edit, basisQty })} />
            <div className="space-y-1"><Label>Basis unit</Label><Select value={edit.basisUnit} onValueChange={(basisUnit) => setEdit({ ...edit, basisUnit })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="g">gram (g)</SelectItem><SelectItem value="ml">millilitre (ml)</SelectItem><SelectItem value="pc">piece (pc)</SelectItem></SelectContent></Select></div>
            <Field label="Energy (kcal)" value={edit.energy} onChange={(energy) => setEdit({ ...edit, energy })} />
            <Field label="Protein (g)" value={edit.protein} onChange={(protein) => setEdit({ ...edit, protein })} />
            <Field label="Carbohydrate (g)" value={edit.carbs} onChange={(carbs) => setEdit({ ...edit, carbs })} />
            <Field label="Fat (g)" value={edit.fat} onChange={(fat) => setEdit({ ...edit, fat })} />
            <Field label="Fibre (g)" value={edit.fibre} onChange={(fibre) => setEdit({ ...edit, fibre })} />
            <div className="space-y-1 sm:col-span-2"><Label>Source / note</Label><Input value={edit.source} onChange={(event) => setEdit({ ...edit, source: event.target.value })} placeholder="Lab report, supplier label, IFCT…" /></div>
          </div>}
          <DialogFooter><Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button disabled={!edit || saveNutrition.isPending} onClick={() => edit && saveNutrition.mutate(edit)}>{saveNutrition.isPending ? "Saving…" : "Save nutrition"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}

function SummaryCards({ summary = {} }: { summary?: ProfitSummary }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
    <Summary label="Meal revenue" value={money(summary.revenue)} />
    <Summary label="Actual FIFO food cost" value={money(summary.actual_food_cost)} />
    <Summary label="Dish allocated" value={money(summary.dish_allocated_cost)} />
    <Summary label="Unallocated / recipe missing" value={money(summary.unallocated_cost)} warning={Math.abs(Number(summary.unallocated_cost || 0)) > 0.01} />
  </div>;
}

function Summary({ label, value, warning }: { label: string; value: string; warning?: boolean }) {
  return <Card className={warning ? "border-warning/50" : ""}><CardContent className="p-4"><p className="text-xs text-muted-foreground">{label}</p><p className={`text-xl font-bold ${warning ? "text-warning" : ""}`}>{value}</p></CardContent></Card>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[10px] text-muted-foreground">{label}</p><p className="text-sm font-semibold">{value}</p></div>;
}

function DishTable({ dishes, provisional }: { dishes: DishAnalysis[]; provisional: boolean }) {
  return <Table className="min-w-[62rem]"><TableHeader><TableRow>
    <TableHead>Dish</TableHead><TableHead>Recipe</TableHead><TableHead className="text-right">Allocated cost</TableHead><TableHead className="text-right">Cost/person</TableHead>
    <TableHead className="text-right">kcal/person</TableHead><TableHead className="text-right">Protein</TableHead><TableHead className="text-right">Carbs</TableHead><TableHead className="text-right">Fat</TableHead><TableHead className="text-right">Waste</TableHead>
  </TableRow></TableHeader><TableBody>
    {dishes.map((dish) => <Fragment key={dish.menu_plan_item_id}><TableRow>
      <TableCell className="font-medium">{dish.dish_name}{provisional && <Badge variant="outline" className="ml-2 text-[9px]">PROVISIONAL</Badge>}</TableCell>
      <TableCell>{dish.recipe_id ? `${number(dish.yield_qty, 0)} ${dish.yield_unit}` : <span className="text-warning">Recipe missing</span>}</TableCell>
      <TableCell className="text-right">{money(dish.allocated_cost)}</TableCell><TableCell className="text-right font-semibold">{money(dish.cost_per_person)}</TableCell>
      <TableCell className="text-right">{number(dish.kcal_per_person)} kcal</TableCell><TableCell className="text-right">{number(dish.protein_g_per_person)} g</TableCell>
      <TableCell className="text-right">{number(dish.carbohydrate_g_per_person)} g</TableCell><TableCell className="text-right">{number(dish.fat_g_per_person)} g</TableCell>
      <TableCell className="text-right">{number(dish.wastage_qty)} {dish.production_unit || "kg"}</TableCell>
    </TableRow>
      {(dish.ingredients || []).length > 0 && <TableRow className="bg-muted/25"><TableCell colSpan={9} className="py-2 text-xs text-muted-foreground"><Scale className="mr-1 inline h-3.5 w-3.5" />{dish.ingredients?.map((item) => `${item.ingredient}: ${number(item.qty, 3)} ${item.unit} = ${money(item.cost)}`).join(" · ")}</TableCell></TableRow>}
    </Fragment>)}
  </TableBody></Table>;
}

function MenuSelect({ label, menus, value, onChange }: { label: string; menus: MenuAnalysis[]; value: string; onChange: (value: string) => void }) {
  return <div className="space-y-1"><Label>{label}</Label><Select value={value} onValueChange={onChange}><SelectTrigger><SelectValue placeholder="Menu select karein" /></SelectTrigger><SelectContent>{menus.map((menu) => <SelectItem key={menu.menu_plan_id} value={menu.menu_plan_id}>{menu.menu_date} · {mealLabel[menu.meal_period] || menu.meal_period}</SelectItem>)}</SelectContent></Select></div>;
}

function Comparison({ a, b }: { a: MenuAnalysis; b: MenuAnalysis }) {
  const rows = [
    ["Unique diners", number(a.diner_count, 0), number(b.diner_count, 0)],
    ["Sale", money(a.revenue), money(b.revenue)],
    ["Actual food cost", money(a.actual_food_cost), money(b.actual_food_cost)],
    ["Cost per person", money(a.cost_per_person), money(b.cost_per_person)],
    ["Margin per person", money(a.margin_per_person), money(b.margin_per_person)],
    ["Energy per person", `${number(a.kcal_per_person)} kcal`, `${number(b.kcal_per_person)} kcal`],
    ["Protein per person", `${number(a.protein_g_per_person)} g`, `${number(b.protein_g_per_person)} g`],
    ["Carbs per person", `${number(a.carbohydrate_g_per_person)} g`, `${number(b.carbohydrate_g_per_person)} g`],
    ["Fat per person", `${number(a.fat_g_per_person)} g`, `${number(b.fat_g_per_person)} g`],
    ["Fibre per person", `${number(a.fibre_g_per_person)} g`, `${number(b.fibre_g_per_person)} g`],
    ["Dish allocation complete", `${number(a.allocation_pct)}%`, `${number(b.allocation_pct)}%`],
  ];
  return <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
    <Card><CardHeader><CardTitle className="text-sm">Meal totals</CardTitle></CardHeader><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead>Metric</TableHead><TableHead className="text-right">Menu A</TableHead><TableHead className="text-right">Menu B</TableHead></TableRow></TableHeader><TableBody>{rows.map(([label, av, bv]) => <TableRow key={label}><TableCell>{label}</TableCell><TableCell className="text-right font-medium">{av}</TableCell><TableCell className="text-right font-medium">{bv}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card>
    <Card><CardHeader><CardTitle className="text-sm">Dish nutrition and cost per person</CardTitle></CardHeader><CardContent className="space-y-3">{([['Menu A', a], ['Menu B', b]] as Array<[string, MenuAnalysis]>).map(([label, menu]) => <div key={label} className="rounded-lg border p-3"><p className="mb-2 text-xs font-bold text-muted-foreground">{label} · {menu.menu_date} · {mealLabel[menu.meal_period] || menu.meal_period}</p>{menu.dishes.map((dish) => <div key={dish.menu_plan_item_id} className="grid grid-cols-[1fr_auto] gap-2 border-t py-2 first:border-0"><span className="text-sm font-medium">{dish.dish_name}</span><span className="text-right text-xs">{money(dish.cost_per_person)} · {number(dish.kcal_per_person)} kcal · {number(dish.protein_g_per_person)}g protein</span></div>)}</div>)}</CardContent></Card>
  </div>;
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <div className="space-y-1"><Label>{label}</Label><Input type="number" min="0" step="any" value={value} onChange={(event) => onChange(event.target.value)} /></div>;
}
