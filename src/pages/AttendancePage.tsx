import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import AppLayout from "@/components/AppLayout";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/contexts/AppContext";
import { useCanteens } from "@/hooks/useSupabaseData";
import { todayIst } from "@/lib/date";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Camera, Copy, KeyRound, MapPin, Pencil, Plus, UserCheck } from "lucide-react";
import { toast } from "sonner";

// The manager's side of staff attendance: who came, when, from how far, with
// the selfie; the staff list with shifts and PINs; and where the canteen is.

const STAFF_LINK = `${window.location.origin}/attendance`;
const sb = supabase as any;

const timeOf = (iso?: string | null) => iso
  ? new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" })
  : "—";
const hm = (t?: string | null) => (t ? String(t).slice(0, 5) : "");
const mins = (n: number) => n >= 60 ? `${Math.floor(n / 60)}h ${n % 60}m` : `${n}m`;

function SelfieButton({ path }: { path?: string | null }) {
  if (!path) return null;
  const open = async () => {
    const { data, error } = await supabase.storage.from("attendance").createSignedUrl(path, 300);
    if (error) { toast.error(error.message); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  };
  return (
    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={open}>
      <Camera className="mr-1 h-3.5 w-3.5" /> Selfie
    </Button>
  );
}

function useStaff(canteenId: string) {
  return useQuery({
    queryKey: ["staff", canteenId],
    enabled: !!canteenId && canteenId !== "all",
    queryFn: async () => {
      const [{ data, error }, pins] = await Promise.all([
        sb.from("staff").select("*").eq("canteen_id", canteenId).order("name"),
        sb.rpc("staff_with_pin", { p_canteen_id: canteenId }),
      ]);
      if (error) throw error;
      const pinBy = new Map((pins.data || []).map((p: any) => [p.staff_id, p]));
      return (data || []).map((s: any) => ({ ...s, pin: pinBy.get(s.id) }));
    },
  });
}

function DayRegister({ canteenId, staff }: { canteenId: string; staff: any[] }) {
  const [day, setDay] = useState(todayIst());
  const { data: rows } = useQuery({
    queryKey: ["attendance", canteenId, day],
    queryFn: async () => {
      const { data, error } = await sb.from("attendance").select("*").eq("canteen_id", canteenId).eq("date", day);
      if (error) throw error;
      return data as any[];
    },
  });
  const byStaff = new Map((rows || []).map((r: any) => [r.staff_id, r]));
  const active = staff.filter((s) => s.active);
  const present = active.filter((s) => byStaff.get(s.id)?.check_in);
  const late = present.filter((s) => Number(byStaff.get(s.id)?.late_min) > 0);
  const absent = active.filter((s) => !byStaff.get(s.id)?.check_in);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" className="h-10 w-44" value={day} max={todayIst()} onChange={(e) => setDay(e.target.value)} />
        <Badge variant="outline" className="border-success/40 text-success">Aaye {present.length}</Badge>
        <Badge variant="outline" className="border-warning/40 text-warning">Late {late.length}</Badge>
        <Badge variant="outline" className="border-destructive/40 text-destructive">Nahi aaye {absent.length}</Badge>
      </div>
      {active.length === 0 && (
        <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">
          Pehle "Staff" tab mein staff jodo.
        </CardContent></Card>
      )}
      {active.map((s) => {
        const a = byStaff.get(s.id);
        return (
          <Card key={s.id} className="border-none shadow-sm">
            <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3">
              <div className="min-w-[9rem] flex-1">
                <p className="font-semibold">{s.name}</p>
                <p className="text-xs text-muted-foreground">
                  {s.role || "Staff"} · Shift {hm(s.shift_start) || "—"}–{hm(s.shift_end) || "—"}
                </p>
              </div>
              {!a?.check_in ? (
                <Badge variant="outline" className="border-destructive/40 text-destructive">Nahi aaye</Badge>
              ) : (
                <>
                  <div className="text-sm">
                    <span className="text-muted-foreground">Aaye </span><b>{timeOf(a.check_in)}</b>
                    {Number(a.late_min) > 0
                      ? <span className="ml-1 font-semibold text-destructive">({mins(a.late_min)} late)</span>
                      : <span className="ml-1 text-success">(time par)</span>}
                    <span className="ml-1 text-xs text-muted-foreground">· {a.in_dist_m ?? "?"} m door</span>
                    <SelfieButton path={a.in_photo} />
                  </div>
                  <div className="text-sm">
                    <span className="text-muted-foreground">Gaye </span><b>{timeOf(a.check_out)}</b>
                    {Number(a.early_leave_min) > 0 && (
                      <span className="ml-1 font-semibold text-warning">({mins(a.early_leave_min)} pehle)</span>
                    )}
                    {a.check_out && <span className="ml-1 text-xs text-muted-foreground">· {a.out_dist_m ?? "?"} m door</span>}
                    <SelfieButton path={a.out_photo} />
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function MonthSummary({ canteenId, staff }: { canteenId: string; staff: any[] }) {
  const [month, setMonth] = useState(todayIst().slice(0, 7));
  const { data: rows } = useQuery({
    queryKey: ["attendanceMonth", canteenId, month],
    queryFn: async () => {
      const [y, m] = month.split("-").map(Number);
      const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const { data, error } = await sb.from("attendance").select("staff_id,check_in,late_min,early_leave_min")
        .eq("canteen_id", canteenId).gte("date", `${month}-01`).lte("date", end);
      if (error) throw error;
      return data as any[];
    },
  });
  const sum = useMemo(() => {
    const m = new Map<string, { days: number; late: number; lateMin: number; early: number }>();
    for (const r of rows || []) {
      if (!r.check_in) continue;
      const x = m.get(r.staff_id) || { days: 0, late: 0, lateMin: 0, early: 0 };
      x.days++; if (r.late_min > 0) { x.late++; x.lateMin += r.late_min; }
      if (r.early_leave_min > 0) x.early++;
      m.set(r.staff_id, x);
    }
    return m;
  }, [rows]);
  return (
    <div className="space-y-3">
      <Input type="month" className="h-10 w-44" value={month} onChange={(e) => setMonth(e.target.value)} />
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr><th className="p-2 text-left">Staff</th><th className="p-2 text-right">Aaye (din)</th>
              <th className="p-2 text-right">Late (din)</th><th className="p-2 text-right">Kul late</th>
              <th className="p-2 text-right">Jaldi gaye</th></tr>
          </thead>
          <tbody>
            {staff.map((s) => {
              const x = sum.get(s.id);
              return (
                <tr key={s.id} className="border-t">
                  <td className="p-2">{s.name}{!s.active && <span className="text-xs text-muted-foreground"> (hata diya)</span>}</td>
                  <td className="p-2 text-right font-semibold">{x?.days || 0}</td>
                  <td className={`p-2 text-right ${x?.late ? "font-semibold text-destructive" : ""}`}>{x?.late || 0}</td>
                  <td className="p-2 text-right">{x?.lateMin ? mins(x.lateMin) : "—"}</td>
                  <td className="p-2 text-right">{x?.early || 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StaffDialog({ canteenId, staff, open, onOpenChange }: { canteenId: string; staff?: any; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState(() => ({
    name: staff?.name || "", role: staff?.role === "billing_staff" ? "" : (staff?.role || ""),
    phone: staff?.phone || "", shift_start: hm(staff?.shift_start) || "07:00", shift_end: hm(staff?.shift_end) || "15:00",
    grace_min: String(staff?.grace_min ?? 10), pin: "", active: staff?.active ?? true,
  }));
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));

  const save = async () => {
    const phone = f.phone.replace(/\D/g, "").slice(-10);
    if (!f.name.trim()) { toast.error("Naam likho"); return; }
    if (phone.length !== 10) { toast.error("10 ank ka mobile number likho"); return; }
    if (!staff && !/^\d{4,6}$/.test(f.pin)) { toast.error("4-6 ank ka PIN do"); return; }
    if (f.pin && !/^\d{4,6}$/.test(f.pin)) { toast.error("PIN 4-6 ank ka ho"); return; }
    setSaving(true);
    try {
      const row = {
        canteen_id: canteenId, name: f.name.trim(), role: f.role.trim() || "Staff", phone,
        shift_start: f.shift_start || null, shift_end: f.shift_end || null,
        grace_min: Math.max(0, Number(f.grace_min) || 0), active: f.active,
      };
      const res = staff
        ? await sb.from("staff").update(row).eq("id", staff.id).select("id").single()
        : await sb.from("staff").insert(row).select("id").single();
      if (res.error) throw new Error(/staff_active_phone_uniq/.test(res.error.message) ? "Ye mobile number pehle se kisi staff ka hai" : res.error.message);
      if (f.pin) {
        const { error } = await sb.rpc("set_staff_pin", { p_staff_id: res.data.id, p_pin: f.pin });
        if (error) throw error;
      }
      toast.success(staff ? "Staff update ho gaya" : `${row.name} jud gaya. Unhe link aur PIN bhejo.`);
      qc.invalidateQueries({ queryKey: ["staff"] });
      onOpenChange(false);
    } catch (e: any) { toast.error(e.message); }
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader><DialogTitle>{staff ? "Staff badlo" : "Naya staff"}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><Label>Naam</Label><Input value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
          <div><Label>Kaam</Label><Input placeholder="Cook, Helper…" value={f.role} onChange={(e) => set("role", e.target.value)} /></div>
          <div><Label>Mobile</Label><Input inputMode="numeric" maxLength={10} value={f.phone} onChange={(e) => set("phone", e.target.value.replace(/\D/g, ""))} /></div>
          <div><Label>Shift shuru</Label><Input type="time" value={f.shift_start} onChange={(e) => set("shift_start", e.target.value)} /></div>
          <div><Label>Shift khatam</Label><Input type="time" value={f.shift_end} onChange={(e) => set("shift_end", e.target.value)} /></div>
          <div><Label>Chhoot (minute)</Label><Input type="number" min={0} value={f.grace_min} onChange={(e) => set("grace_min", e.target.value)} /></div>
          <div><Label>{staff ? "Naya PIN (khaali = wahi)" : "PIN (4-6 ank)"}</Label>
            <Input inputMode="numeric" maxLength={6} value={f.pin} onChange={(e) => set("pin", e.target.value.replace(/\D/g, ""))} /></div>
          {staff && (
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} /> Kaam par hai (active)
            </label>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Shift shuru + chhoot ke baad aaye to "late" maana jayega. Naya PIN dene par staff ke phone se purana login hat jata hai.
        </p>
        <DialogFooter><Button onClick={save} disabled={saving}>{saving ? "Save ho raha hai…" : "Save"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StaffList({ canteenId, staff }: { canteenId: string; staff: any[] }) {
  const [edit, setEdit] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-3">
      <Card className="border-accent/30 bg-accent/5"><CardContent className="space-y-2 p-3 text-sm">
        <p>Staff ko ye link WhatsApp karo. Wo apna mobile aur PIN daal kar attendance lagayenge:</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-xs">{STAFF_LINK}</code>
          <Button size="sm" variant="outline" onClick={() => { navigator.clipboard?.writeText(STAFF_LINK); toast.success("Link copy ho gaya"); }}>
            <Copy className="mr-1 h-3.5 w-3.5" /> Copy
          </Button>
        </div>
      </CardContent></Card>
      <Button onClick={() => setAdding(true)}><Plus className="mr-1 h-4 w-4" /> Staff jodo</Button>
      {staff.map((s) => (
        <Card key={s.id} className="border-none shadow-sm">
          <CardContent className="flex items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{s.name} {!s.active && <Badge variant="outline" className="ml-1 text-[10px]">Hata diya</Badge>}</p>
              <p className="text-xs text-muted-foreground">
                {s.role || "Staff"} · {s.phone || "mobile nahi"} · Shift {hm(s.shift_start) || "—"}–{hm(s.shift_end) || "—"} · Chhoot {s.grace_min}m
              </p>
              <p className="text-xs">
                {s.pin?.has_pin
                  ? (s.pin.locked ? <span className="text-destructive">Galat PIN se 15 min ke liye band</span> : <span className="text-success"><KeyRound className="mr-0.5 inline h-3 w-3" />PIN set</span>)
                  : <span className="text-warning">PIN nahi</span>}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setEdit(s)}><Pencil className="mr-1 h-3.5 w-3.5" /> Badlo</Button>
          </CardContent>
        </Card>
      ))}
      {adding && <StaffDialog canteenId={canteenId} open={adding} onOpenChange={setAdding} />}
      {edit && <StaffDialog key={edit.id} canteenId={canteenId} staff={edit} open={!!edit} onOpenChange={(o) => !o && setEdit(null)} />}
    </div>
  );
}

function LocationSetup({ canteen }: { canteen: any }) {
  const qc = useQueryClient();
  const [radius, setRadius] = useState(String(canteen?.att_radius_m ?? 150));
  const [busy, setBusy] = useState(false);
  const setHere = () => {
    if (!navigator.geolocation) { toast.error("Is device mein location nahi hai"); return; }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(async (pos) => {
      if (pos.coords.accuracy > 100) {
        toast.error(`GPS abhi kamzor hai (${Math.round(pos.coords.accuracy)} m). Khuli jagah par dobara try karo.`);
        setBusy(false); return;
      }
      const { error } = await sb.rpc("set_attendance_location", {
        p_canteen_id: canteen.id, p_lat: pos.coords.latitude, p_lng: pos.coords.longitude, p_radius_m: Number(radius) || 150,
      });
      setBusy(false);
      if (error) { toast.error(error.message); return; }
      toast.success("Canteen ki location set ho gayi");
      qc.invalidateQueries({ queryKey: ["canteens"] });
    }, (e) => { setBusy(false); toast.error(e.code === 1 ? "Location ki permission do" : "Location nahi mili"); },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  };
  const saveRadius = async () => {
    if (canteen.att_lat == null) { setHere(); return; }
    const { error } = await sb.rpc("set_attendance_location", {
      p_canteen_id: canteen.id, p_lat: canteen.att_lat, p_lng: canteen.att_lng, p_radius_m: Number(radius) || 150,
    });
    if (error) { toast.error(error.message); return; }
    toast.success("Daayra save ho gaya"); qc.invalidateQueries({ queryKey: ["canteens"] });
  };
  return (
    <Card><CardContent className="space-y-3 p-4 text-sm">
      {canteen?.att_lat != null ? (
        <p className="flex items-center gap-1">
          <MapPin className="h-4 w-4 text-success" /> Location set hai ·{" "}
          <a className="text-accent underline" target="_blank" rel="noopener noreferrer"
            href={`https://www.google.com/maps?q=${canteen.att_lat},${canteen.att_lng}`}>Map par dekho</a>
          · daayra {canteen.att_radius_m} m
        </p>
      ) : (
        <p className="font-semibold text-warning">Location abhi set nahi hai. Iske bina koi attendance nahi lagegi.</p>
      )}
      <p className="text-muted-foreground">
        Canteen ke andar khade hokar ye button dabao. Staff ki attendance sirf is jagah ke aas-paas (daayre ke andar) hi lagegi.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div><Label>Daayra (meter)</Label><Input type="number" min={30} max={2000} className="w-28" value={radius} onChange={(e) => setRadius(e.target.value)} /></div>
        <Button onClick={setHere} disabled={busy}><MapPin className="mr-1 h-4 w-4" /> {busy ? "Location le rahe hain…" : "Main canteen mein hoon, yahi set karo"}</Button>
        {canteen?.att_lat != null && <Button variant="outline" onClick={saveRadius}>Sirf daayra save karo</Button>}
      </div>
    </CardContent></Card>
  );
}

export default function AttendancePage() {
  const { selectedCanteen } = useAppContext();
  const { data: canteens } = useCanteens();
  const canteen = (canteens || []).find((c: any) => c.id === selectedCanteen) as any;
  const { data: staff } = useStaff(selectedCanteen);

  return (
    <AppLayout title="Staff Attendance">
      {selectedCanteen === "all" || !canteen ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          <UserCheck className="mx-auto mb-2 h-6 w-6" /> Upar se ek site chuno.
        </CardContent></Card>
      ) : (
        <Tabs defaultValue="day" className="space-y-3">
          <TabsList className="flex-wrap">
            <TabsTrigger value="day">Roz ki attendance</TabsTrigger>
            <TabsTrigger value="month">Mahina</TabsTrigger>
            <TabsTrigger value="staff">Staff</TabsTrigger>
            <TabsTrigger value="location">Location</TabsTrigger>
          </TabsList>
          <TabsContent value="day"><DayRegister canteenId={canteen.id} staff={staff || []} /></TabsContent>
          <TabsContent value="month"><MonthSummary canteenId={canteen.id} staff={staff || []} /></TabsContent>
          <TabsContent value="staff"><StaffList canteenId={canteen.id} staff={staff || []} /></TabsContent>
          <TabsContent value="location"><LocationSetup canteen={canteen} /></TabsContent>
        </Tabs>
      )}
    </AppLayout>
  );
}
