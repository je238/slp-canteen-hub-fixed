import { useMemo, useState } from "react";
import { CalendarDays, Save } from "lucide-react";
import { toast } from "sonner";
import { useAvailability, useSetDeliverySchedule } from "@/hooks/useSrsData";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const cycleLabel = (days: number) => days === 1 ? "Daily" : days === 2 ? "Every 2 days" : days === 7 ? "Weekly" : `Every ${days} days`;

export default function DeliverySchedule({ canteenId }: { canteenId: string }) {
  const { data: rows } = useAvailability(canteenId);
  const save = useSetDeliverySchedule();
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Record<string, { days: string; date: string }>>({});

  const list = useMemo(() => (rows || [])
    .filter((r: any) => r.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a: any, b: any) => a.name.localeCompare(b.name)), [rows, search]);

  const valueOf = (r: any) => draft[r.ingredient_id] || {
    days: String(r.delivery_every_days || 7),
    date: r.next_delivery_on || r.next_arrival || "",
  };

  const update = (id: string, current: { days: string; date: string }, patch: Partial<{ days: string; date: string }>) =>
    setDraft((d) => ({ ...d, [id]: { ...current, ...patch } }));

  const doSave = async (r: any) => {
    const v = valueOf(r);
    try {
      await save.mutateAsync({
        ingredientId: r.ingredient_id,
        everyDays: Number(v.days),
        nextDeliveryOn: v.date || null,
      });
      setDraft((d) => { const n = { ...d }; delete n[r.ingredient_id]; return n; });
      toast.success(`${r.name}: ${cycleLabel(Number(v.days))}, next delivery ${v.date || "auto"}`);
    } catch (e: any) { toast.error(e.message); }
  };

  return (
    <Card className="border-none shadow-sm">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-3 flex-wrap">
          <CalendarDays className="w-5 h-5 text-accent mt-0.5" />
          <div className="flex-1 min-w-[220px]">
            <p className="text-sm font-semibold">Delivery calendar</p>
            <p className="text-xs text-muted-foreground">
              Milk/curd daily, vegetables every 2 days, बाकी weekly. Next date Store Keeper confirms; Chef को उसी से “kal/parso aayega” दिखेगा.
            </p>
          </div>
          <Input className="h-8 w-48 text-xs" placeholder="Search item…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="max-h-80 overflow-auto rounded-md border">
          {list.map((r: any) => {
            const v = valueOf(r);
            return (
              <div key={r.ingredient_id} className="grid grid-cols-[minmax(120px,1fr)_130px_145px_42px] gap-2 items-center px-3 py-2 border-b last:border-0">
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{r.name}</p>
                  <p className="text-[10px] text-muted-foreground">Stock {Number(r.current_stock)} {r.unit}</p>
                </div>
                <Select value={v.days} onValueChange={(days) => update(r.ingredient_id, v, { days })}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">Daily</SelectItem>
                    <SelectItem value="2">Every 2 days</SelectItem>
                    <SelectItem value="7">Weekly</SelectItem>
                  </SelectContent>
                </Select>
                <Input type="date" className="h-8 text-xs" value={v.date} onChange={(e) => update(r.ingredient_id, v, { date: e.target.value })} />
                <Button size="icon" variant="outline" className="h-8 w-8" disabled={save.isPending || !draft[r.ingredient_id]} onClick={() => doSave(r)} title="Save delivery date">
                  <Save className="w-3.5 h-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
