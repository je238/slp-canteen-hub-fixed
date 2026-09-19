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
- vendor_name: the SELLER / supplier issuing the invoice (letterhead / "for <company>"), NOT the buyer in "Bill to"
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

const MODELS = [
  // Full Flash reads dense printed tables and difficult handwriting much more
  // reliably than the Lite-only chain that previously returned empty bills.
  // Lite remains the fast fallback for provider load/rate-limit failures.
  { name: "gemini-3.5-flash", timeoutMs: 40_000 },
  { name: "gemini-3.5-flash-lite", timeoutMs: 20_000 },
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

    const requestBody = JSON.stringify({
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
      },
    });

    let parsed: Record<string, unknown> | null = null;
    let sawRateLimit = false;
    let sawTransient = false;
    let lastError = "No OCR model succeeded";

    // One bounded attempt per fallback model. Transient failures back off before
    // trying the next model, keeping total attempts and total execution bounded.
    for (let attempt = 0; attempt < MODELS.length; attempt += 1) {
      const model = MODELS[attempt];
      try {
        const response = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${model.name}:generateContent`,
          {
            method: "POST",
            headers: {
              "x-goog-api-key": geminiKey,
              "Content-Type": "application/json",
            },
            body: requestBody,
          },
          model.timeoutMs,
        );

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
    const invoice = parsed.invoice ?? null;
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

