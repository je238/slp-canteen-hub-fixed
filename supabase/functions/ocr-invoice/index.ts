import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `You are an invoice OCR extraction tool for an Indian canteen ERP. Extract both the header fields and the line items from the invoice.

IMPORTANT: Indian suppliers often give a handwritten Hindi cash memo instead
of a printed GST invoice. That paper is still an invoice. Read handwritten
Devanagari item names and handwritten quantities, units, rates and amounts.
Do not return an empty items array merely because the paper has no GST number,
invoice number, typed text or formal item codes. If visible rows contain an
item description and numbers, return every such row.

Header fields (use null when not present on the invoice):
- vendor_name: the SELLER / supplier issuing the invoice (letterhead / "for <company>"), NOT the buyer in "Bill to".
  The BUYER is always Eicher / SLP Hospitality / Sun Pharma — never return those (or "Aishar") as vendor_name.
  ONLY the shop's name, at most 6 words, in English letters (e.g. "Manwani Traders",
  "New Ganesh Milk Point"). No address, phone, tagline, product list, notes or
  explanation. Never write your reasoning into any field. If unsure, use null.
- invoice_number
- invoice_date: ISO format YYYY-MM-DD
- gstin: the SELLER's GSTIN
- subtotal: taxable amount before taxes
- tax_amount: total GST (CGST+SGST+IGST)
- other_charges: freight, delivery, packing or similar charges
- grand_total: the final payable amount

Line items — one entry per goods line (exclude tax lines, freight, and summary rows):
- item_name: the item in English LETTERS, but NEVER a translated word.
  Write the name the kitchen itself says. Hindi script is romanised, not
  translated: जीरा -> Jeera (NOT Cumin), हींग -> Hing (NOT Asafoetida),
  मेथी -> Methi, राई -> Rai, सूजी -> Suji, बेसन -> Besan, गुड़ -> Gud,
  इमली -> Imli, पुदीना -> Podina, तेज पत्ता -> Tej Patta.
  If the bill already writes the name in English letters, copy it EXACTLY as
  written. Do not correct, translate, expand, or remove words.
- original_name: the name exactly as written on the bill (Hindi stays in Devanagari).
- quantity: copy the written numeric quantity. Do not convert boxes, packets,
  pieces, tins, crates, or bags into kilograms or litres.
- unit: copy the unit written beside the quantity, such as kg, litre, Box,
  packet, pcs, dozen, tin, crate, or bag. If the unit is missing, obscured, or
  unreadable, return exactly UNSURE. NEVER guess kg or infer a unit from the
  item name, rate, total, or common packaging.
- rate: the written price per written unit.
- total: quantity × rate before tax as written.
- gst_percent: total GST % for the line, null if none shown.

Indian invoices group digits like 1,67,700.00 — that is 167700. If a numeric
value is unreadable, use null rather than guessing. Use quantity × rate = total
as a cross-check when handwriting is unclear, but do not invent a value. An
unreadable unit must be UNSURE, never null and never kg.`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    invoice: {
      type: "OBJECT",
      properties: {
        vendor_name: { type: "STRING", nullable: true },
        invoice_number: { type: "STRING", nullable: true },
        invoice_date: { type: "STRING", nullable: true, description: "YYYY-MM-DD" },
        gstin: { type: "STRING", nullable: true },
        subtotal: { type: "NUMBER", nullable: true },
        tax_amount: { type: "NUMBER", nullable: true },
        other_charges: { type: "NUMBER", nullable: true },
        grand_total: { type: "NUMBER", nullable: true },
      },
    },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          item_name: { type: "STRING", description: "English trade name" },
          original_name: { type: "STRING", nullable: true, description: "as written on the bill" },
          quantity: { type: "NUMBER", nullable: true },
          unit: {
            type: "STRING",
            description: "Printed invoice unit exactly as read; use UNSURE when missing or unreadable; never infer kg",
          },
          rate: { type: "NUMBER", nullable: true },
          total: { type: "NUMBER", nullable: true },
          gst_percent: { type: "NUMBER", nullable: true },
        },
        required: ["item_name", "quantity", "unit", "rate", "total"],
      },
    },
  },
  required: ["invoice", "items"],
};

