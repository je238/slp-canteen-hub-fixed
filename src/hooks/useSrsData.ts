import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { clampToCutover, REPORTING_CUTOVER_DATE } from "@/lib/cutover";

// Data layer for the SRS modules: menu planning, requisition approval,
// budgets, the vendor portal and inventory ageing. New tables are reached
// through `as any` because types.ts hasn't been regenerated yet.

export const MEAL_PERIODS = [
  { value: "breakfast", label: "Breakfast" },
  { value: "lunch", label: "Lunch" },
  { value: "evening_snacks", label: "Evening Snacks" },
  { value: "tea", label: "Tea" },
  { value: "dinner", label: "Dinner" },
  { value: "night_snacks", label: "Night Snacks" },
] as const;

// ---------------- Daily visibility + central-kitchen loans ----------------

export function useDailyOperatingSnapshot(canteenId?: string, date?: string) {
  return useQuery({
    queryKey: ["dailyOperatingSnapshot", canteenId, date],
    enabled: !!canteenId && canteenId !== "all" && !!date,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("daily_operating_snapshot" as any, {
        p_canteen_id: canteenId!, p_date: date!,
      });
      if (error) throw error;
      return (Array.isArray(data) ? data[0] : data) as any;
    },
  });
}

export function useMenuWastageContext(menuPlanId?: string) {
  return useQuery({
    queryKey: ["menuWastageContext", menuPlanId],
    enabled: !!menuPlanId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("menu_wastage_context" as any, {
        p_menu_plan_id: menuPlanId!,
      });
      if (error) throw error;
      return (data || []) as any[];
    },
  });
}

export function useCentralKitchenTransfers(canteenId?: string) {
  return useQuery({
    queryKey: ["centralKitchenTransfers", canteenId],
    enabled: !!canteenId && canteenId !== "all",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("central_kitchen_transfers" as any)
        .select("*, central_kitchen_transfer_items(*, ingredients(id,name,unit))")
        .eq("canteen_id", canteenId!)
        .order("transfer_date", { ascending: false });
      if (error) throw error;
      return (data || []) as any[];
    },
  });
}

export function useReceiveCentralKitchenTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { canteen_id: string; source: string; transfer_date: string; expected_return_date?: string; notes?: string; items: any[] }) => {
      const { data, error } = await supabase.rpc("receive_central_kitchen_transfer" as any, {
        p_canteen_id: args.canteen_id,
        p_source_name: args.source,
        p_transfer_date: args.transfer_date,
        p_expected_return_date: args.expected_return_date || null,
        p_items: args.items,
        p_notes: args.notes || null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["centralKitchenTransfers"] });
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["dailyOperatingSnapshot"] });
    },
  });
}

export function useReturnCentralKitchenTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { transfer_id: string; items: any[]; reason: string }) => {
      const { data, error } = await supabase.rpc("return_central_kitchen_transfer" as any, {
        p_transfer_id: args.transfer_id, p_items: args.items, p_reason: args.reason,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["centralKitchenTransfers"] });
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["dailyOperatingSnapshot"] });
    },
  });
}

// ---------------- Menu planning ----------------

export function useMenuPlans(canteenId?: string, from?: string, to?: string) {
  return useQuery({
    queryKey: ["menuPlans", canteenId, from, to],
    enabled: !!canteenId && canteenId !== "all" && !!from,
    queryFn: async () => {
      let q = supabase
        .from("menu_plans" as any)
        .select("*, menu_plan_items(*, menu_unit_wastage(*))")
        .eq("canteen_id", canteenId!)
        .gte("menu_date", from!)
        .order("menu_date");
      if (to) q = q.lte("menu_date", to);
      const { data, error } = await q;
      if (error) throw error;
      return data as any[];
    },
  });
}

export function useSaveMenuPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, items, ...fields }: any) => {
      const table = supabase.from("menu_plans" as any);
      const writeItems = async (planId: string) => {
        if (items.length === 0) return;
        const { error } = await supabase
          .from("menu_plan_items" as any)
          .insert(items.map((i: any) => ({ ...i, menu_plan_id: planId })));
        if (error) throw error;
      };

      if (id) {
        // Replace the dish list BEFORE touching the plan row. Publishing
        // freezes the dishes, so writing the status first would leave the
        // old lines locked against the very save that is replacing them.
        if (items) {
          const { error: dErr } = await supabase
            .from("menu_plan_items" as any).delete().eq("menu_plan_id", id);
          if (dErr) throw dErr;
          await writeItems(id);
        }
        const { data, error } = await table.update(fields).eq("id", id).select().single();
        if (error) throw error;
        return data;
      }

      const { data, error } = await table.insert(fields).select().single();
      if (error) throw error;
      if (items) await writeItems((data as any).id);   // new plan, nothing to replace
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menuPlans"] }),
  });
}

export function useUpdateMenuPlanItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...fields }: any) => {
      const { data, error } = await supabase
        .from("menu_plan_items" as any).update(fields).eq("id", id).select("id");
      if (error) throw error;
      if (!data || data.length === 0) throw new Error("You are not allowed to change this menu line");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menuPlans"] }),
  });
}

