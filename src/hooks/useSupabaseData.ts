import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { REPORTING_CUTOVER_TIMESTAMP } from "@/lib/cutover";

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
      // Removed items remain linked to old bills/issues for accurate history,
      // but never return to an active stock or order picker.
      let q = supabase.from("ingredients").select("*").is("archived_at", null).order("name");
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
    mutationFn: async (item: { canteen_id: string; name: string; category: string; unit: string; current_stock: number; minimum_stock: number; cost_per_unit: number; avg_daily_usage?: number }) => {
      const { data, error } = await supabase.from("ingredients").insert(item).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ingredients"] }),
  });
}

// Expected burn rate ("rice runs at 100 kg/day") — drives the Days Left
// column and the faster-than-normal leak warning. Not a stock movement,
// so no ledger entry.
export function useSetAvgDailyUsage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, avg_daily_usage, reorder_level, maximum_stock }: {
      id: string; avg_daily_usage: number | null;
      reorder_level?: number | null; maximum_stock?: number | null;
    }) => {
      const patch: any = { avg_daily_usage };
      if (reorder_level !== undefined) patch.reorder_level = reorder_level;
      if (maximum_stock !== undefined) patch.maximum_stock = maximum_stock;
      const { error } = await supabase.from("ingredients").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ingredients"] }),
  });
}

// Manual adjustment goes through the database function: stock and its ledger
// row move together in one transaction, and a reason is compulsory. Editing
// ingredients.current_stock directly is refused by a trigger — that was how
// someone could take goods and simply type the lower number.
export function useUpdateIngredientStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, current_stock, reason }: {
      id: string; current_stock: number; reason: string; canteen_id?: string;
    }) => {
      const { error } = await supabase.rpc("adjust_stock" as any, {
        p_ingredient_id: id,
        p_new_stock: current_stock,
        p_reason: reason,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["stockLedger"] });
      qc.invalidateQueries({ queryKey: ["ledgerSince"] });
    },
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

// Suppliers. A NULL canteen_id means a global vendor (e.g. added while
// "All Canteens" was selected) — those must show up under every canteen,
// not vanish the moment a specific canteen is picked.
export function useSuppliers(canteenId?: string) {
  return useQuery({
    queryKey: ["suppliers", canteenId],
    queryFn: async () => {
      let q = supabase.from("suppliers").select("*").order("name");
      if (canteenId && canteenId !== "all") q = q.or(`canteen_id.eq.${canteenId},canteen_id.is.null`);
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

export function useUpdateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...fields }: { id: string; name?: string; contact_person?: string; phone?: string; email?: string; address?: string }) => {
      const { data, error } = await supabase.from("suppliers").update(fields).eq("id", id).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["suppliers"] }),
  });
}

// Purchases for one vendor with their line items (price history)
export function useVendorPurchases(supplierId?: string) {
  return useQuery({
    queryKey: ["vendorPurchases", supplierId],
    enabled: !!supplierId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("purchases")
        .select("*, purchase_items(*)")
        .eq("supplier_id", supplierId!)
        .order("created_at", { ascending: false })
        .limit(25);
      if (error) throw error;
      return data as any[];
    },
  });
}

// Purchases
export function usePurchases(canteenId?: string) {
  return useQuery({
    queryKey: ["purchases", canteenId, REPORTING_CUTOVER_TIMESTAMP],
    queryFn: async () => {
      let q = supabase.from("purchases" as any)
        .select("*, suppliers(name), purchase_items(*), purchase_invoice_files(*), purchase_line_corrections(*)")
        .gte("created_at", REPORTING_CUTOVER_TIMESTAMP)
        .order("created_at", { ascending: false });
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) throw error;
      return data as any[];
    },
  });
}

// Goods are already on the shelf, but the vendor's paper has not arrived yet.
// This RPC moves stock exactly once and marks the receiving as bill-pending.
export function useReceiveStockWithoutBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ canteen_id, supplier_id, items, notes }: {
      canteen_id: string;
      supplier_id?: string;
      items: { ingredient_id: string; quantity: number }[];
      notes?: string;
    }) => {
      const { data, error } = await supabase.rpc("receive_stock_without_bill" as any, {
        p_canteen_id: canteen_id,
        p_supplier_id: supplier_id || null,
        p_items: items,
        p_notes: notes || null,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchases"] });
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["ingredientRates"] });
      qc.invalidateQueries({ queryKey: ["storeKeeperDashboard"] });
    },
  });
}

