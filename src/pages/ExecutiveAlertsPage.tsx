import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CalendarClock, ChevronDown, ChevronUp, ExternalLink, ImageIcon, Search, ShieldAlert, UserRound } from "lucide-react";
import AppLayout from "@/components/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCanteens, useUserDirectory } from "@/hooks/useSupabaseData";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useAppContext } from "@/contexts/AppContext";

const IMPORTANT_ACTIONS = [
  "stock_adjusted","rate_corrected","ingredient_renamed","ingredient_unit_changed","ingredient_removed","ingredient_merged",
  "purchase_line_corrected","purchase_reversed","manager_corrected_requisition","admin_corrected_requisition",
  "confirmed_purchase_line_corrected","consumed_purchase_line_rate_corrected",
  "requisition_cancelled","requisition_sent_back","chef_closed_pending_quantity","operational_alert_reviewed",
];

function todayIso() { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function sinceIso(days=30) { const d=new Date(); d.setDate(d.getDate()-days); return d.toISOString(); }
const human=(v:any)=>String(v||"").replace(/_/g," ");
const money=(v:any)=>`₹${Math.round(Number(v)||0).toLocaleString("en-IN")}`;
const qty=(v:any,unit="")=>`${Number(v||0).toLocaleString("en-IN",{maximumFractionDigits:3})}${unit?` ${unit}`:""}`;
const dateTime=(v:any)=>v?new Date(v).toLocaleString("en-IN",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}):"—";
const mealLabel=(v:any)=>({breakfast:"Breakfast",lunch:"Lunch",dinner:"Dinner",evening_snacks:"Evening Snacks",night_snacks:"Night Snacks",tea:"Tea"} as any)[v]||human(v)||"Meal not linked";
const actionTitle=(action:string)=>({
  stock_adjusted:"Stock manually changed",rate_corrected:"Item rate changed",ingredient_renamed:"Item name changed",
  ingredient_unit_changed:"Item unit changed",ingredient_removed:"Inventory item removed",ingredient_merged:"Duplicate items merged",
  purchase_line_corrected:"Purchase line changed",confirmed_purchase_line_corrected:"Confirmed invoice line corrected",
  purchase_reversed:"Purchase reversed",manager_corrected_requisition:"Manager changed kitchen order",
  admin_corrected_requisition:"Admin changed kitchen order",requisition_cancelled:"Kitchen order cancelled",
  requisition_sent_back:"Order sent back to Chef",chef_closed_pending_quantity:"Chef closed pending quantity",
} as any)[action]||human(action);

type FeedItem={
  key:string; source:"audit"|"automatic"|"system"; siteId?:string|null; site:string; title:string; description:string;
  severity:"critical"|"warning"|"info"; status:string; at:string; oldValue?:string; newValue?:string;
  reason?:string; person?:string; impact?:number; reviewId?:string; to?:string;
  details?:{label:string;value:string}[]; history?:{date:string;meal?:string;req_no?:number;issued_qty:number}[];
  attachments?:{id:string;path:string;label:string;amount?:number|null;billDate?:string|null;uploadedAt:string;uploadedBy:string}[];
  invoiceLines?:{id:string;item:string;purchaseAt:string;vendor:string;quantity:number;unit:string;rate:number;total:number}[];
  invoiceCorrections?:{id:string;at:string;by:string;reason:string;oldValues:any;newValues:any}[];
};