// Expected is the plan, actual is the canteen's served count, and the company
// punch is the official billing count. The database freezes a punch after its
// first save; only an Admin can correct it, with a fresh written reason.
export function useRecordMealCounts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, actual, companyPunch, reason }: {
      id: string;
      actual: number | null;
      companyPunch: number | null;
      reason?: string;
    }) => {
      const { data, error } = await supabase
        .from("menu_plans" as any)
        .update({
          actual_headcount: actual,
          company_punch_count: companyPunch,
          company_punch_source: "manual",
          count_change_reason: reason?.trim() || null,
        })
        .eq("id", id)
        .select("id");
      if (error) throw error;
      if (!data || data.length === 0) throw new Error("You are not allowed to record meal counts");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["menuPlans"] });
      qc.invalidateQueries({ queryKey: ["uncountedMeals"] });
      qc.invalidateQueries({ queryKey: ["managerDashboard"] });
      qc.invalidateQueries({ queryKey: ["operationsSummary"] });
      qc.invalidateQueries({ queryKey: ["periodSummary"] });
      qc.invalidateQueries({ queryKey: ["ownerMenuProfitBreakdown"] });
    },
  });
}

// Meals that were served but never counted — an uncounted meal is one the
// company never gets billed for.
export function useUncountedMeals(canteenId?: string, days = 7) {
  return useQuery({
    queryKey: ["uncountedMeals", canteenId, days],
    enabled: !!canteenId && canteenId !== "all",
    queryFn: async () => {
      const { data, error } = await supabase.rpc("uncounted_meals" as any, {
        p_canteen_id: canteenId, p_days: days,
      });
      if (error) throw error;
      return (data || []) as any[];
    },
  });
}

// ---------------- Requisitions ----------------

export function useRequisitions(canteenId?: string, status?: string) {
  return useQuery({
    queryKey: ["requisitions", canteenId, status, REPORTING_CUTOVER_DATE],
    enabled: !!canteenId && canteenId !== "all",
    queryFn: async () => {
      // A site can cross 100 requisitions in only a few days. The old hard
      // limit silently chopped the History tab at the 100th newest order,
      // even though the older rows were still safe in the database. Fetch in
      // stable pages so every requisition since reporting cutover is visible.
      const pageSize = 500;
      const rows: any[] = [];
      for (let from = 0; ; from += pageSize) {
        let q = supabase
          .from("requisitions" as any)
          // menu_plans comes along so the card can say which DAY's meal this is.
          // Without it the only date on screen was created_at — the day somebody
          // typed the order — and an order raised on the 16th for the 17th's
          // dinner read as a 16th order. The store keeper issuing four of these
          // at once had no way to tell them apart.
          .select("*, menu_plans(menu_date, meal_period, menu_plan_items(dish_name)), requisition_items(*, ingredients:ingredients!requisition_items_ingredient_id_fkey(name, unit, category, current_stock, cost_per_unit), original_ingredient:ingredients!requisition_items_original_ingredient_id_fkey(name, unit))")
          .eq("canteen_id", canteenId!)
          .gte("req_date", REPORTING_CUTOVER_DATE);
        if (status) q = q.eq("status", status);
        const { data, error } = await q
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, from + pageSize - 1);
        if (error) throw error;
        const page = (data || []) as any[];
        rows.push(...page);
        if (page.length < pageSize) break;
      }
      return rows;
    },
  });
}

export function useCreateRequisition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ canteen_id, menu_plan_id, meal_period, notes, expected_headcount, extra_reason, items }: {
      canteen_id: string; menu_plan_id?: string; meal_period?: string; notes?: string;
      expected_headcount?: number;
      // Why more was needed after this meal was already issued. The database
      // refuses a second draw on a meal without one.
      extra_reason?: string;
      items: { ingredient_id: string; requested_qty: number; unit?: string; rate?: number }[];
    }) => {
      const { data, error } = await supabase
        .from("requisitions" as any)
        .insert({ canteen_id, menu_plan_id, meal_period, notes, expected_headcount, extra_reason, status: "pending" })
        .select().single();
      if (error) throw error;
      const reqId = (data as any).id;
      const { error: iErr } = await supabase
        .from("requisition_items" as any)
        .insert(items.map((i) => ({ ...i, requisition_id: reqId })));
      if (iErr) throw iErr;
      return data;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["requisitions"] }); qc.invalidateQueries({ queryKey: ["availability"] }); },
  });
}

// Manager review is one atomic database action: final item/quantity changes
// and the approval status either all save together or none of them do.
export function useReviewRequisition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, lines, approve, review_notes }: {
      id: string;
      lines: { id: string; ingredient_id: string; approved_qty: number }[];
      approve: boolean;
      review_notes?: string;
    }) => {
      const { data, error } = await supabase.rpc("manager_review_requisition" as any, {
        p_req_id: id,
        p_lines: lines,
        p_approve: approve,
        p_review_notes: review_notes?.trim() || null,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["requisitions"] }); qc.invalidateQueries({ queryKey: ["availability"] }); },
  });
}

export function useIssueRequisition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (requisitionId: string) => {
      const { data, error } = await supabase.rpc("issue_requisition" as any, { p_req_id: requisitionId });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["requisitions"] });
      qc.invalidateQueries({ queryKey: ["availability"] });
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["stockLedger"] });
      qc.invalidateQueries({ queryKey: ["ledgerSince"] });
    },
  });
}

export function useIssueRequisitionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (requisitionItemId: string) => {
      const { data, error } = await supabase.rpc("issue_requisition_item" as any, {
        p_requisition_item_id: requisitionItemId,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["requisitions"] });
      qc.invalidateQueries({ queryKey: ["availability"] });
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["stockLedger"] });
      qc.invalidateQueries({ queryKey: ["ledgerSince"] });
    },
  });
}

