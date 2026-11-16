// Emails to Super Admin / Owner / Admin, sent through Gmail.
//   kind "escalation" (6 PM IST): orders still waiting for approval
//   kind "daily"      (10 PM IST): numbers, attendance, consumption, HS entries
//   kind "test"       : both, now, so a manager can see they arrive
// Called by pg_cron with the x-cron-token header, or by a Super Admin / Admin
// from the app (their sign-in is checked) for "test".
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const APP = "https://slp-canteen-hub-fixed.vercel.app";

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const rs = (n: unknown) => n == null ? "—" : "₹" + Math.round(Number(n)).toLocaleString("en-IN");
const num = (n: unknown) => n == null ? "—" : Number(n).toLocaleString("en-IN");
const time = (iso?: string | null) => iso
  ? new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }) : "—";
const dateLabel = (d: string) => new Date(d + "T00:00:00+05:30").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const MEAL: Record<string, string> = { breakfast: "Breakfast", lunch: "Lunch", evening_snacks: "Evening snacks", dinner: "Dinner", night_snacks: "Night snacks", extra: "Extra" };
const mins = (n: number) => n >= 60 ? `${Math.floor(n / 60)}h ${n % 60}m` : `${n}m`;

const TH = 'style="text-align:left;padding:6px 8px;background:#f3f4f6;font-size:12px;border-bottom:1px solid #e5e7eb"';
const TD = 'style="padding:6px 8px;font-size:13px;border-bottom:1px solid #f0f0f0"';
const table = (heads: string[], rows: string[][]) => rows.length === 0 ? "" :
  `<table cellspacing="0" style="border-collapse:collapse;width:100%;margin:6px 0 14px">
    <tr>${heads.map((h) => `<th ${TH}>${h}</th>`).join("")}</tr>
    ${rows.map((r) => `<tr>${r.map((c) => `<td ${TD}>${c}</td>`).join("")}</tr>`).join("")}</table>`;
const wrap = (title: string, body: string) => `<div style="font-family:Arial,sans-serif;max-width:720px;color:#111">
  <h2 style="margin:0 0 4px">${esc(title)}</h2>${body}
  <p style="font-size:12px;color:#6b7280;margin-top:20px">SLP Canteen Hub · <a href="${APP}">App kholo</a></p></div>`;

async function send(subject: string, html: string) {
  const user = Deno.env.get("GMAIL_USER")?.trim(), pass = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!user || !pass) throw new Error("GMAIL_USER / GMAIL_APP_PASSWORD secret set nahi hai");
  const { data, error } = await db.rpc("email_recipients");
  if (error) throw new Error(error.message);
  const to = [...new Set((data || []).map((r: any) => r.email))].join(", ");
  if (!to) throw new Error("Koi Admin / Super Admin email nahi mila");
  const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass: pass.replace(/\s+/g, "") } });
  await t.sendMail({ from: `SLP Canteen Hub <${user}>`, to, subject, html });
  return to;
}