export default function ExecutiveAlertsPage(){
  const {selectedCanteen}=useAppContext();
  const [search,setSearch]=useState("");
  const [alertFilter,setAlertFilter]=useState<"all"|"critical">("all");
  const [review,setReview]=useState<FeedItem|null>(null);
  const [reviewStatus,setReviewStatus]=useState("resolved");
  const [reason,setReason]=useState("");
  const [expanded,setExpanded]=useState<Set<string>>(new Set());
  const qc=useQueryClient();
  const navigate=useNavigate();
  const {data:canteens=[]}=useCanteens();
  const {data:users={}}=useUserDirectory();
  const siteNames=useMemo(()=>Object.fromEntries(canteens.map((c:any)=>[c.id,c.name])),[canteens]);

  const {data:raw,isLoading,error}=useQuery({
    queryKey:["executiveExceptionSource"], refetchInterval:60_000,
    queryFn:async()=>{
      const from=sinceIso(30);
      const [fraud,logs,purchases,scans,units,operations]=await Promise.all([
        supabase.from("fraud_alerts").select("*").in("status",["open","reviewed","escalated"]).order("created_at",{ascending:false}).limit(200),
        supabase.from("action_logs").select("id,user_id,action,entity_type,canteen_id,details,created_at").in("action",IMPORTANT_ACTIONS).gte("created_at",from).order("created_at",{ascending:false}).limit(300),
        supabase.from("purchases").select("id,canteen_id,supplier_id,status,total_amount,stated_total,tax_amount,other_charges,bill_status,payment_status,invoice_image_url,bill_received_at,approved_at,created_at,created_by,suppliers(name),purchase_items(id,ingredient_id,item_name,quantity,unit,rate,total,matched),purchase_invoice_files(id,image_path,bill_number,bill_date,amount,uploaded_by,created_at),purchase_line_corrections(id,corrected_by,reason,old_values,new_values,created_at)").eq("status","confirmed").gte("created_at",from).order("created_at",{ascending:true}),
        supabase.from("ocr_scan_events" as any).select("id,canteen_id,status,error_message,duration_ms,created_at,user_id").gte("created_at",sinceIso(7)).order("created_at",{ascending:false}),
        supabase.from("historical_unit_review" as any).select("purchase_item_id,canteen_id,created_at,item_name,bill_unit,master_unit,conversion_confirmed,conversion_note").eq("conversion_confirmed",false),
        supabase.rpc("executive_alert_details" as any,{p_date:todayIso()}),
      ]);
      const rows=(r:any)=>r.error?[]:(r.data||[]);
      return {fraud:rows(fraud),logs:rows(logs),purchases:rows(purchases),scans:rows(scans),units:rows(units),operations:rows(operations)};
    }
  });

  const feed=useMemo(()=>{
    if(!raw)return [] as FeedItem[];
    const out:FeedItem[]=[];
    const purchaseById=new Map(raw.purchases.map((purchase:any)=>[purchase.id,purchase]));
    const purchaseEvidence=(purchase:any):NonNullable<FeedItem["attachments"]>=>{
      const files:any[]=purchase?.purchase_invoice_files||[];
      const attachments:NonNullable<FeedItem["attachments"]>=files.map((bill:any,index:number)=>({
        id:bill.id,path:bill.image_path,label:bill.bill_number?`Bill ${bill.bill_number}`:`Bill ${index+1}`,
        amount:bill.amount,billDate:bill.bill_date,uploadedAt:bill.created_at,
        uploadedBy:users[bill.uploaded_by]||"Store Keeper",
      }));
      if(purchase?.invoice_image_url&&!attachments.length)attachments.push({
        id:`purchase-${purchase.id}`,path:purchase.invoice_image_url,label:"Original invoice",
        amount:purchase.stated_total??purchase.total_amount,billDate:null,
        uploadedAt:purchase.bill_received_at||purchase.created_at,
        uploadedBy:users[purchase.created_by]||"Store Keeper",
      });
      return attachments;
    };
    const priorPurchaseLine=(ingredientId:string,purchaseAt:string)=>{
      let found:any=null;
      for(const purchase of raw.purchases){
        if(new Date(purchase.created_at).getTime()>=new Date(purchaseAt).getTime())continue;
        for(const line of (purchase.purchase_items||[]))if(line.ingredient_id===ingredientId)found={purchase,line};
      }
      return found;
    };
    for(const row of raw.fraud){
      const purchase:any=row.purchase_id?purchaseById.get(row.purchase_id):null;
      const sameItemLines:any[]=(purchase?.purchase_items||[]).filter((line:any)=>line.ingredient_id===row.ingredient_id);
      const alertRate=Number(row.actual_value||0);
      const line=sameItemLines.length?[...sameItemLines].sort((a,b)=>Math.abs(Number(a.rate)-alertRate)-Math.abs(Number(b.rate)-alertRate))[0]:null;
      const previous=purchase&&row.ingredient_id?priorPurchaseLine(row.ingredient_id,purchase.created_at):null;
      const unit=line?.unit||previous?.line?.unit||"unit";
      const details:{label:string;value:string}[]=[];
      const attachments=purchaseEvidence(purchase);
      if(purchase){
        details.push(
          {label:"Ye purchase kab hua",value:dateTime(purchase.created_at)},
          {label:"Supplier",value:purchase.suppliers?.name||"Supplier nahi dala"},
          {label:"Quantity",value:line?qty(line.quantity,unit):"Purchase line ab change ho chuki hai"},
          {label:"Alert wala rate",value:`${money(row.actual_value)} / ${unit}`},
          {label:"Purchase reference",value:`#${String(purchase.id).slice(0,8).toUpperCase()}`},
          {label:"Entry kisne ki",value:users[purchase.created_by]||"User record unavailable"},
        );
        if(attachments.length)details.push({label:"Bill kab upload hua",value:dateTime(attachments[0].uploadedAt)});
        else details.push({label:"Bill/photo",value:"Abhi attach nahi hai"});
        if(line&&Math.abs(Number(line.rate)-alertRate)>0.0001)details.push({label:"Ab corrected rate",value:`${money(line.rate)} / ${unit}`});
      }
      if(previous)details.push(
        {label:"Pichli purchase date",value:dateTime(previous.purchase.created_at)},
        {label:"Pichla supplier",value:previous.purchase.suppliers?.name||"Supplier nahi dala"},
        {label:"Pichla rate",value:`${money(previous.line.rate)} / ${previous.line.unit||unit}`},
      );
      out.push({
        key:`fraud-${row.id}`,source:"system",siteId:row.canteen_id,site:siteNames[row.canteen_id]||"Site",
        title:row.title,description:row.description||human(row.alert_type),severity:row.severity==="critical"?"critical":"warning",
        status:row.status,at:row.created_at,oldValue:row.expected_value==null?undefined:String(row.expected_value),
        newValue:row.actual_value==null?undefined:String(row.actual_value),reason:row.review_note||"Automatic control rule",
        impact:Number(row.loss_value||0),reviewId:row.id,details,attachments,to:purchase?"/purchases":undefined,
        person:purchase?(users[purchase.created_by]||"Purchase entry user"):undefined,
      });
    }
    for(const row of raw.logs){
      const d=row.details||{};
      const changes=Array.isArray(d.changes)&&d.changes.length?d.changes:[null];
      changes.forEach((change:any,index:number)=>{
        const oldObj=d.old||{};const newObj=d.new||{};
        const oldName=change?.old_item||oldObj.item_name||d.item||d.dish;
        const newName=change?.new_item||newObj.item_name||oldName;
        const oldQty=change?.old_qty??oldObj.quantity??d.was;
        const newQty=change?.new_qty??newObj.quantity??d.now;
        const unit=newObj.unit||oldObj.unit||d.unit||"";
        const changedItem=oldName&&newName&&oldName!==newName;
        const detailRows:{label:string;value:string}[]=[];
        if(d.req_no!=null)detailRows.push({label:"Order",value:`REQ-${d.req_no} · ${human(d.status||"")}`});
        if(oldName)detailRows.push({label:"Item pehle",value:String(oldName)});
        if(newName&&changedItem)detailRows.push({label:"Item ab",value:String(newName)});
        if(oldQty!=null)detailRows.push({label:"Quantity pehle",value:`${oldQty} ${unit}`.trim()});
        if(newQty!=null)detailRows.push({label:"Quantity ab",value:`${newQty} ${unit}`.trim()});
        if(change?.issued!=null)detailRows.push({label:"Pehle hi issue",value:String(change.issued)});
        if(oldObj.rate!=null||newObj.rate!=null)detailRows.push({label:"Rate",value:`${money(oldObj.rate)} → ${money(newObj.rate)}`});
        if(oldObj.unit||newObj.unit)detailRows.push({label:"Unit",value:`${oldObj.unit||"—"} → ${newObj.unit||"—"}`});
        out.push({
          key:`log-${row.id}-${index}`,source:"audit",siteId:row.canteen_id,
          site:siteNames[row.canteen_id]||"Site",title:actionTitle(row.action),
          description:[changedItem?`${oldName} → ${newName}`:newName,d.req_no?`REQ-${d.req_no}`:null].filter(Boolean).join(" · ")||human(row.entity_type),
          severity:["stock_adjusted","rate_corrected","admin_corrected_requisition","confirmed_purchase_line_corrected"].includes(row.action)?"warning":"info",
          status:"recorded",at:row.created_at,
          oldValue:changedItem?String(oldName||"—"):oldQty==null?undefined:String(oldQty),
          newValue:changedItem?String(newName||"—"):newQty==null?undefined:String(newQty),
          reason:d.reason||d.admin_edit_reason||"Recorded action",person:users[row.user_id]||"System",
          impact:Number(d.rupee_impact||d.value_swing||0),details:detailRows,
          to:row.entity_type==="requisition"?"/requisitions":row.entity_type==="purchase_item"?"/purchases":"/audit-log",
        });
      });
    }

    for(const row of raw.operations){
      const d=row.details||{};const unit=d.unit||"";
      if(row.kind==="ledger_mismatch")out.push({
        key:`ops-${row.kind}-${row.entity_id}`,source:"automatic",siteId:row.canteen_id,site:row.site_name,
        title:`Shelf aur ledger mismatch — ${row.item_name}`,description:`${row.event_date} · ${row.item_name}`,
        severity:"critical",status:"open",at:row.event_at,
        oldValue:`Shelf ${qty(d.shelf_qty,unit)}`,newValue:`Ledger ${qty(d.ledger_qty,unit)}`,
        reason:`Shelf aur ledger me ${qty(Math.abs(Number(d.difference)),unit)} ka difference hai`,
        impact:Number(d.rupee_difference||0),to:"/stock-audit",details:[
          {label:"Shelf par",value:qty(d.shelf_qty,unit)},{label:"Ledger me",value:qty(d.ledger_qty,unit)},
          {label:"Difference",value:qty(d.difference,unit)},{label:"Rate",value:`${money(d.rate)} per ${unit}`},
        ]
      });
      if(row.kind==="issue_pending")out.push({
        key:`ops-${row.kind}-${row.entity_id}`,source:"automatic",siteId:row.canteen_id,site:row.site_name,
        title:`Kitchen issue baaki — ${row.item_name}`,description:`REQ-${d.req_no} · ${mealLabel(d.meal_period)} · ${row.event_date}`,
        severity:row.severity,status:"open",at:row.event_at,
        oldValue:`Manga ${qty(d.requested_qty,unit)}`,newValue:`Issue ${qty(d.issued_qty,unit)} · Baaki ${qty(d.pending_qty,unit)}`,
        reason:Number(d.current_stock)<Number(d.pending_qty)?"Pending quantity ke liye stock kam hai":"Approved quantity abhi poori issue nahi hui",
        person:users[d.requested_by]||"Chef",to:"/requisitions",details:[
          {label:"Service date",value:String(row.event_date)},{label:"Meal",value:mealLabel(d.meal_period)},
          {label:"Chef ne manga",value:qty(d.requested_qty,unit)},{label:"Manager approved",value:qty(d.approved_qty,unit)},
          {label:"Store ne diya",value:qty(d.issued_qty,unit)},{label:"Abhi baaki",value:qty(d.pending_qty,unit)},
          {label:"Current stock",value:qty(d.current_stock,unit)},
        ]
      });
      if(row.kind==="over_order")out.push({
        key:`ops-${row.kind}-${row.entity_id}`,source:"automatic",siteId:row.canteen_id,site:row.site_name,
        title:`Chef order normal se ${Number(d.times_normal).toFixed(1)}× — ${row.item_name}`,
        description:`REQ-${d.req_no} · ${mealLabel(d.meal_period)} · ${row.event_date}`,
        severity:row.severity,status:"open",at:row.event_at,
        oldValue:`Pichla avg ${qty(d.previous_issued_avg,unit)}`,newValue:`Ab manga ${qty(d.requested_qty,unit)}`,
        reason:"Chef ki quantity pichle 5 issued records ke average se 50% se zyada hai",
        person:users[d.requested_by]||"Chef",to:"/requisitions",history:d.history||[],details:[
          {label:"Service date",value:String(row.event_date)},{label:"Meal",value:mealLabel(d.meal_period)},
          {label:"Chef ne manga",value:qty(d.requested_qty,unit)},{label:"Approved",value:qty(d.approved_qty,unit)},
          {label:"Issued",value:qty(d.issued_qty,unit)},{label:"Current stock",value:qty(d.current_stock,unit)},
          {label:"Pichla issued avg",value:qty(d.previous_issued_avg,unit)},
        ]
      });
      if(row.kind==="return_pending")out.push({
        key:`ops-${row.kind}-${row.entity_id}`,source:"automatic",siteId:row.canteen_id,site:row.site_name,
        title:`Kitchen return accept hona baaki — ${row.item_name}`,
        description:`${d.req_no?`REQ-${d.req_no} · `:""}${mealLabel(d.meal_period)} · ${row.event_date}`,
        severity:"warning",status:"open",at:row.event_at,oldValue:"Kitchen se return",newValue:qty(d.qty,unit),
        reason:d.reason||"Store Keeper acceptance pending",person:users[d.returned_by]||"Chef",to:"/requisitions",
        details:[{label:"Quantity",value:qty(d.qty,unit)},{label:"Service date",value:String(d.service_date||row.event_date)},
          {label:"Meal",value:mealLabel(d.meal_period)},{label:"Status",value:human(d.status)}]
      });
    }

    const rateHistory=new Map<string,number[]>();
    for(const p of raw.purchases){
      const lines:any[]=p.purchase_items||[];const lineTotal=lines.reduce((s,l)=>s+Number(l.total||0),0);
      const gst=Number(p.tax_amount||0);const otherCharges=Number(p.other_charges||0);
      const calculatedBillTotal=lineTotal+gst+otherCharges;
      if(p.stated_total!=null&&Math.abs(Number(p.stated_total)-calculatedBillTotal)>1){
        const attachments=purchaseEvidence(p);
        const corrections:any[]=p.purchase_line_corrections||[];
        out.push({
          key:`total-${p.id}`,source:"automatic",siteId:p.canteen_id,site:siteNames[p.canteen_id]||"Site",
          title:"Invoice total aur lines mismatch",description:p.suppliers?.name||"Vendor nahi dala",
          severity:"critical",status:"open",at:p.created_at,
          oldValue:`Scan / bill total ${money(p.stated_total)}`,newValue:`Items + GST/charges ${money(calculatedBillTotal)}`,
          reason:"Bill par likha total aur app ke final item rates + GST/charges match nahi hain",
          person:users[p.created_by]||"Store Keeper",impact:Math.abs(Number(p.stated_total)-calculatedBillTotal),to:"/purchases",
          details:[
            {label:"Vendor",value:p.suppliers?.name||"Vendor nahi dala"},
            {label:"Store Keeper entry",value:users[p.created_by]||"User record unavailable"},
            {label:"Purchase kab chadhaya",value:dateTime(p.created_at)},
            {label:"Invoice kab upload hua",value:attachments.length?dateTime(attachments[0].uploadedAt):"Photo attach nahi hai"},
            {label:"Scan / bill me total",value:money(p.stated_total)},
            {label:"Final item lines",value:money(lineTotal)},
            {label:"GST",value:money(gst)},
            {label:"Other charges",value:money(otherCharges)},
            {label:"Items + GST/charges",value:money(calculatedBillTotal)},
            {label:"Difference",value:money(Math.abs(Number(p.stated_total)-calculatedBillTotal))},
            {label:"Confirmed item lines",value:String(lines.length)},
          ],
          attachments,
          invoiceLines:lines.map((line:any)=>({
            id:line.id,item:line.item_name||"Unnamed item",purchaseAt:p.created_at,
            vendor:p.suppliers?.name||"Vendor nahi dala",quantity:Number(line.quantity||0),
            unit:line.unit||"",rate:Number(line.rate||0),total:Number(line.total||0),
          })),
          invoiceCorrections:corrections.map((change:any)=>({
            id:change.id,at:change.created_at,by:users[change.corrected_by]||"User record unavailable",
            reason:change.reason||"Reason nahi mila",oldValues:change.old_values||{},newValues:change.new_values||{},
          })),
        });
      }
      if(p.bill_status==="pending")out.push({key:`bill-${p.id}`,source:"automatic",siteId:p.canteen_id,site:siteNames[p.canteen_id]||"Site",title:"Goods received, bill pending",description:p.suppliers?.name||"No supplier",severity:"warning",status:"open",at:p.created_at,oldValue:"No bill",newValue:`${Math.floor((Date.now()-new Date(p.created_at).getTime())/86400000)} days`,reason:"Invoice photo/files abhi attach nahi hue",person:users[p.created_by]||"—",impact:Number(p.total_amount||0)});
      for(const l of lines){
        if(l.matched===false)out.push({key:`match-${l.id}`,source:"automatic",siteId:p.canteen_id,site:siteNames[p.canteen_id]||"Site",title:"Invoice item match verify karein",description:l.item_name,severity:"warning",status:"open",at:p.created_at,oldValue:"Unmatched",newValue:l.unit,reason:"Scanner/manual line kisi existing inventory item se confidently match nahi hui",person:users[p.created_by]||"—",impact:Number(l.total||0)});
        if(!l.ingredient_id)continue;const prev=rateHistory.get(l.ingredient_id)||[];const avg=prev.length?prev.reduce((a,b)=>a+b,0)/prev.length:0;
        if(avg>0&&Number(l.rate)>avg*1.2)out.push({key:`rate-${l.id}`,source:"automatic",siteId:p.canteen_id,site:siteNames[p.canteen_id]||"Site",title:"Purchase rate previous average se zyada",description:l.item_name,severity:Number(l.rate)>avg*1.5?"critical":"warning",status:"open",at:p.created_at,oldValue:money(avg),newValue:money(l.rate),reason:"Latest rate is over 20% above prior confirmed average",person:users[p.created_by]||"—",impact:Math.max(0,(Number(l.rate)-avg)*Number(l.quantity||0))});
        prev.push(Number(l.rate||0));rateHistory.set(l.ingredient_id,prev);
      }
    }

    const failed=new Map<string,any[]>();for(const s of raw.scans)if(s.status==="failed")failed.set(s.canteen_id,[...(failed.get(s.canteen_id)||[]),s]);for(const [site,list] of failed)if(list.length>=2)out.push({key:`scan-${site}`,source:"automatic",siteId:site,site:siteNames[site]||"Site",title:"Invoice scanner repeatedly fail hua",description:`${list.length} failures in 7 days`,severity:"warning",status:"open",at:list[0].created_at,oldValue:"0",newValue:String(list.length),reason:list[0].error_message||"OCR service/timeout review required",person:users[list[0].user_id]||"—"});
    for(const u of raw.units)out.push({key:`unit-${u.purchase_item_id}`,source:"automatic",siteId:u.canteen_id,site:siteNames[u.canteen_id]||"Site",title:"Bill unit aur inventory unit alag",description:u.item_name,severity:"warning",status:"open",at:u.created_at,oldValue:u.bill_unit,newValue:u.master_unit,reason:u.conversion_note||"Paper bill aur physical stock se verify karein"});

    return out
      .filter((item)=>selectedCanteen==="all"||item.siteId===selectedCanteen)
      .sort((a,b)=>new Date(b.at).getTime()-new Date(a.at).getTime());
  },[raw,siteNames,users,selectedCanteen]);

  const searched=useMemo(()=>{const q=search.trim().toLowerCase();return q?feed.filter(x=>[x.site,x.title,x.description,x.reason,x.person,JSON.stringify(x.details||[]),JSON.stringify(x.history||[])].join(" ").toLowerCase().includes(q)):feed;},[feed,search]);
  const visible=useMemo(()=>alertFilter==="critical"?searched.filter(x=>x.severity==="critical"):searched,[searched,alertFilter]);
  const reviewMutation=useMutation({mutationFn:async()=>{if(!review?.reviewId)throw new Error("This automatic alert is read-only");if(!reason.trim())throw new Error("Reason likhna zaroori hai");const {error}=await supabase.rpc("review_operational_alert" as any,{p_alert_id:review.reviewId,p_status:reviewStatus,p_reason:reason.trim()});if(error)throw error;},onSuccess:()=>{toast.success("Alert status audit ke saath save ho gaya");setReview(null);setReason("");qc.invalidateQueries({queryKey:["executiveExceptionSource"]});qc.invalidateQueries({queryKey:["executiveSiteDashboard"]});},onError:(e:any)=>toast.error(e.message)});

  return <AppLayout title="Executive Alerts"><div className="space-y-4 animate-fade-in">
    <Card className="border-none shadow-sm"><CardContent className="p-4"><div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3"><div><p className="font-semibold">Owner / GM exception control</p><p className="text-xs text-muted-foreground">Human changes me written reason; automatic alerts me detection basis. Audit history delete nahi hoti.</p></div><div className="relative sm:w-80"><Search className="absolute left-3 top-3 w-4 h-4 text-muted-foreground"/><Input className="pl-9" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Site, item, reason, person search"/></div></div></CardContent></Card>
    <div className="grid grid-cols-3 gap-3"><Stat label="Critical" value={searched.filter(x=>x.severity==="critical").length} bad/><Stat label="Warning" value={searched.filter(x=>x.severity==="warning").length}/><Stat label="Audit records" value={searched.filter(x=>x.source==="audit").length}/></div>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant={alertFilter==="all"?"default":"outline"} onClick={()=>setAlertFilter("all")} aria-pressed={alertFilter==="all"}>
        All Alerts ({searched.length})
      </Button>
      <Button
        variant={alertFilter==="critical"?"destructive":"outline"}
        className={alertFilter==="critical"?"":"border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"}
        onClick={()=>setAlertFilter("critical")}
        aria-pressed={alertFilter==="critical"}
      >
        <ShieldAlert className="w-4 h-4 mr-2"/>Red Alerts ({searched.filter(x=>x.severity==="critical").length})
      </Button>
      {alertFilter==="critical"?<span className="text-xs text-muted-foreground">Sirf critical red alerts dikh rahe hain</span>:null}
    </div>
    {error?<Card><CardContent className="p-8 text-center text-destructive">Alerts load nahi hue.</CardContent></Card>:isLoading?<Card><CardContent className="p-8 text-center text-muted-foreground">Alerts load ho rahe hain…</CardContent></Card>:<div className="space-y-2">{visible.map(item=><AlertCard key={item.key} item={item} open={expanded.has(item.key)} onToggle={()=>setExpanded(prev=>{const next=new Set(prev);next.has(item.key)?next.delete(item.key):next.add(item.key);return next;})} onGo={item.to?()=>navigate(item.to!):undefined} onReview={item.reviewId?()=>{setReview(item);setReviewStatus("resolved");setReason("");}:undefined}/>)}</div>}
    <Dialog open={!!review} onOpenChange={o=>{if(!o&&!reviewMutation.isPending)setReview(null);}}><DialogContent><DialogHeader><DialogTitle>Alert review — reason compulsory</DialogTitle></DialogHeader><div className="space-y-3"><div><Label>Status</Label><Select value={reviewStatus} onValueChange={setReviewStatus}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="reviewed">Reviewed — action chal raha hai</SelectItem><SelectItem value="resolved">Resolved — problem close</SelectItem><SelectItem value="escalated">Escalate to Owner</SelectItem><SelectItem value="open">Keep open</SelectItem></SelectContent></Select></div><div><Label>Kya check/action kiya?</Label><Input value={reason} onChange={e=>setReason(e.target.value)} placeholder="Written reason"/></div><Button className="w-full" disabled={reviewMutation.isPending} onClick={()=>reviewMutation.mutate()}>{reviewMutation.isPending?"Saving…":"Save with audit"}</Button></div></DialogContent></Dialog>
  </div></AppLayout>;
}