// The quantity which physically leaves the counter is typed explicitly.
// The old one-click RPC is disabled in the database so a full approved amount
// can never be recorded merely because it happens to be on the shelf.
export function useIssueRequisitionActual() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ requisitionId, items }: {
      requisitionId: string;
      items: { requisition_item_id: string; actual_qty: number; reason?: string }[];
    }) => {
      const { data, error } = await supabase.rpc("issue_requisition_actual" as any, {
        p_req_id: requisitionId,
        p_items: items,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      for (const key of ["requisitions", "availability", "ingredients", "stockLedger", "ledgerSince",
        "consumptionReport", "operationsSummary", "periodSummary", "managerDashboard", "storeDashboard"]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export function useStoreKeeperLeaveMode(canteenId?: string) {
  return useQuery({
    queryKey: ["storeKeeperLeaveMode", canteenId],
    enabled: !!canteenId && canteenId !== "all",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("store_keeper_leave_periods" as any)
        .select("*")
        .eq("canteen_id", canteenId!)
        .is("ended_at", null)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
  });
}

export function useSetStoreKeeperLeaveMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ canteenId, onLeave, reason }: {
      canteenId: string; onLeave: boolean; reason?: string;
    }) => {
      const { data, error } = await supabase.rpc("set_store_keeper_leave_mode" as any, {
        p_canteen_id: canteenId, p_on_leave: onLeave, p_reason: reason || null,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["storeKeeperLeaveMode"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

export function useAssignLeavePickup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ requisitionId, pickupName }: {
      requisitionId: string; pickupName: string;
    }) => {
      const { data, error } = await supabase.rpc("assign_leave_pickup" as any, {
        p_req_id: requisitionId, p_pickup_name: pickupName,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["requisitions"] }),
  });
}

export function useIssueLeavePickup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ requisitionId, items, proofPath }: {
      requisitionId: string;
      items: { requisition_item_id: string; actual_qty: number; reason?: string }[];
      proofPath: string;
    }) => {
      const { data, error } = await supabase.rpc("issue_requisition_leave_pickup" as any, {
        p_req_id: requisitionId, p_items: items, p_proof_path: proofPath,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      for (const key of ["requisitions", "availability", "ingredients", "stockLedger", "ledgerSince",
        "consumptionReport", "operationsSummary", "periodSummary", "managerDashboard", "storeDashboard", "notifications"]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export function useHistoricalIssueReconciliation(canteenId?: string, date?: string) {
  return useQuery({
    queryKey: ["historicalIssueReconciliation", canteenId, date],
    enabled: !!canteenId && canteenId !== "all" && !!date,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("historical_issue_reconciliation_lines" as any, {
        p_canteen_id: canteenId,
        p_date: date,
      });
      if (error) throw error;
      return (data || []) as any[];
    },
  });
}

export function useSubmitIssueReconciliation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ requisitionId, items }: {
      requisitionId: string;
      items: { requisition_item_id: string; actual_qty: number; reason?: string }[];
    }) => {
      const { data, error } = await supabase.rpc("submit_issue_reconciliation" as any, {
        p_requisition_id: requisitionId,
        p_items: items,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["historicalIssueReconciliation"] }),
  });
}

export function useReviewIssueReconciliation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ requisitionId, approve, reason }: {
      requisitionId: string; approve: boolean; reason?: string;
    }) => {
      const { data, error } = await supabase.rpc("review_issue_reconciliation" as any, {
        p_requisition_id: requisitionId,
        p_approve: approve,
        p_reason: reason || null,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      for (const key of ["historicalIssueReconciliation", "consumptionReport", "operationsSummary",
        "periodSummary", "managerDashboard", "storeDashboard", "ownerMenuProfitBreakdown"]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export function useClosePendingRequisitionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, reason }: { itemId: string; reason: string }) => {
      const { data, error } = await supabase.rpc("close_requisition_item_pending" as any, {
        p_requisition_item_id: itemId,
        p_reason: reason,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["requisitions"] });
      qc.invalidateQueries({ queryKey: ["availability"] });
    },
  });
}

// A manager may correct an approved order until the goods move. The chef's
// original request is retained; this only lowers the final approved quantity.
// An already-issued quantity is the floor, because stock that left the store
// comes back through the separate kitchen-return flow.
export function useCorrectRequisition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, lines, reason }: {
      id: string;
      lines: { id: string; approved_qty: number }[];
      reason: string;
    }) => {
      const { data, error } = await supabase.rpc("manager_correct_requisition" as any, {
        p_req_id: id,
        p_lines: lines,
        p_reason: reason,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["requisitions"] });
      qc.invalidateQueries({ queryKey: ["availability"] });
    },
  });
}

// Admins can repair both the effective item and the final quantity while the
// order is waiting at the store. The database retains the Chef's original
// request and refuses to rename a line after any stock has been issued.
export function useAdminCorrectRequisition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, lines, reason }: {
      id: string;
      lines: { id: string; ingredient_id: string; approved_qty: number }[];
      reason: string;
    }) => {
      const { data, error } = await supabase.rpc("admin_correct_requisition" as any, {
        p_req_id: id,
        p_lines: lines,
        p_reason: reason,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["requisitions"] });
      qc.invalidateQueries({ queryKey: ["availability"] });
    },
  });
}

// ---------------- Budgets ----------------

export function useSiteBudgets(canteenId?: string) {
  return useQuery({
    queryKey: ["siteBudgets", canteenId],
    queryFn: async () => {
      let q = supabase.from("site_budgets" as any).select("*, canteens(name)").order("budget_month", { ascending: false });
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) throw error;
      return data as any[];
    },
  });
}

export function useSaveBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (b: {
      id?: string; canteen_id: string; budget_month: string;
      food_budget: number; labour_budget: number; purchase_budget: number; food_cost_pct?: number;
    }) => {
      const { id, ...fields } = b;
      const table = supabase.from("site_budgets" as any);
      const { error } = id
        ? await table.update(fields).eq("id", id)
        : await table.upsert(fields, { onConflict: "canteen_id,budget_month" });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["siteBudgets"] });
      qc.invalidateQueries({ queryKey: ["budgetVsActual"] });
    },
  });
}

