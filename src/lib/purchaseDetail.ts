// One bill line, as the purchase detail report reads it.
export interface PurchaseLine {
  purchase_id: string;
  purchase_item_id: string;
  purchase_date: string;
  purchased_at: string;
  vendor_name: string;
  item_name: string;
  category: string;
  quantity: number;
  unit: string;
  rate: number;
  amount: number;
}

export interface VendorShare {
  vendor: string;
  qty: number;
  amount: number;
  avgRate: number | null;
  bills: number;
}

export interface ItemSummary {
  key: string;
  item: string;
  unit: string;
  category: string;
  qty: number;
  amount: number;
  avgRate: number | null;
  minRate: number | null;
  maxRate: number | null;
  bills: number;
  vendors: VendorShare[];
}

// Same fallback the category totals use, so the two always add up alike.
export const UNKNOWN_CATEGORY = "Unknown — check";

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// What was bought, item by item: total quantity and spend, the average paid
// (spend / quantity, not an average of rates), the cheapest and dearest rate
// seen, and how it split between vendors. Units are kept apart: 10 kg and
// 10 packet of the same name are not one quantity.
export function summariseByItem(lines: PurchaseLine[]): ItemSummary[] {
  const items = new Map<string, ItemSummary & { _bills: Set<string>; _vendors: Map<string, VendorShare & { _bills: Set<string> }> }>();
  for (const l of lines) {
    const key = `${l.item_name.trim().toLowerCase()}|${l.unit.trim().toLowerCase()}`;
    let s = items.get(key);
    if (!s) {
      s = { key, item: l.item_name.trim(), unit: l.unit.trim(), category: l.category, qty: 0, amount: 0, avgRate: null,
        minRate: null, maxRate: null, bills: 0, vendors: [], _bills: new Set(), _vendors: new Map() };
      items.set(key, s);
    }
    s.qty += l.quantity;
    s.amount += l.amount;
    s._bills.add(l.purchase_id);
    if (l.rate > 0) {
      s.minRate = s.minRate == null ? l.rate : Math.min(s.minRate, l.rate);
      s.maxRate = s.maxRate == null ? l.rate : Math.max(s.maxRate, l.rate);
    }
    let v = s._vendors.get(l.vendor_name);
    if (!v) {
      v = { vendor: l.vendor_name, qty: 0, amount: 0, avgRate: null, bills: 0, _bills: new Set() };
      s._vendors.set(l.vendor_name, v);
    }
    v.qty += l.quantity;
    v.amount += l.amount;
    v._bills.add(l.purchase_id);
  }
  return [...items.values()]
    .map(({ _bills, _vendors, ...s }) => ({
      ...s,
      qty: round(s.qty, 3),
      amount: round(s.amount),
      avgRate: s.qty > 0 ? round(s.amount / s.qty) : null,
      bills: _bills.size,
      vendors: [..._vendors.values()]
        .map(({ _bills: vb, ...v }) => ({
          ...v, qty: round(v.qty, 3), amount: round(v.amount),
          avgRate: v.qty > 0 ? round(v.amount / v.qty) : null, bills: vb.size,
        }))
        .sort((a, b) => b.amount - a.amount),
    }))
    .sort((a, b) => b.amount - a.amount);
}

// Spend per category, largest first, for the category chips.
export function categoryTotals(lines: PurchaseLine[]) {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.category, (m.get(l.category) || 0) + l.amount);
  return [...m.entries()].map(([category, amount]) => ({ category, amount: round(amount) }))
    .sort((a, b) => b.amount - a.amount);
}
