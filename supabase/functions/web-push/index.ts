import { createClient } from "npm:@supabase/supabase-js@2.98.0";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
let keysPromise: Promise<{ publicKey: string; privateKey: string }> | null = null;
function keys() {
  if (!keysPromise) {
    keysPromise = (async () => {
      const existing = await db.rpc("web_push_keys");
      if (existing.error) throw new Error("Signing configuration unavailable");
      if (existing.data) return existing.data;
      const initialized = await db.rpc("web_push_keys", { p_candidate: webpush.generateVAPIDKeys() });
      if (initialized.error || !initialized.data) throw new Error("Signing configuration unavailable");
      return initialized.data;
    })().catch((error) => { keysPromise = null; throw error; });
  }
  return keysPromise;
}
function trustedEndpoint(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.port &&
      (u.hostname === "fcm.googleapis.com" || u.hostname === "web.push.apple.com" ||
       /(^|\.)push\.services\.mozilla\.com$/.test(u.hostname));
  } catch { return false; }
}
function safeLink(value: unknown) {
  const link = typeof value === "string" ? value : "/dashboard";
  return link.startsWith("/") && !link.startsWith("//") && !link.includes("\\") ? link : "/dashboard";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method === "GET") {
    try { return reply({ publicKey: (await keys()).publicKey }); }
    catch { return reply({ error: "Push configuration unavailable" }, 503); }
  }
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  let jobId: string;
  let token: string;
  try {
    const bodyText = await req.text();
    if (bodyText.length > 1024) return reply({ error: "Invalid request" }, 400);
    const body = JSON.parse(bodyText);
    jobId = body.job_id;
    token = body.token;
    if (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/.test(jobId) ||
        typeof token !== "string" || !/^[0-9a-f-]{72}$/.test(token)) return reply({ error: "Unauthorized" }, 401);
  } catch { return reply({ error: "Invalid request" }, 400); }

  // Custom webhook authentication: per-job random credential is stored in a
  // service-role-only outbox, and atomically consumed before any network send.
  const claim = await db.rpc("claim_web_push_job", { p_job: jobId, p_token: token });
  if (claim.error) return reply({ error: "Queue unavailable" }, 503);
  if (!claim.data) return reply({ error: "Invalid or already claimed job" }, 401);
  const job = claim.data;
  try {
    if (!trustedEndpoint(job.subscription.endpoint)) throw new Error("Invalid push provider");
    const k = await keys();
    const payload = JSON.stringify({
      id: job.notification.id,
      title: String(job.notification.title || "SLP Canteen Hub").slice(0, 160),
      body: String(job.notification.body || "Naya update aaya hai").slice(0, 500),
      url: safeLink(job.notification.link),
    });
    // Use fetch rather than Node's HTTPS socket implementation in the edge runtime.
    const request = webpush.generateRequestDetails(job.subscription, payload, {
      TTL: 86400, urgency: "high",
      vapidDetails: {
        subject: "https://slp-canteen-hub-fixed.vercel.app",
        publicKey: k.publicKey, privateKey: k.privateKey,
      },
    });
    const result = await fetch(request.endpoint, {
      method: request.method, headers: request.headers,
      body: new Uint8Array(request.body),
      redirect: "error", signal: AbortSignal.timeout(12000),
    });
    if (result.status === 404 || result.status === 410) {
      await db.from("web_push_subscriptions").delete().eq("id", job.subscription_id).eq("user_id", job.user_id);
      return reply({ status: "expired_subscription" });
    }
    if (!result.ok) throw new Error("Push provider HTTP " + result.status);
    const finished = await db.from("web_push_jobs").update({
      state: "sent", sent_at: new Date().toISOString(), last_error: null,
    }).eq("id", jobId).eq("dispatch_token", token);
    if (finished.error) throw new Error("Delivery acknowledgement failed");
    return reply({ status: "accepted_by_push_provider" });
  } catch (error) {
    // Never log endpoints, credentials, or private notification contents.
    const message = error instanceof Error ? error.message : "Push temporarily unavailable";
    await db.from("web_push_jobs").update({
      state: "pending", last_error: message.slice(0, 120),
    }).eq("id", jobId).eq("dispatch_token", token);
    return reply({ error: "Delivery will retry" }, 503);
  }
});