function Stat({label,value,bad}:{label:string;value:number;bad?:boolean}){return <Card className="border-none shadow-sm"><CardContent className="p-3"><p className="text-xs text-muted-foreground">{label}</p><p className={`text-xl font-bold ${bad&&value>0?"text-destructive":""}`}>{value}</p></CardContent></Card>}

function AlertCard({item,open,onToggle,onGo,onReview}:{item:FeedItem;open:boolean;onToggle:()=>void;onGo?:()=>void;onReview?:()=>void}){
  const hasDetail=!!item.details?.length||!!item.history?.length||!!item.attachments?.length||!!item.invoiceLines?.length||item.invoiceCorrections!==undefined;
  return <Card className={`border-none shadow-sm ${item.severity==="critical"?"bg-destructive/5":item.severity==="warning"?"bg-warning/5":""}`}>
    <CardContent className="p-4">
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldAlert className={`w-4 h-4 ${item.severity==="critical"?"text-destructive":item.severity==="warning"?"text-warning":"text-muted-foreground"}`}/>
            <p className="font-semibold text-sm">{item.title}</p>
            <Badge variant="outline" className="text-[10px]">{item.source}</Badge>
            <Badge variant={item.severity==="critical"?"destructive":"outline"} className="text-[10px]">{item.status}</Badge>
          </div>
          <p className="text-sm mt-1">{item.site} · {item.description}</p>
          {item.oldValue||item.newValue?<div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2 max-w-2xl">
            <div className="rounded-lg border bg-background/70 p-2"><p className="text-[9px] uppercase text-muted-foreground">Pehle / normal</p><p className="text-sm font-semibold break-words">{item.oldValue||"—"}</p></div>
            <ArrowRight className="w-4 h-4 text-muted-foreground"/>
            <div className="rounded-lg border bg-background/70 p-2"><p className="text-[9px] uppercase text-muted-foreground">Ab / actual</p><p className="text-sm font-semibold break-words">{item.newValue||"—"}</p></div>
          </div>:null}
          <div className="mt-2 rounded-lg border bg-background/70 px-3 py-2"><p className="text-[10px] uppercase text-muted-foreground">Reason / detection</p><p className="text-sm break-words">{item.reason||"—"}</p></div>
          {Number(item.impact)>0?<p className="text-xs mt-2 text-destructive font-semibold">Rupee impact: {money(item.impact)}</p>:null}
        </div>
        <div className="text-xs text-muted-foreground lg:text-right shrink-0 space-y-1">
          <p className="flex lg:justify-end items-center gap-1"><UserRound className="w-3 h-3"/>{item.person||"Automatic check"}</p>
          <p className="flex lg:justify-end items-center gap-1"><CalendarClock className="w-3 h-3"/>{dateTime(item.at)}</p>
        </div>
      </div>

      {hasDetail&&open?<div className="mt-3 border-t pt-3 space-y-3">
        {!!item.details?.length&&<div className="grid grid-cols-2 md:grid-cols-4 gap-2">{item.details.map((d,index)=><div key={`${d.label}-${index}`} className="rounded-lg bg-background/80 border p-2.5"><p className="text-[10px] text-muted-foreground">{d.label}</p><p className="text-sm font-semibold break-words mt-0.5">{d.value}</p></div>)}</div>}
        {!!item.attachments?.length&&<div><p className="text-xs font-semibold mb-2">Purchase ke saath laga bill</p><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{item.attachments.map(file=><InvoiceEvidence key={file.id} file={file}/>)}</div></div>}
        {!!item.invoiceLines?.length&&<div><p className="text-xs font-semibold mb-2">Har item ka purchase breakup</p><div className="overflow-x-auto rounded-lg border bg-background/80"><table className="w-full text-xs"><thead><tr className="border-b text-muted-foreground"><th className="text-left p-2">Purchase date</th><th className="text-left p-2">Vendor</th><th className="text-left p-2">Item</th><th className="text-right p-2">Kitna purchase</th><th className="text-right p-2">Cost / rate</th><th className="text-right p-2">Total purchase</th></tr></thead><tbody>{item.invoiceLines.map(line=><tr key={line.id} className="border-b last:border-0"><td className="p-2 whitespace-nowrap">{dateTime(line.purchaseAt)}</td><td className="p-2 whitespace-nowrap">{line.vendor}</td><td className="p-2 font-medium">{line.item}</td><td className="p-2 text-right whitespace-nowrap">{qty(line.quantity,line.unit)}</td><td className="p-2 text-right whitespace-nowrap">{money(line.rate)} / {line.unit||"unit"}</td><td className="p-2 text-right font-semibold whitespace-nowrap">{money(line.total)}</td></tr>)}</tbody></table></div></div>}
        {item.invoiceCorrections!==undefined&&<div><p className="text-xs font-semibold mb-2">Save hone ke baad kaunsi line badli</p>{item.invoiceCorrections.length?<div className="space-y-2">{item.invoiceCorrections.map(change=>{const oldValue=change.oldValues||{};const newValue=change.newValues||{};return <div key={change.id} className="rounded-lg border bg-background/80 p-3 text-xs"><p className="font-semibold">{oldValue.item_name||newValue.item_name||"Invoice line"}</p><p className="mt-1">Pehle: <span className="font-medium">{qty(oldValue.quantity,oldValue.unit)} × {money(oldValue.rate)} = {money(oldValue.total)}</span></p><p>Ab: <span className="font-medium">{qty(newValue.quantity,newValue.unit)} × {money(newValue.rate)} = {money(newValue.total)}</span></p><p className="mt-1 text-muted-foreground">{change.by} · {dateTime(change.at)} · {change.reason}</p></div>;})}</div>:<div className="rounded-lg border bg-background/80 p-3 text-xs text-muted-foreground">Save hone ke baad koi line correction record nahi hui. Difference initial scan/confirmation ke time se hai; bill photo se line verify karein.</div>}</div>}
        {!!item.history?.length&&<div><p className="text-xs font-semibold mb-2">Pehle kab kitna issue hua</p><div className="overflow-x-auto rounded-lg border bg-background/80"><table className="w-full text-xs"><thead><tr className="border-b text-muted-foreground"><th className="text-left p-2">Date</th><th className="text-left p-2">Meal</th><th className="text-left p-2">Order</th><th className="text-right p-2">Issued</th></tr></thead><tbody>{item.history.map((h,index)=><tr key={index} className="border-b last:border-0"><td className="p-2 whitespace-nowrap">{h.date}</td><td className="p-2">{mealLabel(h.meal)}</td><td className="p-2">{h.req_no?`REQ-${h.req_no}`:"—"}</td><td className="p-2 text-right font-semibold">{qty(h.issued_qty)}</td></tr>)}</tbody></table></div></div>}
      </div>:null}

      <div className="mt-3 flex flex-wrap gap-2">
        {hasDetail?<Button size="sm" variant="outline" onClick={onToggle}>{open?<><ChevronUp className="w-3.5 h-3.5 mr-1"/>Detail band karo</>:<><ChevronDown className="w-3.5 h-3.5 mr-1"/>Puri detail dekho</>}</Button>:null}
        {onGo?<Button size="sm" variant="outline" onClick={onGo}>Related screen <ArrowRight className="w-3.5 h-3.5 ml-1"/></Button>:null}
        {onReview?<Button size="sm" onClick={onReview}>Review / escalate</Button>:null}
      </div>
    </CardContent>
  </Card>;
}

