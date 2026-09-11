import { useEffect, useMemo, useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import {
  useRequisitions, useCreateRequisition, useReviewRequisition, useIssueRequisitionActual,
  useSendRequisitionBack, useClosePendingRequisitionItem, useCorrectRequisition, useAdminCorrectRequisition, useCancelRequisition,
  useMenuPlans, useIngredientRates, useSuggestedRequisition, useAvailability, useDailyOperatingSnapshot,
  useMenuWastageContext, useHistoricalIssueReconciliation, useSubmitIssueReconciliation,
  useReviewIssueReconciliation, useStoreKeeperLeaveMode, useSetStoreKeeperLeaveMode,
  useAssignLeavePickup, useIssueLeavePickup, MEAL_PERIODS,
} from "@/hooks/useSrsData";
import { sayShortage, sayShortageSummary, speechSupported, isMuted, setMuted } from "@/lib/speak";
import { supabase } from "@/integrations/supabase/client";
import { useIngredients } from "@/hooks/useSupabaseData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertTriangle, CalendarDays, Camera, CheckCircle2, ChevronDown, ClipboardList, PackageCheck, Pencil, Plus, Search, Send, Sparkles, Trash2, Undo2, UserCheck, Users, Zap } from "lucide-react";
import { toast } from "sonner";
import { fmtDate, fmtDateTime, fmtDayDate, shiftIst, todayIst, tomorrowIst, yesterdayIst } from "@/lib/date";
import { requisitionMenuDishes } from "@/lib/requisitionMenu";
import KitchenPlan from "@/components/KitchenPlan";
import { ReturnButton, PendingReturns } from "@/components/KitchenReturns";
import VoiceReasonInput from "@/components/VoiceReasonInput";

// The approval chain on one screen, shown according to who is looking:
//   Chef        → raise a requisition against a published menu
//   Unit Mgr    → review it; each line may be moved by at most ±7%
//   Store Keeper→ issue the approved requisition (stock moves here)
// The ±7% band is enforced by a DB trigger, not just by this UI.

const TOLERANCE = 0.07;
const money = (v: any) => `₹${Math.round(Number(v) || 0).toLocaleString("en-IN")}`;

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-warning/10 text-warning border-warning/20",
  approved: "bg-success/10 text-success border-success/20",
  rejected: "bg-destructive/10 text-destructive border-destructive/20",
  issued: "bg-accent/10 text-accent border-accent/20",
  cancelled: "bg-muted text-muted-foreground",
};