export function useBudgetVsActual(canteenId?: string, month?: string) {
  return useQuery({
    queryKey: ["budgetVsActual", canteenId, month],
    enabled: !!canteenId && canteenId !== "all" && !!month,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("budget_vs_actual" as any, {
        p_canteen_id: canteenId,
        p_month: `${month}-01`,
      });
      if (error) throw error;
      return data as any;
    },
  });
}

// ---------------- Vendor portal ----------------

export function useVendorBills(canteenId?: string, supplierId?: string) {
  return useQuery({
    queryKey: ["vendorBills", canteenId, supplierId],
    queryFn: async () => {
      let q = supabase
        .from("vendor_bills" as any)
        .select("*, suppliers(name), vendor_bill_items(*)")
        .order("created_at", { ascending: false })
        .limit(100);
      if (supplierId) q = q.eq("supplier_id", supplierId);
      else if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) throw error;
      return data as any[];
    },
  });
}

export function useSubmitVendorBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ items, ...bill }: any) => {
      const { data, error } = await supabase.from("vendor_bills" as any).insert(bill).select().single();
      if (error) throw error;
      const billId = (data as any).id;
      if (items?.length) {
        const { error: iErr } = await supabase
          .from("vendor_bill_items" as any)
          .insert(items.map((i: any) => ({ ...i, vendor_bill_id: billId })));
        if (iErr) throw iErr;
      }
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendorBills"] }),
  });
}

export function useReviewVendorBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status, review_notes }: { id: string; status: string; review_notes?: string }) => {
      const { data, error } = await supabase
        .from("vendor_bills" as any)
        .update({ status, review_notes: review_notes || null, verified_at: new Date().toISOString() })
        .eq("id", id)
        .select("id");
      if (error) throw error;
      if (!data || data.length === 0) throw new Error("You are not allowed to review this bill");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendorBills"] }),
  });
}

export function useConvertVendorBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (billId: string) => {
      const { data, error } = await supabase.rpc("convert_vendor_bill" as any, { p_bill_id: billId });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vendorBills"] });
      qc.invalidateQueries({ queryKey: ["purchases"] });
    },
  });
}

// Headcount per day, summed across meal periods, from the menu plan.
// Actual beats expected once the unit manager records it. This is the
// denominator for the per-head consumption check on the daily register.
export function useHeadcountRange(canteenId?: string, from?: string, to?: string) {
  return useQuery({
    queryKey: ["headcountRange", canteenId, from, to],
    enabled: !!canteenId && canteenId !== "all" && !!from && !!to,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("menu_plans" as any)
        .select("menu_date, expected_headcount, actual_headcount, company_punch_count")
        .eq("canteen_id", canteenId!)
        .gte("menu_date", from!)
        .lte("menu_date", to!);
      if (error) throw error;
      const byDate: Record<string, number> = {};
      for (const r of (data as any[]) || []) {
        const heads = Number(r.company_punch_count ?? r.actual_headcount ?? r.expected_headcount ?? 0);
        byDate[r.menu_date] = (byDate[r.menu_date] || 0) + heads;
      }
      return byDate;
    },
  });
}

// ---------------- Reports ----------------
// Every aggregation runs in Postgres; the browser only renders the result.

function useReportRpc(name: string, key: string, canteenId?: string, from?: string, to?: string) {
  return useQuery({
    queryKey: [key, canteenId, clampToCutover(from), to],
    enabled: !!canteenId && canteenId !== "all" && !!from && !!to,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(name as any, {
        p_canteen_id: canteenId, p_start: clampToCutover(from), p_end: to,
      });
      if (error) throw error;
      return data as any;
    },
  });
}

export const usePurchaseReport = (c?: string, f?: string, t?: string) =>
  useReportRpc("purchase_report", "purchaseReport", c, f, t);

export function useVegetablePurchaseReport(canteenId?: string, from?: string, to?: string) {
  const reportFrom = clampToCutover(from);
  return useQuery({
    queryKey: ["vegetablePurchaseReport", canteenId, reportFrom, to],
    enabled: !!canteenId && canteenId !== "all" && !!reportFrom && !!to,
    queryFn: async () => {
      const endExclusive = new Date(`${to}T00:00:00+05:30`);
      endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
      const { data, error } = await (supabase as any)
        .from("purchases")
        .select("id, created_at, suppliers(name), purchase_items(id, item_name, quantity, unit, rate, total, ingredients(name, category))")
        .eq("canteen_id", canteenId)
        .eq("status", "confirmed")
        .gte("created_at", new Date(`${reportFrom}T00:00:00+05:30`).toISOString())
        .lt("created_at", endExclusive.toISOString())
        .order("created_at", { ascending: false });
      if (error) throw error;

      return (data || []).flatMap((purchase: any) =>
        (purchase.purchase_items || [])
          .filter((line: any) => {
            const category = String(line.ingredients?.category || "").trim().toLowerCase();
            return category.includes("vegetable") || ["veg", "sabzi"].includes(category);
          })
          .map((line: any) => ({
            purchase_id: purchase.id,
            purchase_item_id: line.id,
            purchase_date: new Date(purchase.created_at).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
            purchased_at: purchase.created_at,
            vendor_name: purchase.suppliers?.name || "Vendor nahi dala",
            item_name: line.ingredients?.name || line.item_name,
            category: line.ingredients?.category || "Uncategorised",
            quantity: Number(line.quantity || 0),
            unit: line.unit || "unit",
            rate: Number(line.rate || 0),
            amount: Number(line.total ?? (Number(line.quantity || 0) * Number(line.rate || 0))),
          })),
      );
    },
  });
}