// Attaching late-arriving bill photos is documentary only. The database RPC
// explicitly returns stock_changed=false and caps one receiving at four bills.
export function useAttachPurchaseInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ purchase_id, image_path, amount, bill_number, bill_date }: {
      purchase_id: string;
      image_path: string;
      amount?: number | null;
      bill_number?: string;
      bill_date?: string;
    }) => {
      const { data, error } = await supabase.rpc("attach_purchase_invoice" as any, {
        p_purchase_id: purchase_id,
        p_image_path: image_path,
        p_amount: amount ?? null,
        p_bill_number: bill_number || null,
        p_bill_date: bill_date || null,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchases"] }),
  });
}

// A confirmed invoice line is corrected atomically in Postgres: the old
// untouched lot is reversed, the corrected lot is added, and both versions
// are retained in the audit trail. The RPC refuses to rewrite issued stock.
export function useCorrectPurchaseLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      purchase_item_id: string;
      ingredient_id?: string | null;
      new_item_name?: string | null;
      new_category?: string | null;
      new_unit: string;
      new_quantity: number;
      new_rate: number;
      reason: string;
    }) => {
      const { data, error } = await supabase.rpc("correct_confirmed_purchase_line" as any, {
        p_purchase_item_id: input.purchase_item_id,
        p_ingredient_id: input.ingredient_id || null,
        p_new_item_name: input.new_item_name || null,
        p_new_category: input.new_category || "Uncategorised",
        p_new_unit: input.new_unit,
        p_new_quantity: input.new_quantity,
        p_new_rate: input.new_rate,
        p_reason: input.reason,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchases"] });
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["ingredientRates"] });
      qc.invalidateQueries({ queryKey: ["storeKeeperDashboard"] });
      qc.invalidateQueries({ queryKey: ["periodSummary"] });
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
    mutationFn: async ({ canteen_id, supplier_id, items, notes, invoice_image_url, total_override }: {
      canteen_id: string;
      supplier_id?: string;
      items: { item_name: string; quantity: number; unit: string; rate: number; total: number; ingredient_id?: string; confidence_score?: number; matched?: boolean }[];
      notes?: string;
      invoice_image_url?: string;
      // e.g. an invoice's grand total (incl. GST/freight) — reconciles with what the vendor is actually owed
      total_override?: number;
    }) => {
      const total_amount = total_override ?? items.reduce((s, i) => s + i.total, 0);
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
      const { data, error } = await supabase
        .from("purchases")
        .update({ status: "confirmed", approved_at: new Date().toISOString() })
        .eq("id", purchaseId)
        .select("id");
      if (error) throw error;
      if (!data || data.length === 0) throw new Error("You are not allowed to confirm this purchase");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchases"] });
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["availability"] });
      qc.invalidateQueries({ queryKey: ["requisitions"] });
      qc.invalidateQueries({ queryKey: ["stockLedger"] });
    },
  });
}

// Recipes
export function useRecipes(canteenId?: string) {
  return useQuery({
    queryKey: ["recipes", canteenId],
    queryFn: async () => {
      // recipe_ingredients also references recipes via sub_recipe_id; select
      // the parent recipe relationship explicitly to avoid PGRST201.
      let q = supabase.from("recipes").select("*, recipe_ingredients!recipe_ingredients_recipe_id_fkey(*, ingredients(name, unit))").order("name");
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
// Fraud Alerts
export function useFraudAlerts(canteenId?: string) {
  return useQuery({
    queryKey: ["fraudAlerts", canteenId],
    queryFn: async () => {
      let q = supabase.from("fraud_alerts").select("*, ingredients(name), purchases(id)").order("created_at", { ascending: false });
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
  });
}

// Storekeeper's daily usage entry ("aaj 200 kg rice nikla"): deducts stock
// and writes an 'issue' ledger row per item — the digital version of the
// Excel register's "used" column.
export function useRecordDailyUsage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ canteen_id, entries }: {
      canteen_id: string;
      entries: { ingredient_id: string; name: string; qty: number }[];
    }) => {
      // One atomic transaction server-side (record_stock_issue RPC): deducts
      // and writes the ledger together, balance read back from the DB. This
      // replaces the old browser read-modify-write that could lose concurrent
      // deductions and desync current_stock from the ledger.
      const { error } = await supabase.rpc("record_stock_issue" as any, {
        p_canteen_id: canteen_id,
        p_items: entries.map((e) => ({ ingredient_id: e.ingredient_id, qty: e.qty, name: e.name })),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["stockLedger"] });
      qc.invalidateQueries({ queryKey: ["ledgerSince"] });
    },
  });
}

