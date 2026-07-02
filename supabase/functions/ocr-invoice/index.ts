import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `You are an invoice OCR extraction tool for an Indian canteen ERP. Extract both the header fields and the line items from the invoice.

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
- item_name, quantity, unit (kg, litre, pcs, dozen, ...), rate (price per unit), total (quantity × rate, pre-tax), gst_percent (total GST % for the line, null if none shown)

Indian invoices group digits like 1,67,700.00 — that is 167700. If a value is unreadable, use null rather than guessing.`;

// Gemini native responseSchema (supports nullable, unlike OpenAI-style unions)
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
          item_name: { type: "STRING" },
          quantity: { type: "NUMBER" },
          unit: { type: "STRING" },
          rate: { type: "NUMBER" },
          total: { type: "NUMBER" },
          gst_percent: { type: "NUMBER", nullable: true },
        },
        required: ["item_name", "quantity", "unit", "rate", "total"],
      },
    },
  },
  required: ["invoice", "items"],
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { imageBase64, mimeType } = await req.json();
    if (!imageBase64) throw new Error("No image provided");

    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");

    // Not every key has access to every model — walk the chain until one answers.
    const MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
    let response: Response | null = null;
    let lastErr = "";
    for (const model of MODELS) {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "x-goog-api-key": GEMINI_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [
              {
                role: "user",
                parts: [
                  { text: "Extract the header fields and all line items from this invoice:" },
                  { inlineData: { mimeType: mimeType || "image/jpeg", data: imageBase64 } },
                ],
              },
            ],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: RESPONSE_SCHEMA,
              temperature: 0,
            },
          }),
        }
      );
      if (response.ok) break;
      lastErr = `${model} -> ${response.status}: ${(await response.text()).slice(0, 300)}`;
      console.error("Gemini API error:", lastErr);
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limited, please try again shortly." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (!response || !response.ok) {
      throw new Error(`AI error: ${lastErr}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const invoice = parsed.invoice ?? null;

    return new Response(JSON.stringify({ items, invoice }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("OCR error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
