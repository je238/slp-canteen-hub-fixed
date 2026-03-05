import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useRecipes, useAddRecipe, useIngredients } from "@/hooks/useSupabaseData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Plus, ChefHat, Trash2, Beaker } from "lucide-react";
import { toast } from "sonner";

const recipeCategories = ["Main", "Starter", "Dessert", "Beverage", "Side", "Bread", "Curry"];

interface RecipeIngredientForm {
  type: "ingredient" | "sub_recipe";
  ingredient_id?: string;
  sub_recipe_id?: string;
  quantity: number;
  unit: string;
}

export default function RecipesPage() {
  const { selectedCanteen } = useAppContext();
  const { data: recipes, isLoading } = useRecipes(selectedCanteen);
  const { data: ingredients } = useIngredients(selectedCanteen);
  const addRecipe = useAddRecipe();
  const [dialogOpen, setDialogOpen] = useState(false);

  const [name, setName] = useState("");
  const [category, setCategory] = useState("Main");
  const [isSemiFinished, setIsSemiFinished] = useState(false);
  const [yieldQty, setYieldQty] = useState(1);
  const [yieldUnit, setYieldUnit] = useState("portion");
  const [instructions, setInstructions] = useState("");
  const [recipeIngredients, setRecipeIngredients] = useState<RecipeIngredientForm[]>([]);

  const semiFinishedRecipes = recipes?.filter((r: any) => r.is_semi_finished) || [];

  const addIngredientRow = () => {
    setRecipeIngredients([...recipeIngredients, { type: "ingredient", quantity: 0, unit: "kg" }]);
  };

  const removeIngredientRow = (idx: number) => {
    setRecipeIngredients(recipeIngredients.filter((_, i) => i !== idx));
  };

  const updateIngredientRow = (idx: number, updates: Partial<RecipeIngredientForm>) => {
    setRecipeIngredients(recipeIngredients.map((r, i) => (i === idx ? { ...r, ...updates } : r)));
  };

  const handleSubmit = async () => {
    if (!name || selectedCanteen === "all") {
      toast.error("Please select a canteen and enter recipe name");
      return;
    }

    try {
      await addRecipe.mutateAsync({
        recipe: {
          canteen_id: selectedCanteen,
          name,
          category,
          is_semi_finished: isSemiFinished,
          yield_qty: yieldQty,
          yield_unit: yieldUnit,
          instructions: instructions || undefined,
        },
        ingredients: recipeIngredients.map((r) => ({
          ingredient_id: r.type === "ingredient" ? r.ingredient_id : undefined,
          sub_recipe_id: r.type === "sub_recipe" ? r.sub_recipe_id : undefined,
          quantity: r.quantity,
          unit: r.unit,
        })),
      });
      toast.success("Recipe created!");
      setDialogOpen(false);
      resetForm();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const resetForm = () => {
    setName("");
    setCategory("Main");
    setIsSemiFinished(false);
    setYieldQty(1);
    setYieldUnit("portion");
    setInstructions("");
    setRecipeIngredients([]);
  };

  return (
    <AppLayout title="Recipe Management">
      <div className="space-y-4 animate-fade-in">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{recipes?.length || 0} recipes</p>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button className="bg-accent text-accent-foreground hover:bg-accent/90 gap-1.5" size="sm">
                <Plus className="w-4 h-4" /> Add Recipe
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>New Recipe</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-2">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Recipe Name</Label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Paneer Butter Masala" />
                  </div>
                  <div>
                    <Label className="text-xs">Category</Label>
                    <Select value={category} onValueChange={setCategory}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {recipeCategories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <Switch checked={isSemiFinished} onCheckedChange={setIsSemiFinished} />
                  <Label className="text-sm">Semi-finished item (used as ingredient in other recipes)</Label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Yield Quantity</Label>
                    <Input type="number" value={yieldQty} onChange={(e) => setYieldQty(Number(e.target.value))} />
                  </div>
                  <div>
                    <Label className="text-xs">Yield Unit</Label>
                    <Input value={yieldUnit} onChange={(e) => setYieldUnit(e.target.value)} placeholder="portion, kg, litre" />
                  </div>
                </div>

                <div>
                  <Label className="text-xs">Instructions (optional)</Label>
                  <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} />
                </div>

                {/* Recipe Ingredients */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <Label className="text-sm font-semibold">Ingredients</Label>
                    <Button variant="outline" size="sm" onClick={addIngredientRow} className="gap-1 text-xs">
                      <Plus className="w-3 h-3" /> Add Ingredient
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {recipeIngredients.map((ri, idx) => (
                      <div key={idx} className="flex gap-2 items-end p-2 rounded bg-muted">
                        <div className="w-28">
                          <Label className="text-[10px]">Type</Label>
                          <Select value={ri.type} onValueChange={(v: "ingredient" | "sub_recipe") => updateIngredientRow(idx, { type: v, ingredient_id: undefined, sub_recipe_id: undefined })}>
                            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="ingredient">Raw Material</SelectItem>
                              <SelectItem value="sub_recipe">Semi-Finished</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex-1">
                          <Label className="text-[10px]">{ri.type === "ingredient" ? "Ingredient" : "Sub-Recipe"}</Label>
                          {ri.type === "ingredient" ? (
                            <Select value={ri.ingredient_id || ""} onValueChange={(v) => updateIngredientRow(idx, { ingredient_id: v })}>
                              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select..." /></SelectTrigger>
                              <SelectContent>
                                {ingredients?.map((ing: any) => (
                                  <SelectItem key={ing.id} value={ing.id}>{ing.name} ({ing.unit})</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Select value={ri.sub_recipe_id || ""} onValueChange={(v) => updateIngredientRow(idx, { sub_recipe_id: v })}>
                              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select..." /></SelectTrigger>
                              <SelectContent>
                                {semiFinishedRecipes.map((r: any) => (
                                  <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                        <div className="w-20">
                          <Label className="text-[10px]">Qty</Label>
                          <Input type="number" className="h-8 text-xs" value={ri.quantity} onChange={(e) => updateIngredientRow(idx, { quantity: Number(e.target.value) })} />
                        </div>
                        <div className="w-20">
                          <Label className="text-[10px]">Unit</Label>
                          <Input className="h-8 text-xs" value={ri.unit} onChange={(e) => updateIngredientRow(idx, { unit: e.target.value })} />
                        </div>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeIngredientRow(idx)}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                    {recipeIngredients.length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-4">No ingredients added yet</p>
                    )}
                  </div>
                </div>

                <Button onClick={handleSubmit} disabled={addRecipe.isPending} className="w-full bg-accent text-accent-foreground hover:bg-accent/90">
                  {addRecipe.isPending ? "Creating..." : "Create Recipe"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Recipe List */}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
            {recipes?.map((recipe: any) => (
              <Card key={recipe.id} className="border-none shadow-sm">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h4 className="font-semibold text-sm">{recipe.name}</h4>
                      <p className="text-xs text-muted-foreground">{recipe.category}</p>
                    </div>
                    {recipe.is_semi_finished ? (
                      <span className="flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-info/10 text-info">
                        <Beaker className="w-3 h-3" /> Semi-finished
                      </span>
                    ) : (
                      <ChefHat className="w-4 h-4 text-muted-foreground" />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mb-2">
                    Yield: {recipe.yield_qty} {recipe.yield_unit}
                  </p>
                  {recipe.recipe_ingredients?.length > 0 && (
                    <div className="border-t pt-2">
                      <p className="text-[10px] font-medium text-muted-foreground mb-1">Ingredients:</p>
                      {recipe.recipe_ingredients.map((ri: any) => (
                        <p key={ri.id} className="text-xs">
                          {ri.ingredients?.name || "Sub-recipe"} — {ri.quantity} {ri.unit}
                        </p>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
            {recipes?.length === 0 && (
              <div className="col-span-full text-center py-12">
                <ChefHat className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No recipes yet. Create your first recipe!</p>
              </div>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
