// Turns an action_logs.details payload into a line a person can read. The
// raw rows carry ids (line_id, chef_item_id…) that mean nothing on screen.

const isId = (key: string) => key === "id" || key.endsWith("_id") || key.endsWith("_ids");
const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
const qty = (v: number | null) => (v == null ? "—" : String(Number(v.toFixed(3))));

export function valueText(value: unknown): string {
  if (value == null || value === "") return "—";
  if (Array.isArray(value)) return value.map(rowText).filter(Boolean).join(" · ");
  if (typeof value === "object") return rowText(value);
  return String(value);
}

// A requisition line as the order moved through chef → head chef → manager.
function orderLineText(r: Record<string, any>): string {
  const chefItem = r.chef_item ?? r.final_item ?? "Item";
  const finalItem = r.final_item ?? chefItem;
  const chef = num(r.chef_qty);
  const head = num(r.head_chef_qty);
  const fin = num(r.final_qty);
  const unit = r.unit ? ` ${r.unit}` : "";
  const steps = [`chef ${qty(chef)}`];
  if (head != null && head !== chef) steps.push(`head chef ${qty(head)}`);
  steps.push(`final ${qty(fin)}${unit}`);
  const swap = finalItem !== chefItem ? ` → ${finalItem}` : "";
  return `${chefItem}${swap}: ${steps.join(" → ")}`;
}

function rowText(row: unknown): string {
  if (row == null || typeof row !== "object") return row == null ? "" : String(row);
  const r = row as Record<string, any>;
  if ("chef_qty" in r || "final_qty" in r || "chef_item" in r) return orderLineText(r);
  const item = r.item ?? r.item_name ?? r.name ?? r.dish ?? r.unit;
  const was = r.was ?? r.old_qty ?? r.old;
  const now = r.now ?? r.new_qty ?? r.new;
  if (was !== undefined || now !== undefined) return `${item ?? "Line"}: ${valueText(was)} → ${valueText(now)}`;
  // Anything else: its readable fields, never its ids.
  const parts = Object.entries(r)
    .filter(([k, v]) => !isId(k) && v != null && v !== "" && typeof v !== "object")
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`);
  return parts.join(", ");
}

// A manager or admin who set a line far above what the chef asked — e.g. 45
// asked, 400 given — is worth a second look: usually a typo, sometimes not.
export function bigJumps(details: unknown): string[] {
  const rows = (details as any)?.changes;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r: any) => {
    const asked = num(r?.head_chef_qty ?? r?.chef_qty);
    const fin = num(r?.final_qty);
    if (asked == null || fin == null || asked <= 0) return [];
    return fin >= asked * 3 ? [`${r.final_item ?? r.chef_item ?? "Item"}: ${qty(asked)} maanga, ${qty(fin)} kiya (${Math.round(fin / asked)}x)`] : [];
  });
}

export function auditSummary(details: unknown, label: (v: string) => string = (v) => v): string {
  const d = (details && typeof details === "object" ? details : {}) as Record<string, any>;
  const parts: string[] = [];
  if (d.req_no != null) parts.push(`REQ-${d.req_no}`);
  if (d.item) parts.push(String(d.item));
  else if (d.dish) parts.push(String(d.dish));
  if (d.unit && typeof d.unit === "string" && d.count) parts.push(String(d.unit));
  if (d.meal_period) parts.push(label(String(d.meal_period)));
  if (d.was !== undefined || d.now !== undefined) parts.push(`${valueText(d.was)} → ${valueText(d.now)}`);
  if (d.old_values || d.new_values) parts.push(`${valueText(d.old_values)} → ${valueText(d.new_values)}`);
  if (Array.isArray(d.changes) ? d.changes.length : d.changes) parts.push(valueText(d.changes));
  if (d.cancelled_pending_qty != null) parts.push(`${valueText(d.cancelled_pending_qty)} pending band`);
  if (d.quantity_kg != null) parts.push(`${valueText(d.quantity_kg)} kg · Unit ${valueText(d.unit_no)}`);
  if (d.expected != null && d.now != null) parts.push(`expected ${valueText(d.expected)}`);
  return parts.filter((p) => p && p.trim() && p !== "—").join(" · ") || "Record update hua";
}
