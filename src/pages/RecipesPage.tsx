import { useMemo, useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useIngredients, useRecipes } from "@/hooks/useSupabaseData";
import { useSaveDishRecipe } from "@/hooks/useSrsData";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Check, ChefHat, ChevronsUpDown, Pencil, Plus, Search, Trash2, Users } from "lucide-react";
import { toast } from "sonner";

const BASE_UNITS = ["kg", "litre", "packet", "pcs", "box"];
type RecipeLine = { ingredient_id: string; quantity: string; unit: string };
type Ingredient = { id: string; name: string; unit: string | null };
type SavedRecipeLine = {
  id: string; ingredient_id: string | null; quantity: number | string; unit: string;
  ingredients?: { name: string; unit: string | null } | null;
};
type SavedRecipe = {
  id: string; name: string; yield_qty: number | string | null;
  recipe_ingredients?: SavedRecipeLine[] | null;
};
const emptyLine = (): RecipeLine => ({ ingredient_id: "", quantity: "", unit: "kg" });

export default function RecipesPage() {
  const { selectedCanteen } = useAppContext();
  const { data: recipes, isLoading, isError, isFetching, refetch } = useRecipes(selectedCanteen);
  const { data: ingredients } = useIngredients(selectedCanteen);
  const saveRecipe = useSaveDishRecipe();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SavedRecipe | null>(null);
  const [dishName, setDishName] = useState("");
  const [people, setPeople] = useState("100");
  const [lines, setLines] = useState<RecipeLine[]>([emptyLine()]);

  const sortedIngredients = useMemo(() => ((ingredients || []) as Ingredient[]).slice()
    .sort((a, b) => a.name.localeCompare(b.name)), [ingredients]);
  const units = useMemo(() => Array.from(new Set([
    ...BASE_UNITS,
    ...sortedIngredients.map((i) => String(i.unit || "").trim()).filter(Boolean),
  ])), [sortedIngredients]);
  const visibleRecipes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ((recipes || []) as SavedRecipe[]).filter((r) => !q || r.name.toLowerCase().includes(q));
  }, [recipes, search]);

  const startNew = () => {
    setEditing(null); setDishName(""); setPeople("100"); setLines([emptyLine()]); setOpen(true);
  };

  const startEdit = (recipe: SavedRecipe) => {
    setEditing(recipe);
    setDishName(recipe.name || "");
    setPeople(String(Number(recipe.yield_qty) > 0 ? recipe.yield_qty : 100));
    setLines(recipe.recipe_ingredients?.some((r) => r.ingredient_id)
      ? recipe.recipe_ingredients.filter((r) => r.ingredient_id).map((r) => ({
          ingredient_id: r.ingredient_id, quantity: String(r.quantity || ""),
          unit: r.unit || r.ingredients?.unit || "kg",
        }))
      : [emptyLine()]);
    setOpen(true);
  };

  const updateLine = (index: number, update: Partial<RecipeLine>) =>
    setLines((current) => current.map((line, i) => i === index ? { ...line, ...update } : line));

  const save = async () => {
    const name = dishName.trim();
    const count = Number(people);
    const clean = lines.filter((line) => line.ingredient_id && Number(line.quantity) > 0);
    if (selectedCanteen === "all") { toast.error("Pehle site select karein"); return; }
    if (!name) { toast.error("Dish ka naam bharo"); return; }
    if (!(count > 0)) { toast.error("Recipe kitne logon ke liye hai, woh bharo"); return; }
    if (clean.length === 0) { toast.error("Kam se kam ek saman aur quantity bharo"); return; }
    if (new Set(clean.map((line) => line.ingredient_id)).size !== clean.length) {
      toast.error("Ek saman do baar hai—quantity ek hi line me jodo"); return;
    }
    try {
      const result = await saveRecipe.mutateAsync({
        canteen_id: selectedCanteen, dish_name: name, yield_qty: count, yield_unit: "plate",
        items: clean.map((line) => ({
          ingredient_id: line.ingredient_id, quantity: Number(line.quantity), unit: line.unit,
        })),
      });
      const linked = Number(result?.menu_lines_linked || 0);
      toast.success(`${name} ki recipe save ho gayi${linked ? `—${linked} menu me link hui` : ""}`);
      setOpen(false);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Recipe save nahi hui");
    }
  };

  return (
    <AppLayout title="Recipes">
      <div className="mx-auto max-w-5xl space-y-4 animate-fade-in">
        <Card className="border-accent/25 bg-accent/5 shadow-sm">
          <CardContent className="p-4 sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <ChefHat className="h-5 w-5 text-accent" /><h2 className="text-lg font-bold">Chef Recipe Book</h2>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Ek baar recipe save karo. Agli baar app headcount ke hisaab se saman khud calculate karega.
                </p>
              </div>
              <Button className="h-11 shrink-0" onClick={startNew}>
                <Plus className="mr-2 h-4 w-4" /> Nayi recipe dalo
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-sm">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Recipe search karo…" className="h-10 pl-9" />
          </div>
          {!isLoading && !isError && <p className="text-xs text-muted-foreground">{visibleRecipes.length} recipes</p>}
        </div>

        {isLoading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Recipes loading…</p>
        ) : isError ? (
          <Card className="border-destructive/30 shadow-none"><CardContent className="p-6 text-center" role="alert">
            <p className="font-medium">Recipes load nahi ho paayi</p>
            <p className="mt-1 text-sm text-muted-foreground">Iska matlab recipes delete hona nahi hai. Dobara load karein; recipe phir se mat bharein.</p>
            <Button className="mt-4" variant="outline" disabled={isFetching} onClick={() => void refetch()}>
              {isFetching ? "Load ho rahi hain…" : "Dobara load karo"}
            </Button>
          </CardContent></Card>
        ) : visibleRecipes.length === 0 ? (
          <Card className="border-dashed shadow-none"><CardContent className="p-10 text-center">
            <ChefHat className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
            <p className="font-medium">Abhi koi recipe nahi mili</p>
            <p className="mt-1 text-sm text-muted-foreground">{search.trim() ? "Is naam se recipe nahi mili. Search badal kar dekhein." : "Pehli recipe add karke ordering ko simple banao."}</p>
            <Button className="mt-4" onClick={startNew}><Plus className="mr-1 h-4 w-4" /> Recipe dalo</Button>
          </CardContent></Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {visibleRecipes.map((recipe) => (
              <Card key={recipe.id} className="shadow-sm">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate font-bold">{recipe.name}</h3>
                      <Badge variant="secondary" className="mt-1 text-[10px]">
                        <Users className="mr-1 h-3 w-3" /> Recipe for {Number(recipe.yield_qty || 0)} people
                      </Badge>
                    </div>
                    <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={() => startEdit(recipe)}>
                      <Pencil className="mr-1 h-3.5 w-3.5" /> Badlo
                    </Button>
                  </div>
                  <div className="mt-3 space-y-1.5 border-t pt-3">
                    {(recipe.recipe_ingredients || []).filter((r) => r.ingredient_id).length === 0 ? (
                      <p className="text-xs text-destructive">Is recipe me saman abhi set nahi hai.</p>
                    ) : (recipe.recipe_ingredients || []).filter((r) => r.ingredient_id).map((line) => (
                      <div key={line.id} className="flex items-center justify-between gap-3 text-sm">
                        <span className="truncate">{line.ingredients?.name || "Unknown item"}</span>
                        <b className="shrink-0">{Number(line.quantity)} {line.unit}</b>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[calc(100vw-1rem)] max-w-xl max-h-[92vh] overflow-y-auto p-4 sm:p-6">
          <DialogHeader><DialogTitle>{editing ? `${editing.name} ki recipe badlo` : "Nayi recipe dalo"}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="font-semibold">Dish ka naam</Label>
              <Input value={dishName} onChange={(e) => setDishName(e.target.value)} disabled={!!editing}
                placeholder="Jaise: Dal Tadka" className="h-11" />
              {editing && <p className="text-[11px] text-muted-foreground">Naam same rahega; niche saman aur quantity badal sakte hain.</p>}
            </div>

            <div className="rounded-xl border border-accent/25 bg-accent/5 p-3">
              <Label className="font-semibold">Ye quantity kitne logon ke liye hai?</Label>
              <div className="relative mt-2 max-w-52">
                <Input type="number" min={1} inputMode="numeric" value={people}
                  onChange={(e) => setPeople(e.target.value)} className="h-11 pr-14 text-base font-bold" />
                <span className="absolute right-3 top-3 text-sm text-muted-foreground">log</span>
              </div>
            </div>

            <div className="space-y-2">
              <div><p className="font-semibold">Kaunsa saman kitna lagega?</p>
                <p className="text-xs text-muted-foreground">Inventory ka item search karo aur total quantity bharo.</p>
              </div>
              {lines.map((line, index) => (
                <div key={index} className="space-y-2 rounded-xl border p-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold">Saman {index + 1}</Label>
                    {lines.length > 1 && <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive"
                      onClick={() => setLines((current) => current.filter((_, i) => i !== index))}>
                      <Trash2 className="mr-1 h-3.5 w-3.5" /> Hatao
                    </Button>}
                  </div>
                  <IngredientPicker value={line.ingredient_id} ingredients={sortedIngredients}
                    onChange={(id) => {
                      const item = sortedIngredients.find((i) => i.id === id);
                      updateLine(index, { ingredient_id: id, unit: item?.unit || line.unit });
                    }} />
                  <div className="grid grid-cols-[1fr_112px] gap-2">
                    <div className="space-y-1"><Label className="text-xs">Total quantity</Label>
                      <Input type="number" min={0} step="any" inputMode="decimal" value={line.quantity}
                        onChange={(e) => updateLine(index, { quantity: e.target.value })} className="h-11" placeholder="0" />
                    </div>
                    <div className="space-y-1"><Label className="text-xs">Unit</Label>
                      <Select value={line.unit} onValueChange={(unit) => updateLine(index, { unit })}>
                        <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                        <SelectContent>{units.map((unit) => <SelectItem key={unit} value={unit}>{unit}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  </div>
                  {Number(line.quantity) > 0 && Number(people) > 0 && (
                    <p className="text-[11px] text-muted-foreground">{perPerson(Number(line.quantity), line.unit, Number(people))}</p>
                  )}
                </div>
              ))}
              <Button variant="outline" className="h-11 w-full border-dashed"
                onClick={() => setLines((current) => [...current, emptyLine()])}>
                <Plus className="mr-1 h-4 w-4" /> Aur saman jodo
              </Button>
            </div>
          </div>
          <DialogFooter className="sticky -bottom-4 mt-4 flex-row gap-2 border-t bg-background pt-3 sm:-bottom-6">
            <Button variant="outline" className="flex-1" onClick={() => setOpen(false)}>Band karo</Button>
            <Button className="flex-[2]" disabled={saveRecipe.isPending} onClick={save}>
              {saveRecipe.isPending ? "Save ho raha hai…" : "Recipe save karo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}

function perPerson(quantity: number, unit: string, people: number) {
  const each = quantity / people;
  const normalized = String(unit).toLowerCase();
  if (normalized === "kg") return `Lagbhag ${(each * 1000).toLocaleString("en-IN", { maximumFractionDigits: 1 })} gram per person`;
  if (["litre", "liter"].includes(normalized)) return `Lagbhag ${(each * 1000).toLocaleString("en-IN", { maximumFractionDigits: 1 })} ml per person`;
  return `Lagbhag ${each.toLocaleString("en-IN", { maximumFractionDigits: 3 })} ${unit} per person`;
}

function IngredientPicker({ value, ingredients, onChange }: {
  value: string; ingredients: Ingredient[]; onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = ingredients.find((item) => item.id === value);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" role="combobox" aria-expanded={open}
        className="h-11 w-full justify-between font-normal">
        <span className={selected ? "truncate" : "truncate text-muted-foreground"}>
          {selected?.name || "Saman search karke chuno"}
        </span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </Button>
    </PopoverTrigger>
    <PopoverContent className="w-[min(440px,calc(100vw-2rem))] p-0" align="start">
      <Command><CommandInput placeholder="Item ka naam likho…" />
        <CommandList className="max-h-64"><CommandEmpty>Inventory me item nahi mila.</CommandEmpty>
          <CommandGroup>{ingredients.map((item) => (
            <CommandItem key={item.id} value={item.name} onSelect={() => { onChange(item.id); setOpen(false); }}>
              <Check className={`mr-2 h-4 w-4 ${value === item.id ? "opacity-100" : "opacity-0"}`} />
              <span className="truncate">{item.name}</span>
              <span className="ml-auto pl-2 text-xs text-muted-foreground">{item.unit}</span>
            </CommandItem>
          ))}</CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>;
}
