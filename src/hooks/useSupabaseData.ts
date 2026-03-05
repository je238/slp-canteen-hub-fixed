import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// Canteens
export function useCanteens() {
  return useQuery({
    queryKey: ["canteens"],
    queryFn: async () => {
      const { data, error } = await supabase.from("canteens").select("*").order("name");
      if (error) throw error;
      return data;
    },
  });
}

// Ingredients
export function useIngredients(canteenId?: string) {
  return useQuery({
    queryKey: ["ingredients", canteenId],
    queryFn: async () => {
      let q = supabase.from("ingredients").select("*").order("name");
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
  });
}

export function useAddIngredient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (item: { canteen_id: string; name: string; category: string; unit: string; current_stock: number; minimum_stock: number; cost_per_unit: number }) => {
      const { data, error } = await supabase.from("ingredients").insert(item).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ingredients"] }),
  });
}

export function useUpdateIngredientStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, current_stock, reason, canteen_id }: { id: string; current_stock: number; reason: string; canteen_id: string }) => {
      const { data: ingredient, error: fetchErr } = await supabase.from("ingredients").select("current_stock").eq("id", id).single();
      if (fetchErr) throw fetchErr;

      const { error } = await supabase.from("ingredients").update({ current_stock }).eq("id", id);
      if (error) throw error;

      const { error: ledgerErr } = await supabase.from("stock_ledger").insert({
        ingredient_id: id,
        canteen_id,
        change_qty: current_stock - (ingredient?.current_stock || 0),
        balance_after: current_stock,
        reason,
        reference_type: "manual",
      });
      if (ledgerErr) throw ledgerErr;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ingredients"] }),
  });
}

// Menu Items
export function useMenuItems(canteenId?: string) {
  return useQuery({
    queryKey: ["menuItems", canteenId],
    queryFn: async () => {
      let q = supabase.from("menu_items").select("*").order("category").order("name");
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
  });
}

export function useAddMenuItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (item: { canteen_id: string; name: string; category: string; price: number; recipe_id?: string }) => {
      const { data, error } = await supabase.from("menu_items").insert(item).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menuItems"] }),
  });
}

// Orders
export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ canteen_id, items, payment_mode, total_amount }: {
      canteen_id: string;
      items: { menu_item_id: string; item_name: string; quantity: number; unit_price: number; total_price: number }[];
      payment_mode: string;
      total_amount: number;
    }) => {
      const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}`;
      const { data: order, error } = await supabase
        .from("orders")
        .insert({ canteen_id, order_number: orderNumber, total_amount, payment_mode })
        .select()
        .single();
      if (error) throw error;

      const orderItems = items.map((i) => ({ ...i, order_id: order.id }));
      const { error: itemsErr } = await supabase.from("order_items").insert(orderItems);
      if (itemsErr) throw itemsErr;

      return order;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

export function useOrders(canteenId?: string) {
  return useQuery({
    queryKey: ["orders", canteenId],
    queryFn: async () => {
      let q = supabase.from("orders").select("*").order("created_at", { ascending: false }).limit(50);
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
  });
}

// Suppliers
export function useSuppliers(canteenId?: string) {
  return useQuery({
    queryKey: ["suppliers", canteenId],
    queryFn: async () => {
      let q = supabase.from("suppliers").select("*").order("name");
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
  });
}

export function useAddSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (item: { name: string; contact_person?: string; phone?: string; email?: string; address?: string; canteen_id?: string }) => {
      const { data, error } = await supabase.from("suppliers").insert(item).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["suppliers"] }),
  });
}

// Purchases
export function usePurchases(canteenId?: string) {
  return useQuery({
    queryKey: ["purchases", canteenId],
    queryFn: async () => {
      let q = supabase.from("purchases").select("*, suppliers(name)").order("created_at", { ascending: false });
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
  });
}

export function usePurchaseItems(purchaseId?: string) {
  return useQuery({
    queryKey: ["purchaseItems", purchaseId],
    enabled: !!purchaseId,
    queryFn: async () => {
      const { data, error } = await supabase.from("purchase_items").select("*").eq("purchase_id", purchaseId!);
      if (error) throw error;
      return data;
    },
  });
}

export function useCreatePurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ canteen_id, supplier_id, items, notes, invoice_image_url }: {
      canteen_id: string;
      supplier_id?: string;
      items: { item_name: string; quantity: number; unit: string; rate: number; total: number; ingredient_id?: string; confidence_score?: number; matched?: boolean }[];
      notes?: string;
      invoice_image_url?: string;
    }) => {
      const total_amount = items.reduce((s, i) => s + i.total, 0);
      const { data: purchase, error } = await supabase
        .from("purchases")
        .insert({ canteen_id, supplier_id, total_amount, notes, invoice_image_url, status: "draft" })
        .select()
        .single();
      if (error) throw error;

      const purchaseItems = items.map((i) => ({ ...i, purchase_id: purchase.id }));
      const { error: itemsErr } = await supabase.from("purchase_items").insert(purchaseItems);
      if (itemsErr) throw itemsErr;

      return purchase;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchases"] }),
  });
}

export function useConfirmPurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (purchaseId: string) => {
      // Get purchase items
      const { data: items, error: itemsErr } = await supabase
        .from("purchase_items")
        .select("*")
        .eq("purchase_id", purchaseId);
      if (itemsErr) throw itemsErr;

      // Get the purchase for canteen_id
      const { data: purchase, error: pErr } = await supabase
        .from("purchases")
        .select("canteen_id")
        .eq("id", purchaseId)
        .single();
      if (pErr) throw pErr;

      // Process matched items: fetch current stocks in parallel, then update
      const matchedItems = (items || []).filter(item => item.ingredient_id);

      if (matchedItems.length > 0) {
        // Fetch all ingredient stocks in parallel
        const stockResults = await Promise.all(
          matchedItems.map(item =>
            supabase
              .from("ingredients")
              .select("id, current_stock")
              .eq("id", item.ingredient_id!)
              .single()
          )
        );

        // Check for errors
        for (const result of stockResults) {
          if (result.error) throw result.error;
        }

        const stockMap: Record<string, number> = {};
        for (const result of stockResults) {
          if (result.data) stockMap[result.data.id] = Number(result.data.current_stock);
        }

        // Update stocks and ledger in parallel
        await Promise.all(
          matchedItems.map(async item => {
            const currentStock = stockMap[item.ingredient_id!] ?? 0;
            const newStock = currentStock + Number(item.quantity);

            const { error: updateErr } = await supabase
              .from("ingredients")
              .update({ current_stock: newStock })
              .eq("id", item.ingredient_id!);
            if (updateErr) throw updateErr;

            const { error: ledgerErr } = await supabase.from("stock_ledger").insert({
              ingredient_id: item.ingredient_id,
              canteen_id: purchase.canteen_id,
              change_qty: Number(item.quantity),
              balance_after: newStock,
              reason: `Purchase confirmed #${purchaseId.slice(0, 8)}`,
              reference_type: "purchase",
              reference_id: purchaseId,
            });
            if (ledgerErr) throw ledgerErr;
          })
        );
      }

      // Mark purchase as confirmed
      const { error } = await supabase
        .from("purchases")
        .update({ status: "confirmed", approved_at: new Date().toISOString() })
        .eq("id", purchaseId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchases"] });
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["stockLedger"] });
    },
  });
}

