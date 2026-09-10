import { useMemo, useState, type ReactNode } from "react";
import { useDayKitchenPlan, useSaveDishRecipe, MEAL_PERIODS } from "@/hooks/useSrsData";
import { useIngredients } from "@/hooks/useSupabaseData";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Check, ChefHat, ChevronsUpDown, Pencil, Plus, Trash2, Undo2, Users, Utensils, Zap } from "lucide-react";
import { toast } from "sonner";

// The chef's day, in the order the kitchen actually works through it:
// breakfast first, then lunch, then the evening. Each dish carries the
// manager's quantity and the people it is being cooked for, and underneath
// it the ingredients that go into it — so the order can be built by reading
// down the screen instead of from memory.
//
// A dish the kitchen has not described yet shows "what does this take?".
// Answering once teaches it for good: the same dish on next week's menu
// arrives with its ingredients already attached.

const UNITS = ["kg", "litre", "pcs", "packet"];

interface Props {
  canteenId: string;
  date: string;
  /** Add a quantity onto the order being built on the page. */
  onAdd?: (ingredientId: string, qty: number, meal?: any) => void;
  /** Open the order already linked to this exact published meal. */
  onOrderMeal?: (meal: any) => void;
  /** Raise a short, additional request against this exact meal. */
  onExtraMeal?: (meal: any) => void;
  /** Render the return action for stock already issued against this meal. */
  renderMealReturn?: (meal: any) => ReactNode;
}