async function escalation(force = false) {
  const { data, error } = await db.rpc("email_pending_orders");
  if (error) throw new Error(error.message);
  const rows = (data || []) as any[];
  if (!rows.length && !force) return { sent: false, reason: "Sab orders approve ho chuke" };
  const body = rows.length === 0
    ? `<p>Abhi koi order approval ke liye nahi ruka hai. (Test email)</p>`
    : `<p style="color:#b91c1c;font-weight:bold">Shaam 6 baje tak ${rows.length} order approve nahi hue.</p>` +
      table(["Site", "Order", "Kiske liye", "Meal", "Items", "Kiske paas ruka", "Kab bana", "Kisne banaya"],
        rows.map((r) => [esc(r.site), `REQ-${r.req_no}${r.is_extra ? " (extra)" : ""}`, r.for_date ? dateLabel(r.for_date) : "—",
          esc(MEAL[r.meal] || r.meal), num(r.items), `<b>${esc(r.waiting_with)}</b>`,
          new Date(r.raised_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
          esc(r.raised_by)])) +
      `<p><a href="${APP}/requisitions">Orders kholo →</a></p>`;
  const to = await send(rows.length ? `⚠ ${rows.length} order abhi tak approve nahi hue (6 PM)` : "Test: 6 PM order escalation", wrap("Order approval escalation", body));
  return { sent: true, to, orders: rows.length };
}

async function daily(day = istToday()) {
  const { data, error } = await db.rpc("email_daily_digest", { p_date: day });
  if (error) throw new Error(error.message);
  let body = `<p style="color:#6b7280;margin:0 0 12px">${dateLabel(day)}</p>`;
  for (const s of (data?.sites || []) as any[]) {
    const m = s.summary || {};
    body += `<h3 style="margin:18px 0 6px;border-bottom:2px solid #111;padding-bottom:4px">${esc(s.site)}</h3>`;
    const idle = !Number(m.consumption) && !(s.meals || []).length && !s.staff_total && !Number(m.purchase_amount);
    if (idle) { body += `<p style="font-size:13px;color:#6b7280">Aaj is site par koi kaam darj nahi hua.</p>`; continue; }
    // wastage value from the dashboard is not reliable; quantity only
    body += table(["Food consumption", "Plates (expected → served)", "Per plate", "Wastage (qty)", "Purchase", "Approval baaki", "Issue baaki"], [[
      `<b>${rs(m.consumption)}</b>`, `${num(m.expected_headcount)} → <b>${num(m.plates_served)}</b>`, rs(m.cost_per_plate),
      m.wastage_qty ? num(m.wastage_qty) : "—", rs(m.purchase_amount),
      num(m.approvals_pending), num(m.issues_pending)]]);

    // Attendance
    const att = (s.attendance || []) as any[];
    if (!s.staff_total) body += `<p style="font-size:13px"><b>Staff attendance:</b> staff list abhi nahi bani (Staff Attendance → Staff).</p>`;
    else {
      const came = att.filter((a) => a.in), late = came.filter((a) => a.late_min > 0), absent = att.filter((a) => !a.in);
      body += `<p style="font-size:13px;margin-bottom:2px"><b>Staff attendance:</b> ${came.length}/${s.staff_total} aaye · ` +
        `<span style="color:#b91c1c">${late.length} late</span> · ${absent.length} nahi aaye</p>`;
      body += table(["Naam", "Kaam", "Shift", "Aaye", "Late", "Gaye"], att.map((a) => [
        esc(a.name), esc(a.role), a.shift_start || "—",
        a.in ? time(a.in) : `<span style="color:#b91c1c">Nahi aaye</span>`,
        a.late_min > 0 ? `<span style="color:#b91c1c">${mins(a.late_min)}</span>` : (a.in ? "Time par" : ""),
        a.out ? time(a.out) + (a.early_min > 0 ? ` <span style="color:#b45309">(${mins(a.early_min)} pehle)</span>` : "") : "—"]));
    }

    // HS entries
    const meals = (s.meals || []) as any[];
    body += `<p style="font-size:13px;margin-bottom:2px"><b>HS report (plates):</b>${meals.length ? "" : " aaj ka menu nahi tha"}</p>`;
    body += table(["Meal", "Expected", "Served", "Company punch", "Kab bhara"], meals.map((x) => [
      esc(MEAL[x.meal] || x.meal), num(x.expected),
      x.actual == null ? `<span style="color:#b45309">Nahi bhara</span>` : `<b>${num(x.actual)}</b>`,
      num(x.company_punch), x.recorded_at ? time(x.recorded_at) : "—"]));
    const w = (s.wastage || []) as any[];
    if (w.length) body += `<p style="font-size:13px;margin-bottom:2px"><b>Wastage (HS):</b></p>` +
      table(["Meal", "Dish", "Unit", "Kitna"], w.map((x) => [esc(MEAL[x.meal] || x.meal), esc(x.dish), x.unit_no ?? "—", `${num(x.qty)} ${esc(x.unit)}`]));

    // Consumption
    const cons = (s.consumption || []) as any[];
    body += `<p style="font-size:13px;margin-bottom:2px"><b>Sabse zyada laga saman:</b>${cons.length ? "" : " aaj koi issue nahi"}</p>`;
    body += table(["Item", "Quantity", "Value"], cons.map((x) => [esc(x.item), `${num(x.qty)} ${esc(x.unit)}`, rs(x.value)]));
  }
  body += `<p><a href="${APP}/reports-center">Poori report app mein →</a></p>`;
  const to = await send(`Daily report · ${dateLabel(day)}`, wrap("SLP Canteen · Daily report", body));
  return { sent: true, to };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const kind = String(body.kind || "");
    const cronToken = Deno.env.get("DAILY_EMAIL_TOKEN");
    const byCron = !!cronToken && req.headers.get("x-cron-token") === cronToken;
    if (!byCron) {
      // A signed-in Super Admin / Owner / Admin may send a test from the app.
      const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u } = await db.auth.getUser(jwt);
      const { data: role } = u?.user ? await db.from("user_roles").select("role").eq("user_id", u.user.id).maybeSingle() : { data: null };
      if (!["super_admin", "owner", "admin"].includes(role?.role || "")) return json({ error: "Not allowed" }, 403);
      if (kind !== "test") return json({ error: "Only test from the app" }, 400);
    }
    if (kind === "escalation") return json(await escalation());
    if (kind === "daily") return json(await daily(body.date));
    if (kind === "test") return json({ escalation: await escalation(true), daily: await daily(body.date) });
    return json({ error: "Unknown kind" }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("daily-email", msg);
    return json({ error: msg }, 500);
  }
});