function InvoiceEvidence({file}:{file:NonNullable<FeedItem["attachments"]>[number]}){
  const {data:url,isLoading,error}=useQuery({
    queryKey:["executive-invoice-evidence",file.path],
    queryFn:async()=>{const {data,error}=await supabase.storage.from("invoices").createSignedUrl(file.path,300);if(error)throw error;return data.signedUrl;},
    staleTime:240_000,
  });
  return <div className="overflow-hidden rounded-lg border bg-background/90">
    <button type="button" className="block w-full bg-muted/40" disabled={!url} onClick={()=>url&&window.open(url,"_blank","noopener,noreferrer")}>
      {url?<img src={url} alt={file.label} className="h-44 w-full object-contain" loading="lazy"/>:<div className="flex h-44 items-center justify-center text-sm text-muted-foreground"><ImageIcon className="mr-2 h-5 w-5"/>{isLoading?"Bill load ho raha hai…":error?"Bill nahi khula":"Bill photo"}</div>}
    </button>
    <div className="space-y-1 border-t p-3 text-xs">
      <div className="flex items-center justify-between gap-2"><p className="font-semibold">{file.label}</p>{url?<button type="button" className="inline-flex items-center gap-1 text-primary hover:underline" onClick={()=>window.open(url,"_blank","noopener,noreferrer")}>Full bill <ExternalLink className="h-3 w-3"/></button>:null}</div>
      {file.amount!=null?<p>Bill amount: <span className="font-semibold">{money(file.amount)}</span></p>:null}
      {file.billDate?<p>Bill date: <span className="font-semibold">{dateTime(file.billDate).split(",")[0]}</span></p>:null}
      <p>Store Keeper upload: <span className="font-semibold">{dateTime(file.uploadedAt)}</span></p>
      <p>Uploaded by: <span className="font-semibold">{file.uploadedBy}</span></p>
    </div>
  </div>;
}