// Recipes
export function useRecipes(canteenId?: string) {
  return useQuery({
    queryKey: ["recipes", canteenId],
    queryFn: async () => {
      let q = supabase.from("recipes").select("*, recipe_ingredients(*, ingredients(name, unit))").order("name");
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
  });
}

export function useAddRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ recipe, ingredients: recipeIngredients }: {
      recipe: { canteen_id: string; name: string; category: string; is_semi_finished: boolean; yield_qty: number; yield_unit: string; instructions?: string };
      ingredients: { ingredient_id?: string; sub_recipe_id?: string; quantity: number; unit: string }[];
    }) => {
      const { data, error } = await supabase.from("recipes").insert(recipe).select().single();
      if (error) throw error;

      if (recipeIngredients.length > 0) {
        const items = recipeIngredients.map((i) => ({ ...i, recipe_id: data.id }));
        const { error: ingErr } = await supabase.from("recipe_ingredients").insert(items);
        if (ingErr) throw ingErr;
      }

      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recipes"] }),
  });
}

// Expenses
export function useExpenses(canteenId?: string) {
  return useQuery({
    queryKey: ["expenses", canteenId],
    queryFn: async () => {
      let q = supabase.from("expenses").select("*").order("expense_date", { ascending: false });
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
  });
}

export function useAddExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (item: { canteen_id: string; category: string; description?: string; amount: number; expense_date: string }) => {
      const { data, error } = await supabase.from("expenses").insert(item).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["expenses"] }),
  });
}

// Staff
export function useStaff(canteenId?: string) {
  return useQuery({
    queryKey: ["staff", canteenId],
    queryFn: async () => {
      let q = supabase.from("staff").select("*").order("name");
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
  });
}

export function useAddStaff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (item: { canteen_id: string; name: string; role: string; phone?: string; email?: string }) => {
      const { data, error } = await supabase.from("staff").insert(item).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["staff"] }),
  });
}

// Stock Ledger
export function useStockLedger(canteenId?: string) {
  return useQuery({
    queryKey: ["stockLedger", canteenId],
    queryFn: async () => {
      let q = supabase.from("stock_ledger").select("*, ingredients(name)").order("created_at", { ascending: false }).limit(100);
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
  });
}
