import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

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

// True when the error means the lifecycle columns from
// 20260702072533_order_lifecycle_kds_qr.sql are not applied yet.
export function isSchemaMissingError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  const msg = e.message || "";
  return (
    e.code === "PGRST204" ||
    e.code === "42703" ||
    /kitchen_status|order_type|payment_status|special_instructions/.test(msg)
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

// Live kitchen queue: today's orders that are new / preparing / ready.
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
        .gte("created_at", startOfServiceDay())
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
      const { error } = await supabase.from("orders").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kitchenQueue"] });
      qc.invalidateQueries({ queryKey: ["kitchenServed"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["qrUnsettled"] });
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

      const subtotal = orderItems.reduce((s, i) => s + i.total_price, 0);
      const gst = Math.round(subtotal * 0.05);
      const total = subtotal + gst;

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
      qc.invalidateQueries({ queryKey: ["kitchenQueue"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

// Live tracking of a single order (QR customer view).
export function useTrackOrder(orderId?: string) {
  return useQuery({
    queryKey: ["trackOrder", orderId],
    enabled: !!orderId,
    refetchInterval: 5000,
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

// QR orders from today that still need to be paid at the counter.
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
        .gte("created_at", startOfServiceDay())
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
export function useSettleQROrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, payment_mode }: { id: string; payment_mode: string }) => {
      const { error } = await supabase
        .from("orders")
        .update({ payment_mode, payment_status: "paid", status: "completed" })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["qrUnsettled"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["kitchenQueue"] });
      qc.invalidateQueries({ queryKey: ["kitchenServed"] });
    },
  });
}