// uuid → email map for showing WHO made each stock entry. Tolerant: if the
// user_directory view isn't on this database yet, names just show as "—".
export function useUserDirectory() {
  return useQuery({
    queryKey: ["userDirectory"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("user_directory" as any).select("id, email");
      if (error) return {} as Record<string, string>;
      const map: Record<string, string> = {};
      for (const u of (data as any[]) || []) map[u.id] = u.email;
      return map;
    },
  });
}

// Every ledger row of a canteen since a date — the Daily Register works
// backwards from current stock, so it needs all movements after the
// chosen day, not just that day's.
export function useLedgerSince(canteenId?: string, sinceDate?: string) {
  return useQuery({
    queryKey: ["ledgerSince", canteenId, sinceDate],
    enabled: !!canteenId && canteenId !== "all" && !!sinceDate,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_ledger")
        .select("ingredient_id, change_qty, reference_type, created_at, service_date")
        .eq("canteen_id", canteenId!)
        // A day earlier than asked for: the store issues the evening BEFORE
        // the food is cooked, so a movement serving the first day of the
        // window was written the day before it and would otherwise be missed.
        .gte("created_at", new Date(new Date(sinceDate! + "T00:00:00Z").getTime() - 864e5).toISOString().slice(0, 10))
        .order("created_at");
      if (error) throw error;
      return data;
    },
  });
}

// Full movement history of ONE ingredient ("I bought 100 kg rice — where did
// it go?"): every purchase, recipe deduction, manual adjustment and audit
// correction in order, with the running balance.
export function useIngredientLedger(ingredientId?: string, from?: string, to?: string) {
  return useQuery({
    queryKey: ["ingredientLedger", ingredientId, from, to],
    enabled: !!ingredientId && !!from && !!to,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_ledger")
        .select("*")
        .eq("ingredient_id", ingredientId!)
        .gte("created_at", from!)
        .lt("created_at", `${to}T23:59:59.999`)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

// Dish-wise consumption of one ingredient (from the automatic recipe
// deductions): which menu items used it and how much.
export function useIngredientUsageByDish(ingredientId?: string, from?: string, to?: string) {
  return useQuery({
    queryKey: ["ingredientUsageByDish", ingredientId, from, to],
    enabled: !!ingredientId && !!from && !!to,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ingredient_usage_log")
        .select("quantity_used, unit, created_at, menu_items(name)")
        .eq("ingredient_id", ingredientId!)
        .gte("created_at", from!)
        .lt("created_at", `${to}T23:59:59.999`);
      if (error) throw error;
      return data;
    },
  });
}

// Per-ingredient movement summary over a period (anti-theft variance report).
// See migration 20260711083000_variance_anti_theft.
export function useStockVarianceReport(canteenId?: string, start?: string, end?: string) {
  return useQuery({
    queryKey: ["stockVariance", canteenId, start, end],
    enabled: !!canteenId && canteenId !== "all" && !!start && !!end,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("stock_variance_report" as any, {
        p_canteen_id: canteenId,
        p_start: start,
        p_end: end,
      });
      if (error) throw error;
      return data as any[];
    },
  });
}

// Ingredient Usage Log
export function useIngredientUsageLogs(canteenId?: string) {
  return useQuery({
    queryKey: ["ingredientUsageLog", canteenId],
    queryFn: async () => {
      let q = supabase.from("ingredient_usage_log").select("*, ingredients(name), menu_items(name)").order("created_at", { ascending: false }).limit(50);
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
  });
}
