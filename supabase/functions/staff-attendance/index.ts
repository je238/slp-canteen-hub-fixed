// Staff attendance from the staff member's own phone.
//
// Staff have no app account (that would open stock, bills and rates to them
// through the API). They sign in here with mobile + PIN and get a signed
// token that only this function accepts. Location and time are checked in
// the database (staff_attendance_punch); the selfie goes to the private
// "attendance" bucket, which only managers can read.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_KEY);
const TOKEN_DAYS = 180;
const enc = new TextEncoder();

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let keyPromise: Promise<CryptoKey> | null = null;
const hmacKey = () => keyPromise ??= crypto.subtle.importKey(
  "raw", enc.encode("staff-attendance:" + SERVICE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

async function sign(payload: string) {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(payload)));
  return b64url(sig);
}

// token = staffId.pinVer.expiry.signature — a new PIN (pinVer) signs every phone out
async function makeToken(staffId: string, pinVer: number) {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_DAYS * 86400;
  const body = `${staffId}.${pinVer}.${exp}`;
  return `${body}.${await sign(body)}`;
}

async function readToken(token: unknown): Promise<{ staffId: string; pinVer: number } | null> {
  const parts = String(token || "").split(".");
  if (parts.length !== 4) return null;
  const [staffId, pinVer, exp, sig] = parts;
  if (!/^[0-9a-f-]{36}$/.test(staffId) || Number(exp) < Date.now() / 1000) return null;
  if ((await sign(`${staffId}.${pinVer}.${exp}`)) !== sig) return null;
  return { staffId, pinVer: Number(pinVer) };
}

async function status(staffId: string) {
  const { data, error } = await db.rpc("staff_attendance_status", { p_staff_id: staffId });
  if (error) throw new Error(error.message);
  return data as Record<string, any> | null;
}

const istDate = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    if (action === "login") {
      const phone = String(body.phone || "").replace(/\D/g, "").slice(-10);
      const pin = String(body.pin || "");
      if (phone.length !== 10 || !/^\d{4,6}$/.test(pin)) return json({ error: "10 ank ka mobile aur 4-6 ank ka PIN daalo" }, 400);
      const { data, error } = await db.rpc("staff_attendance_login", { p_phone: phone, p_pin: pin });
      if (error) return json({ error: error.message }, 400);
      if (data?.error) return json({ error: data.error }, 400);
      const token = await makeToken(data.staff_id, Number(data.pin_ver));
      return json({ token, me: await status(data.staff_id) });
    }

    const who = await readToken(body.token);
    if (!who) return json({ error: "Dobara login karo", relogin: true }, 401);
    const me = await status(who.staffId);
    if (!me || !me.active || Number(me.pin_ver) !== who.pinVer) {
      return json({ error: "Dobara login karo", relogin: true }, 401);
    }

    if (action === "status") return json({ me });

    if (action === "punch") {
      const kind = body.kind === "out" ? "out" : "in";
      const photo = String(body.photo || "");
      const m = photo.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
      if (!m) return json({ error: "Selfie zaroori hai" }, 400);
      const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      if (bytes.length > 3_000_000) return json({ error: "Photo bahut badi hai" }, 400);
      const path = `${me.canteen_id}/${istDate()}/${who.staffId}-${kind}-${Date.now()}.jpg`;
      const up = await db.storage.from("attendance").upload(path, bytes, {
        contentType: `image/${m[1] === "jpg" ? "jpeg" : m[1]}`, upsert: false,
      });
      if (up.error) return json({ error: "Selfie save nahi hui, dobara try karo" }, 500);

      const { data, error } = await db.rpc("staff_attendance_punch", {
        p_staff_id: who.staffId, p_kind: kind,
        p_lat: Number(body.lat), p_lng: Number(body.lng),
        p_accuracy_m: body.accuracy == null ? null : Number(body.accuracy),
        p_photo: path,
      });
      if (error) {
        await db.storage.from("attendance").remove([path]);   // refused: keep no photo
        return json({ error: error.message }, 400);
      }
      return json({ result: data, me: await status(who.staffId) });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("staff-attendance", e instanceof Error ? e.message : e);
    return json({ error: "Server mein dikkat, thodi der baad try karo" }, 500);
  }
});