export default function KitchenPlan({ canteenId, date, onAdd, onOrderMeal, onExtraMeal, renderMealReturn }: Props) {
  const { data: meals, isLoading } = useDayKitchenPlan(canteenId, date);
  const { data: ingredients } = useIngredients(canteenId);
  const saveRecipe = useSaveDishRecipe();

  const [editing, setEditing] = useState<any>(null);   // the dish being described
  const [lines, setLines] = useState<any[]>([]);
  const [makes, setMakes] = useState("100");

  const labelOf = (p: string) =>
    MEAL_PERIODS.find((m) => m.value === p)?.label || p.replace(/_/g, " ");

  const sorted = useMemo(() => (ingredients || []).slice()
    .sort((a: any, b: any) => a.name.localeCompare(b.name)), [ingredients]);
  const availableUnits = useMemo(() => Array.from(new Set([
    ...UNITS,
    ...(ingredients || []).map((i: any) => String(i.unit || "").trim()).filter(Boolean),
  ])), [ingredients]);

  const describe = (dish: any, meal: any) => {
    setEditing(dish);
    setLines((dish.ingredients || []).length > 0
      ? dish.ingredients.map((i: any) => ({
          ingredient_id: i.ingredient_id,
          quantity: String(i.qty),
          unit: i.unit || "kg",
        }))
      : [{ ingredient_id: "", quantity: "", unit: "kg" }]);
    setMakes(String(Number(meal?.headcount) > 0 ? meal.headcount : 100));
  };

  const save = async () => {
    const items = lines
      .filter((l) => l.ingredient_id && Number(l.quantity) > 0)
      .map((l) => ({ ingredient_id: l.ingredient_id, quantity: Number(l.quantity), unit: l.unit }));
    if (items.length === 0) { toast.error("Kam se kam ek saman aur uski quantity bharo"); return; }
    if (new Set(items.map((i) => i.ingredient_id)).size !== items.length) {
      toast.error("Ek hi saman do baar chuna hai. Quantity ek hi line me jodo."); return;
    }
    if (!(Number(makes) > 0)) { toast.error("Kitne logon ka khana hai, woh bharo"); return; }
    try {
      const res = await saveRecipe.mutateAsync({
        canteen_id: canteenId,
        dish_name: editing.dish_name,
        items,
        yield_qty: Number(makes),
        yield_unit: "plate",
      });
      const linked = Number(res?.menu_lines_linked || 0);
      toast.success(`${editing.dish_name} ki recipe save ho gayi` +
        (linked > 1 ? ` — ${linked} menu me lag gayi` : ""));
      setEditing(null);
    } catch (e: any) { toast.error(e.message); }
  };

  const addMeal = (meal: any) => {
    if (!onAdd) return;
    let n = 0;
    for (const d of meal.dishes) {
      for (const ing of d.ingredients || []) {
        if (Number(ing.qty) > 0) { onAdd(ing.ingredient_id, Number(ing.qty), meal); n++; }
      }
    }
    if (n === 0) toast.error("Pehle dish ke niche uska saman set karo");
    else toast.success(`${n} saman order me add ho gaye`);
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading the day…</p>;
  if (!meals || meals.length === 0) {
    return (
      <Card className="border-none shadow-sm">
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          No menu published for this day yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {meals.map((meal: any) => {
        const known = meal.dishes.filter((d: any) => (d.ingredients || []).length > 0).length;
        const returnAction = renderMealReturn?.(meal);
        return (
          <Card key={meal.meal_period} className="border-none shadow-sm">
            <CardContent className="p-3 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <Utensils className="w-4 h-4 text-accent" />
                  <p className="text-sm font-bold">{labelOf(meal.meal_period)}</p>
                  <Badge variant="secondary" className="text-[10px]">
                    <Users className="w-3 h-3 mr-1" />{meal.headcount} people
                  </Badge>
                </div>
                {onAdd && known > 0 && (
                  <Button size="sm" variant="secondary" className="h-7 text-xs"
                          onClick={() => addMeal(meal)}>
                    <Plus className="w-3.5 h-3.5 mr-1" /> Add all to order
                  </Button>
                )}
              </div>

              {meal.dishes.map((d: any) => (
                <div key={d.item_id} className="rounded-md border p-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-semibold">{d.dish_name}</p>
                    {d.planned_qty != null && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        make {d.planned_qty} {d.unit || ""}
                      </span>
                    )}
                  </div>

                  {(d.ingredients || []).length === 0 ? (
                    <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                      <p className="text-[11px] text-muted-foreground">
                        Is dish ka saman abhi save nahi hai.
                      </p>
                      <Button size="sm" variant="outline" className="h-8 text-xs font-semibold"
                              onClick={() => describe(d, meal)}>
                        <ChefHat className="w-3.5 h-3.5 mr-1" /> Is dish ka saman set karo
                      </Button>
                    </div>
                  ) : (
                    <table className="w-full mt-1.5 text-xs">
                      <tbody>
                        {d.ingredients.map((ing: any) => {
                          const short = Number(ing.in_stock) < Number(ing.qty);
                          return (
                            <tr key={ing.ingredient_id} className="border-t first:border-0">
                              <td className="py-1">{ing.name}</td>
                              <td className="py-1 text-right font-medium whitespace-nowrap">
                                {ing.qty} {ing.unit}
                              </td>
                              <td className="py-1 pl-2 text-right whitespace-nowrap">
                                {short ? (
                                  <span className="text-destructive">only {ing.in_stock} left</span>
                                ) : (
                                  <span className="text-muted-foreground">{ing.in_stock} in store</span>
                                )}
                              </td>
                              {onAdd && (
                                <td className="py-1 pl-2 text-right">
                                  <button
                                    className="text-accent hover:underline"
                                    onClick={() => {
                                      onAdd(ing.ingredient_id, Number(ing.qty), meal);
                                      toast.success(`${ing.name} added`);
                                    }}
                                  >
                                    add
                                  </button>
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                  {(d.ingredients || []).length > 0 && (
                    <Button size="sm" variant="ghost" className="h-7 mt-1 px-2 text-[11px] text-muted-foreground"
                            onClick={() => describe(d, meal)}>
                      <Pencil className="w-3 h-3 mr-1" /> Recipe badlo
                    </Button>
                  )}
                </div>
              ))}

              {(onOrderMeal || onExtraMeal || renderMealReturn) && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {onOrderMeal && (
                    <Button className="h-11 w-full text-sm" onClick={() => onOrderMeal(meal)}>
                      <Plus className="mr-2 h-4 w-4" /> Is menu ka saman mangao
                    </Button>
                  )}
                  {onExtraMeal && (
                    <Button variant="outline" className="h-11 w-full border-warning/50 text-sm text-warning"
                            onClick={() => onExtraMeal(meal)}>
                      <Zap className="mr-2 h-4 w-4" /> Extra saman mangao
                    </Button>
                  )}
                  {returnAction || (renderMealReturn && (
                    <Button variant="outline" className="h-11 w-full text-sm" disabled>
                      <Undo2 className="mr-2 h-4 w-4" /> Bacha saman wapas bhejo
                    </Button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      {/* Describing a dish once, for every time it appears again */}
      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent className="w-[calc(100vw-1rem)] sm:max-w-lg max-h-[92vh] overflow-y-auto p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle>{editing?.dish_name} ka saman</DialogTitle>
          </DialogHeader>
          <div className="rounded-xl border border-accent/25 bg-accent/5 p-3 space-y-1">
            <p className="text-sm font-semibold">Bas aaj jitna lagega, utna bharo</p>
            <p className="text-xs text-muted-foreground">Ek baar save karne ke baad agli baar app logon ke hisaab se quantity khud nikalega.</p>
          </div>

          <div className="space-y-1.5">
              <Label className="text-sm font-semibold">Kitne logon ke liye?</Label>
              <div className="relative max-w-48">
                <Input type="number" min={1} inputMode="numeric" className="h-11 pr-14 text-base font-semibold" value={makes}
                     onChange={(e) => setMakes(e.target.value)} />
                <span className="absolute right-3 top-3 text-sm text-muted-foreground">log</span>
              </div>
          </div>

          <div className="space-y-2">
            <div>
              <p className="text-sm font-semibold">Kaunsa saman kitna lagega?</p>
              <p className="text-[11px] text-muted-foreground">Naam chuno, quantity bharo.</p>
            </div>
            {lines.map((l, idx) => (
              <div key={idx} className="rounded-xl border p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs font-semibold">Saman {idx + 1}</Label>
                  {lines.length > 1 ? <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive"
                        onClick={() => setLines((p) => p.filter((_, i) => i !== idx))}>
                    <Trash2 className="w-3.5 h-3.5 mr-1" /> Hatao
                  </Button> : null}
                </div>
                <IngredientPicker value={l.ingredient_id} ingredients={sorted}
                  onChange={(v) => {
                    const item = sorted.find((i: any) => i.id === v);
                    setLines((p) => p.map((x, i) => i === idx
                      ? { ...x, ingredient_id: v, unit: item?.unit || x.unit }
                      : x));
                  }} />
                <div className="grid grid-cols-[1fr_110px] gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Kitna?</Label>
                    <Input type="number" inputMode="decimal" min={0} step="any" placeholder="0" className="h-11 text-base" value={l.quantity}
                         onChange={(e) => setLines((p) =>
                           p.map((x, i) => i === idx ? { ...x, quantity: e.target.value } : x))} />
                    {Number(l.quantity) > 0 && Number(makes) > 0 ? <p className="text-[10px] text-muted-foreground">
                      {perPerson(Number(l.quantity), l.unit, Number(makes))}
                    </p> : null}
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Unit</Label>
                    <Select value={l.unit} onValueChange={(v) => setLines((p) =>
                      p.map((x, i) => i === idx ? { ...x, unit: v } : x))}>
                      <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                      <SelectContent>{availableUnits.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            ))}
            <Button variant="outline" className="w-full h-11 text-sm border-dashed"
                    onClick={() => setLines((p) => [...p, { ingredient_id: "", quantity: "", unit: "kg" }])}>
              <Plus className="w-4 h-4 mr-1" /> Aur saman jodo
            </Button>
          </div>

          <DialogFooter className="sticky -bottom-4 sm:-bottom-6 bg-background pt-3 border-t flex-row gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setEditing(null)}>Band karo</Button>
            <Button className="flex-[2]" onClick={save} disabled={saveRecipe.isPending}>
              {saveRecipe.isPending ? "Save ho raha hai…" : "Recipe save karo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function perPerson(quantity: number, unit: string, people: number) {
  const each = quantity / people;
  const normalized = String(unit || "").toLowerCase();
  if (normalized === "kg") return `Lagbhag ${(each * 1000).toLocaleString("en-IN", { maximumFractionDigits: 1 })} gram per person`;
  if (normalized === "litre" || normalized === "liter") return `Lagbhag ${(each * 1000).toLocaleString("en-IN", { maximumFractionDigits: 1 })} ml per person`;
  return `Lagbhag ${each.toLocaleString("en-IN", { maximumFractionDigits: 3 })} ${unit} per person`;
}

function IngredientPicker({ value, ingredients, onChange }: {
  value: string; ingredients: any[]; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = ingredients.find((i: any) => i.id === value);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" role="combobox" aria-expanded={open}
        className="w-full h-11 justify-between text-left font-normal">
        <span className={selected ? "truncate" : "truncate text-muted-foreground"}>
          {selected?.name || "Saman search karke chuno"}
        </span>
        <ChevronsUpDown className="w-4 h-4 ml-2 opacity-50 shrink-0" />
      </Button>
    </PopoverTrigger>
    <PopoverContent className="w-[min(420px,calc(100vw-2rem))] p-0" align="start">
      <Command>
        <CommandInput placeholder="Naam likho…" />
        <CommandList className="max-h-64">
          <CommandEmpty>Saman nahi mila.</CommandEmpty>
          <CommandGroup>
            {ingredients.map((i: any) => <CommandItem key={i.id} value={i.name}
              onSelect={() => { onChange(i.id); setOpen(false); }}>
              <Check className={`w-4 h-4 mr-2 ${value === i.id ? "opacity-100" : "opacity-0"}`} />
              <span className="truncate">{i.name}</span>
              <span className="ml-auto text-[10px] text-muted-foreground">{i.current_stock} {i.unit}</span>
            </CommandItem>)}
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>;
}