const MENU_PROMPT = `You are reading a canteen MENU chart supplied by a client company.

Return every meal you can see. A chart may cover one day or a whole week.

For each entry:
- day: the weekday in lowercase english ("monday".."sunday") if organised by weekday; otherwise null.
- date: ISO YYYY-MM-DD if an explicit calendar date is shown; otherwise null.
- meal_period: exactly one of breakfast, lunch, evening_snacks, tea, dinner,
  night_snacks. Map common wording: "morning tea"/"chai" -> tea,
  "snacks"/"sham ka nashta" -> evening_snacks, "supper" -> dinner,
  "nashta"/"breakfast" -> breakfast.
- items: dishes for that meal as short strings. Keep the language as written.
  Split on commas, slashes or new lines. Do not invent dishes.

If a cell is empty, omit that entry. Ignore prices, headings, logos and signatures.`;

const MENU_SCHEMA = {
  type: "OBJECT",
  properties: {
    menu: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          day: { type: "STRING", nullable: true },
          date: { type: "STRING", nullable: true, description: "YYYY-MM-DD" },
          meal_period: { type: "STRING" },
          items: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["meal_period", "items"],
      },
    },
  },
  required: ["menu"],
};

// The vision model is a reasoning model, and on a hard handwritten bill it has
// written its own thinking into the vendor_name field ("Let's use Manwani
// Traders... Wait, the M/s is SLP..."), pasted the whole letterhead, or looped
// one syllable a thousand times. The app saved each of those as a new vendor.
// Whatever the model sends, only a short clean name leaves this function.
const REASONING = /\b(let'?s|wait|vendor[_ ]name|as per|letterhead|context|actually|i think|check)\b/i;

// The buyer's own name is printed on many bills ("Eicher", "M/s SLP",
// "Sun Pharma") and the reader has taken it for the seller — Maa Annapurna's
// 1 Oct bill came back as vendor "Aishar". The buyer is never the vendor.
const BUYER = /^(m\/?s\.?\s*)?(eicher|aishar|aicher|ayshar|eichar|slp|s\.?\s?l\.?\s?p\.?|sun\s*pharma|sunpharma)\b/i;

export function cleanVendorName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let v = raw.replace(/[​-‍﻿]/g, "").trim();
  if (!v) return null;

  // Reasoning usually ends by stating the answer: take the last stated name.
  if (REASONING.test(v)) {
    const said = [...v.matchAll(/(?:vendor name is|let'?s (?:write|use|put)|name is)\s+["“]?([^."”()\n]{2,60})/gi)];
    if (said.length) v = said[said.length - 1][1];
  }

  v = v.split(/\r?\n/)[0];                 // a letterhead dump: its first line is the name
  v = v.replace(/^m\s*\/\s*s\.?\s+/i, ""); // "M/s Manwani Traders" -> the name
  v = v.replace(/\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]{3}.*$/i, ""); // a GSTIN glued on
  v = v.replace(/\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}.*$/, "");     // a date glued on
  v = v.replace(/\d{5,}.*$/, "");                               // a phone or bill no.
  v = v.replace(/\(.*$/, "");              // "(from warranty text ..." and anything after
  v = v.split(/\s+[-–|]\s+/)[0];           // "Shop - Ganga Nagar - Dewas"
  const parts = v.split(/\s*\/\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) v = parts.find((p) => /[A-Za-z]{3}/.test(p)) ?? parts[0];
  v = v.replace(/(.{3,}?)\1{2,}.*/u, "$1"); // a looped syllable
  v = v.replace(/\s+/g, " ").replace(/[.,;:]+$/, "").trim();

  if (v.length < 2 || REASONING.test(v) || BUYER.test(v)) return null;
  if (v.length > 60) v = v.slice(0, 60).replace(/\s+\S*$/, "");
  if (/^[A-Z0-9 &.'-]+$/.test(v) && /[A-Z]{3}/.test(v)) {
    v = v.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return v || null;
}

const MODELS = [
  // Full Flash reads dense printed tables and difficult handwriting much more
  // reliably than the Lite-only chain that previously returned empty bills.
  // Lite remains the fast fallback for provider load/rate-limit failures.
  // Handwritten bills take ~45 s on Flash; 40 s used to cut them off. The two
  // together stay inside the app's 115 s wait.
  { name: "gemini-3.5-flash", timeoutMs: 75_000 },
  { name: "gemini-3.5-flash-lite", timeoutMs: 30_000 },
];

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The scanner kept breaking about once a week because the model names were
// typed into this file and Google retires and renames models: Lovable's
// gateway went, then gemini-1.5/2.0/2.5, then 3.1, each time leaving the
// store keeper without a scanner until someone edited the names by hand.
// Now the newest stable Flash and Flash-Lite are asked of Google itself and
// remembered for a few hours; the list above is only the fallback. A model
// that answers 404 drops the memory so the next scan asks again.
// ---------------------------------------------------------------------------
type Model = { name: string; timeoutMs: number };
let modelCache: { at: number; list: Model[] } | null = null;
const MODEL_CACHE_MS = 6 * 60 * 60 * 1000;

async function pickModels(key: string): Promise<Model[]> {
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.list;
  try {
    const res = await fetchWithTimeout(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
      { headers: { "x-goog-api-key": key } },
      5_000,
    );
    if (res.ok) {
      const data = await res.json() as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      const names = (data.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, ""))
        // stable names only: no -preview, -exp, -tts, -image, dated snapshots
        .filter((n) => /^gemini-\d+(\.\d+)?-flash(-lite)?$/.test(n));
      const version = (n: string) => parseFloat(n.match(/^gemini-(\d+(?:\.\d+)?)/)![1]);
      const newest = (lite: boolean) => names.filter((n) => n.endsWith("-lite") === lite)
        .sort((a, b) => version(b) - version(a))[0];
      const list: Model[] = [];
      if (newest(false)) list.push({ name: newest(false)!, timeoutMs: MODELS[0].timeoutMs });
      if (newest(true)) list.push({ name: newest(true)!, timeoutMs: MODELS[1].timeoutMs });
      if (list.length) {
        modelCache = { at: Date.now(), list };
        return list;
      }
    } else {
      console.warn("Model list unavailable:", res.status);
    }
  } catch (error) {
    console.warn("Model list failed:", error instanceof Error ? error.message : error);
  }
  return MODELS;
}

// Said in words the owner can act on, from what Google answered.
function plainReason(lastError: string, sawRateLimit: boolean): string {
  if (sawRateLimit || /429|quota|RESOURCE_EXHAUSTED/i.test(lastError)) return "Gemini ka daily/minute quota khatam ho gaya (429). Billing ya quota badhana padega.";
  if (/API key|API_KEY|PERMISSION_DENIED|-> 40[13]/i.test(lastError)) return "Gemini API key kaam nahi kar rahi (galat, expire ya billing band). Nayi key daalni padegi.";
  if (/-> 404|not found|NOT_FOUND/i.test(lastError)) return "Google ne ye model band kar diya. Scanner agle scan par naya model khud dhoondhega.";
  if (/timed out|-> 50[34]|UNAVAILABLE|overloaded/i.test(lastError)) return "Google ka server dheema/busy tha, time par jawab nahi aaya.";
  return "Scanner fail hua.";
}

// One alert to the admin per few hours while the scanner is down, so the
// owner hears it from the app and not a week later from the store keeper.
async function alertScannerDown(canteenId: string | null, lastError: string, sawRateLimit: boolean) {
  const url = Deno.env.get("SUPABASE_URL");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !service) return;
  const h = { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" };
  try {
    const since = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const recent = await fetchWithTimeout(
      `${url}/rest/v1/notifications?select=id&ref_type=eq.scanner_down&created_at=gte.${since}&limit=1`,
      { headers: h }, 3_000);
    if (recent.ok && ((await recent.json()) as unknown[]).length) return;
    await fetchWithTimeout(`${url}/rest/v1/notifications`, {
      method: "POST", headers: { ...h, Prefer: "return=minimal" },
      body: JSON.stringify({
        canteen_id: canteenId, target_role: "admin",
        title: "Invoice scanner kaam nahi kar raha",
        body: `${plainReason(lastError, sawRateLimit)} Detail: ${lastError.slice(0, 220)}`,
        link: "/invoice-scan", ref_type: "scanner_down",
      }),
    }, 3_000);
  } catch (error) {
    console.warn("Scanner-down alert failed:", error instanceof Error ? error.message : error);
  }
}

function isTransientStatus(status: number) {
  return status === 408 || status === 429 || status === 500 ||
    status === 502 || status === 503 || status === 504;
}

function retryDelay(attempt: number) {
  const exponential = Math.min(750 * 2 ** attempt, 4_000);
  return exponential + Math.floor(Math.random() * 250);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    // Daily self-check from the database scheduler: a one-line request to
    // the model the scanner would use, and an alert to the admin if it fails.
    const healthToken = Deno.env.get("SCANNER_HEALTH_TOKEN");
    if (healthToken && req.headers.get("x-health-token") === healthToken) {
      const key = Deno.env.get("GEMINI_API_KEY");
      if (!key) {
        await alertScannerDown(null, "GEMINI_API_KEY not configured", false);
        return new Response(JSON.stringify({ ok: false, error: "GEMINI_API_KEY not configured" }), { headers: corsHeaders });
      }
      modelCache = null;                       // re-ask Google every morning
      const models = await pickModels(key);
      const started = Date.now();
      let error = "";
      try {
        const r = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${models[0].name}:generateContent`,
          { method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with the single word OK." }] }] }) },
          25_000);
        if (!r.ok) error = `${models[0].name} -> ${r.status}: ${(await r.text()).slice(0, 200)}`;
      } catch (e) {
        error = `${models[0].name} ${e instanceof DOMException && e.name === "AbortError" ? "timed out after 25000ms" : String(e)}`;
      }
      if (error) await alertScannerDown(null, error, /-> 429/.test(error));
      return new Response(JSON.stringify({ ok: !error, models: models.map((m) => m.name), ms: Date.now() - started, error: error || null }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (!jwt || jwt === anonKey) {
      return new Response(JSON.stringify({ error: "Sign in to use the scanner." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userRes = await fetchWithTimeout(
      `${Deno.env.get("SUPABASE_URL")}/auth/v1/user`,
      { headers: { apikey: anonKey, Authorization: `Bearer ${jwt}` } },
      4_000,
    );
    if (!userRes.ok) {
      return new Response(JSON.stringify({ error: "Your session has expired. Sign in again." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { imageBase64, mimeType, mode, canteenId } = await req.json();
    if (!imageBase64) throw new Error("No image provided");
    const isMenu = mode === "menu";

    if (imageBase64.length > 12_000_000) {
      return new Response(JSON.stringify({ error: "That image is too large. Take the photo again." }), {
        status: 413,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const kind = String(mimeType || "").toLowerCase();
    if (kind && !kind.startsWith("image/") && kind !== "application/pdf") {
      return new Response(JSON.stringify({ error: `Unsupported file type: ${mimeType}` }), {
        status: 415,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let knownNames: string[] = [];
    if (canteenId) {
      try {
        const namesRes = await fetchWithTimeout(
          `${Deno.env.get("SUPABASE_URL")}/rest/v1/ingredients` +
            `?select=name&canteen_id=eq.${canteenId}&order=name&limit=600`,
          { headers: { apikey: anonKey, Authorization: `Bearer ${jwt}` } },
          3_000,
        );
        if (namesRes.ok) {
          knownNames = ((await namesRes.json()) as { name: string }[])
            .map((row) => row.name)
            .filter(Boolean);
        }
      } catch (error) {
        console.warn("Known-name lookup skipped:", error instanceof Error ? error.message : error);
      }
    }

    const knownBlock = knownNames.length
      ? `\n\nTHE STORE ALREADY KEEPS THESE ITEMS, spelled exactly like this:\n` +
        knownNames.join(" | ") +
        `\n\nIf a bill line is one of the items above, reply with the store's spelling ` +
        `character for character. Only use a new name when it is genuinely new. ` +
        `This name matching rule never authorizes guessing or changing the printed unit.`
      : "";

    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) throw new Error("GEMINI_API_KEY not configured");

    // Reading a bill needs eyes, not deliberation. Left to itself the model
    // "thinks" before answering and a handwritten bill took ~45 s; a low
    // thinking level brings it down to seconds. If a model refuses the
    // setting, the same call is repeated without it.
    const bodyFor = (lowThinking: boolean) => JSON.stringify({
      systemInstruction: {
        parts: [{ text: (isMenu ? MENU_PROMPT : SYSTEM_PROMPT) + knownBlock }],
      },
      contents: [{
        role: "user",
        parts: [
          { text: isMenu
            ? "Read this menu chart:"
            : "Read this invoice or handwritten Hindi cash memo. Extract every visible goods row, including handwritten Devanagari rows:" },
          { inlineData: { mimeType: mimeType || "image/jpeg", data: imageBase64 } },
        ],
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: isMenu ? MENU_SCHEMA : RESPONSE_SCHEMA,
        temperature: 0,
        ...(lowThinking ? { thinkingConfig: { thinkingLevel: "medium" } } : {}),
      },
    });
    let lowThinking = true;

    let parsed: Record<string, unknown> | null = null;
    let sawRateLimit = false;
    let sawTransient = false;
    let lastError = "No OCR model succeeded";

    // One bounded attempt per fallback model. Transient failures back off before
    // trying the next model, keeping total attempts and total execution bounded.
    // Flash reads handwriting; Lite mostly cannot. When Flash hiccups (an
    // empty answer, a 503) it gets a second go before Lite is tried — going
    // straight to Lite turned one bad second at Google into a failed scan.
    // 45 + 40 + 20 s stays inside the app's 120 s wait.
    const found = await pickModels(geminiKey);
    const models: Model[] = found.length > 1
      ? [{ ...found[0], timeoutMs: 45_000 }, { ...found[0], timeoutMs: 40_000 }, { ...found[1], timeoutMs: 20_000 }]
      : [{ ...found[0], timeoutMs: 55_000 }, { ...found[0], timeoutMs: 50_000 }];
    const retired = new Set<string>();
    for (let attempt = 0; attempt < models.length; attempt += 1) {
      const model = models[attempt];
      if (retired.has(model.name)) continue;
      try {
        const response = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${model.name}:generateContent`,
          {
            method: "POST",
            headers: {
              "x-goog-api-key": geminiKey,
              "Content-Type": "application/json",
            },
            body: bodyFor(lowThinking),
          },
          model.timeoutMs,
        );

        if (response.status === 400 && lowThinking) {
          const detail = (await response.clone().text()).slice(0, 300);
          if (/thinking/i.test(detail)) {
            console.warn("thinkingLevel refused, retrying without:", detail);
            lowThinking = false;
            attempt -= 1;          // same model again, plain request
            continue;
          }
        }

        if (response.ok) {
          const data = await response.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
          try {
            const candidate = JSON.parse(text) as Record<string, unknown>;
            const hasUsefulResult = isMenu
              ? Array.isArray(candidate.menu)
              : Array.isArray(candidate.items) && candidate.items.length > 0;
            if (hasUsefulResult) {
              parsed = candidate;
              break;
            }
            // A model can successfully return valid JSON while treating an
            // informal handwritten cash memo as having no invoice lines. That
            // is an extraction miss, so let the fallback vision model try the
            // same photo instead of reporting "take a clearer photo".
            sawTransient = true;
            lastError = `${model.name} returned no invoice lines`;
            console.warn("Gemini empty extraction:", lastError);
          } catch {
            sawTransient = true;
            lastError = `${model.name} returned invalid JSON`;
            console.error("Gemini response error:", lastError);
          }
        } else {
          const detail = (await response.text()).slice(0, 300);
          lastError = `${model.name} -> ${response.status}: ${detail}`;
          console.error("Gemini API error:", lastError);
          sawRateLimit ||= response.status === 429;
          sawTransient ||= isTransientStatus(response.status);
          if (response.status === 404) { modelCache = null; retired.add(model.name); }   // retired: skip it, ask Google again next time
        }
      } catch (error) {
        const timedOut = error instanceof DOMException && error.name === "AbortError";
        sawTransient = true;
        lastError = timedOut
          ? `${model.name} timed out after ${model.timeoutMs}ms`
          : `${model.name} request failed: ${error instanceof Error ? error.message : String(error)}`;
        console.error("Gemini transport error:", lastError);
      }

      // Fail over immediately. Sleeping here consumed the worker deadline and
      // turned a recoverable provider error into a platform-level 503.
    }

    if (!parsed) {
      await alertScannerDown(typeof canteenId === "string" ? canteenId : null, lastError, sawRateLimit);
      return new Response(JSON.stringify({
        error: sawRateLimit
          ? "The scanner is temporarily rate-limited. Wait a minute and try again."
          : "The scanner could not reach the OCR service in time. Please try again.",
        code: sawRateLimit ? "OCR_RATE_LIMITED" : "OCR_TEMPORARILY_UNAVAILABLE",
        retryable: true,
        retry_after_seconds: sawRateLimit ? 60 : 15,
      }), {
        status: sawRateLimit ? 429 : 503,
        headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": sawRateLimit ? "60" : "15" },
      });
    }

    if (isMenu) {
      const menu = Array.isArray(parsed.menu) ? parsed.menu : [];
      return new Response(JSON.stringify({ menu }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const invoice = parsed.invoice && typeof parsed.invoice === "object"
      ? { ...(parsed.invoice as Record<string, unknown>),
          vendor_name: cleanVendorName((parsed.invoice as Record<string, unknown>).vendor_name) }
      : null;
    return new Response(JSON.stringify({ items, invoice }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    console.error("OCR error:", error);
    return new Response(JSON.stringify({
      error: timedOut
        ? "The scanner timed out. Please try again."
        : error instanceof Error ? error.message : "Unknown error",
      code: timedOut ? "OCR_TIMEOUT" : "OCR_ERROR",
      retryable: timedOut,
    }), {
      status: timedOut ? 503 : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

