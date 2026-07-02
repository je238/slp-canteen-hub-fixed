import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { orderTotals } from "@/lib/pricing";

export type KitchenStatus = "new" | "preparing" | "ready" | "served" | "cancelled";

export interface KitchenOrder {
  id: string;
  canteen_id: string;
  order_number: string;
  total_amount: number;
  payment_mode: string;
  status: string;
  kitchen_status: KitchenStatus;
  order_type: "pos" | "qr";
  payment_status: "paid" | "unpaid";
  customer_name: string | null;
  special_instructions: string | null;
  created_at: string;
  preparing_at: string | null;
  ready_at: string | null;
  served_at: string | null;
  order_items: { id: string; item_name: string; quantity: number; unit_price: number; total_price: number }[];
}

// Query keys derived from the orders table — invalidate together after
// any order mutation (mirrors the realtime subscription map).
export const ORDER_QUERY_KEYS = ["orders", "kitchenQueue", "kitchenServed", "qrUnsettled"] as const;

const LIFECYCLE_COLUMNS = /kitchen_status|order_type|payment_status|special_instructions/;

// True when the error means the lifecycle columns from
// 20260702072533_order_lifecycle_kds_qr.sql are not applied yet.
// Deliberately narrow: a check-constraint violation whose *name* contains
// "kitchen_status" must NOT be mistaken for a missing column.
export function isSchemaMissingError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  const msg = e.message || "";
  if (!LIFECYCLE_COLUMNS.test(msg)) return false;
  return (
    e.code === "PGRST204" || // PostgREST: "Could not find the 'x' column ... in the schema cache"
    e.code === "42703" ||    // Postgres: undefined column
    /could not find the '.*' column/i.test(msg) ||
    /column .* does not exist/i.test(msg)
  );
}

// Probes whether the KDS/QR migration has been applied to the database.
export function useKdsSchemaReady() {
  return useQuery({
    queryKey: ["kdsSchemaReady"],
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { error } = await supabase.from("orders").select("id, kitchen_status").limit(1);
      if (error) {
        if (isSchemaMissingError(error)) return false;
        throw error;
      }
      return true;
    },
  });
}

