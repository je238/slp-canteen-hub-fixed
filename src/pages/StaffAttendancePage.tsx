import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { LogIn, LogOut, MapPin, Camera, Clock, CheckCircle2, AlertTriangle } from "lucide-react";
import { toCompressedBase64 } from "@/lib/image";

// The staff member's own phone. No app account: mobile + PIN gives a token
// that only the staff-attendance function accepts. "Aaya" / "Gaya" takes a
// selfie and the phone's GPS; the server decides if they are at the canteen.

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

function getLocation(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("Is phone mein location nahi hai")); return; }
    navigator.geolocation.getCurrentPosition(resolve, (e) => reject(new Error(
      e.code === 1 ? "Location ki permission do (browser settings → Location → Allow)"
        : "Location nahi mili. GPS on karke dobara try karo")),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
}

export default function StaffAttendancePage() {
  const [token, setToken] = useState(readToken);
  const [me, setMe] = useState<any>(null);
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);
  const kindRef = useRef<"in" | "out">("in");
  const locRef = useRef<Promise<GeolocationPosition> | null>(null);

  useEffect(() => { document.title = "Staff Attendance"; }, []);

  useEffect(() => {
    if (!token) return;
    call({ action: "status", token }).then((d) => setMe(d.me)).catch((e) => {
      if (e.relogin) { saveToken(""); setToken(""); }
      setError(e.message);
    });
  }, [token]);

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
    locRef.current = getLocation();
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
      const { base64, mimeType } = await toCompressedBase64(file, 900);
      const d = await call({
        action: "punch", token, kind,
        lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy,
        photo: `data:${mimeType};base64,${base64}`,
      });
      setMe(d.me);
      const r = d.result;
      setDone(kind === "in"
        ? `Attendance lag gayi: ${timeOf(r.at)}${r.late_min > 0 ? ` · ${mins(r.late_min)} late` : " · Time par"}`
        : `Chhutti darj: ${timeOf(r.at)} · Kaam: ${mins(r.worked_min)}${r.early_min > 0 ? ` · ${mins(r.early_min)} pehle gaye` : ""}`);
    } catch (e: any) {
      if (e.relogin) { saveToken(""); setToken(""); setMe(null); }
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

        {!token ? (
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
              Attendance sirf canteen par hi lagegi.
            </p>
            <Button variant="ghost" className="w-full text-xs" onClick={logout}>Is phone se logout</Button>
          </>
        )}
      </div>
    </div>
  );
}
