import { supabase } from "@/integrations/supabase/client";
import { toCompressedBase64 } from "@/lib/image";

// One way in for both scanners, so the menu behaves exactly like the bill.
//
// This does NOT use supabase.functions.invoke. That helper throws away the
// response body and reports every failure as "Edge Function returned a
// non-2xx status code", so the messages the function takes care to write —
// the scanner is busy, the file type is wrong, sign in again — never reached
// anybody. The whole error was one sentence that named no cause and offered
// no action, which is what got reported.
//
// A plain fetch gives us the status and the body, so the person is told what
// actually happened.

// Only the things that are definitely not a bill or a menu. Everything else
// is allowed through, including a file the phone reports no type for at all —
// Android file managers and gallery apps routinely hand back an empty or
// odd type for an ordinary photo, and refusing those turned "pick the
// picture I just took" into a dead end.
const CLEARLY_NOT_A_PICTURE = /^(video|audio|font)\//i;
const NOT_READABLE = /(zip|x-msdownload|vnd\.android\.package-archive|octet-stream$)/i;

export interface ScanResult {
  items?: any[];
  invoice?: any;
  menu?: any[];
}

/** Refuse only what is certainly not readable. Everything else is tried. */
export function checkFile(file: File): string | null {
  const type = (file.type || "").toLowerCase();
  if (CLEARLY_NOT_A_PICTURE.test(type)) {
    return `"${file.name}" is a ${type.split("/")[0]} file. Send a photo or a PDF.`;
  }
  if (NOT_READABLE.test(type)) {
    return `"${file.name}" is not something that can be read. Send a photo or a PDF.`;
  }
  if (file.size > 20 * 1024 * 1024) {
    return `"${file.name}" is ${Math.round(file.size / 1024 / 1024)} MB, too big to send. ` +
           `Take a photo of it instead of sending the original file.`;
  }
  return null;
}

// A photo picked from a gallery can arrive with no type at all. The reader
// needs to be told something, and these files are jpegs in practice.
const guessType = (file: File) => {
  const t = (file.type || "").toLowerCase();
  if (t) return t;
  if (/\.pdf$/i.test(file.name)) return "application/pdf";
  if (/\.png$/i.test(file.name)) return "image/png";
  if (/\.webp$/i.test(file.name)) return "image/webp";
  return "image/jpeg";
};

/**
 * Send a picture to the reader. `onStage` reports progress so the screen can
 * say what is happening during the half minute this takes.
 */
export async function scanFile(
  file: File,
  mode: "menu" | "invoice",
  onStage?: (s: string) => void,
  canteenId?: string,
): Promise<ScanResult> {
  const bad = checkFile(file);
  if (bad) throw new Error(bad);

  onStage?.(`Preparing ${file.name || "the picture"}…`);
  const { base64, mimeType, sizeKb } = await toCompressedBase64(file);

  onStage?.(`Sending ${sizeKb} KB to be read…`);
  // A gallery photo can carry no type; compression keeps whatever it had.
  return scanBase64(base64, mimeType || guessType(file), mode, onStage, canteenId);
}

/** Same call, for a picture already in memory (the in-app camera). */
export async function scanBase64(
  base64: string,
  mimeType: string,
  mode: "menu" | "invoice",
  onStage?: (s: string) => void,
  // The site whose item list the reader should match names against, so a
  // bill saying जीरा comes back as the "Jeera" the store already keeps
  // rather than as a brand new word holding its own separate stock.
  canteenId?: string,
): Promise<ScanResult> {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  if (!token) throw new Error("You have been signed out. Sign in again and retry.");

  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ocr-invoice`;
  onStage?.("Reading it…");

  const payload = JSON.stringify({ imageBase64: base64, mimeType, canteenId,
    ...(mode === "menu" ? { mode: "menu" } : {}) });
  let res: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 75_000);
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: payload,
        signal: controller.signal,
      });
    } catch (error: any) {
      if (error?.name === "AbortError") {
        if (attempt === 0) { onStage?.("Scanner slow hai — ek baar phir try kar rahe hain…"); continue; }
        throw new Error("Scanner ne 75 second mein jawab nahi diya. Photo save hai — ek minute baad Scan dabayein.");
      }
      if (attempt === 0) { onStage?.("Connection dobara try kar rahe hain…"); continue; }
      throw new Error("Could not reach the scanner. Check the internet connection and try again.");
    } finally {
      clearTimeout(timeout);
    }
    if (res.ok || ![429, 502, 503, 504].includes(res.status) || attempt === 1) break;
    onStage?.("Scanner busy hai — ek baar automatically retry kar rahe hain…");
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  if (!res) throw new Error("Scanner se jawab nahi mila. Ek minute baad phir try karein.");

  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* not json */ }

  if (!res.ok) {
    // The function writes a plain-English reason for every case it knows
    // about; show that rather than the status code.
    throw new Error(body?.error || `The scanner failed (${res.status}). Try again in a minute.`);
  }
  if (body?.error) throw new Error(body.error);
  return (body || {}) as ScanResult;
}