function startOfServiceDay(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// Rolling window for live kitchen work. A fixed "local midnight" cutoff
// would make unserved night-canteen orders vanish from the queue at 00:00.
function liveOrdersSince(): string {
  return new Date(Date.now() - 12 * 3600_000).toISOString();
}

// Live kitchen queue: recent orders that are new / preparing / ready.
export function useKitchenQueue(canteenId?: string, enabled = true) {
  return useQuery({
    queryKey: ["kitchenQueue", canteenId],
    enabled,
    refetchInterval: 8000,
    queryFn: async () => {
      let q = supabase
        .from("orders")
        .select("*, order_items(*)")
        .in("kitchen_status", ["new", "preparing", "ready"])
        .gte("created_at", liveOrdersSince())
        .order("created_at", { ascending: true });
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as KitchenOrder[];
    },
  });
}

// Orders served today, most recent first (for the KDS history strip + avg prep KPI).
export function useServedToday(canteenId?: string, enabled = true) {
  return useQuery({
    queryKey: ["kitchenServed", canteenId],
    enabled,
    refetchInterval: 30_000,
    queryFn: async () => {
      let q = supabase
        .from("orders")
        .select("*, order_items(*)")
        .eq("kitchen_status", "served")
        .gte("created_at", startOfServiceDay())
        .order("served_at", { ascending: false })
        .limit(30);
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as KitchenOrder[];
    },
  });
}

// Advance an order through the kitchen lifecycle.
export function useUpdateKitchenStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, kitchen_status }: { id: string; kitchen_status: KitchenStatus }) => {
      const patch: Record<string, unknown> = { kitchen_status };
      const now = new Date().toISOString();
      if (kitchen_status === "preparing") patch.preparing_at = now;
      if (kitchen_status === "ready") patch.ready_at = now;
      if (kitchen_status === "served") patch.served_at = now;
      if (kitchen_status === "cancelled") patch.status = "cancelled";
      let q = supabase.from("orders").update(patch).eq("id", id);
      // A stale card on another screen must not cancel food that was
      // already handed over (that would also restock its ingredients).
      if (kitchen_status === "cancelled") q = q.neq("kitchen_status", "served");
      const { data, error } = await q.select("id");
      if (error) throw error;
      if (kitchen_status === "cancelled" && (data?.length ?? 0) === 0) {
        throw new Error("Order was already served on another screen — not cancelled.");
      }
    },
    onSuccess: () => {
      for (const key of ORDER_QUERY_KEYS) qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

// Place a self-service QR order. Prices are re-read from menu_items so a
// tampered client can't set its own totals. Stays "unpaid" until the
// cashier settles it at the counter.
export function useCreateQROrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ canteen_id, items, customer_name, special_instructions }: {
      canteen_id: string;
      items: { menu_item_id: string; quantity: number }[];
      customer_name?: string;
      special_instructions?: string;
    }) => {
      const ids = items.map((i) => i.menu_item_id);
      const { data: menuRows, error: menuErr } = await supabase
        .from("menu_items")
        .select("id, name, price, available")
        .in("id", ids)
        .eq("canteen_id", canteen_id);
      if (menuErr) throw menuErr;

      const byId = new Map((menuRows || []).map((m) => [m.id, m]));
      const orderItems = items.map((i) => {
        const m = byId.get(i.menu_item_id);
        if (!m || !m.available) throw new Error("An item in your order is no longer available. Please refresh the menu.");
        return {
          menu_item_id: m.id,
          item_name: m.name,
          quantity: i.quantity,
          unit_price: Number(m.price),
          total_price: Number(m.price) * i.quantity,
        };
      });

      const { subtotal, gst, total } = orderTotals(orderItems.reduce((s, i) => s + i.total_price, 0));

      const { data: order, error } = await supabase
        .from("orders")
        .insert({
          canteen_id,
          total_amount: total,
          payment_mode: "counter",
          status: "pending",
          kitchen_status: "new",
          order_type: "qr",
          payment_status: "unpaid",
          customer_name: customer_name || null,
          special_instructions: special_instructions || null,
        })
        .select()
        .single();
      if (error) throw error;

      const rows = orderItems.map((i) => ({ ...i, order_id: order.id }));
      const { error: itemsErr } = await supabase.from("order_items").insert(rows);
      if (itemsErr) throw itemsErr;

      return { order, subtotal, gst, total };
    },
    onSuccess: () => {
      for (const key of ORDER_QUERY_KEYS) qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

// Live tracking of a single order (QR customer view). Stops polling once
// the order reaches a terminal state — abandoned tabs shouldn't poll forever.
export function useTrackOrder(orderId?: string) {
  return useQuery({
    queryKey: ["trackOrder", orderId],
    enabled: !!orderId,
    refetchInterval: (query) => {
      const s = (query.state.data as KitchenOrder | null | undefined)?.kitchen_status;
      return s === "served" || s === "cancelled" ? false : 5000;
    },
    queryFn: async () => {
      const { data, error } = await supabase
        .from("orders")
        .select("*, order_items(*)")
        .eq("id", orderId!)
        .maybeSingle();
      if (error) throw error;
      return data as KitchenOrder | null;
    },
  });
}

// QR orders that still need to be paid at the counter. Deliberately not
// date-bounded: an unpaid order must stay visible until it is settled or
// cancelled, even across midnight.
export function useUnsettledQROrders(canteenId?: string, enabled = true) {
  return useQuery({
    queryKey: ["qrUnsettled", canteenId],
    enabled,
    refetchInterval: 10_000,
    retry: false,
    queryFn: async () => {
      let q = supabase
        .from("orders")
        .select("*, order_items(*)")
        .eq("order_type", "qr")
        .eq("payment_status", "unpaid")
        .neq("kitchen_status", "cancelled")
        .order("created_at", { ascending: true });
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) {
        if (isSchemaMissingError(error)) return [] as KitchenOrder[];
        throw error;
      }
      return (data || []) as KitchenOrder[];
    },
  });
}

// Cashier settles a QR order: records payment mode, marks it a completed sale.
// Guarded so an order the kitchen just cancelled (or one already settled on
// another terminal) cannot be charged: that would book revenue for food that
// was never made — and whose ingredients were already restocked.
export function useSettleQROrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, payment_mode }: { id: string; payment_mode: string }) => {
      const { data, error } = await supabase
        .from("orders")
        .update({ payment_mode, payment_status: "paid", status: "completed" })
        .eq("id", id)
        .eq("payment_status", "unpaid")
        .neq("kitchen_status", "cancelled")
        .select("id");
      if (error) throw error;
      if ((data?.length ?? 0) === 0) {
        throw new Error("Not settled — this order was cancelled or already paid. Do not take payment.");
      }
    },
    onSuccess: () => {
      for (const key of ORDER_QUERY_KEYS) qc.invalidateQueries({ queryKey: [key] });
    },
  });
}
