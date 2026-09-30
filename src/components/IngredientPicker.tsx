import { useMemo, useState } from "react";
import { Check, Plus, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Choosing an item when goods arrive.
//
// The store keeper used to either scroll a 146-row dropdown with no search on
// a phone, or give up and type the name into the bill scanner — which is how
// "G Chili" and "Chili", "MIX VEG" and "MIX  VEG" became two items holding
// one sack. Here he types, and the items already in the store come up first.
// A new item can still be made, but only after the near names are shown and
// he says it is not one of them.

const norm = (s: string) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** How alike two names are, 0..1. Containment counts: "chili" vs "g chili". */
export function nameLikeness(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9 * Math.min(x.length, y.length) / Math.max(x.length, y.length) + 0.1;
  return 1 - editDistance(x, y) / Math.max(x.length, y.length);
}

export interface PickerIngredient { id: string; name: string; unit: string; current_stock?: number | string; }

const UNITS = ["kg", "litre", "packet", "pcs", "box", "tin", "dozen", "gram", "bag", "crate"];

export default function IngredientPicker({
  ingredients, value, onPick, onCreate, creating,
}: {
  ingredients: PickerIngredient[];
  value?: string;
  onPick: (ingredient: PickerIngredient) => void;
  /** Omit to hide "new item". */
  onCreate?: (name: string, unit: string) => Promise<void> | void;
  creating?: boolean;
}) {
  const picked = ingredients.find((i) => i.id === value);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [newMode, setNewMode] = useState(false);
  const [newUnit, setNewUnit] = useState("kg");

  const q = query.trim();
  const matches = useMemo(() => {
    if (!q) return ingredients.slice(0, 8);
    return ingredients
      .map((i) => ({ i, score: nameLikeness(q, i.name) + (norm(i.name).startsWith(norm(q)) ? 0.3 : 0) }))
      .filter((m) => m.score >= 0.6 || norm(m.i.name).includes(norm(q)))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((m) => m.i);
  }, [ingredients, q]);

  const exact = q ? ingredients.find((i) => norm(i.name) === norm(q)) : undefined;
  const nearNames = q ? ingredients.filter((i) => nameLikeness(q, i.name) >= 0.6 && norm(i.name) !== norm(q)).slice(0, 4) : [];

  if (picked && !open) {
    return (
      <div>
        <Label className="text-[10px]">Inventory ka saman</Label>
        <button type="button" onClick={() => { setOpen(true); setQuery(""); }}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-left text-sm">
          <span className="truncate"><b>{picked.name}</b> <span className="text-muted-foreground">· stock {Number(picked.current_stock || 0)} {picked.unit}</span></span>
          <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Label className="text-[10px]">Inventory ka saman</Label>
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input className="h-9 pl-8 text-sm" placeholder="Naam likho — jaise tomato, paneer"
          value={query} autoFocus={open}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setNewMode(false); }} />
      </div>

      {open && (
        <div className="mt-1 space-y-1 rounded-md border bg-popover p-1 shadow-sm">
          {matches.map((i) => (
            <button key={i.id} type="button"
              onClick={() => { onPick(i); setOpen(false); setQuery(""); setNewMode(false); }}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left text-sm hover:bg-muted">
              <span className="truncate">{i.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">stock {Number(i.current_stock || 0)} {i.unit}</span>
            </button>
          ))}
          {q && matches.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">Is naam ka koi saman inventory mein nahi mila.</p>}

          {onCreate && q.length >= 2 && !exact && !newMode && (
            <button type="button" onClick={() => setNewMode(true)}
              className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm text-accent hover:bg-muted">
              <Plus className="h-4 w-4" /> Naya item banao: "{q}"
            </button>
          )}

          {onCreate && newMode && (
            <div className="space-y-2 rounded border border-warning/40 bg-warning/5 p-2">
              {nearNames.length > 0 && (
                <div className="text-xs">
                  <b>Ruko — kya ye inme se koi hai?</b>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {nearNames.map((i) => (
                      <Button key={i.id} type="button" size="sm" variant="outline" className="h-7 text-xs"
                        onClick={() => { onPick(i); setOpen(false); setQuery(""); setNewMode(false); }}>
                        <Check className="mr-1 h-3 w-3" /> {i.name}
                      </Button>
                    ))}
                  </div>
                  <p className="mt-1 text-muted-foreground">Agar wahi hai to usi ko chuno. Do naam se ek saman ka stock bant jaata hai.</p>
                </div>
              )}
              <div className="flex items-end gap-2">
                <div className="w-28">
                  <Label className="text-[10px]">Unit</Label>
                  <Select value={newUnit} onValueChange={setNewUnit}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <Button type="button" size="sm" className="h-8" disabled={creating}
                  onClick={async () => { await onCreate(q, newUnit); setOpen(false); setQuery(""); setNewMode(false); }}>
                  {creating ? "Ban raha…" : nearNames.length ? `Nahi, "${q}" naya hai` : `"${q}" banao`}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