export const useConsumptionReport = (c?: string, f?: string, t?: string) =>
  useReportRpc("consumption_report", "consumptionReport", c, f, t);

export function useDailyItemUsageRateTrend(
  canteenId?: string,
  date?: string,
  lookbackDays = 7,
  enabled = true,
) {
  return useQuery({
    queryKey: ["dailyItemUsageRateTrend", canteenId, date, lookbackDays],
    enabled: enabled && !!canteenId && canteenId !== "all" && !!date,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("daily_item_usage_rate_trend" as any, {
        p_canteen_id: canteenId,
        p_date: date,
        p_lookback_days: lookbackDays,
      });
      if (error) throw error;
      return (data || []) as any[];
    },
  });
}

export function useItemPurchaseRateHistory(
  canteenId?: string,
  ingredientId?: string | null,
  beforeDate?: string,
) {
  return useQuery({
    queryKey: ["itemPurchaseRateHistory", canteenId, ingredientId, beforeDate],
    enabled: !!canteenId && canteenId !== "all" && !!ingredientId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("item_purchase_rate_history" as any, {
        p_canteen_id: canteenId,
        p_ingredient_id: ingredientId,
        p_before_date: beforeDate || null,
      });
      if (error) throw error;
      return (data || []) as any[];
    },
  });
}

export const useOperationsSummary = (c?: string, f?: string, t?: string) =>
  useReportRpc("operations_summary", "operationsSummary", c, f, t);

// Owner / GM drill-down: menu profitability is based on FIFO issue value
// less accepted kitchen returns. Purchases stay separate because stock bought
// today may be used by several future menus.
export function useOwnerMenuProfitBreakdown(
  canteenId?: string,
  from?: string,
  to?: string,
  enabled = true,
) {
  return useQuery({
    queryKey: ["ownerMenuProfitBreakdown", canteenId, clampToCutover(from), to],
    enabled: enabled && !!canteenId && canteenId !== "all" && !!from && !!to,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("owner_menu_profit_breakdown" as any, {
        p_canteen_id: canteenId,
        p_start: clampToCutover(from),
        p_end: to,
      });
      if (error) throw error;
      return data as any;
    },
  });
}

// The operations summary only contains one total. This log carries the audit
// detail an admin needs: meal, dish, internal unit, weight, manager and the
// immutable photo path. The existing database function accepts a day count,
// so the selected report window is filtered once more in the client.
export function useWastageLog(canteenId?: string, from?: string, to?: string) {
  return useQuery({
    queryKey: ["wastageLog", canteenId, clampToCutover(from), to],
    enabled: !!canteenId && canteenId !== "all" && !!from && !!to,
    queryFn: async () => {
      const start = clampToCutover(from)!;
      const startMs = new Date(`${start}T00:00:00+05:30`).getTime();
      const days = Math.min(366, Math.max(1, Math.ceil((Date.now() - startMs) / 86_400_000) + 2));
      const { data, error } = await supabase.rpc("wastage_log" as any, {
        p_canteen_id: canteenId,
        p_days: days,
      });
      if (error) throw error;
      return ((data || []) as any[]).filter((row: any) =>
        row.menu_date >= start && row.menu_date <= to!
      );
    },
  });
}

// Role home screens. Each returns one JSON blob so the dashboard is a single
// round trip rather than a dozen queries.
function useDashboardRpc(name: string, key: string, canteenId?: string, date?: string) {
  return useQuery({
    queryKey: [key, canteenId, date],
    enabled: !!canteenId && canteenId !== "all" && !!date,
    refetchInterval: 120_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(name as any, {
        p_canteen_id: canteenId, p_date: date,
      });
      if (error) throw error;
      return data as any;
    },
  });
}

export const useManagerDashboard = (c?: string, d?: string) =>
  useDashboardRpc("manager_dashboard", "managerDashboard", c, d);

export const useStoreKeeperDashboard = (c?: string, d?: string) =>
  useDashboardRpc("store_keeper_dashboard", "storeKeeperDashboard", c, d);

// The store keeper's day sheet. Completed lines stay on the screen so the
// kitchen and store can reconcile Manga / Mila / Wapas / Use hua / Baaki.
export function useTodayIssueDetails(canteenId?: string, date?: string) {
  return useQuery({
    queryKey: ["todayIssueDetails", canteenId, date],
    enabled: !!canteenId && canteenId !== "all" && !!date,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("today_issue_detail" as any, {
        p_canteen_id: canteenId, p_date: date,
      });
      if (error) throw error;
      return (data || []) as any[];
    },
  });
}

export function useVendorStockReport(canteenId?: string) {
  return useQuery({
    queryKey: ["vendorStock", canteenId],
    enabled: !!canteenId && canteenId !== "all",
    queryFn: async () => {
      const { data, error } = await supabase.rpc("vendor_stock_report" as any, {
        p_canteen_id: canteenId,
      });
      if (error) throw error;
      return data as any[];
    },
  });
}

export const useMealCostReport = (c?: string, f?: string, t?: string) =>
  useReportRpc("meal_cost_report", "mealCost", c, f, t);

// Moving stock between sites — the store keeper's transfer module.
export function useTransferStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ from, to, items, note }: {
      from: string; to: string; items: { ingredient_id: string; qty: number }[]; note?: string;
    }) => {
      const { data, error } = await supabase.rpc("transfer_stock" as any, {
        p_from_canteen: from, p_to_canteen: to, p_items: items, p_note: note || null,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["ledgerSince"] });
      qc.invalidateQueries({ queryKey: ["storeKeeperDashboard"] });
    },
  });
}

export const useStockInOutReport = (c?: string, f?: string, t?: string) =>
  useReportRpc("stock_in_out_report", "stockInOut", c, f, t);

