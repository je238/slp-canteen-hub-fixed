import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { imageBase64, mimeType } = await req.json();
    if (!imageBase64) throw new Error("No image provided");

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `You are an invoice OCR extraction tool for an Indian canteen ERP. Extract both the header fields and the line items from the invoice.

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

Indian invoices group digits like 1,67,700.00 — that is 167700. If a value is unreadable, use null rather than guessing.`,
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Extract the header fields and all line items from this invoice:" },
              {
                type: "image_url",
                image_url: { url: `data:${mimeType || "image/jpeg"};base64,${imageBase64}` },
              },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "extract_invoice",
              description: "Extract structured header fields and line items from an invoice",
              parameters: {
                type: "object",
                properties: {
                  invoice: {
                    type: "object",
                    properties: {
                      vendor_name: { type: ["string", "null"] },
                      invoice_number: { type: ["string", "null"] },
                      invoice_date: { type: ["string", "null"], description: "YYYY-MM-DD" },
                      gstin: { type: ["string", "null"] },
                      subtotal: { type: ["number", "null"] },
                      tax_amount: { type: ["number", "null"] },
                      other_charges: { type: ["number", "null"] },
                      grand_total: { type: ["number", "null"] },
                    },
                    required: [
                      "vendor_name", "invoice_number", "invoice_date", "gstin",
                      "subtotal", "tax_amount", "other_charges", "grand_total",
                    ],
                    additionalProperties: false,
                  },
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        item_name: { type: "string" },
                        quantity: { type: "number" },
                        unit: { type: "string" },
                        rate: { type: "number" },
                        total: { type: "number" },
                        gst_percent: { type: ["number", "null"] },
                      },
                      required: ["item_name", "quantity", "unit", "rate", "total", "gst_percent"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["invoice", "items"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "extract_invoice" } },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("AI gateway error:", response.status, errText);
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limited, please try again shortly." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Please add credits." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw new Error(`AI error: ${response.status}`);
    }

    const data = await response.json();

    // Extract from tool call response
    let items: unknown[] = [];
    let invoice: Record<string, unknown> | null = null;
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.arguments) {
      const parsed = JSON.parse(toolCall.function.arguments);
      items = parsed.items || [];
      invoice = parsed.invoice || null;
    } else {
      // Fallback: try to parse content directly
      const content = data.choices?.[0]?.message?.content || "";
      const jsonMatch = content.match(/\{[\s\S]*\}/) || content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        items = Array.isArray(parsed) ? parsed : parsed.items || [];
        invoice = Array.isArray(parsed) ? null : parsed.invoice || null;
      }
    }

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
