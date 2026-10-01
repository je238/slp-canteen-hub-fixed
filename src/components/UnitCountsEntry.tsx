import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { mergeUnitInput, unitTotals, unitValue, type UnitCounts, type UnitField } from "@/lib/unitCounts";

interface Props {
  plan: { id: string; expected_headcount: number | null; unit_counts?: UnitCounts | null; count_change_reason?: string | null };
  units: string[];
  /** May enter a figure that is still empty (Head Supervisor, owner). */
  canFirst: boolean;
  /** May correct a figure already recorded (Manager and above), with a reason. */
  canCorrect: boolean;
  saving: boolean;
  onSave: (counts: UnitCounts, reason: string) => Promise<void>;
}

// Each unit's actual served and Eicher final punch, entered as they come in.
// The site total appears once all units are in; until then it says how many
// are still pending, so a meal never bills on two units out of three.
export default function UnitCountsEntry({ plan, units, canFirst, canCorrect, saving, onSave }: Props) {
  const current = plan.unit_counts || {};
  const [input, setInput] = useState<Record<string, Partial<Record<UnitField, string>>>>({});
  const [reason, setReason] = useState("");
  const anyRecorded = units.some((u) => unitValue(current, u, "actual") != null || unitValue(current, u, "punch") != null);

  const set = (u: string, f: UnitField, v: string) =>
    setInput((p) => ({ ...p, [u]: { ...(p[u] || {}), [f]: v } }));

  const editable = (u: string, f: UnitField) => unitValue(current, u, f) == null ? canFirst : canCorrect;

  const save = async () => {
    const { counts, changed, error } = mergeUnitInput(current, units, input);
    if (error) { toast.error(error); return; }
    if (!changed.length) { toast.info("Koi naya count nahi dala"); return; }
    if (changed.some((c) => c.was != null) && !reason.trim()) {
      toast.error("Recorded count correct karne ke liye reason likhna zaroori hai");
      return;
    }
    try {
      await onSave(counts, reason);
      setInput({});
      setReason("");
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const actual = unitTotals(current, units, "actual");
  const punch = unitTotals(current, units, "punch");
  const totalCell = (t: ReturnType<typeof unitTotals>) =>
    t.total != null ? <b>{t.total}</b> : <span className="text-warning">{t.entered ? `${t.sum} · ${t.of - t.entered} pending` : "Pending"}</span>;

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[4.5rem_1fr_1fr] gap-1 items-center text-[10px] text-muted-foreground">
        <span />
        <span>Actual served</span>
        <span>Eicher punch (Final)</span>
        {units.map((u) => (
          <UnitRow key={u} unit={u}>
            {(["actual", "punch"] as UnitField[]).map((f) => {
              const recorded = unitValue(current, u, f);
              return (
                <Input key={f} type="number" min={0} inputMode="numeric" className="h-8 text-xs"
                  aria-label={`${u} ${f === "actual" ? "actual served" : "Eicher punch"}`}
                  placeholder={recorded != null ? String(recorded) : f === "actual" ? "Actual" : "Punch"}
                  value={input[u]?.[f] ?? (recorded != null ? String(recorded) : "")}
                  readOnly={!editable(u, f)}
                  onChange={(e) => set(u, f, e.target.value)} />
              );
            })}
          </UnitRow>
        ))}
        <span className="text-xs font-semibold text-foreground">Total</span>
        <span className="text-xs">{totalCell(actual)}</span>
        <span className="text-xs">{totalCell(punch)}</span>
      </div>
      {anyRecorded && canCorrect && (
        <Input className="h-8 text-xs" placeholder="Correction reason (count badalne par mandatory)"
          value={reason} onChange={(e) => setReason(e.target.value)} />
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] text-muted-foreground">
          {punch.total != null ? "Final billing Eicher punch se" : actual.total != null ? "Provisional billing actual served se" : "Teeno unit aane par total banega · jo unit nahi chala usme 0"}
        </p>
        <Button size="sm" variant="secondary" className="h-8 text-xs" disabled={saving} onClick={save}>
          Save counts
        </Button>
      </div>
    </div>
  );
}

function UnitRow({ unit, children }: { unit: string; children: React.ReactNode }) {
  return (
    <>
      <span className="text-xs font-medium text-foreground">{unit}</span>
      {children}
    </>
  );
}
