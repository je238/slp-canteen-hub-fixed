import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { LogIn, LogOut, MapPin, Camera, Clock, CheckCircle2, AlertTriangle } from "lucide-react";
import { toCompressedBase64 } from "@/lib/image";
import { supabase } from "@/integrations/supabase/client";

// The staff member's own phone. No app account: mobile + PIN gives a token
// that only the staff-attendance function accepts. "Aaya" / "Gaya" takes a
// selfie and the phone's GPS; the server decides if they are at the canteen.
// Someone with an app login (a Unit Supervisor) is recognised by that login
// instead, with no PIN.

const FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/staff-attendance`;
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const TOKEN_KEY = "slp-staff-attendance-token";

async function call(body: Record<string, unknown>) {
  const r = await fetch(FN, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({ error: "Network dikkat, dobara try karo" }));
  if (!r.ok || data.error) throw Object.assign(new Error(data.error || "Dikkat aayi"), { relogin: !!data.relogin });
  return data;
}

const readToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } };
const saveToken = (t: string) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } };

const timeOf = (iso?: string | null) => iso
  ? new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" })
  : "—";
const fmt12 = (hhmm?: string | null) => {
  if (!hhmm) return "—";
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const mins = (n: number) => n >= 60 ? `${Math.floor(n / 60)} ghante ${n % 60} min` : `${n} min`;

const isIphone = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);
// What to do about a GPS problem, said for the phone in hand.
const PERMISSION_HELP = () => isIphone()
  ? "Location ki permission band hai. iPhone: Settings → Privacy → Location Services → Safari (ya Chrome) → “While Using” chuno aur Precise Location ON karo. Phir page dobara kholo."
  : "Location ki permission band hai. Browser mein address ke paas taala (🔒) dabao → Permissions → Location → Allow. Phone ki Location bhi ON rakho.";
const COARSE_HELP = () => isIphone()
  ? "Phone sirf andaze wali location de raha hai. iPhone: Settings → Privacy → Location Services → Safari (ya Chrome) → Precise Location ON karo."
  : "Phone sirf andaze wali location de raha hai. Settings → Location → Google Location Accuracy ON karo, aur Wi-Fi ON rakho (connect zaroori nahi).";
const WEAK_HELP = "GPS kamzor hai. Khidki ya darwaze ke paas aakar 10-20 second ruko, phir dobara try karo.";
// A reading this far off means the phone gave only its rough location.
const COARSE_M = 500;

// Attendance counts only inside the canteen, so the reading must be sharp.
// The first GPS fix is often 50-100 m off; keep listening for up to 15 s and
// use the best one, stopping early once it is within 15 m.
export function getBestLocation(goodEnoughM = 15, maxWaitMs = 15000): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("Is phone mein location nahi hai")); return; }
    let best: GeolocationPosition | null = null;
    let done = false;
    const finish = (err?: Error) => {
      if (done) return; done = true;
      navigator.geolocation.clearWatch(id); clearTimeout(timer);
      if (best) resolve(best); else reject(err || new Error("Location nahi mili. Phone ki Location ON karo. " + WEAK_HELP));
    };
    const id = navigator.geolocation.watchPosition((pos) => {
      if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
      if (pos.coords.accuracy <= goodEnoughM) finish();
    }, (e) => {
      if (e.code === 1) finish(new Error(PERMISSION_HELP()));
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: maxWaitMs });
    const timer = setTimeout(() => finish(), maxWaitMs);
  });
}
const getLocation = () => getBestLocation(15, 25000);

// GPS starts as soon as the attendance screen is open, so by the time the
// button is tapped the phone has usually settled on a sharp reading. The
// screen shows how sharp it is, and the punch uses it if it is fresh.
type Gps = { pos: GeolocationPosition | null; error: string };
function useWarmGps(active: boolean) {
  const [gps, setGps] = useState<Gps>({ pos: null, error: "" });
  useEffect(() => {
    if (!active) return;
    if (!navigator.geolocation) { setGps({ pos: null, error: "Is phone mein location nahi hai" }); return; }
    const id = navigator.geolocation.watchPosition(
      (pos) => setGps((g) => {
        const prev = g.pos;
        // keep a sharper reading for up to 30 s rather than a blurrier new one
        const keep = prev && prev.coords.accuracy < pos.coords.accuracy && pos.timestamp - prev.timestamp < 30_000;
        return { pos: keep ? prev : pos, error: "" };
      }),
      (e) => setGps((g) => ({ ...g, error: e.code === 1 ? PERMISSION_HELP() : g.pos ? "" : WEAK_HELP })),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [active]);
  return gps;
}

export default function StaffAttendancePage() {
  const [token, setToken] = useState(readToken);
  // App login, when there is no PIN sign-in on this phone.
  const [session, setSession] = useState("");
  const auth = token ? { token } : session ? { session } : null;
  const [me, setMe] = useState<any>(null);
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);
  const kindRef = useRef<"in" | "out">("in");
  const locRef = useRef<Promise<GeolocationPosition> | null>(null);
  const gps = useWarmGps(!!me);
  const gpsRef = useRef(gps);
  gpsRef.current = gps;

  useEffect(() => { document.title = "Staff Attendance"; }, []);

  useEffect(() => {
    if (token) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session?.access_token || ""));
  }, [token]);

  useEffect(() => {
    if (!auth) return;
    call({ action: "status", ...auth }).then((d) => setMe(d.me)).catch((e) => {
      if (e.relogin && token) { saveToken(""); setToken(""); }
      if (session && !token) setSession("");   // not linked to staff: fall back to PIN sign-in
      setError(e.message);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, session]);

  const login = async () => {
    setError(""); setBusy("login");
    try {
      const d = await call({ action: "login", phone, pin });
      saveToken(d.token); setToken(d.token); setMe(d.me); setPin("");
    } catch (e: any) { setError(e.message); }
    setBusy("");
  };

  // The camera must open straight from the tap, so location is asked for in
  // parallel and awaited once the selfie is back.
  const start = (kind: "in" | "out") => {
    setError(""); setDone("");
    kindRef.current = kind;
    const warm = gpsRef.current.pos;
    locRef.current = warm && warm.coords.accuracy <= 25 && Date.now() - warm.timestamp < 60_000
      ? Promise.resolve(warm)
      : getLocation();
    locRef.current.catch(() => {});
    fileRef.current?.click();
  };

  const onSelfie = async (file?: File) => {
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    const kind = kindRef.current;
    setBusy(kind);
    try {
      const pos = await (locRef.current || getLocation());
      if (pos.coords.accuracy > COARSE_M) throw new Error(COARSE_HELP());
      const { base64, mimeType } = await toCompressedBase64(file, 900);
      const d = await call({
        action: "punch", ...auth, kind,
        lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy,
        photo: `data:${mimeType};base64,${base64}`,
      });
      setMe(d.me);
      const r = d.result;
      setDone(kind === "in"
        ? `Attendance lag gayi: ${timeOf(r.at)}${r.late_min > 0 ? ` · ${mins(r.late_min)} late` : " · Time par"}`
        : `Chhutti darj: ${timeOf(r.at)} · Kaam: ${mins(r.worked_min)}${r.early_min > 0 ? ` · ${mins(r.early_min)} pehle gaye` : ""}`);
    } catch (e: any) {
      if (e.relogin && token) { saveToken(""); setToken(""); setMe(null); }
      setError(e.message);
    }
    setBusy("");
  };

  const logout = () => { saveToken(""); setToken(""); setMe(null); setDone(""); setError(""); };

  const today = me?.today;
  const open = me?.open;
  const canIn = me && !today?.check_in && !open;
  const canOut = me && !!open;

  return (
    <div className="min-h-[100dvh] bg-background px-4 py-6">
      <div className="mx-auto max-w-sm space-y-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Staff Attendance</h1>
          <p className="text-sm text-muted-foreground">SLP Canteen</p>
        </div>

        <input ref={fileRef} type="file" accept="image/*" capture="user" className="hidden"
          onChange={(e) => onSelfie(e.target.files?.[0])} />

        {error && (
          <div className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{error}</span>
          </div>
        )}
        {done && (
          <div className="flex gap-2 rounded-lg border border-success/40 bg-success/10 p-3 text-base font-semibold text-success">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" /> <span>{done}</span>
          </div>
        )}

        {!auth ? (
          <Card><CardContent className="space-y-3 p-4">
            <label className="block text-sm font-medium">Mobile number</label>
            <Input className="h-12 text-lg" inputMode="numeric" maxLength={10} placeholder="10 ank"
              value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} />
            <label className="block text-sm font-medium">PIN</label>
            <Input className="h-12 text-lg tracking-widest" type="password" inputMode="numeric" maxLength={6}
              placeholder="Manager se mila PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && login()} />
            <Button className="h-12 w-full text-base" disabled={busy === "login" || phone.length !== 10 || pin.length < 4}
              onClick={login}>
              {busy === "login" ? "Ruko…" : "Login"}
            </Button>
            <p className="text-xs text-muted-foreground">Ek baar login karne ke baad ye phone aapko yaad rakhega.</p>
          </CardContent></Card>
        ) : !me ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Load ho raha hai…</p>
        ) : (
          <>
            <Card><CardContent className="space-y-1 p-4">
              <p className="text-lg font-semibold">{me.name}</p>
              <p className="text-sm text-muted-foreground">{me.role ? `${me.role} · ` : ""}{me.site}</p>
              <p className="flex items-center gap-1 text-sm">
                <Clock className="h-4 w-4 text-accent" />
                Shift: {me.shift_start ? `${fmt12(me.shift_start)} – ${fmt12(me.shift_end)}` : "set nahi"}
              </p>
            </CardContent></Card>

            <Card><CardContent className="grid grid-cols-2 gap-2 p-4 text-center">
              <div className="rounded-md bg-muted/40 p-2">
                <p className="text-[11px] text-muted-foreground">AAYE</p>
                <p className="text-lg font-bold">{timeOf(today?.check_in || open?.check_in)}</p>
                {Number(today?.late_min) > 0 && <p className="text-xs font-semibold text-destructive">{mins(today.late_min)} late</p>}
              </div>
              <div className="rounded-md bg-muted/40 p-2">
                <p className="text-[11px] text-muted-foreground">GAYE</p>
                <p className="text-lg font-bold">{timeOf(today?.check_out)}</p>
              </div>
            </CardContent></Card>

            {!me.location_set && (
              <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                Canteen ki location abhi set nahi hui. Manager ko bolo.
              </p>
            )}

            {(canIn || canOut) && me.location_set && <GpsLine gps={gps} />}

            {canIn && (
              <Button className="h-20 w-full text-xl" disabled={!!busy} onClick={() => start("in")}>
                {busy === "in" ? "Lag rahi hai…" : <><LogIn className="mr-2 h-6 w-6" /> Aaya (attendance lagao)</>}
              </Button>
            )}
            {canOut && (
              <Button className="h-20 w-full text-xl" variant="secondary" disabled={!!busy} onClick={() => start("out")}>
                {busy === "out" ? "Darj ho raha hai…" : <><LogOut className="mr-2 h-6 w-6" /> Gaya (chhutti)</>}
              </Button>
            )}
            {!canIn && !canOut && (
              <p className="text-center text-sm text-muted-foreground">Aaj ki attendance poori ho gayi.</p>
            )}

            <p className="flex items-start gap-1 text-xs text-muted-foreground">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Button dabane par selfie khulegi <Camera className="mx-0.5 inline h-3.5 w-3.5" /> aur location li jayegi.
              Attendance sirf canteen ke andar hi lagegi. Location on rakho; bahar ya door se nahi lagegi.
            </p>
            {token ? (
              <Button variant="ghost" className="w-full text-xs" onClick={logout}>Is phone se logout</Button>
            ) : (
              <Button variant="ghost" className="w-full text-xs" onClick={() => { window.location.href = "/"; }}>App par wapas</Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function GpsLine({ gps }: { gps: Gps }) {
  const acc = gps.pos ? Math.round(gps.pos.coords.accuracy) : null;
  const [tone, text] = gps.error && acc == null ? ["text-destructive", gps.error]
    : acc == null ? ["text-muted-foreground", "GPS dhoondh raha hai… 10-20 second ruko"]
    : acc > COARSE_M ? ["text-destructive", COARSE_HELP()]
    : acc > 50 ? ["text-warning", `GPS abhi ${acc} m tak galat hai. ${WEAK_HELP}`]
    : acc > 25 ? ["text-warning", `GPS ${acc} m · thoda ruko, aur saaf ho raha hai`]
    : ["text-success", `GPS theek hai (${acc} m) · ab attendance lagao`];
  return (
    <p className={`flex items-start gap-1 rounded-md bg-muted/40 p-2 text-sm font-medium ${tone}`}>
      <MapPin className="mt-0.5 h-4 w-4 shrink-0" /> <span>{text}</span>
    </p>
  );
}