export default function RequisitionsPage() {
  const { selectedCanteen } = useAppContext();
  const { isManagerOrAbove, isChef, canIssueStock, roleData } = useAuth();
  const canFullEdit = isManagerOrAbove;
  const isStoreKeeper = String(roleData.role).toLowerCase() === "store_keeper";
  const [kitchenDate, setKitchenDate] = useState(todayIst());
  const { data: reqs, isLoading } = useRequisitions(selectedCanteen);
  const { data: ingredients } = useIngredients(selectedCanteen);
  // Yesterday, today AND tomorrow. The chef orders in the afternoon for food
  // that will be cooked tomorrow — the store issues that same evening between
  // six and seven. Fetching only today meant the one menu the manager had
  // actually published, tomorrow's, was not in the list at all, and the chef
  // was left picking today's unpublished draft or nothing.
  //
  // Yesterday is there because a day gets missed. On 14/08 the kitchen served
  // 2444 lunches and no order was ever raised: the food was gone from the
  // shelf and the book still counted it. Locking the chef out of yesterday
  // does not put that food back — it only guarantees the shelf and the book
  // never agree again. The late entry is allowed, it is labelled as late, and
  // it still goes to the manager and then the store like any other.
  const { data: menus } = useMenuPlans(selectedCanteen, yesterdayIst(), tomorrowIst());
  const { data: availability } = useAvailability(selectedCanteen);
  const [muted, setMutedState] = useState(isMuted());
  const createReq = useCreateRequisition();
  const reviewReq = useReviewRequisition();
  const issueActual = useIssueRequisitionActual();
  const issueLeavePickup = useIssueLeavePickup();
  const sendBack = useSendRequisitionBack();
  const closePending = useClosePendingRequisitionItem();
  const correctReq = useCorrectRequisition();
  const adminCorrectReq = useAdminCorrectRequisition();
  const cancelReq = useCancelRequisition();
  const { data: activeStoreLeave } = useStoreKeeperLeaveMode(selectedCanteen);
  const setStoreLeave = useSetStoreKeeperLeaveMode();
  const assignLeavePickup = useAssignLeavePickup();
  const storeLeaveMode = !!activeStoreLeave;
  const canProcessApproved = storeLeaveMode ? (isChef || isManagerOrAbove) : canIssueStock;

  // An approval is a decision, and a decision can be wrong. Until the goods
  // actually move it can be undone; after that it is not a decision any more,
  // it is a fact about where the food went.
  const doSendBack = async (id: string) => {
    const why = window.prompt(
      "Send this order back to the chef. Why? (the chef sees this)",
      "some items are not in stock");
    if (why === null) return;
    try {
      await sendBack.mutateAsync({ id, reason: why || undefined });
      toast.success("Sent back — the chef can change it and send it again");
    } catch (e: any) { toast.error(e.message); }
  };

  const toggleStoreLeaveMode = async () => {
    if (!selectedCanteen || selectedCanteen === "all") return;
    const reason = storeLeaveMode ? undefined : window.prompt(
      "Store Keeper chhutti par kyun hai?",
      "Store Keeper on leave");
    if (!storeLeaveMode && reason === null) return;
    try {
      await setStoreLeave.mutateAsync({
        canteenId: selectedCanteen,
        onLeave: !storeLeaveMode,
        reason: reason?.trim() || undefined,
      });
      toast.success(storeLeaveMode
        ? "Normal Store Keeper issue chalu ho gaya"
        : "Leave mode ON — ab named self-pickup aur photo compulsory hai");
    } catch (e: any) { toast.error(e.message); }
  };

  const openPickupProof = async (path: string) => {
    const { data, error } = await supabase.storage.from("stock-photos").createSignedUrl(path, 300);
    if (error || !data?.signedUrl) return toast.error(error?.message || "Photo nahi khuli");
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  const assignPickupForApproved = async (r: any) => {
    const name = window.prompt("Saman lene wale kitchen person ka naam", r.pickup_person_name || "");
    if (name === null) return;
    if (name.trim().length < 2) return toast.error("Saman lene wale ka poora naam likhein");
    try {
      await assignLeavePickup.mutateAsync({ requisitionId: r.id, pickupName: name.trim() });
      toast.success(`${name.trim()} ko pickup assign ho gaya`);
    } catch (e: any) { toast.error(e.message); }
  };

  // ----- raise -----
  const [newOpen, setNewOpen] = useState(false);
  const [chefExtraMode, setChefExtraMode] = useState(false);
  const [search, setSearch] = useState("");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [mealPeriod, setMealPeriod] = useState<string>("lunch");
  const [menuPlanId, setMenuPlanId] = useState<string>("");
  const { data: chefMoney } = useDailyOperatingSnapshot(isChef ? selectedCanteen : undefined, kitchenDate);
  const { data: wastageContext = [] } = useMenuWastageContext(menuPlanId || undefined);
  // Halfway through cooking and the poha is short. Asking for more has to be
  // quick — a chef who cannot get 5 kg in a minute will just take it, and
  // then the book and the shelf stop agreeing for good.
  const [extraReason, setExtraReason] = useState("");
  const [notes, setNotes] = useState("");
  // Headcount drives the whole request: the manager's plan sets it, and the
  // suggestion engine sizes every line against it.
  const [headcount, setHeadcount] = useState<string>("");
  const { data: rates } = useIngredientRates(selectedCanteen);
  const { data: suggestions } = useSuggestedRequisition(selectedCanteen, Number(headcount) || 0);

  // ----- review -----
  const [review, setReview] = useState<any>(null);
  const [approved, setApproved] = useState<Record<string, string>>({});
  const [reviewNotes, setReviewNotes] = useState("");
  const [pickupName, setPickupName] = useState("");
  const [correction, setCorrection] = useState<any>(null);
  const [correctedQty, setCorrectedQty] = useState<Record<string, string>>({});
  const [correctedIngredient, setCorrectedIngredient] = useState<Record<string, string>>({});
  const [correctionReason, setCorrectionReason] = useState("");
  const [requisitionDate, setRequisitionDate] = useState("");
  const [openRequisitionDay, setOpenRequisitionDay] = useState<string | null>(null);
  const [openRequisitionMeal, setOpenRequisitionMeal] = useState<string | null>(null);
  const [actualIssueReq, setActualIssueReq] = useState<any>(null);
  const [actualIssueQty, setActualIssueQty] = useState<Record<string, string>>({});
  const [actualIssueReason, setActualIssueReason] = useState<Record<string, string>>({});
  const [actualIssueProof, setActualIssueProof] = useState<File | null>(null);
  const [reconciliationDate, setReconciliationDate] = useState("2026-08-20");
  const { data: reconciliationLines = [], isLoading: reconciliationLoading } =
    useHistoricalIssueReconciliation(canIssueStock ? selectedCanteen : undefined, reconciliationDate);
  const submitReconciliation = useSubmitIssueReconciliation();
  const reviewReconciliation = useReviewIssueReconciliation();
  const [reconciledQty, setReconciledQty] = useState<Record<string, string>>({});
  const [reconciledReason, setReconciledReason] = useState<Record<string, string>>({});

  const list = reqs || [];
  // Waiting work reads in the order it will be cooked, not the order it was
  // typed. The store keeper issuing at six in the evening wants the 14th's
  // dinner before the 15th's breakfast; created_at gave him neither.
  const MEAL_ORDER = MEAL_PERIODS.map((m) => m.value);
  const byService = (a: any, b: any) => {
    const da = a.menu_plans?.menu_date || "9999-12-31";
    const db = b.menu_plans?.menu_date || "9999-12-31";
    if (da !== db) return da.localeCompare(db);
    return MEAL_ORDER.indexOf(a.meal_period) - MEAL_ORDER.indexOf(b.meal_period);
  };
  const pending = list.filter((r: any) => r.status === "pending").sort(byService);
  const approvedRaw = list.filter((r: any) => r.status === "approved");
  const done = list.filter((r: any) => ["issued", "rejected", "cancelled"].includes(r.status));

  // What a kg off this shelf actually costs — the money tied up in the lots
  // on hand, divided by what is on hand. The last invoice rate is a different
  // question (what the NEXT delivery will cost) and quoting it against stock
  // bought cheaper made every order read high.
  const rateOf = (id: string) => {
    const r = (rates || []).find((x: any) => x.ingredient_id === id);
    const onShelf = Number(r?.stock_rate) || 0;
    return {
      rate: onShelf || Number(r?.latest_rate) || 0,
      fromInvoice: !!r?.rate_from_invoice,
      latest: Number(r?.latest_rate) || 0,
    };
  };

  // What this exact quantity will be charged. The store issues oldest lot
  // first, so 60 kg off 50@50 + 20@54 costs 3,040, not 60 x the blended
  // 51.14. Walking the same lots here means the chef is quoted the figure
  // that will actually land in the books.
  const costOf = (id: string, qty: number) => {
    const r = (rates || []).find((x: any) => x.ingredient_id === id);
    if (!r || !(qty > 0)) return 0;
    let left = qty, cost = 0;
    for (const lot of (r.lots || []) as any[]) {
      if (left <= 0) break;
      const take = Math.min(left, Number(lot.qty) || 0);
      cost += take * (Number(lot.rate) || 0);
      left -= take;
    }
    // Stock with no lot behind it — opening balance, hand adjustment — at the
    // item's standard cost, which is how the store will price it too.
    if (left > 0) cost += left * (Number(r.unlotted_rate) || Number(r.stock_rate) || 0);
    return cost;
  };
  const suggestionOf = (id: string) =>
    (suggestions || []).find((s: any) => s.ingredient_id === id);

  // What is FREE, not what is on the shelf. The shelf counts sugar already
  // promised to breakfast; ordering lunch against it is how 25 items came to
  // be over-committed at once.
  // Declared up here, ahead of everything that reads it. It used to sit below
  // `chosen`, which calls arrivalNote(), which reads this — a const read
  // before its own line is a dead-zone error, and the whole page came up as
  // "Cannot access 'Rn' before initialization" on every load.
  const pickedMenu = (menus || []).find((m: any) => m.id === menuPlanId);

  const availOf = (id: string) => (availability || []).find((a: any) => a.ingredient_id === id);
  const freeOf = (i: any) => {
    const a = availOf(i.id);
    return a ? Number(a.free_qty) : Number(i.current_stock);
  };
  const arrivesDaily = (i: any) => !!availOf(i.id)?.arrives_daily;

  // "It comes tomorrow" is the half of the sentence that decides whether a
  // shortfall is a problem. Said in the words a person uses for a date two
  // days out, and measured against the day the food is actually cooked — not
  // against today, because the order is raised the evening before.
  const arrivalNote = (i: any): { text: string; ok: boolean } | null => {
    const a = availOf(i.id);
    if (!a?.next_arrival) return null;
    const next = String(a.next_arrival);
    const cookOn = pickedMenu?.menu_date || tomorrowIst();
    const word = next === todayIst() ? "aaj aayega"
      : next === tomorrowIst() ? "kal aayega"
      : next === shiftIst(todayIst(), 2) ? "parso aayega"
      : `${fmtDate(next)} ko aayega`;
    // In time only if it lands on or before the day it will be cooked.
    return { text: word, ok: next <= cookOn };
  };

  const chosen = (ingredients || [])
    .map((i: any) => ({
      ...i, q: Number(qty[i.id]) || 0, free: freeOf(i),
      daily: arrivesDaily(i), arrival: arrivalNote(i),
    }))
    .filter((i: any) => i.q > 0);

  // Lines the store could not actually issue, caught here rather than when the
  // store keeper is standing at the counter.
  //
  // An item with a delivery landing on or before the day the food is cooked is
  // NOT short — an empty paneer shelf on the 13th, for the 14th's lunch, is
  // correct, and warning about it teaches the chef to ignore warnings. But the
  // same vegetable arriving the day AFTER the meal is a real problem, and that
  // is exactly the case the old blanket "arrives daily" rule was hiding.
  const shortLines = chosen.filter((i: any) => i.q > i.free && !(i.arrival && i.arrival.ok));

  // The running total the chef watches as they build the order — the same
  // lot walk the store will do, so the number does not move at the counter.
  const requestValue = chosen.reduce(
    (s: number, i: any) => s + costOf(i.id, i.q), 0
  );

  // Item picker grouped by category, as the kitchen thinks about it.
  const grouped = useMemo(() => {
    const m: Record<string, any[]> = {};
    for (const i of (ingredients || []) as any[]) {
      if (!i.name.toLowerCase().includes(search.toLowerCase())) continue;
      const cat = i.category || "Other";
      (m[cat] = m[cat] || []).push(i);
    }
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0]));
  }, [ingredients, search]);

  const applySuggestions = () => {
    if (!suggestions?.length) { toast.error("Not enough history yet to suggest quantities"); return; }
    const next: Record<string, string> = { ...qty };
    let n = 0;
    for (const s of suggestions) {
      const want = Number(s.suggested_qty);
      if (want > 0) { next[s.ingredient_id] = String(Math.round(want * 100) / 100); n++; }
    }
    setQty(next);
    toast.success(`Filled ${n} items from what this canteen actually used per head`);
  };

  // This meal has already had stock released against it, so anything more
  // is a top-up: same approval, same issue, but it says what it is.
  const alreadyIssued = !!menuPlanId && list.some(
    (r: any) => r.menu_plan_id === menuPlanId && ["approved", "issued"].includes(r.status));

  const submitNew = async () => {
    if (selectedCanteen === "all") { toast.error("Select a site first"); return; }
    if (chosen.length === 0) { toast.error("Enter at least one quantity"); return; }
    try {
      await createReq.mutateAsync({
        canteen_id: selectedCanteen,
        menu_plan_id: menuPlanId || undefined,
        meal_period: mealPeriod,
        notes: notes || undefined,
        expected_headcount: Number(headcount) || undefined,
        extra_reason: (alreadyIssued || chefExtraMode) ? extraReason.trim() : undefined,
        // Freeze the invoice rate onto the line so the amount the manager
        // approves is the amount that was requested.
        items: chosen.map((i: any) => ({
          ingredient_id: i.id, requested_qty: i.q, unit: i.unit, rate: rateOf(i.id).rate,
        })),
      });
      // On the way out, once, so a shortage is not left behind on a screen
      // that is about to close.
      if (shortLines.length > 0) {
        sayShortageSummary(shortLines.map((i: any) => ({ name: i.name, short: i.q - i.free, unit: i.unit })));
      }
      toast.success((alreadyIssued || chefExtraMode)
        ? "Top-up sent — the manager sees it as urgent"
        : "Requisition sent to the manager for approval");
      setNewOpen(false); setChefExtraMode(false); setQty({}); setNotes(""); setExtraReason("");
    } catch (e: any) { toast.error(e.message); }
  };

  // The lines the store will not be able to issue, worked out from what the
  // manager is about to approve rather than from what was asked.
  const shortInReview = (review?.requisition_items || []).map((l: any) => {
    const have = Number(l.ingredients?.current_stock ?? 0);
    const typed = Number(approved[l.id]);
    const take = isNaN(typed) ? Number(l.requested_qty) : typed;
    return { name: l.ingredients?.name, have, take, unit: l.unit };
  }).filter((x: any) => x.take > 0 && x.take > x.have);

  const openReview = (r: any) => {
    setReview(r);
    setReviewNotes(r.review_notes || "");
    setPickupName(r.pickup_person_name || "");
    const init: Record<string, string> = {};
    for (const l of r.requisition_items || []) {
      init[l.id] = String(l.approved_qty ?? l.requested_qty);
    }
    setApproved(init);
  };

  const outOfBand = useMemo(() => {
    if (!review) return [];
    return (review.requisition_items || []).filter((l: any) => {
      const v = Number(approved[l.id]);
      if (isNaN(v) || v === 0) return false;
      const req = Number(l.requested_qty);
      return v < req * (1 - TOLERANCE) - 1e-9 || v > req * (1 + TOLERANCE) + 1e-9;
    });
  }, [review, approved]);

  const submitReview = async (approve: boolean) => {
    if (!review) return;
    if (approve && outOfBand.length > 0) {
      toast.error(`${outOfBand.length} line(s) are outside ±7% — adjust them or send the requisition back`);
      return;
    }
    if (approve && storeLeaveMode && pickupName.trim().length < 2) {
      toast.error("Store Keeper chhutti par hai — saman lene wale ka naam likhein");
      return;
    }
    try {
      if (approve && storeLeaveMode) {
        await assignLeavePickup.mutateAsync({ requisitionId: review.id, pickupName: pickupName.trim() });
      }
      await reviewReq.mutateAsync({
        id: review.id,
        approve,
        review_notes: reviewNotes,
        lines: (review.requisition_items || []).map((l: any) => ({
          id: l.id,
          approved_qty: approve ? (Number(approved[l.id]) || 0) : 0,
        })),
      });
      toast.success(approve
        ? (storeLeaveMode ? `Approved — ${pickupName.trim()} ko self-pickup assign hua` : "Approved — the store keeper can issue it now")
        : "Sent back / rejected");
      setReview(null);
    } catch (e: any) {
      toast.error(e.message);   // includes the DB's ±7% rejection
    }
  };

  const pendingQty = (line: any) => {
    const raw = Number(line.approved_qty ?? line.requested_qty ?? 0)
      - Number(line.issued_qty ?? 0);
    // JavaScript represents decimal subtraction in binary, so 0.8 - 0.1 can
    // become 0.7000000000000001. Stock quantities use at most three decimal
    // places; round once here so every badge, total and confirmation agrees.
    return Math.max(Math.round(raw * 1000) / 1000, 0);
  };
  const hasIssuedAnything = (r: any) =>
    (r.requisition_items || []).some((line: any) => Number(line.issued_qty ?? 0) > 0);
  const hasAnythingPending = (r: any) =>
    (r.requisition_items || []).some((line: any) => pendingQty(line) > 0);

  const returnableOrderForMeal = (meal: any) => [...list]
    .filter((r: any) => r.menu_plan_id === meal.plan_id
      && r.meal_period === meal.meal_period
      && ["approved", "issued"].includes(r.status)
      && hasIssuedAnything(r))
    .sort((a: any, b: any) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];

  const openActualIssue = (r: any, focusLineId?: string) => {
    const quantities: Record<string, string> = {};
    const reasons: Record<string, string> = {};
    for (const line of (r.requisition_items || [])) {
      const ready = Math.min(pendingQty(line), shelfOf(line.ingredient_id));
      quantities[line.id] = ready > 0 ? String(ready) : "0";
      reasons[line.id] = "";
    }
    setActualIssueQty(quantities);
    setActualIssueReason(reasons);
    setActualIssueProof(null);
    setActualIssueReq({ ...r, focusLineId });
  };

  const submitActualIssue = async () => {
    if (!actualIssueReq) return;
    const lines = (actualIssueReq.requisition_items || []).filter((line: any) => pendingQty(line) > 0);
    const payload = lines.map((line: any) => ({
      requisition_item_id: line.id,
      actual_qty: Number(actualIssueQty[line.id] || 0),
      reason: actualIssueReason[line.id]?.trim() || undefined,
    }));
    if (!payload.some((line: any) => line.actual_qty > 0)) {
      toast.error("Kam se kam ek item ki actual di hui quantity bharein");
      return;
    }
    if (storeLeaveMode && !actualIssueProof) {
      toast.error("Self-pickup ki photo lagayein");
      return;
    }
    try {
      let res: any;
      if (storeLeaveMode) {
        const rawExt = actualIssueProof!.name.split(".").pop() || "jpg";
        const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
        const proofPath = `${selectedCanteen}/leave-pickup/${actualIssueReq.id}-${Date.now()}.${ext}`;
        const { error: uploadError } = await supabase.storage.from("stock-photos").upload(
          proofPath, actualIssueProof!, { contentType: actualIssueProof!.type || "image/jpeg" });
        if (uploadError) throw uploadError;
        res = await issueLeavePickup.mutateAsync({
          requisitionId: actualIssueReq.id, items: payload, proofPath,
        });
      } else {
        res = await issueActual.mutateAsync({ requisitionId: actualIssueReq.id, items: payload });
      }
      toast.success(storeLeaveMode
        ? `${res.pickup_person} ka self-pickup photo ke saath save hua · ${res.pending_lines} pending`
        : `${res.issued_lines} items actual quantity ke hisaab se issue hue · ${res.pending_lines} pending`);
      setActualIssueReq(null);
    } catch (e: any) { toast.error(e.message); }
  };

  useEffect(() => {
    const q: Record<string, string> = {};
    const why: Record<string, string> = {};
    for (const line of reconciliationLines as any[]) {
      q[line.requisition_item_id] = String(line.actual_qty ?? line.recorded_qty ?? 0);
      why[line.requisition_item_id] = line.reason || "";
    }
    setReconciledQty(q);
    setReconciledReason(why);
  }, [reconciliationLines]);

  const reconciliationOrders = useMemo(() => {
    const groups = new Map<string, any>();
    for (const line of reconciliationLines as any[]) {
      if (!groups.has(line.requisition_id)) groups.set(line.requisition_id, {
        id: line.requisition_id, req_no: line.req_no, meal_period: line.meal_period,
        service_date: line.service_date, lines: [],
      });
      groups.get(line.requisition_id).lines.push(line);
    }
    return Array.from(groups.values());
  }, [reconciliationLines]);

  const submitHistoricalOrder = async (order: any) => {
    try {
      await submitReconciliation.mutateAsync({
        requisitionId: order.id,
        items: order.lines.map((line: any) => ({
          requisition_item_id: line.requisition_item_id,
          actual_qty: Number(reconciledQty[line.requisition_item_id] ?? line.recorded_qty),
          reason: reconciledReason[line.requisition_item_id]?.trim() || undefined,
        })),
      });
      toast.success(`REQ-${order.req_no}: actual quantities Manager verification ke liye bhej di`);
    } catch (e: any) { toast.error(e.message); }
  };

  const reviewHistoricalOrder = async (order: any, approve: boolean) => {
    const reason = approve ? undefined : window.prompt("Reject karne ka internal reason") || undefined;
    if (!approve && !reason) return;
    try {
      const res = await reviewReconciliation.mutateAsync({ requisitionId: order.id, approve, reason });
      toast.success(approve
        ? `Verified · consumption ₹${Math.round(Number(res.consumption_value_reduced || 0)).toLocaleString("en-IN")} kam hua`
        : "Store Keeper ko correction ke liye wapas bheja");
    } catch (e: any) { toast.error(e.message); }
  };

  const openCorrection = (r: any) => {
    const initial: Record<string, string> = {};
    const initialIngredients: Record<string, string> = {};
    for (const line of r.requisition_items || []) {
      initial[line.id] = String(Number(line.approved_qty ?? line.requested_qty ?? 0));
      initialIngredients[line.id] = line.ingredient_id;
    }
    setCorrectedQty(initial);
    setCorrectedIngredient(initialIngredients);
    setCorrectionReason("");
    setCorrection(r);
  };

  const saveCorrection = async () => {
    if (!correction) return;
    if (!correctionReason.trim()) {
      toast.error("Reason likhna zaroori hai");
      return;
    }
    const lines = (correction.requisition_items || []).map((line: any) => {
      const rawQty = correctedQty[line.id]?.trim();
      return {
        id: line.id,
        ingredient_id: correctedIngredient[line.id] || line.ingredient_id,
        approved_qty: rawQty ? Number(rawQty) : Number.NaN,
      };
    });
    const invalid = lines.find((line: any) => {
      const original = (correction.requisition_items || []).find((x: any) => x.id === line.id);
      const issued = Number(original?.issued_qty || 0);
      const current = Number(original?.approved_qty ?? original?.requested_qty ?? 0);
      const changedItem = line.ingredient_id !== original?.ingredient_id;
      return !Number.isFinite(line.approved_qty) || line.approved_qty < issued - 1e-9
        || (!canFullEdit && line.approved_qty > current + 1e-9)
        || (changedItem && issued > 0);
    });
    if (invalid) {
      toast.error(canFullEdit
        ? "Issued quantity se kam nahi kar sakte; issued item ka name bhi change nahi hoga"
        : "Quantity current approval se zyada ya issued quantity se kam nahi ho sakti");
      return;
    }
    const activeIngredientIds = lines
      .filter((line: any) => {
        const original = (correction.requisition_items || []).find((x: any) => x.id === line.id);
        return line.approved_qty > Number(original?.issued_qty || 0) + 1e-9;
      })
      .map((line: any) => line.ingredient_id);
    if (new Set(activeIngredientIds).size !== activeIngredientIds.length) {
      toast.error("Ek hi item order mein do active lines par select nahi ho sakta");
      return;
    }
    try {
      const res = canFullEdit
        ? await adminCorrectReq.mutateAsync({ id: correction.id, lines, reason: correctionReason.trim() })
        : await correctReq.mutateAsync({
            id: correction.id,
            lines: lines.map(({ id, approved_qty }: any) => ({ id, approved_qty })),
            reason: correctionReason.trim(),
          });
      toast.success(res?.status === "cancelled"
        ? "Pura order cancel ho gaya"
        : canFullEdit ? "Order ka item/quantity update ho gaya" : "Order ki quantity update ho gayi");
      setCorrection(null);
    } catch (e: any) { toast.error(e.message); }
  };

  const cancelWholeOrder = async (r: any) => {
    if (hasIssuedAnything(r)) {
      toast.error("Kuch saman issue ho chuka hai. Baaki quantity 0 karein; mila hua saman Chef return karega.");
      return;
    }
    const why = window.prompt("Pura order kyun cancel karna hai?", "Chef ko ab saman nahi chahiye");
    if (!why?.trim()) return;
    if (!window.confirm(`REQ-${r.req_no} cancel karna hai? Record history mein rahega.`)) return;
    try {
      await cancelReq.mutateAsync({ id: r.id, reason: why.trim() });
      toast.success(`REQ-${r.req_no} cancel ho gaya`);
      if (correction?.id === r.id) setCorrection(null);
    } catch (e: any) { toast.error(e.message); }
  };

  const cancelAllRemaining = () => {
    if (!correction) return;
    const next: Record<string, string> = {};
    for (const line of correction.requisition_items || []) {
      next[line.id] = String(Number(line.issued_qty || 0));
    }
    setCorrectedQty(next);
  };

  const closeUnneeded = async (line: any) => {
    const left = pendingQty(line);
    const why = window.prompt(
      `${line.ingredients?.name || "Is item"} ka baaki ${left} ${line.unit || line.ingredients?.unit || ""} band karna hai?\nKyun nahi chahiye?`,
      "Kam saman mein kaam ho gaya"
    );
    if (!why?.trim()) return;
    if (!window.confirm(`Baaki ${left} band hoga. Jo saman mil chuka hai woh return nahi hoga. Theek hai?`)) return;
    try {
      const res = await closePending.mutateAsync({ itemId: line.id, reason: why.trim() });
      toast.success(`${res.item}: ${res.closed_qty} baaki band hua`);
    } catch (e: any) { toast.error(e.message); }
  };
  const shelfOf = (ingredientId: string) => Number(availOf(ingredientId)?.current_stock ?? 0);
  const readyQtyFor = (r: any) => (r.requisition_items || []).reduce((sum: number, line: any) =>
    sum + Math.min(pendingQty(line), shelfOf(line.ingredient_id)), 0);
  // A delivery changes current_stock, so the same pending order automatically
  // rises above orders that still cannot be served. Nothing is issued here;
  // the Store Keeper must press the confirmation button.
  const approvedList = [...approvedRaw].sort((a: any, b: any) => {
    const ready = Number(readyQtyFor(b) > 0) - Number(readyQtyFor(a) > 0);
    return ready || byService(a, b);
  });
  const pendingShortRows = approvedList.flatMap((r: any) =>
    (r.requisition_items || [])
      .filter((line: any) => pendingQty(line) > 0)
      .map((line: any) => ({
        req: r,
        line,
        pending: pendingQty(line),
        stock: shelfOf(line.ingredient_id),
        ready: Math.min(pendingQty(line), shelfOf(line.ingredient_id)),
      })))
    .sort((a: any, b: any) => Number(b.ready > 0) - Number(a.ready > 0)
      || byService(a.req, b.req));

  const openExtraFor = (r: any) => {
    setQty({});
    setSearch("");
    setMenuPlanId(r.menu_plan_id || "");
    setMealPeriod(r.meal_period || "lunch");
    setHeadcount(String(r.expected_headcount || ""));
    setChefExtraMode(true);
    setExtraReason("");
    setNewOpen(true);
  };

  // Keep this as a render helper, not a component declared inside the page.
  // An inline component gets a new identity on every query refresh, so React
  // unmounts the whole card while the user is pressing a button. That made
  // both the extra-order and kitchen-return buttons detach before the click
  // could finish, and it also discarded ReturnButton's open-dialog state.
  const renderRequisitionCard = (r: any, action?: React.ReactNode) => (
    <Card key={r.id} className="border-none shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-semibold">
              REQ-{r.req_no} · {MEAL_PERIODS.find((m) => m.value === r.meal_period)?.label || r.meal_period || "—"}
            </p>
            {/* The day the food is FOR, said first and said plainly. An order
                is raised the evening before the day it is cooked, so the only
                date on the card used to be the wrong one to act on: four
                orders sitting in "Ready to issue" all read as the same day,
                and the store keeper could not tell the 14th's dinner from the
                15th's breakfast without opening each one. */}
            {r.menu_plans?.menu_date ? (
              <p className="text-xs font-semibold text-accent mt-0.5">
                {(() => {
                  const d = r.menu_plans.menu_date;
                  const when = d === todayIst() ? "Today" : d === tomorrowIst() ? "Tomorrow"
                    : d === yesterdayIst() ? "Yesterday" : null;
                  return `For ${fmtDayDate(d)}${when ? ` · ${when}` : ""}`;
                })()}
              </p>
            ) : (
              <p className="text-xs font-semibold text-warning mt-0.5">
                Not linked to any day's menu
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Raised {fmtDateTime(r.created_at)}
              {" · "}{(r.requisition_items || []).length} items
            </p>
            {r.expected_headcount > 0 && (
              <p className="text-xs mt-1 flex items-center gap-1">
                <Users className="w-3.5 h-3.5 text-accent" />
                <span className="font-semibold">{r.expected_headcount} people expected</span>
                <span className="text-muted-foreground">(from the manager's menu)</span>
              </p>
            )}
            {r.menu_plan_id && (() => {
              const dishes = requisitionMenuDishes(r.menu_plans);
              return (
                <div className="mt-2 rounded-md border border-accent/20 bg-accent/5 px-3 py-2 text-xs">
                  <span className="font-semibold text-foreground">Menu dishes: </span>
                  <span className={dishes.length ? "text-foreground" : "text-muted-foreground"}>
                    {dishes.length ? dishes.join(" + ") : "Menu mein dishes record nahi hain"}
                  </span>
                </div>
              );
            })()}
            {r.notes && <p className="text-xs mt-1">{r.notes}</p>}
            {r.pickup_person_name && (
              <p className="mt-1 flex items-center gap-1 text-xs font-medium text-accent">
                <UserCheck className="h-3.5 w-3.5" /> Pickup: {r.pickup_person_name}
                {r.issue_mode === "leave_self_pickup" ? " · confirmed" : " · manager assigned"}
              </p>
            )}
            {r.pickup_proof_path && (
              <Button type="button" variant="link" className="h-auto p-0 text-xs"
                onClick={() => openPickupProof(r.pickup_proof_path)}>
                <Camera className="mr-1 h-3.5 w-3.5" /> Pickup photo dekho
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={`text-[10px] uppercase ${STATUS_STYLE[r.status] || ""}`}>
              {isChef
                ? (r.status === "pending" ? "MANAGER KE PAAS"
                  : r.status === "approved" ? (storeLeaveMode ? "SELF PICKUP READY" : "STORE PROCESSING")
                  : r.status === "issued" ? "ISSUE COMPLETE"
                  : r.status === "rejected" ? "MANA HUA" : r.status)
                : (r.status === "approved" && hasIssuedAnything(r) ? "PARTIALLY ISSUED" : r.status)}
            </Badge>
            {action}
          </div>
        </div>
        {isChef ? (
          <div className="mt-3 space-y-2">
            {(r.requisition_items || []).map((l: any) => {
              const asked = Number(l.requested_qty || 0);
              const got = Number(l.issued_qty || 0);
              const left = pendingQty(l);
              const cancelled = Number(l.cancelled_qty || 0);
              const unit = l.unit || l.ingredients?.unit || "";
              return (
                <div key={l.id} className={`rounded-lg border p-3 ${r.status === "issued" ? "bg-success/5 border-success/20" : "bg-muted/20"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-base">{l.ingredients?.name || "—"}</p>
                    {r.status === "issued"
                      ? <Badge variant="outline" className="text-success border-success/30"><CheckCircle2 className="w-3 h-3 mr-1" /> Complete</Badge>
                      : <Badge variant="outline">Store processing</Badge>}
                  </div>
                  <div className="grid grid-cols-1 gap-2 mt-2 text-center">
                    <div className="rounded bg-background p-2"><p className="text-[10px] text-muted-foreground">CHEF ORDER</p><p className="font-bold">{asked} {unit}</p></div>
                  </div>
                  {cancelled > 0 && (
                    <p className="text-xs text-muted-foreground mt-2">{cancelled} {unit} “ab nahi chahiye” karke band kiya{l.cancellation_reason ? ` — ${l.cancellation_reason}` : ""}</p>
                  )}
                  {r.status === "approved" && got > 0 && left > 0 && (
                    <Button variant="outline" className="w-full mt-2 h-11 text-sm" disabled={closePending.isPending} onClick={() => closeUnneeded(l)}>
                      <CheckCircle2 className="w-4 h-4 mr-2" /> Kaam ho gaya — baaki band karo
                    </Button>
                  )}
                </div>
              );
            })}
            {hasIssuedAnything(r) && hasAnythingPending(r) && (
              <p className="text-xs text-muted-foreground px-1">
                Mila hua saman bach gaya ho तो ऊपर Return दबाएँ. “Baaki nahi chahiye” केवल अभी तक नहीं मिले सामान को बंद करता है.
              </p>
            )}
            {hasIssuedAnything(r) && (
              <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2">
                <Button className="h-11 text-sm" onClick={() => openExtraFor(r)}>
                  <Zap className="mr-2 h-4 w-4" /> Aur saman mangao
                </Button>
                <ReturnButton requisition={r} full />
              </div>
            )}
          </div>
        ) : (
        <div className="mt-2 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Item</TableHead>
                <TableHead className="text-xs text-right">Quantity</TableHead>
                <TableHead className="text-xs text-right">Rate</TableHead>
                <TableHead className="text-xs text-right">Amount</TableHead>
                <TableHead className="text-xs text-right">Approved</TableHead>
                <TableHead className="text-xs text-right">Issued</TableHead>
                <TableHead className="text-xs text-right">Pending</TableHead>
                <TableHead className="text-xs text-right">In stock</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(r.requisition_items || []).map((l: any) => {
                const left = pendingQty(l);
                const liveStock = shelfOf(l.ingredient_id);
                const short = left > liveStock;
                // Once the goods have moved there is a real figure — what
                // the oldest lots on the shelf actually cost. Before that it
                // can only be an estimate, and it is shown as one.
                const issuedValue = l.issued_value != null ? Number(l.issued_value) : null;
                const qtyNow = Number(l.approved_qty ?? l.requested_qty);
                const rate = issuedValue != null && Number(l.issued_qty) > 0
                  ? issuedValue / Number(l.issued_qty)
                  : rateOf(l.ingredient_id).rate || Number(l.rate ?? 0);
                const amount = issuedValue != null ? issuedValue : costOf(l.ingredient_id, qtyNow);
                return (
                  <TableRow key={l.id} className={short ? "bg-destructive/5" : ""}>
                    <TableCell className="text-sm">{l.ingredients?.name || "—"}</TableCell>
                    <TableCell className="text-sm text-right">{Number(l.requested_qty)} {l.unit}</TableCell>
                    <TableCell className="text-sm text-right text-muted-foreground">
                      ₹{rate.toFixed(2)}
                      <span className="block text-[10px]">{issuedValue != null ? "charged" : "estimate"}</span>
                    </TableCell>
                    <TableCell className="text-sm text-right font-medium">₹{Math.round(amount).toLocaleString()}</TableCell>
                    <TableCell className="text-sm text-right">{l.approved_qty != null ? Number(l.approved_qty) : "—"}</TableCell>
                    <TableCell className="text-sm text-right">{Number(l.issued_qty ?? 0)}</TableCell>
                    <TableCell className={`text-sm text-right font-semibold ${left > 0 ? "text-warning" : "text-success"}`}>
                      {left > 0 ? `${left} ${l.unit || l.ingredients?.unit || ""}` : "Done"}
                    </TableCell>
                    <TableCell className={`text-sm text-right ${short ? "text-destructive font-semibold" : "text-muted-foreground"}`}>
                      {liveStock}
                    </TableCell>
                  </TableRow>
                );
              })}
              {(r.requisition_items || []).length > 0 && (() => {
                // Add up the same figures the lines above print. Reading the
                // stored amount instead left the total on the estimate frozen
                // at order time, so a footer could disagree with the rows
                // right over it.
                const total = (r.requisition_items || []).reduce((s: number, l: any) =>
                  s + (l.issued_value != null
                        ? Number(l.issued_value)
                        : costOf(l.ingredient_id, Number(l.approved_qty ?? l.requested_qty))), 0);
                return (
                  <TableRow className="bg-muted/40">
                    <TableCell className="text-sm font-bold" colSpan={3}>
                      TOTAL
                      {r.expected_headcount > 0 && total > 0 && (
                        <span className="font-normal text-xs text-muted-foreground">
                          {" "}· ₹{(total / r.expected_headcount).toFixed(2)} per person
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-right font-bold">₹{Math.round(total).toLocaleString()}</TableCell>
                    <TableCell colSpan={4} />
                  </TableRow>
                );
              })()}
            </TableBody>
          </Table>
        </div>
        )}
      </CardContent>
    </Card>
  );

  const renderDateGroupedRequisitions = (
    rows: any[],
    scope: string,
    emptyText: string,
    actionFor?: (r: any) => React.ReactNode,
  ) => {
    const filtered = rows
      .filter((r: any) => !requisitionDate || (r.menu_plans?.menu_date || r.req_date) === requisitionDate)
      .sort((a: any, b: any) => {
        const da = a.menu_plans?.menu_date || a.req_date || "";
        const db = b.menu_plans?.menu_date || b.req_date || "";
        if (da !== db) return db.localeCompare(da);
        return MEAL_ORDER.indexOf(a.meal_period) - MEAL_ORDER.indexOf(b.meal_period);
      });
    if (!filtered.length) {
      return <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
        {requisitionDate ? `${fmtDate(requisitionDate)} ko ${emptyText.toLowerCase()}` : emptyText}
      </CardContent></Card>;
    }

    const days = new Map<string, any[]>();
    for (const row of filtered) {
      const day = row.menu_plans?.menu_date || row.req_date || "No date";
      days.set(day, [...(days.get(day) || []), row]);
    }

    return Array.from(days, ([day, orders]) => {
      const dayKey = `${scope}:${day}`;
      const dayOpen = openRequisitionDay === dayKey;
      const presentMeals = Array.from(new Set(orders.map((r: any) => r.meal_period || "extra")));
      const mealKeys = [
        ...MEAL_ORDER.filter((meal) => presentMeals.includes(meal)),
        ...presentMeals.filter((meal) => !MEAL_ORDER.includes(meal)),
      ];
      const itemCount = orders.reduce((sum: number, r: any) => sum + (r.requisition_items || []).length, 0);
      return (
        <Card key={dayKey} className="overflow-hidden border-none shadow-sm">
          <button type="button" className="flex min-h-16 w-full items-center gap-3 p-4 text-left hover:bg-muted/40"
            onClick={() => { setOpenRequisitionDay(dayOpen ? null : dayKey); setOpenRequisitionMeal(null); }}>
            <CalendarDays className="h-5 w-5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{day === "No date" ? "Date nahi mili" : fmtDayDate(day)}</p>
              <p className="text-xs text-muted-foreground">{orders.length} orders · {itemCount} items</p>
            </div>
            <ChevronDown className={`h-5 w-5 shrink-0 transition-transform ${dayOpen ? "rotate-180" : ""}`} />
          </button>
          {dayOpen && (
            <div className="space-y-2 border-t bg-muted/20 p-2 sm:p-3">
              {mealKeys.map((meal) => {
                const mealOrders = orders.filter((r: any) => (r.meal_period || "extra") === meal);
                const mealKey = `${scope}:${day}:${meal}`;
                const mealOpen = openRequisitionMeal === mealKey;
                const label = MEAL_PERIODS.find((m) => m.value === meal)?.label || (meal === "extra" ? "Extra saman" : meal);
                const count = mealOrders.reduce((sum: number, r: any) => sum + (r.requisition_items || []).length, 0);
                return (
                  <div key={mealKey} className="overflow-hidden rounded-lg border bg-background">
                    <button type="button" className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/40"
                      onClick={() => setOpenRequisitionMeal(mealOpen ? null : mealKey)}>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold">{label}</p>
                        <p className="text-xs text-muted-foreground">{mealOrders.length} order · {count} items</p>
                      </div>
                      <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${mealOpen ? "rotate-180" : ""}`} />
                    </button>
                    {mealOpen && (
                      <div className="space-y-2 border-t bg-muted/20 p-2">
                        {mealOrders.map((r: any) => renderRequisitionCard(r, actionFor?.(r)))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

      );
    });
  };

  return (
    <AppLayout title="Raw Material Requisitions">
      <div className="min-w-0 max-w-full flex flex-col gap-4 animate-fade-in">
        <Card className="order-1 border-none shadow-sm">
          <CardContent className="p-4">
            {isChef ? (
              <div className="space-y-3">
                <div>
                  <p className="text-lg font-bold">Saman mangao</p>
                  <p className="text-sm text-muted-foreground">1. Menu chuno &nbsp; 2. Quantity bharo &nbsp; 3. Manager ko bhejo</p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Button className="h-14 text-base" onClick={() => { setChefExtraMode(false); setExtraReason(""); setNewOpen(true); }} disabled={selectedCanteen === "all"}>
                    <Plus className="w-5 h-5 mr-2" /> Kal ka saman mangao
                  </Button>
                  <Button variant="outline" className="h-14 text-base border-warning/50 text-warning" onClick={() => { setChefExtraMode(true); setNewOpen(true); }} disabled={selectedCanteen === "all"}>
                    <Zap className="w-5 h-5 mr-2" /> Extra saman chahiye
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Chef raises the request → Unit Manager may adjust each line by at most <b>±7%</b> and approves → Store Keeper issues it, and only then does stock move.
              </p>
            )}
          </CardContent>
        </Card>

        {selectedCanteen !== "all" && (storeLeaveMode || isManagerOrAbove || isStoreKeeper) && (
          <Card className={`order-1 shadow-sm ${storeLeaveMode ? "border-warning/50 bg-warning/5" : "border-success/30 bg-success/5"}`}>
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                {storeLeaveMode
                  ? <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
                  : <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />}
                <div>
                  <p className="font-semibold">
                    {storeLeaveMode ? "Store Keeper chhutti par · Self-pickup ON" : "Store Keeper available · Normal issue"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {storeLeaveMode
                      ? `Manager pickup naam assign karega. Actual quantity aur photo ke bina stock minus nahi hoga.${activeStoreLeave?.reason ? ` Reason: ${activeStoreLeave.reason}` : ""}`
                      : "Approved saman Store Keeper actual quantity se issue karega."}
                  </p>
                </div>
              </div>
              {(isManagerOrAbove || isStoreKeeper) && (
                <Button type="button" variant={storeLeaveMode ? "default" : "outline"}
                  onClick={toggleStoreLeaveMode} disabled={setStoreLeave.isPending}>
                  {storeLeaveMode ? "Store Keeper wapas aa gaya" : "Store Keeper chhutti par hai"}
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {isChef && selectedCanteen !== "all" && (
          <div className="order-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card className="border-none shadow-sm"><CardContent className="p-4"><p className="text-xs text-muted-foreground">{fmtDate(kitchenDate)} consumption</p><p className="text-xl font-bold">{money(chefMoney?.consumption)}</p><p className="text-[11px] text-muted-foreground">Issue − accepted return</p></CardContent></Card>
            <Card className="border-none shadow-sm"><CardContent className="p-4"><p className="text-xs text-muted-foreground">Revenue</p><p className="text-xl font-bold">{money(chefMoney?.revenue)}</p><p className="text-[11px] text-muted-foreground">{chefMoney?.provisional ? "Punch pending — provisional" : "Eicher punch final"}</p></CardContent></Card>
            <Card className="border-none shadow-sm"><CardContent className="p-4"><p className="text-xs text-muted-foreground">Food cost</p><p className="text-xl font-bold">{Number(chefMoney?.food_cost_pct || 0).toFixed(1)}%</p><p className="text-[11px] text-muted-foreground">Consumption ÷ revenue</p></CardContent></Card>
          </div>
        )}

        {/* The chef's day, meal by meal in the order it gets cooked, each dish
            carrying what it takes. Tapping an ingredient drops it straight
            into the order below instead of being typed from memory. */}
        {isChef && selectedCanteen !== "all" && (
          <div className="order-3 space-y-2">
            <div className="flex items-end gap-3 flex-wrap">
              <div className="space-y-1.5">
                <Label className="text-xs">Kis din ka khana?</Label>
                <Input type="date" className="w-44" value={kitchenDate}
                       onChange={(e) => setKitchenDate(e.target.value)} />
              </div>
              <p className="text-xs text-muted-foreground flex-1 min-w-[220px]">
                Menu mein item ke सामने <b>add</b> दबाओ. Recipe/history बनते ही suggested quantity अपने आप मिलने लगेगी.
              </p>
            </div>
            <KitchenPlan
              canteenId={selectedCanteen}
              date={kitchenDate}
              onAdd={(ingredientId, q, meal) => {
                setQty((p: any) => ({
                  ...p,
                  [ingredientId]: String(Math.round(((Number(p[ingredientId]) || 0) + q) * 1000) / 1000),
                }));
                if (meal) {
                  setMenuPlanId(String(meal.plan_id || ""));
                  setMealPeriod(meal.meal_period);
                  setHeadcount(String(meal.headcount ?? ""));
                }
                setNewOpen(true);
              }}
              onOrderMeal={(meal) => {
                const nextQty: Record<string, string> = {};
                for (const dish of meal.dishes || []) {
                  for (const ingredient of dish.ingredients || []) {
                    const id = ingredient.ingredient_id;
                    const total = (Number(nextQty[id]) || 0) + Number(ingredient.qty || 0);
                    if (id && total > 0) nextQty[id] = String(Math.round(total * 1000) / 1000);
                  }
                }
                setQty(nextQty);
                setMenuPlanId(String(meal.plan_id || ""));
                setMealPeriod(meal.meal_period);
                setHeadcount(String(meal.headcount ?? ""));
                setChefExtraMode(false);
                setExtraReason("");
                setNewOpen(true);
              }}
              onExtraMeal={(meal) => {
                setQty({});
                setSearch("");
                setMenuPlanId(String(meal.plan_id || ""));
                setMealPeriod(meal.meal_period);
                setHeadcount(String(meal.headcount ?? ""));
                setChefExtraMode(true);
                setExtraReason("");
                setNewOpen(true);
              }}
              renderMealReturn={(meal) => {
                const requisition = returnableOrderForMeal(meal);
                return requisition ? <ReturnButton requisition={requisition} full /> : null;
              }}
            />
          </div>
        )}

        {selectedCanteen !== "all" && (
          <div className="order-2">
            <PendingReturns canteenId={selectedCanteen} />
          </div>
        )}

        {selectedCanteen === "all" ? (
          <Card className="order-2"><CardContent className="p-8 text-center text-sm text-muted-foreground">Select a site to see its requisitions.</CardContent></Card>
        ) : (
          <Tabs defaultValue="pending" className="order-2">
            <TabsList className="w-full sm:w-auto">
              <TabsTrigger value="pending">{isChef ? "Manager ke paas" : "Awaiting approval"} ({pending.length})</TabsTrigger>
              <TabsTrigger value="approved">{isChef ? "Store se lena" : "Ready to issue"} ({approvedList.length})</TabsTrigger>
              <TabsTrigger value="history">{isChef ? "Purane orders" : "History"} ({done.length})</TabsTrigger>
              {canIssueStock && !isChef && <TabsTrigger value="actual-check">20 Aug actual check</TabsTrigger>}
            </TabsList>

            <Card className="mt-3 border-none shadow-sm">
              <CardContent className="p-3 sm:p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Label className="text-xs">Kis date ke requisitions dekhne hain?</Label>
                    <Input type="date" className="h-12 w-full text-base sm:w-64"
                      value={requisitionDate}
                      onChange={(e) => {
                        setRequisitionDate(e.target.value);
                        setOpenRequisitionDay(null);
                        setOpenRequisitionMeal(null);
                      }} />
                  </div>
                  {requisitionDate && (
                    <Button variant="outline" className="h-12" onClick={() => {
                      setRequisitionDate(""); setOpenRequisitionDay(null); setOpenRequisitionMeal(null);
                    }}>Sab dates</Button>
                  )}
                </div>
              </CardContent>
            </Card>

            <TabsContent value="pending" className="mt-3 space-y-3">
              {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> :
               renderDateGroupedRequisitions(pending, "pending", "Nothing waiting for approval.", (r: any) =>
                  isManagerOrAbove ? (
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button size="sm" variant="outline" className="text-destructive"
                              onClick={() => cancelWholeOrder(r)} disabled={cancelReq.isPending}>
                        <Trash2 className="mr-1.5 h-4 w-4" /> Order cancel
                      </Button>
                      <Button size="sm" onClick={() => openReview(r)}>Review</Button>
                    </div>
                  ) : null)}
            </TabsContent>

            <TabsContent value="approved" className="mt-3 space-y-3">
              {canProcessApproved && pendingShortRows.length > 0 && (
                <Card className="border-accent/20 bg-accent/5 shadow-sm">
                  <CardContent className="p-4 space-y-3">
                    <div>
                      <p className="text-sm font-semibold">Aaj dena baaki · {pendingShortRows.length} items</p>
                      <p className="text-xs text-muted-foreground">
                        Green rows अभी issue हो सकती हैं. New stock आते ही order ऊपर आ जाएगा; issue automatic नहीं होगा.
                      </p>
                    </div>
                    <div className="max-h-72 overflow-auto rounded-md border bg-background">
                      {pendingShortRows.map(({ req, line, pending, stock, ready }: any) => (
                        <div key={line.id} className={`grid grid-cols-[minmax(130px,1fr)_90px_90px_120px] gap-2 items-center px-3 py-2 border-b last:border-0 text-xs ${ready > 0 ? "bg-success/5" : "bg-destructive/5"}`}>
                          <div className="min-w-0">
                            <p className="font-medium truncate">{line.ingredients?.name || "—"}</p>
                            <p className="text-[10px] text-muted-foreground">REQ-{req.req_no} · {MEAL_PERIODS.find((m) => m.value === req.meal_period)?.label || req.meal_period}</p>
                          </div>
                          <div className="text-right"><span className="text-muted-foreground">Pending</span><br /><b>{pending} {line.unit || line.ingredients?.unit}</b></div>
                          <div className="text-right"><span className="text-muted-foreground">Now</span><br /><b>{ready} / {stock}</b></div>
                          <Button size="sm" className="h-8 text-xs"
                            disabled={issueActual.isPending || issueLeavePickup.isPending || ready <= 0 || (storeLeaveMode && !req.pickup_person_name)}
                            onClick={() => openActualIssue(req, line.id)}>
                            <PackageCheck className="w-3.5 h-3.5 mr-1" /> Actual qty bharo
                          </Button>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
              {renderDateGroupedRequisitions(approvedList, "approved", "Nothing approved and waiting.", (r: any) =>
                  <div className="flex gap-2 flex-wrap justify-end">
                     {isManagerOrAbove && (
                       <>
                         <Button size="sm" variant="outline" onClick={() => openCorrection(r)}>
                           <Pencil className="w-4 h-4 mr-1.5" /> Full order edit
                         </Button>
                         {!hasIssuedAnything(r) && (
                           <Button size="sm" variant="ghost" onClick={() => doSendBack(r.id)}
                                   disabled={sendBack.isPending}>
                             <Undo2 className="w-4 h-4 mr-1.5" /> Chef ko wapas
                           </Button>
                         )}
                       </>
                     )}
                    {storeLeaveMode && isManagerOrAbove && !r.pickup_person_name ? (
                      <Button size="sm" onClick={() => assignPickupForApproved(r)} disabled={assignLeavePickup.isPending}>
                        <UserCheck className="w-4 h-4 mr-1.5" /> Pickup person assign
                      </Button>
                    ) : canProcessApproved ? (
                      <Button size="sm" onClick={() => openActualIssue(r)}
                              disabled={issueActual.isPending || issueLeavePickup.isPending || !hasAnythingPending(r) || (storeLeaveMode && !r.pickup_person_name)}>
                        <PackageCheck className="w-4 h-4 mr-1.5" />
                        {storeLeaveMode
                          ? (r.pickup_person_name ? `${r.pickup_person_name} ka pickup` : "Manager pickup assign kare")
                          : (hasIssuedAnything(r) ? "Baaki ki actual quantity" : "Actual quantity se issue")}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground self-center">waiting for the store keeper</span>
                    )}
                  </div>
              )}
            </TabsContent>

            <TabsContent value="history" className="mt-3 space-y-3">
              {renderDateGroupedRequisitions(done, "history", "No history yet.")}
            </TabsContent>

            {canIssueStock && !isChef && (
              <TabsContent value="actual-check" className="mt-3 space-y-3">
                <Card className="border-warning/30 bg-warning/5">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                      <div>
                        <p className="font-semibold">20 August se actual kitchen issue check</p>
                        <p className="text-xs text-muted-foreground">
                          Chef ne manga, software ne issue dikhaya, aur asal mein Store ne kitna diya—har line verify hogi.
                          Current physical stock dobara nahi badlega; Manager verify karne ke baad consumption aur food cost sudhrega.
                        </p>
                      </div>
                      <div className="space-y-1 min-w-[190px]">
                        <Label className="text-xs">Service date</Label>
                        <Input type="date" min="2026-08-20" max={todayIst()} value={reconciliationDate}
                          onChange={(e) => setReconciliationDate(e.target.value)} />
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {reconciliationLoading ? <Card><CardContent className="p-8 text-center text-sm">Loading…</CardContent></Card>
                  : reconciliationOrders.length === 0 ? (
                    <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Is date par recorded issue nahi hai.</CardContent></Card>
                  ) : reconciliationOrders.map((order: any) => {
                    const statuses = new Set(order.lines.map((line: any) => line.reconciliation_status).filter(Boolean));
                    const verified = statuses.has("verified");
                    const pendingReview = statuses.has("pending");
                    const recordedValue = order.lines.reduce((s: number, line: any) => s + Number(line.recorded_value || 0), 0);
                    const actualValue = order.lines.reduce((s: number, line: any) => {
                      const qty = Number(reconciledQty[line.requisition_item_id] ?? line.recorded_qty);
                      const recordedQty = Number(line.recorded_qty || 0);
                      return s + (recordedQty > 0 ? Number(line.recorded_value || 0) * qty / recordedQty : 0);
                    }, 0);
                    return (
                      <Card key={order.id} className={verified ? "border-success/30" : pendingReview ? "border-warning/30" : ""}>
                        <CardHeader className="pb-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <CardTitle className="text-base">REQ-{order.req_no} · {MEAL_PERIODS.find((m) => m.value === order.meal_period)?.label || order.meal_period}</CardTitle>
                            <Badge variant="outline" className={verified ? "text-success" : pendingReview ? "text-warning" : ""}>
                              {verified ? "MANAGER VERIFIED" : pendingReview ? "MANAGER KE PAAS" : "ACTUAL QTY BAAKI"}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Recorded ₹{Math.round(recordedValue).toLocaleString("en-IN")} · Actual estimate ₹{Math.round(actualValue).toLocaleString("en-IN")}
                          </p>
                        </CardHeader>
                        <CardContent className="space-y-2">
                          {order.lines.map((line: any) => {
                            const id = line.requisition_item_id;
                            const actual = Number(reconciledQty[id] ?? line.recorded_qty);
                            const changed = Math.abs(actual-Number(line.recorded_qty))>0.000000001;
                            return (
                              <div key={id} className={`grid gap-2 rounded-lg border p-3 sm:grid-cols-[minmax(150px,1fr)_110px_130px_minmax(180px,1fr)] sm:items-end ${changed ? "bg-warning/5 border-warning/30" : ""}`}>
                                <div><p className="font-medium">{line.item_name}</p><p className="text-xs text-muted-foreground">Chef order {Number(line.requested_qty)} {line.unit}</p></div>
                                <div><Label className="text-[10px]">SOFTWARE ISSUE</Label><p className="h-10 flex items-center font-semibold">{Number(line.recorded_qty)} {line.unit}</p></div>
                                <div><Label className="text-[10px]">ASAL ME DIYA</Label><Input type="number" min="0" max={Number(line.recorded_qty)} step="any"
                                  value={reconciledQty[id] ?? ""} disabled={!isStoreKeeper || verified || pendingReview}
                                  onChange={(e) => setReconciledQty((p) => ({ ...p, [id]: e.target.value }))} /></div>
                                <div><Label className="text-[10px]">INTERNAL REASON {changed ? "*" : ""}</Label><Input
                                  placeholder={changed ? "Kam dene ka reason" : "Recorded quantity sahi hai"}
                                  value={reconciledReason[id] ?? ""} disabled={!isStoreKeeper || verified || pendingReview}
                                  onChange={(e) => setReconciledReason((p) => ({ ...p, [id]: e.target.value }))} /></div>
                              </div>
                            );
                          })}
                          <div className="flex flex-wrap justify-end gap-2 pt-2">
                            {isStoreKeeper && !verified && !pendingReview && (
                              <Button onClick={() => submitHistoricalOrder(order)} disabled={submitReconciliation.isPending}>
                                <Send className="mr-2 h-4 w-4" /> Manager ko verify bhejo
                              </Button>
                            )}
                            {isManagerOrAbove && pendingReview && (
                              <>
                                <Button variant="outline" className="text-destructive" onClick={() => reviewHistoricalOrder(order,false)} disabled={reviewReconciliation.isPending}>Wapas bhejo</Button>
                                <Button onClick={() => reviewHistoricalOrder(order,true)} disabled={reviewReconciliation.isPending}>
                                  <CheckCircle2 className="mr-2 h-4 w-4" /> Verify consumption
                                </Button>
                              </>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
              </TabsContent>
            )}
          </Tabs>
        )}
      </div>

      <Dialog open={!!actualIssueReq} onOpenChange={(open) => { if (!open) setActualIssueReq(null); }}>
        <DialogContent className="h-[calc(100dvh-0.75rem)] max-h-[calc(100dvh-0.75rem)] w-[calc(100vw-0.75rem)] max-w-[calc(100vw-0.75rem)] overflow-y-auto p-4 sm:h-auto sm:max-h-[90vh] sm:max-w-3xl sm:p-6">
          <DialogHeader>
            <DialogTitle>REQ-{actualIssueReq?.req_no} · Asal mein kitna saman diya?</DialogTitle>
          </DialogHeader>
          <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
            Software sirf neeche bhari hui <b>actual quantity</b> stock aur consumption mein dalega.
            Approved quantity apne-aap issue nahi hogi. Kam dene par internal reason जरूरी है.
          </div>
          {storeLeaveMode && (
            <div className="space-y-3 rounded-lg border border-accent/30 bg-accent/5 p-3">
              <div className="flex items-center gap-2 text-sm">
                <UserCheck className="h-4 w-4 text-accent" />
                Manager assigned pickup: <b>{actualIssueReq?.pickup_person_name || "Naam assign nahi hua"}</b>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="leave-pickup-photo">Pickup ki photo *</Label>
                <Input id="leave-pickup-photo" type="file" accept="image/*" capture="environment"
                  onChange={(e) => setActualIssueProof(e.target.files?.[0] || null)} />
                <p className="text-[11px] text-muted-foreground">
                  Saman aur weight/photo saaf dikhna chahiye. Photo audit history mein rahegi.
                </p>
              </div>
            </div>
          )}
          <div className="space-y-2">
            {(actualIssueReq?.requisition_items || []).filter((line: any) => pendingQty(line)>0).map((line: any) => {
              const left = pendingQty(line);
              const stock = shelfOf(line.ingredient_id);
              const ready = Math.min(left,stock);
              const actual = Number(actualIssueQty[line.id] || 0);
              const unit = line.unit || line.ingredients?.unit || "";
              const needsReason = actual+0.000000001<ready;
              return (
                <div key={line.id} className={`rounded-lg border p-3 ${actualIssueReq?.focusLineId===line.id ? "ring-2 ring-accent" : ""}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold text-base">{line.ingredients?.name || "—"}</p>
                    <p className="text-xs text-muted-foreground">Pending {left} {unit} · Shelf {stock} {unit}</p>
                  </div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-[150px_1fr]">
                    <div>
                      <Label className="text-xs">Asal mein diya ({unit})</Label>
                      <Input type="number" min="0" max={ready} step="any" value={actualIssueQty[line.id] ?? "0"}
                        onChange={(e) => setActualIssueQty((p) => ({ ...p,[line.id]:e.target.value }))} />
                    </div>
                    <div>
                      <Label className="text-xs">Internal reason {needsReason ? "*" : ""}</Label>
                      <Input placeholder={needsReason ? `Available ${ready} ${unit} mein se kam kyun diya?` : "Optional"}
                        value={actualIssueReason[line.id] ?? ""}
                        onChange={(e) => setActualIssueReason((p) => ({ ...p,[line.id]:e.target.value }))} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActualIssueReq(null)}>Cancel</Button>
            <Button onClick={submitActualIssue}
              disabled={issueActual.isPending || issueLeavePickup.isPending || (storeLeaveMode && !actualIssueProof)}>
              <PackageCheck className="mr-2 h-4 w-4" />
              {storeLeaveMode ? "Photo ke saath pickup save karo" : "Actual quantity issue karo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Chef's original request is never rewritten. Managers may reduce only;
          admins may replace an unissued item and set the full final quantity. */}
      <Dialog open={!!correction} onOpenChange={(open) => { if (!open) setCorrection(null); }}>
        <DialogContent className="h-[calc(100dvh-0.75rem)] max-h-[calc(100dvh-0.75rem)] w-[calc(100vw-0.75rem)] max-w-[calc(100vw-0.75rem)] overflow-y-auto p-4 sm:h-auto sm:max-h-[90vh] sm:max-w-2xl sm:p-6">
          <DialogHeader>
            <DialogTitle>REQ-{correction?.req_no} · Manager full order edit</DialogTitle>
          </DialogHeader>
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            {canFullEdit ? (
              <>Quantity badha ya ghata sakte hain. Item name bhi badal sakte hain, jab us line ka saman issue na hua ho. <b>0</b> karne par item cancel hoga.</>
            ) : (
              <>Quantity sirf kam ho sakti hai. <b>0</b> karne par woh item cancel hoga.</>
            )}
            {" "}Jo quantity Store Keeper de chuka hai, usse kam nahi kar sakte—woh Chef “Bacha saman wapas” se return karega.
          </div>

          <div className="space-y-2">
            {(correction?.requisition_items || []).map((line: any) => {
              const asked = Number(line.requested_qty || 0);
              const finalNow = Number(line.approved_qty ?? line.requested_qty ?? 0);
              const issued = Number(line.issued_qty || 0);
              const unit = line.unit || line.ingredients?.unit || "";
              const selectedIngredientId = correctedIngredient[line.id] || line.ingredient_id;
              const selectedIngredient = (ingredients || []).find((x: any) => x.id === selectedIngredientId);
              const displayUnit = selectedIngredient?.unit || unit;
              return (
                <div key={line.id} className="rounded-lg border p-3">
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                    <div className="min-w-0 space-y-1.5">
                      <p className="font-semibold">{line.ingredients?.name || "—"}</p>
                      <p className="text-xs text-muted-foreground">
                        Chef ne manga {asked} {unit} · Approved {finalNow} {unit} · Mila {issued} {unit}
                      </p>
                      {line.original_ingredient?.name && (
                        <p className="text-xs text-warning">Chef ka original item: {line.original_ingredient.name}</p>
                      )}
                      {canFullEdit && (
                        <div className="pt-1">
                          <Label className="text-xs">Item name</Label>
                          <Select value={selectedIngredientId}
                                  disabled={issued > 0}
                                  onValueChange={(value) => setCorrectedIngredient((prev) => ({ ...prev, [line.id]: value }))}>
                            <SelectTrigger className="mt-1 h-11 w-full sm:w-72">
                              <SelectValue placeholder="Item chuno" />
                            </SelectTrigger>
                            <SelectContent>
                              {(ingredients || []).map((item: any) => (
                                <SelectItem key={item.id} value={item.id}>
                                  {item.name} · {item.unit}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <Label className="text-xs">Ab kitna rakhna hai?</Label>
                      <div className="mt-1 flex items-center gap-2">
                        <Input type="number" min={issued} max={canFullEdit ? undefined : finalNow} step="any"
                               className="h-11 w-28 text-right text-base"
                               value={correctedQty[line.id] ?? ""}
                               onChange={(e) => setCorrectedQty((prev) => ({ ...prev, [line.id]: e.target.value }))} />
                        <span className="w-12 text-left text-sm">{displayUnit}</span>
                      </div>
                    </div>
                  </div>
                  {issued > 0 && (
                    <p className="mt-2 text-xs text-warning">
                      Minimum {issued} {unit}: itna saman already kitchen ko mil chuka hai. Isliye item name locked hai.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <VoiceReasonInput value={correctionReason} onChange={setCorrectionReason}
            label="Reason" placeholder="Jaise: 35 ki jagah 3.5 kg chahiye tha" required />

          <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
            Original order delete nahi hoga. History mein Chef ka item/quantity, Admin correction aur reason sab dikhega.
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <div className="flex flex-wrap gap-2">
              {correction && !hasIssuedAnything(correction) ? (
                <Button variant="destructive" className="h-11" disabled={cancelReq.isPending}
                        onClick={() => cancelWholeOrder(correction)}>
                  <Trash2 className="mr-2 h-4 w-4" /> Pura order cancel
                </Button>
              ) : (
                <Button variant="outline" className="h-11" onClick={cancelAllRemaining}>
                  Baaki sab cancel
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="h-11" onClick={() => setCorrection(null)}>Band karo</Button>
              <Button className="h-11" onClick={saveCorrection}
                      disabled={correctReq.isPending || adminCorrectReq.isPending || !correctionReason.trim()}>
                {correctReq.isPending || adminCorrectReq.isPending ? "Save ho raha hai…" : "Changes save karo"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Raise a requisition ---- */}
      <Dialog open={newOpen} onOpenChange={(open) => { setNewOpen(open); if (!open) setChefExtraMode(false); }}>
        <DialogContent className="w-[calc(100vw-0.75rem)] max-w-[calc(100vw-0.75rem)] h-[calc(100dvh-0.75rem)] max-h-[calc(100dvh-0.75rem)] overflow-y-auto gap-4 p-4 sm:h-auto sm:max-w-3xl sm:max-h-[92vh] sm:p-6 lg:max-w-4xl">
          <DialogHeader className="sticky top-0 z-20 -mx-4 -mt-4 border-b bg-background px-4 pb-3 pt-4 sm:-mx-6 sm:-mt-6 sm:px-6 sm:pt-6">
            <DialogTitle>{chefExtraMode ? "Extra saman chahiye" : "Saman ki list bhejo"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Khana</Label>
              {/* Locked once a menu is picked, because the two used to be able
                  to disagree. Order #182 said "evening snacks" while pointing
                  at the 17th's night snacks plan: evening snacks was left with
                  no order at all, night snacks carried one nobody placed, and
                  the chef was told he was raising a top-up on a meal he had
                  never ordered. The menu is the more trustworthy of the two —
                  it is a dated row the manager published, not a dropdown
                  somebody may simply have left alone. The database now
                  enforces the same thing. */}
              <Select value={mealPeriod} onValueChange={setMealPeriod} disabled={!!pickedMenu}>
                <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MEAL_PERIODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                </SelectContent>
              </Select>
              {pickedMenu && (
                <p className="text-[11px] text-muted-foreground">
                  Taken from the menu you picked. Change the menu to change the meal.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Kis menu ke liye?</Label>
              <Select
                value={menuPlanId || "none"}
                onValueChange={(v) => {
                  setMenuPlanId(v === "none" ? "" : v);
                  // The manager's expected count is the number the kitchen
                  // should cook for — carry it across instead of retyping.
                  const plan = (menus || []).find((m: any) => m.id === v);
                  if (plan) {
                    setHeadcount(String(plan.actual_headcount ?? plan.expected_headcount ?? ""));
                    if (plan.meal_period) setMealPeriod(plan.meal_period);
                  }
                }}
              >
                <SelectTrigger className="h-11"><SelectValue placeholder="Pick the day being cooked for" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not linked</SelectItem>
                  {(menus || [])
                    .filter((m: any) => m.status === "published")
                    .sort((a: any, b: any) => String(b.menu_date).localeCompare(String(a.menu_date)))
                    .map((m: any) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.menu_date === tomorrowIst() ? "Tomorrow"
                        : m.menu_date === todayIst() ? "Today"
                        : fmtDate(m.menu_date)}
                      {" · "}
                      {MEAL_PERIODS.find((x) => x.value === m.meal_period)?.label} ({m.expected_headcount} pax)
                      {/* A day that has already gone says so, so nobody picks
                          it by accident and nobody enters one quietly. */}
                      {m.menu_date < todayIst() && (
                        <span className="ml-1.5 text-warning font-medium">· late entry</span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {/* A day already gone. The entry is allowed — the food left the
              shelf whether or not anyone wrote it down — but it is never
              silent, because a backdated order is exactly the shape a covered
              theft would take. The date it lands on is said out loud. */}
          {pickedMenu && pickedMenu.menu_date < todayIst() && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
              <p className="text-xs font-semibold">
                Late entry — this goes on {fmtDate(pickedMenu.menu_date)}, not today
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Order the quantities the kitchen actually took that day. The stock
                and the cost will be counted against {fmtDate(pickedMenu.menu_date)}.
              </p>
            </div>
          )}
          {/* Already issued once. The extra draw is allowed and still goes
              through the manager and the store — but it says what it is, and
              why, so 20 + 5 reads as 25 against a plan of 20 instead of two
              unrelated orders nobody adds up. */}
          {(alreadyIssued || chefExtraMode) && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 space-y-2">
              <p className="text-xs font-semibold">
                Extra saman kyun chahiye?
              </p>
              <p className="text-[11px] text-muted-foreground">
                Ek line mein reason likho. Manager ko साफ दिखेगा कि यह urgent top-up है.
              </p>
              <VoiceReasonInput value={extraReason} onChange={setExtraReason}
                label="Reason" placeholder="Jaise: poha kam pad gaya, 30 log extra aaye" required />
            </div>
          )}

          {/* Headcount for the day, and the learned suggestion built from it */}
          <div className="rounded-lg border p-3 space-y-2 bg-muted/30">
            <div className="flex items-end gap-3 flex-wrap">
              <div className="space-y-1.5">
                <Label className="text-xs">
                  Kitne log khayenge?
                  {menuPlanId && <span className="text-accent"> — manager ne bhara</span>}
                </Label>
                <Input
                  type="number" min={0} className="h-11 w-36" placeholder="e.g. 250"
                  value={headcount}
                  // The manager's published figure is the one that counts; the
                  // chef only types it when no menu is linked.
                  readOnly={!!menuPlanId}
                  onChange={(e) => setHeadcount(e.target.value)}
                />
              </div>
              <Button variant="outline" size="sm" className="h-11 text-xs"
                onClick={applySuggestions}
                disabled={!headcount || !suggestions?.length}>
                <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                Purane istemal se bharo
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {suggestions?.length
                ? `Pichhle 30 din se ${suggestions.length} saman ki quantity seekh li hai.`
                : "Abhi recipe save nahi hai. Kuch din issue record hone ke baad app quantity suggest karega."}
            </p>
          </div>

          {menuPlanId && (
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
              <p className="text-sm font-semibold">Is menu mein pehle kitna wastage hua?</p>
              <p className="mb-2 text-[11px] text-muted-foreground">Chef ko order bhejne se pehle pichhla result dikh raha hai.</p>
              {wastageContext.length === 0 ? <p className="text-xs text-muted-foreground">Is menu ka purana wastage record nahi hai.</p> : (
                <div className="space-y-1.5">{wastageContext.map((w: any) => <div key={w.dish_name} className="flex items-center justify-between gap-3 rounded-md bg-background p-2 text-xs"><b className="truncate">{w.dish_name}</b><span className="shrink-0 text-right">Pichhla: <b>{Number(w.last_wastage || 0).toFixed(2)} kg</b><br/><span className="text-muted-foreground">30 din avg {Number(w.avg_wastage_30d || 0).toFixed(2)} kg</span></span></div>)}</div>
              )}
            </div>
          )}

          {/* What the chef is actually asking for, and what it is worth.
              Without this they had to scroll the whole item list to see
              their own order. */}
          {/* The note the chef asked for: every short item in one place, with
              the figure. It is not a block — the kitchen still needs the food,
              and a chef who cannot ASK for it will simply take it, which is
              the one outcome this whole system exists to prevent. It is told,
              loudly, and the manager sees the same thing. */}
          {shortLines.length > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-semibold text-destructive">
                  {shortLines.length} cheez{shortLines.length > 1 ? "ein" : ""} kam
                  {shortLines.length > 1 ? " hain" : " hai"}
                </p>
                {speechSupported() && (
                  <button
                    type="button"
                    className="text-[11px] underline text-muted-foreground shrink-0"
                    onClick={() => {
                      const m = !muted;
                      setMuted(m); setMutedState(m);
                      if (!m) sayShortageSummary(shortLines.map((i) => ({ name: i.name, short: i.q - i.free, unit: i.unit })));
                    }}
                  >
                    {muted ? "awaaz chalu karo" : "awaaz band karo"}
                  </button>
                )}
              </div>
              <p className="text-[11px] mt-1 font-medium">
                {shortLines.map((i) =>
                  `${i.name} ${Math.round((i.q - i.free) * 1000) / 1000} ${i.unit} kam`).join(" · ")}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Order chala jayega, par store me itna maal nahi hai. Manager ko
                batao — ya to kam karo, ya khareedna padega.
              </p>
              {speechSupported() && !muted && (
                <button
                  type="button"
                  className="text-[11px] underline text-destructive mt-1"
                  onClick={() => sayShortageSummary(shortLines.map((i) => ({ name: i.name, short: i.q - i.free, unit: i.unit })))}
                >
                  phir se bolo
                </button>
              )}
            </div>
          )}

          {chosen.length > 0 && (
            <div className="rounded-lg border">
              <div className="px-3 py-2 border-b flex items-center justify-between">
                <p className="text-xs font-semibold">Aapki list — {chosen.length} saman</p>
                {!isChef && <p className="text-sm font-bold">₹{Math.round(requestValue).toLocaleString()}</p>}
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Saman</TableHead>
                      <TableHead className="text-xs text-right">Kitna</TableHead>
                      {!isChef && <TableHead className="text-xs text-right">Rate</TableHead>}
                      {!isChef && <TableHead className="text-xs text-right">Value</TableHead>}
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {chosen.map((i: any) => {
                      const { rate, fromInvoice } = rateOf(i.id);
                      return (
                        <TableRow key={i.id}>
                          <TableCell className="text-sm">{i.name}</TableCell>
                          <TableCell className="text-sm text-right">{i.q} {i.unit}</TableCell>
                          {!isChef && <TableCell className="text-sm text-right text-muted-foreground">
                            ₹{rate}
                            {!fromInvoice && <span className="text-[10px] block">no invoice yet</span>}
                          </TableCell>}
                          {!isChef && <TableCell className="text-sm text-right font-medium">
                            ₹{Math.round(i.q * rate).toLocaleString()}
                          </TableCell>}
                          <TableCell>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                              onClick={() => setQty((p) => ({ ...p, [i.id]: "" }))}>
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input placeholder="Search item…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-11 pl-8" />
          </div>

          <div className="space-y-3">
            {grouped.map(([cat, items]) => (
              <div key={cat}>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1 sticky top-0 bg-background py-1">
                  {cat}
                </p>
                <div className="space-y-1.5">
                  {items.map((i: any) => {
                    const { rate, fromInvoice } = rateOf(i.id);
                    const sug = suggestionOf(i.id);
                    const q = Number(qty[i.id]) || 0;
                    const free = freeOf(i);
                    const a = availOf(i.id);
                    const arrival = arrivalNote(i);
                    // Short only if nothing is coming in time. A vegetable that
                    // lands the morning of the meal is not a shortage; the same
                    // vegetable landing the day AFTER is.
                    const short = q > 0 && q > free && !(arrival && arrival.ok);
                    const shortBy = Math.round((q - free) * 1000) / 1000;
                    return (
                      <div key={i.id} className="flex min-h-14 items-center gap-3 rounded-md px-1 py-1.5">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate">{i.name}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {/* Free, not shelf. And when the two differ, both —
                                because "300 on the shelf but 240 already
                                ordered" is a thing the chef needs to see, not
                                a number quietly reduced behind his back. */}
                            {isChef ? `Abhi mil sakta hai: ${Math.round(free * 1000) / 1000} ${i.unit}` : `free ${Math.round(free * 1000) / 1000} ${i.unit}`}
                            {!isChef && a && Number(a.committed) > 0
                              ? ` (shelf ${Number(a.current_stock)}, ${Number(a.committed)} already ordered)` : ""}
                            {!isChef ? ` · ₹${rate}/${i.unit}${fromInvoice ? "" : " (no invoice yet)"}` : ""}
                            {sug?.per_head ? ` · pehle ${Number(sug.per_head).toFixed(3)}/person laga` : ""}
                          </p>
                          {/* Beside anything short of what is free: when the
                              next van comes. Green when it lands in time for
                              the meal, red when it lands after it — that is
                              the whole difference between "fine" and "the
                              kitchen has a problem tomorrow". */}
                          {/* q > 0 matters: free can be NEGATIVE when an item is
                              already over-ordered, and 0 > -85 is true. Without
                              this, Paneer sat there announcing "85 kg kam" to a
                              chef who had not asked for any. The negative free
                              figure on the line above already says it. */}
                          {q > 0 && q > free && arrival && (
                            <p className={`text-[11px] font-medium ${arrival.ok ? "text-success" : "text-destructive"}`}>
                              {arrival.ok
                                ? `${Math.round((q - free) * 1000) / 1000} ${i.unit} kam — par ${arrival.text}`
                                : `${Math.round((q - free) * 1000) / 1000} ${i.unit} kam — ${arrival.text}, khana pehle banega`}
                            </p>
                          )}
                          {q > 0 && !arrival && (
                            <p className={`text-[11px] font-medium ${short ? "text-destructive" : "text-muted-foreground"}`}>
                              {Math.round(free * 1000) / 1000} − {q} ={" "}
                              {Math.round((free - q) * 1000) / 1000} {i.unit}
                              {short
                                ? ` — ${shortBy} ${i.unit} kam hai`
                                : " left after this"}
                            </p>
                          )}
                        </div>
                        <Input
                          type="number" min={0}
                          className={`h-11 w-24 shrink-0 text-right text-base ${short ? "border-destructive" : ""}`}
                          placeholder="0"
                          value={qty[i.id] ?? ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            setQty((p) => ({ ...p, [i.id]: v }));
                            // Said out loud the moment it goes past what is
                            // free. A red line on a phone at arm's length in a
                            // kitchen is easy to walk past; a voice is not.
                            const n = Number(v) || 0;
                            if (n > 0 && n > free && !(arrival && arrival.ok)) sayShortage(i.name, n - free, i.unit);
                          }}
                        />
                        {!isChef && <span className="w-20 text-right text-xs text-muted-foreground">
                          {q > 0 ? `₹${Math.round(q * rate).toLocaleString()}` : ""}
                        </span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <VoiceReasonInput value={notes} onChange={setNotes} label="Notes (optional)" placeholder="Type ya bolkar note likho" />
          <DialogFooter className="sticky bottom-0 z-20 -mx-4 -mb-4 flex-col items-stretch gap-3 border-t bg-background px-4 pb-4 pt-3 sm:-mx-6 sm:-mb-6 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:pb-6">
            <p className="text-sm font-medium">
              {chosen.length} saman
              {!isChef && <> · <span className="font-bold">₹{Math.round(requestValue).toLocaleString()}</span></>}
              {!isChef && Number(headcount) > 0 && requestValue > 0 && (
                <span className="text-xs text-muted-foreground font-normal">
                  {" "}(₹{(requestValue / Number(headcount)).toFixed(2)}/head)
                </span>
              )}
            </p>
            <div className="flex w-full gap-2 sm:w-auto">
              <Button className="h-11 flex-1 sm:flex-none" variant="outline" onClick={() => { setNewOpen(false); setChefExtraMode(false); }}>Band karo</Button>
              <Button className="h-11 flex-1 sm:flex-none" onClick={submitNew}
                disabled={createReq.isPending || ((alreadyIssued || chefExtraMode) && !extraReason.trim())}>
                <Send className="w-4 h-4 mr-1.5" />
                {(alreadyIssued || chefExtraMode) ? "Extra saman bhejo" : "Manager ko bhejo"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Manager review with the ±7% band ---- */}
      <Dialog open={!!review} onOpenChange={(o) => { if (!o) setReview(null); }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Review REQ-{review?.req_no}</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">
            You may change any quantity by up to <b>±7%</b>. Set a line to 0 to reject just that item.
            Anything further has to go back to the chef — the database refuses it.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Item</TableHead>
                <TableHead className="text-xs text-right">Requested</TableHead>
                <TableHead className="text-xs text-right">Allowed band</TableHead>
                <TableHead className="text-xs text-right">Approve</TableHead>
                <TableHead className="text-xs text-right">Stock</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(review?.requisition_items || []).map((l: any) => {
                const req = Number(l.requested_qty);
                const lo = +(req * (1 - TOLERANCE)).toFixed(3);
                const hi = +(req * (1 + TOLERANCE)).toFixed(3);
                const v = Number(approved[l.id]);
                const bad = !isNaN(v) && v !== 0 && (v < lo - 1e-9 || v > hi + 1e-9);
                return (
                  <TableRow key={l.id} className={bad ? "bg-destructive/5" : ""}>
                    <TableCell className="text-sm">{l.ingredients?.name}</TableCell>
                    <TableCell className="text-sm text-right">{req} {l.unit}</TableCell>
                    <TableCell className="text-xs text-right text-muted-foreground">{lo} – {hi}</TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number" className={`w-24 h-8 text-right ml-auto ${bad ? "border-destructive" : ""}`}
                        value={approved[l.id] ?? ""}
                        onChange={(e) => setApproved((p) => ({ ...p, [l.id]: e.target.value }))}
                      />
                    </TableCell>
                    <TableCell className="text-sm text-right">
                      {(() => {
                        // What the manager is actually deciding: whether the
                        // store can hand this over. Thirty-eight lines on a
                        // phone and a bare number in the last column is not a
                        // warning — eleven lines were approved against an
                        // empty shelf because nothing on the screen said so.
                        const have = Number(l.ingredients?.current_stock ?? 0);
                        const take = isNaN(v) ? Number(l.requested_qty) : v;
                        const left = Math.round((have - take) * 1000) / 1000;
                        return (
                          <>
                            <span className="text-muted-foreground">{have} {l.unit}</span>
                            {take > 0 && (
                              left < 0
                                ? <span className="block text-[11px] font-semibold text-destructive">
                                    {Math.abs(left)} {l.unit} short
                                  </span>
                                : <span className="block text-[11px] text-muted-foreground">
                                    {left} left after
                                  </span>
                            )}
                          </>
                        );
                      })()}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {/* Said once, at the bottom, where the approve button is. */}
          {shortInReview.length > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5">
              <p className="text-xs font-semibold text-destructive">
                {shortInReview.length} line(s) ask for more than the store has
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {shortInReview.slice(0, 6).map((x: any) =>
                  `${x.name}: wants ${x.take}, has ${x.have}`).join(" · ")}
                {shortInReview.length > 6 ? " …" : ""}
              </p>
              <p className="text-[11px] mt-1">
                Approving is allowed — the delivery may still arrive before the
                evening issue. Store Keeper available quantity दे देगा और shortage
                वाली quantity pending रहेगी.
              </p>
            </div>
          )}

          {storeLeaveMode && (
            <div className="rounded-md border border-warning/40 bg-warning/5 p-3 space-y-1.5">
              <Label htmlFor="leave-pickup-name">Saman lene wale kitchen person ka naam *</Label>
              <Input id="leave-pickup-name" value={pickupName}
                onChange={(e) => setPickupName(e.target.value)}
                placeholder="Jaise: Ramesh Yadav" />
              <p className="text-[11px] text-muted-foreground">
                Ye naam Manager assign karega. Isi naam se actual pickup aur photo audit mein save honge.
              </p>
            </div>
          )}

          <Input placeholder="Review note (optional)" value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} />
          <DialogFooter className="items-center sm:justify-between gap-3">
            <p className={`text-xs ${outOfBand.length ? "text-destructive font-semibold" : "text-muted-foreground"}`}>
              {outOfBand.length ? `${outOfBand.length} line(s) outside ±7%` : "All lines within ±7%"}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => submitReview(false)} disabled={reviewReq.isPending || assignLeavePickup.isPending}>Reject</Button>
              <Button onClick={() => submitReview(true)} disabled={reviewReq.isPending || assignLeavePickup.isPending || outOfBand.length > 0 || (storeLeaveMode && pickupName.trim().length < 2)}>
                <ClipboardList className="w-4 h-4 mr-1.5" /> Approve
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