// One function serves both the weekly performance report and the monthly
// summary — the only difference is the dates handed to it.
export const usePeriodSummary = (c?: string, f?: string, t?: string) =>
  useReportRpc("period_summary", "periodSummary", c, f, t);

export function useWeeklyBudget(canteenId?: string, month?: string) {
  return useQuery({
    queryKey: ["weeklyBudget", canteenId, month],
    enabled: !!canteenId && canteenId !== "all" && !!month,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("weekly_budget_utilisation" as any, {
        p_canteen_id: canteenId, p_month: `${month}-01`,
      });
      if (error) throw error;
      return data as any[];
    },
  });
}

export function useSitePerformance(from?: string, to?: string) {
  return useQuery({
    queryKey: ["sitePerformance", clampToCutover(from), to],
    enabled: !!from && !!to,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("site_performance" as any, {
        p_start: clampToCutover(from), p_end: to,
      });
      if (error) throw error;
      return data as any[];
    },
  });
}

// One RLS-scoped row per site for the Owner/Super Admin and Operations
// Manager control rooms. The database does the cross-site aggregation so a
// growing group does not make the phone download every ledger row.
export function useExecutiveSiteDashboard(date?: string) {
  return useQuery({
    queryKey: ["executiveSiteDashboard", date],
    enabled: !!date,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("executive_site_dashboard" as any, { p_date: date });
      if (error) throw error;
      return (data || []) as any[];
    },
  });
}

// Rates the store keeper actually scanned, never typed by the kitchen.
export function useIngredientRates(canteenId?: string) {
  return useQuery({
    queryKey: ["ingredientRates", canteenId],
    // "All sites" is a real choice, and it is what an admin lands on. Refusing
    // to run here left every screen that asks for a rate silently falling back
    // to the item's last-purchase cost — so the inventory page added up to
    // 7.87 lakh while the shelf was worth 11.47, and nothing on the page said
    // which figure it was showing.
    enabled: !!canteenId,
    queryFn: async () => {
      let q = supabase.from("ingredient_rates" as any).select("*");
      if (canteenId !== "all") q = q.eq("canteen_id", canteenId!);
      const { data, error } = await q.order("category").order("name");
      if (error) throw error;
      return data as any[];
    },
  });
}

// Learned from this site's own issue history ÷ the headcount it served.
// Give it tomorrow's expected headcount and it sizes the requisition.
export function useSuggestedRequisition(canteenId?: string, headcount?: number) {
  return useQuery({
    queryKey: ["suggestRequisition", canteenId, headcount],
    enabled: !!canteenId && canteenId !== "all" && !!headcount && headcount > 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("suggest_requisition" as any, {
        p_canteen_id: canteenId, p_headcount: headcount, p_days: 30,
      });
      if (error) throw error;
      return data as any[];
    },
  });
}

// ---------------- Notifications ----------------

export function useNotifications(canteenId?: string) {
  return useQuery({
    queryKey: ["notifications", canteenId],
    refetchInterval: 60_000,
    queryFn: async () => {
      let q = supabase
        .from("notifications" as any)
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) return [] as any[];   // table may predate this deploy
      return data as any[];
    },
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("notifications" as any)
        .update({ read_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

// ---------------- Geo-tagged movement photos ----------------
// Evidence of what physically moved: the store keeper's issue photo, a
// vendor delivery shot, an audit picture. Append-only by policy.

export function useStockPhotos(canteenId?: string, referenceId?: string, photoType?: string) {
  return useQuery({
    queryKey: ["stockPhotos", canteenId, referenceId, photoType],
    enabled: !!canteenId && canteenId !== "all",
    queryFn: async () => {
      let q = supabase
        .from("stock_photos" as any)
        .select("*")
        .eq("canteen_id", canteenId!)
        .order("created_at", { ascending: false })
        .limit(100);
      if (referenceId) q = q.eq("reference_id", referenceId);
      if (photoType) q = q.eq("photo_type", photoType);
      const { data, error } = await q;
      if (error) throw error;
      return data as any[];
    },
  });
}

export function useAddStockPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (row: {
      canteen_id: string; photo_type: string; reference_id?: string | null;
      image_path: string; media_kind?: string; latitude?: number | null;
      longitude?: number | null; geo_accuracy?: number | null;
      captured_at?: string | null; note?: string | null;
    }) => {
      const { data, error } = await supabase.from("stock_photos" as any).insert(row).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["stockPhotos"] }),
  });
}

// ---------------- Inventory ageing ----------------

export function useStockAgeing(canteenId?: string) {
  return useQuery({
    queryKey: ["stockAgeing", canteenId],
    enabled: !!canteenId && canteenId !== "all",
    queryFn: async () => {
      const { data, error } = await supabase.rpc("stock_ageing" as any, { p_canteen_id: canteenId });
      if (error) throw error;
      return data as any[];
    },
  });
}

// ---------------- The kitchen's day ----------------
// The whole day in the order it gets cooked, each dish carrying what it
// takes. Until a dish has a recipe its ingredient list comes back empty and
// the chef is offered the chance to fill it in — after which every future
// menu carrying that dish name already knows.
export function useDayKitchenPlan(canteenId?: string, date?: string) {
  return useQuery({
    queryKey: ["kitchenPlan", canteenId, date],
    enabled: !!canteenId && canteenId !== "all" && !!date,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("day_kitchen_plan" as any, {
        p_canteen_id: canteenId, p_date: date,
      });
      if (error) throw error;
      return (data || []) as any[];
    },
  });
}

