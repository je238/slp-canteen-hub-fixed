import { useStockAlertTrail } from "@/hooks/useSrsData";

// The story behind one count difference, told in the order it happened:
// the last count, what came in and went out since, what the app therefore
// expected, what was actually counted — and the most likely reason. An alert
// that only says "116 kg in the app, 38 counted" tells the owner nothing he
// can act on; this tells him where to look.

const TYPE_LABEL: Record<string, string> = {
  purchase: "Bill se aaya",
  purchase_correction: "Bill ki line sudhari",
  bill_reprice_consumed: "Bill ka rate sudhara",
  issue: "Kitchen ko diya",
  return: "Kitchen se wapas aaya",
  central_kitchen_in: "Sun Pharma se udhaar liya",
  central_kitchen_return: "Sun Pharma ko udhaar wapas",
  central_kitchen_lend: "Sun Pharma ko udhaar diya",
  central_kitchen_lend_back: "Sun Pharma se wapas aaya",
  manual: "Haath se sudhaar",
  audit: "Pichhli ginti ka sudhaar",
  merge_reconciliation: "Do naam jode gaye",
  opening_reconciliation: "Shuruaati aankda",
  unit_conversion: "Unit badla",
  transfer: "Site transfer",
};

const q = (v: any, unit = "") => `${Number(Number(v || 0).toFixed(3)).toLocaleString("en-IN")} ${unit}`.trim();
const money = (v: any) => `₹${Math.round(Math.abs(Number(v) || 0)).toLocaleString("en-IN")}`;
const when = (v?: string | null) => v ? new Date(v).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

export default function StockTrail({ ingredientId, at }: { ingredientId: string; at: string }) {
  const { data: t, isLoading, error } = useStockAlertTrail(ingredientId, at);
  if (isLoading) return <p className="text-xs text-muted-foreground">Poori kahani load ho rahi hai…</p>;
  if (error) return <p className="text-xs text-destructive">Detail nahi aayi: {(error as any).message}</p>;
  if (!t) return null;

  const unit = t.unit || "";
  const diff = Number(t.difference || 0);
  const start = t.previous_count_at ? Number(t.previous_count) : Number(t.implied_start);
  const moves = (t.movements || []) as { type: string; qty: number; entries: number }[];

  return (
    <div className="space-y-2 rounded-lg border bg-background/80 p-3">
      <p className="text-xs font-semibold">Ginti ke beech kya-kya hua</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <tbody>
            <tr className="border-b">
              <td className="py-1.5 pr-2">{t.previous_count_at ? `Pichhli ginti (${when(t.previous_count_at)})` : "Shuru ka stock (pehle kabhi gina nahi gaya)"}</td>
              <td className="py-1.5 text-right font-semibold tabular-nums">{q(start, unit)}</td>
            </tr>
            {moves.length === 0 && (
              <tr className="border-b"><td className="py-1.5 pr-2 text-muted-foreground" colSpan={2}>Beech mein koi entry nahi hui</td></tr>
            )}
            {moves.map((m) => (
              <tr key={m.type} className="border-b">
                <td className="py-1.5 pr-2">{TYPE_LABEL[m.type] || m.type} <span className="text-muted-foreground">({m.entries} entry)</span></td>
                <td className={`py-1.5 text-right tabular-nums ${Number(m.qty) < 0 ? "text-destructive" : "text-success"}`}>{Number(m.qty) > 0 ? "+" : ""}{q(m.qty, unit)}</td>
              </tr>
            ))}
            <tr className="border-b">
              <td className="py-1.5 pr-2 font-medium">App ke hisaab se hona chahiye tha</td>
              <td className="py-1.5 text-right font-semibold tabular-nums">{q(t.expected, unit)}</td>
            </tr>
            <tr className="border-b">
              <td className="py-1.5 pr-2 font-medium">Gina gaya ({when(t.counted_at)})</td>
              <td className="py-1.5 text-right font-semibold tabular-nums">{q(t.counted, unit)}</td>
            </tr>
            <tr>
              <td className="py-1.5 pr-2 font-semibold">{diff < 0 ? "Kam nikla" : "Zyada nikla"}</td>
              <td className={`py-1.5 text-right font-bold tabular-nums ${diff < 0 ? "text-destructive" : "text-warning"}`}>
                {q(Math.abs(diff), unit)} · {money(t.value)}{t.rate ? <span className="font-normal text-muted-foreground"> @₹{t.rate}/{unit}</span> : null}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {(t.look_alikes || []).length > 0 && (
        <p className="rounded-md bg-warning/10 p-2 text-xs">
          <b>Isi jaisa doosra item bhi stock mein hai:</b>{" "}
          {(t.look_alikes as any[]).map((l) => `${l.name} (${q(l.stock, l.unit)})`).join(", ")}
        </p>
      )}
      <p className="rounded-md bg-muted/60 p-2 text-xs"><b>Sambhavit wajah:</b> {t.cause}</p>
    </div>
  );
}
