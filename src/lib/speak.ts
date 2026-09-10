// The app says it out loud.
//
// A chef entering an order is standing at a stove with wet hands, and the one
// thing he must not miss is that what he is asking for is not there. On a
// phone screen held at arm's length, in a kitchen, a red line is easy to walk
// past. A voice is not.
//
// This uses the browser's own speech engine — nothing is sent anywhere, it
// works with the phone in a pocket, and it costs nothing per use.
//
// Three things learned the hard way about speech in a browser:
//
//   * voices load asynchronously. Asking for the list on the first call
//     usually returns an empty array, and the utterance then comes out in
//     whatever the system default is. So the list is warmed and re-read.
//   * mobile browsers refuse to speak until the user has interacted with the
//     page. Typing a quantity IS an interaction, so by the time this is
//     called the gate is open — but the very first utterance of a session can
//     still be swallowed, and that is not worth fighting.
//   * calling speak() repeatedly queues rather than replaces. A chef typing
//     "4", "45" would hear both, one after the other, saying different
//     numbers. Every call cancels what is still pending.

const MUTE_KEY = "srs.speech.muted";

let voices: SpeechSynthesisVoice[] = [];
let warmed = false;

function warm() {
  if (warmed || typeof window === "undefined" || !window.speechSynthesis) return;
  warmed = true;
  const load = () => { voices = window.speechSynthesis.getVoices() || []; };
  load();
  window.speechSynthesis.addEventListener?.("voiceschanged", load);
}

/** Hindi if the device has it, Indian English next, then whatever there is. */
function pickVoice(): SpeechSynthesisVoice | null {
  if (!voices.length) voices = window.speechSynthesis?.getVoices() || [];
  return voices.find((v) => v.lang?.toLowerCase().startsWith("hi"))
      || voices.find((v) => v.lang?.toLowerCase() === "en-in")
      || voices.find((v) => v.lang?.toLowerCase().startsWith("en"))
      || null;
}

export function speechSupported(): boolean {
  return typeof window !== "undefined" && !!window.speechSynthesis;
}

export function isMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
}

export function setMuted(m: boolean) {
  try { localStorage.setItem(MUTE_KEY, m ? "1" : "0"); } catch { /* private mode */ }
  if (m) window.speechSynthesis?.cancel();
}

let lastSaid = "";
let lastAt = 0;

/**
 * Say it once. Repeating the identical sentence within a few seconds is
 * swallowed — a chef correcting "45" to "46" should not hear the same
 * shortage twice, but a different number is news and gets said.
 */
export function speak(text: string, opts?: { repeatAfterMs?: number }) {
  if (!speechSupported() || isMuted() || !text) return;
  warm();

  const now = Date.now();
  const gap = opts?.repeatAfterMs ?? 4000;
  if (text === lastSaid && now - lastAt < gap) return;
  lastSaid = text; lastAt = now;

  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.lang = v?.lang || "hi-IN";
    // Slightly slow. A kitchen is noisy and the number is the whole point.
    u.rate = 0.92;
    u.pitch = 1;
    u.volume = 1;
    window.speechSynthesis.speak(u);
  } catch { /* speech is a courtesy, never a blocker */ }
}

/** Units as a person says them, not as a database stores them. */
function saidUnit(unit?: string): string {
  const u = String(unit || "").trim().toLowerCase();
  if (u === "kg") return "kilo";
  if (u === "ltr" || u === "litre" || u === "liter") return "litre";
  if (u === "pcs" || u === "nos") return "piece";
  return u || "";
}

/** A tidy number: 25 not 25.000, 0.5 not 0.500. */
function saidQty(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** "Aata mein 25 kilo kam hai" */
export function sayShortage(name: string, short: number, unit?: string) {
  speak(`${String(name).trim()} mein ${saidQty(short)} ${saidUnit(unit)} kam hai`);
}

/** Said once when the order is closed, so nothing is missed on the way out. */
export function sayShortageSummary(lines: { name: string; short: number; unit?: string }[]) {
  if (!lines.length) return;
  if (lines.length === 1) {
    const l = lines[0];
    speak(`${String(l.name).trim()} mein ${saidQty(l.short)} ${saidUnit(l.unit)} kam hai`, { repeatAfterMs: 0 });
    return;
  }
  const list = lines.slice(0, 5)
    .map((l) => `${String(l.name).trim()} ${saidQty(l.short)} ${saidUnit(l.unit)}`)
    .join(", ");
  const more = lines.length > 5 ? ` aur ${lines.length - 5} aur cheezein` : "";
  speak(`${lines.length} cheezein kam hain. ${list}${more}`, { repeatAfterMs: 0 });
}