export function useSaveDishRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      canteen_id: string; dish_name: string;
      items: { ingredient_id: string; quantity: number; unit: string }[];
      yield_qty: number; yield_unit: string;
    }) => {
      const { data, error } = await supabase.rpc("save_dish_recipe" as any, {
        p_canteen_id: args.canteen_id,
        p_dish_name: args.dish_name,
        p_items: args.items,
        p_yield_qty: args.yield_qty,
        p_yield_unit: args.yield_unit,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kitchenPlan"] });
      qc.invalidateQueries({ queryKey: ["menuPlans"] });
      qc.invalidateQueries({ queryKey: ["recipes"] });
    },
  });
}

// ---------------- Sending unused stock back ----------------
// The kitchen draws for the day and rarely uses every gram. What comes back
// has to go back on the books, or the day's consumption is overstated and
// the surplus sits in the kitchen unaccounted for.

export function useReturnableItems(requisitionId?: string) {
  return useQuery({
    queryKey: ["returnable", requisitionId],
    enabled: !!requisitionId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("returnable_items" as any, {
        p_requisition_id: requisitionId,
      });
      if (error) throw error;
      return (data || []) as any[];
    },
  });
}

export function useKitchenReturns(canteenId?: string, status = "pending") {
  return useQuery({
    queryKey: ["kitchenReturns", canteenId, status],
    enabled: !!canteenId && canteenId !== "all",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("kitchen_returns" as any)
        .select("*, ingredients(name, unit), requisitions(req_no)")
        .eq("canteen_id", canteenId!)
        .eq("status", status)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data || []) as any[];
    },
  });
}

export function useReturnToStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      requisition_id: string;
      items: { ingredient_id: string; qty: number; reason?: string }[];
      reason?: string;
    }) => {
      const { data, error } = await supabase.rpc("return_to_store" as any, {
        p_requisition_id: args.requisition_id,
        p_items: args.items,
        p_reason: args.reason ?? null,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kitchenReturns"] });
      qc.invalidateQueries({ queryKey: ["returnable"] });
      qc.invalidateQueries({ queryKey: ["requisitions"] });
      qc.invalidateQueries({ queryKey: ["availability"] });
    },
  });
}

export function useAcceptReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, accept }: { id: string; accept: boolean }) => {
      const { data, error } = await supabase.rpc("accept_return" as any, {
        p_return_id: id, p_accept: accept,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kitchenReturns"] });
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["stockLedger"] });
      qc.invalidateQueries({ queryKey: ["returnable"] });
      qc.invalidateQueries({ queryKey: ["todayIssueDetails"] });
      qc.invalidateQueries({ queryKey: ["storeKeeperDashboard"] });
      qc.invalidateQueries({ queryKey: ["managerDashboard"] });
      qc.invalidateQueries({ queryKey: ["periodSummary"] });
      qc.invalidateQueries({ queryKey: ["consumptionReport"] });
    },
  });
}

// ---------------- Two names for one thing ----------------
// Stock is matched to an item by its exact name, so a bill read as "Rose"
// when it meant "Rice" opens a second item and the stock for one ingredient
// ends up sitting in two places. These find it and put it back together.

export function useSimilarIngredients(canteenId?: string) {
  return useQuery({
    queryKey: ["similarIngredients", canteenId],
    enabled: !!canteenId && canteenId !== "all",
    queryFn: async () => {
      const { data, error } = await supabase.rpc("similar_ingredients" as any, {
        p_canteen_id: canteenId,
      });
      if (error) throw error;
      return (data || []) as any[];
    },
  });
}

export function useMergeIngredients() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ from, into }: { from: string; into: string }) => {
      const { data, error } = await supabase.rpc("merge_ingredients" as any, {
        p_from: from, p_into: into,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["similarIngredients"] });
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["stockLedger"] });
    },
  });
}

// ---------------- Planning ahead ----------------
// The company sends the menu as a hard copy for a fortnight or more, so the
// manager sits once and enters the lot. This is the map of that work: every
// working day in the window, what is on it, and what is still missing.
export function usePlanningWindow(canteenId?: string, days = 30) {
  return useQuery({
    queryKey: ["planningWindow", canteenId, days],
    enabled: !!canteenId && canteenId !== "all",
    queryFn: async () => {
      const { data, error } = await supabase.rpc("planning_window" as any, {
        p_canteen_id: canteenId, p_n: days,
      });
      if (error) throw error;
      return (data || []) as any[];
    },
  });
}

// The manager's one job each evening: tomorrow's menu, with its headcount,
// sent to the chef. Planning a month ahead is fine; only tomorrow goes out.
export function useDueToPublish(canteenId?: string) {
  return useQuery({
    queryKey: ["dueToPublish", canteenId],
    enabled: !!canteenId && canteenId !== "all",
    queryFn: async () => {
      const { data, error } = await supabase.rpc("due_to_publish" as any, {
        p_canteen_id: canteenId,
      });
      if (error) throw error;
      return (data || []) as any[];
    },
  });
}

// An approval taken back, right up until the stock moves. A pending order
// could always be rejected; an approved one had nowhere to go, so an order
// approved against an empty shelf simply sat there unissuable.
export function useSendRequisitionBack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason?: string }) => {
      const { data, error } = await supabase.rpc("send_requisition_back" as any, {
        p_req_id: id, p_reason: reason || null,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["requisitions"] }); qc.invalidateQueries({ queryKey: ["availability"] }); },
  });
}

export function useCancelRequisition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason?: string }) => {
      const { data, error } = await supabase.rpc("cancel_requisition" as any, {
        p_req_id: id, p_reason: reason || null,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["requisitions"] }); qc.invalidateQueries({ queryKey: ["availability"] }); },
  });
}

// Typing a stock figure is normally an admin act — the store keeper holds the
// key to the store, and letting them rewrite the store's own record is how a
// shortage gets written away by the person it points at. During setup that
// rule is relaxed for a few days, and this is how a screen knows.
export function useStockEditingOpen(canteenId?: string) {
  return useQuery({
    queryKey: ["stockEditingOpen", canteenId],
    enabled: !!canteenId && canteenId !== "all",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("canteens")
        .select("stock_edit_open_until")
        .eq("id", canteenId!)
        .maybeSingle();
      // The column may not be there yet on an older database. A missing
      // window is a shut window, which is the safe answer either way.
      if (error) return { open: false, until: null as string | null };
      const until = (data as any)?.stock_edit_open_until;
      return { open: !!until && new Date(until) > new Date(), until: until as string | null };
    },
    retry: false,
    refetchInterval: 5 * 60 * 1000,   // it closes on its own; notice when it does
  });
}

// A rate lives in two places: the item's own cost_per_unit, and each lot's
// rate taken off the bill it arrived on. Correcting only the first leaves an
// item that came in on a bill unmoved, so this fixes both — but only lots
// nothing has been drawn from, because a lot that has been issued has already
// priced a meal.
export function useSetIngredientRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, rate, reason }: { id: string; rate: number; reason?: string }) => {
      const { data, error } = await supabase.rpc("set_ingredient_rate" as any, {
        p_ingredient_id: id, p_rate: rate, p_reason: reason || null,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["ingredientRates"] });
    },
  });
}

// Inventory's edit dialog changes fields that share one ingredient row. Doing
// stock, planning, rate and name as separate HTTP requests made one Save take
// several seconds and started a full-list refresh after every request. The
// database function keeps the existing audit functions as the authority, but
// runs the whole edit in one transaction and one round trip.
export function useSaveInventoryItemEdit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      id: string;
      new_stock: number;
      avg_daily_usage: number | null;
      reorder_level: number | null;
      maximum_stock: number | null;
      rate: number | null;
      name: string;
      unit: string;
      unit_change_confirmed: boolean;
      reason: string;
    }) => {
      const { data, error } = await supabase.rpc("save_inventory_item_edit" as any, {
        p_ingredient_id: args.id,
        p_new_stock: args.new_stock,
        p_avg_daily_usage: args.avg_daily_usage,
        p_reorder_level: args.reorder_level,
        p_maximum_stock: args.maximum_stock,
        p_rate: args.rate,
        p_name: args.name,
        p_unit: args.unit,
        p_unit_change_confirmed: args.unit_change_confirmed,
        p_reason: args.reason || null,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["ingredientRates"] });
      qc.invalidateQueries({ queryKey: ["availability"] });
      qc.invalidateQueries({ queryKey: ["stockLedger"] });
      qc.invalidateQueries({ queryKey: ["ledgerSince"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

// What is actually free to order: the shelf, minus everything already asked
// for on an order that has not been handed over yet. The shelf figure counts
// goods that are already promised to another meal — 100 kg of sugar with 12
// already ordered for breakfast is 88 kg of sugar, whether or not the store
// keeper has remembered to press "issue".
export function useAvailability(canteenId?: string) {
  return useQuery({
    queryKey: ["availability", canteenId],
    enabled: !!canteenId,
    queryFn: async () => {
      let q = supabase
        .from("ingredient_availability" as any)
        .select("ingredient_id, name, unit, current_stock, committed, free_qty, arrives_daily, delivery_every_days, next_delivery_on, last_received_on, next_arrival");
      if (canteenId && canteenId !== "all") q = q.eq("canteen_id", canteenId);
      const { data, error } = await q;
      if (error) throw error;
      return data as any[];
    },
    // The whole point is that it is current. A stale free figure is the bug
    // this view exists to fix.
    staleTime: 0,
  });
}

export function useSetDeliverySchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ingredientId, everyDays, nextDeliveryOn }: {
      ingredientId: string; everyDays: number; nextDeliveryOn: string | null;
    }) => {
      const { data, error } = await supabase.rpc("set_ingredient_delivery_schedule" as any, {
        p_ingredient_id: ingredientId,
        p_every_days: everyDays,
        p_next_delivery_on: nextDeliveryOn || null,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["availability"] });
      qc.invalidateQueries({ queryKey: ["ingredients"] });
    },
  });
}

export function useHistoricalUnitReview(canteenId?: string) {
  return useQuery({
    queryKey: ["historicalUnitReview", canteenId],
    enabled: !!canteenId && canteenId !== "all",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("historical_unit_review" as any)
        .select("*")
        .eq("canteen_id", canteenId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as any[];
    },
  });
}

// Fixing a spelling, at the shelf, by the person reading the sack. It goes
// through a function rather than an UPDATE so that it can be logged, and so
// that renaming ONTO a name already on the list is refused — one word on two
// rows with neither total right is worse than the typo was. That case is a
// merge, and the error says so.
export function useRenameIngredient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name, reason }: { id: string; name: string; reason?: string }) => {
      const { data, error } = await supabase.rpc("rename_ingredient" as any, {
        p_ingredient_id: id, p_name: name, p_reason: reason || null,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["ingredientRates"] });
    },
  });
}

// Taking a name out of the list. Only ever a name — the database refuses if
// the item holds stock or has ever moved, because those rows are the record
// of what the kitchen cooked. For a misspelling that HAS traded, the answer
// is a merge, and the error says so.
export function useDeleteIngredient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason?: string }) => {
      const { data, error } = await supabase.rpc("delete_ingredient" as any, {
        p_ingredient_id: id,
        p_reason: reason || null,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingredients"] });
      qc.invalidateQueries({ queryKey: ["ingredientRates"] });
      qc.invalidateQueries({ queryKey: ["similarIngredients"] });
    },
  });
}
