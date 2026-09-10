import { useMemo, useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useCanteens } from "@/hooks/useSupabaseData";
import { useSaveMenuPlan, MEAL_PERIODS } from "@/hooks/useSrsData";
import { supabase } from "@/integrations/supabase/client";
import { scanFile, scanBase64 } from "@/lib/scan";
import { parseMenuText } from "@/lib/menuText";
import { fmtDayDate, todayIst } from "@/lib/date";
import ScanProgress from "@/components/ScanProgress";
import InPageCamera from "@/components/InPageCamera";
import FilePickButton from "@/components/FilePickButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CalendarDays, Camera, Check, ClipboardPaste, Plus, ScanLine, Send, Trash2, Upload, Users } from "lucide-react";
import { toast } from "sonner";

// The client company sends the canteen its menu — a day's list or a whole
// week's chart, usually on paper. The manager photographs it here instead of
// retyping it, checks what the scan read, sets the expected headcount, and
// publishes it. Publishing is what puts it on the chef's screen.

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function isoOf(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayIso() { return isoOf(new Date()); }
function tomorrowIso() { const d = new Date(); d.setDate(d.getDate() + 1); return isoOf(d); }

// A weekday name from the chart becomes the next date that falls on it, so a
// Monday row lands on the coming Monday rather than a date in the past.
function dateForWeekday(day: string, from: string) {
  const target = WEEKDAYS.indexOf(String(day || "").toLowerCase());
  if (target < 0) return null;
  const d = new Date(`${from}T00:00:00`);
  const delta = (target - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + delta);
  return isoOf(d);
}

const PERIOD_ALIASES: Record<string, string> = {
  breakfast: "breakfast", nashta: "breakfast", morning: "breakfast",
  lunch: "lunch", "mid day meal": "lunch",
  tea: "tea", chai: "tea",
  evening_snacks: "evening_snacks", snacks: "evening_snacks", "evening snacks": "evening_snacks",
  dinner: "dinner", supper: "dinner",
  night_snacks: "night_snacks", "night snacks": "night_snacks",
};
const normalisePeriod = (p: string) =>
  PERIOD_ALIASES[String(p || "").toLowerCase().replace(/[-\s]+/g, "_")] ||
  PERIOD_ALIASES[String(p || "").toLowerCase()] || "lunch";

// A dish carries how much of it to cook, because that is what the kitchen
// actually plans around — "dal 200 kg" not just "dal".
interface Dish { name: string; qty: string; unit: string }

interface Row {
  id: string;
  date: string;
  meal_period: string;
  dishes: Dish[];
  headcount: string;
  day?: string;        // the weekday printed on the chart, kept so the whole
}                      // week can be re-spread if the start date was wrong

// A weekly chart gives two answers for the same row: the weekday printed on
// the row, and a date range in the header that the scanner spreads across the
// rows. When they disagree the weekday wins — the chart is organised BY
// weekday, and a header range left over from last week is an ordinary mistake
// on a printed sheet. Trusting the header instead shifts the whole week by a
// day, and the kitchen cooks Monday's menu on Tuesday.
function resolveDate(m: any, startFrom: string): { date: string; mismatch: boolean } {
  const byDay = dateForWeekday(m.day, startFrom);
  if (!m.date) return { date: byDay || startFrom, mismatch: false };
  if (!byDay) return { date: m.date, mismatch: false };
  const printed = new Date(`${m.date}T00:00:00`);
  const agrees = !isNaN(printed.getTime()) &&
    WEEKDAYS[printed.getDay()] === String(m.day).toLowerCase();
  return agrees ? { date: m.date, mismatch: false } : { date: byDay, mismatch: true };
}

const UNITS = ["kg", "litre", "pcs", "plate"];

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function MenuScanPage() {
  const { selectedCanteen } = useAppContext();
  const savePlan = useSaveMenuPlan();

  const [step, setStep] = useState<"scan" | "review" | "done">("scan");
  const [busy, setBusy] = useState(false);
  const [startFrom, setStartFrom] = useState(tomorrowIso());
  const [rows, setRows] = useState<Row[]>([]);
  const [defaultHeads, setDefaultHeads] = useState("");
  const [savedCount, setSavedCount] = useState(0);
  const [status, setStatus] = useState("");
  const [lastError, setLastError] = useState("");
  const [pasted, setPasted] = useState("");
  const [dateClash, setDateClash] = useState(false);
  const [toAllUnits, setToAllUnits] = useState(true);
  const { data: canteens } = useCanteens();

  // What to do with whatever came back, however the picture was obtained.
  const handleMenu = (menu: any[], what: string) => {
    if (menu.length === 0) {
      // This used to be a toast only. On a phone, after waiting half a
      // minute, a message that fades in three seconds reads as "nothing
      // happened" — which is exactly how it kept being reported.
      setLastError(
        `The scanner could not find any meals in ${what}. ` +
        `If it is a photo, take it again straight-on in good light with the ` +
        `whole chart in frame. If the menu came as a WhatsApp message, use ` +
        `the paste box below instead — that is exact and takes a second.`
      );
      toast.warning("Nothing readable found");
      return;
    }
    let clash = false;
    setRows(menu.map((m, i) => {
      const { date, mismatch } = resolveDate(m, startFrom);
      if (mismatch) clash = true;
      return {
        id: `${Date.now()}-${i}`,
        date,
        day: m.day ? String(m.day).toLowerCase() : undefined,
        meal_period: normalisePeriod(m.meal_period),
        dishes: (Array.isArray(m.items) ? m.items : []).map((d: string) => ({
          name: String(d), qty: "", unit: "kg",
        })),
        headcount: "",
      };
    }));
    setDateClash(clash);
    setStep("review");
    if (clash) {
      toast.warning("The dates printed on the chart do not match its weekday rows — check the dates");
    } else {
      toast.success(`Read ${menu.length} meal${menu.length > 1 ? "s" : ""} — check it before publishing`);
    }
  };

  // A photo taken on this page is already base64, so it skips the file step
  // and joins the same reading path.
  const runCaptured = async (base64: string) => {
    setLastError("");
    setBusy(true);
    setStatus("Reading the photo…");
    try {
      const data = await scanBase64(base64, "image/jpeg", "menu", setStatus);
      handleMenu(data?.menu || [], "the photo");
    } catch (e: any) {
      setStatus("");
      setLastError(e.message || "The scan failed. Try again.");
    } finally { setBusy(false); }
  };

  const runScan = async (file: File) => {
    setLastError("");
    setBusy(true);
    // Show the user each stage. When this silently did nothing on a phone
    // there was no way to tell how far it had got.
    setStatus(`Reading ${file.name || "photo"} (${Math.round(file.size / 1024)} KB)…`);
    try {
      // The same path the bill scanner takes, through a plain fetch, so the
      // reason a scan failed reaches the screen instead of being flattened
      // into "Edge Function returned a non-2xx status code".
      const data = await scanFile(file, "menu", setStatus);
      handleMenu(data?.menu || [], `"${file.name || "that file"}"`);
    } catch (e: any) {
      setStatus("");
      toast.error(e.message || "Upload failed");
      setLastError(e.message || String(e));
    } finally { setBusy(false); }
  };

  // The pasted WhatsApp message, read here in the browser. Same review grid
  // as a scan, so anything mistyped in the message is still corrected before
  // it reaches the chef.
  const readPasted = () => {
    const meals = parseMenuText(pasted);
    if (meals.length === 0) {
      toast.error("No meals found. Each meal needs its name on its own line, dishes underneath.");
      return;
    }
    const date = meals[0].date || startFrom;
    setRows(meals.map((m, i) => ({
      id: `${Date.now()}-${i}`,
      date,
      meal_period: m.meal_period,
      dishes: m.items.map((d) => ({ name: d, qty: "", unit: "kg" })),
      headcount: "",
    })));
    setLastError("");
    setStatus("");
    setStep("review");
    const dishes = meals.reduce((n, m) => n + m.items.length, 0);
    toast.success(`Read ${meals.length} meals and ${dishes} dishes for ${date}`);
  };

  // Straight to the review grid with one row per meal of the day, ready to
  // be typed into. Same screen, same publish — only the scan is skipped.
  const startBlank = () => {
    setRows(MEAL_PERIODS.map((m, i) => ({
      id: `${Date.now()}-${i}`,
      date: startFrom,
      meal_period: m.value,
      dishes: [{ name: "", qty: "", unit: "kg" }],
      headcount: "",
    })));
    setLastError("");
    setStatus("");
    setStep("review");
  };

  const update = (id: string, patch: Partial<Row>) =>
    setRows((p) => p.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  // A whole week is 35 rows. If the week landed on the wrong dates, fixing
  // that one date at a time is not something anyone will do correctly, so the
  // weekday labels re-spread the lot in one go.
  const hasWeekdays = rows.some((r) => r.day);
  const respread = (from: string) => {
    setStartFrom(from);
    setRows((p) => p.map((r) => (r.day ? { ...r, date: dateForWeekday(r.day, from) || r.date } : r)));
    setDateClash(false);
    toast.success(`Week re-spread from ${from}`);
  };

  const grouped = useMemo(() => {
    const m: Record<string, Row[]> = {};
    for (const r of rows) (m[r.date] = m[r.date] || []).push(r);
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  const publish = async () => {
    if (selectedCanteen === "all") { toast.error("Select a site first"); return; }
    const usable = rows.filter((r) => r.date && r.dishes.some((d) => d.name.trim()));
    if (usable.length === 0) { toast.error("Nothing to publish"); return; }

    // The three Eicher units cook the same menu, so publishing it once and
    // having it land on all of them is the honest amount of work. Only the
    // headcount differs between them, and that is set per unit afterwards.
    const targets = toAllUnits
      ? (canteens || []).map((c: any) => c.id)
      : [selectedCanteen];
    if (targets.length === 0) targets.push(selectedCanteen);

    setBusy(true);
    try {
      let n = 0;
      const clashes: string[] = [];
      for (const site of targets) {
        // The company gives ONE expected count covering all three units, so
        // it is recorded once. Copying it onto every unit would treble the
        // headcount, and the sale is plates x rate — the company would be
        // billed three times over for the same meal.
        const primary = site === selectedCanteen;
        for (const r of usable) {
          try {
            await savePlan.mutateAsync({
              canteen_id: site,
              menu_date: r.date,
              meal_period: r.meal_period,
              expected_headcount: primary ? (Number(r.headcount || defaultHeads) || 0) : 0,
              status: "published",
              published_at: new Date().toISOString(),
              items: r.dishes.filter((d) => d.name.trim()).map((d) => ({
                dish_name: d.name.trim(),
                recipe_id: null,
                planned_qty: d.qty === "" ? null : Number(d.qty),
                unit: d.qty === "" ? null : d.unit,
              })),
            });
            n++;
          } catch (e: any) {
            // A meal already published on that unit and date is not a
            // failure worth abandoning the rest of the week for.
            const where = (canteens || []).find((c: any) => c.id === site)?.name || "a unit";
            clashes.push(`${where} ${r.date} ${r.meal_period}`);
          }
        }
      }
      if (n === 0) throw new Error(
        clashes.length
          ? `Nothing published — these meals already exist: ${clashes.slice(0, 3).join(", ")}`
          : "Nothing published."
      );
      setSavedCount(n);
      setStep("done");
      toast.success(
        `${n} meal${n > 1 ? "s" : ""} published across ${targets.length} unit${targets.length > 1 ? "s" : ""}` +
        (clashes.length ? ` · ${clashes.length} already existed` : "")
      );
    } catch (e: any) {
      toast.error(e.message);
    } finally { setBusy(false); }
  };

  const reset = () => { setStep("scan"); setRows([]); setSavedCount(0); };

  return (
    <AppLayout title="Daily Menu">
      <ScanProgress busy={busy} status={status} />
      <div className="max-w-4xl mx-auto space-y-4 animate-fade-in">
        <div className="flex items-center gap-4">
          {["Scan or write the menu", "Check it", "Sent to chef"].map((label, i) => {
            const cur = step === "scan" ? 0 : step === "review" ? 1 : 2;
            return (
              <div key={label} className="flex items-center gap-2">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                  i <= cur ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground"}`}>
                  {i < cur ? <Check className="w-4 h-4" /> : i + 1}
                </div>
                <span className={`text-sm ${i <= cur ? "font-medium" : "text-muted-foreground"}`}>{label}</span>
                {i < 2 && <div className={`w-6 h-0.5 ${i < cur ? "bg-accent" : "bg-muted"}`} />}
              </div>
            );
          })}
        </div>

        {step === "scan" && (
          <Card className="border-none shadow-sm">
            <CardContent className="p-6 space-y-4">
              <p className="text-sm text-muted-foreground">
                Photograph the menu the company sent — one day or a whole week. Rows written as
                weekdays are placed on the next matching date, starting from the date below.
              </p>
              <div className="space-y-1.5 max-w-xs">
                <Label className="text-xs">Menu starts from</Label>
                <Input type="date" value={startFrom} min={todayIso()} onChange={(e) => setStartFrom(e.target.value)} />
              </div>

              {/* The camera stays on this page. Handing off to the phone's
                  camera app lets Android destroy the page behind it, and the
                  photo comes back to nothing — which is what "I tap OK and
                  the page opens the same" was. */}
              <InPageCamera onCapture={runCaptured} disabled={busy} />

              <div className="flex gap-2 flex-wrap">
                <FilePickButton
                  onPick={runScan} accept="*/*" disabled={busy}
                  className="h-10 px-4 border bg-background hover:bg-secondary"
                >
                  <Upload className="w-4 h-4" /> Upload the file company sent
                </FilePickButton>
              </div>
              {/* The menu usually arrives as a WhatsApp message, not a photo.
                  Reading the text we were handed is exact; photographing it
                  and running OCR over it could only be less accurate. */}
              <div className="pt-3 border-t space-y-2">
                <Label className="text-xs">
                  Menu came on WhatsApp? Paste it here — text or the picture
                </Label>
                <Textarea
                  rows={5} value={pasted} onChange={(e) => setPasted(e.target.value)}
                  className="text-xs font-mono"
                  placeholder={"Paste the message, or long-press the menu photo in WhatsApp,\nCopy, then paste it here.\n\n24/07/2026\n\nBreakfast\nVeg Upma\n…"}
                  // A pasted IMAGE is read too. On a phone the file picker is
                  // the least reliable part of the whole app, and copying a
                  // photo out of WhatsApp avoids it completely.
                  onPaste={(e) => {
                    const img = Array.from(e.clipboardData?.items || [])
                      .find((i) => i.type.startsWith("image/"));
                    if (!img) return;
                    const file = img.getAsFile();
                    if (!file) return;
                    e.preventDefault();
                    runScan(file);
                  }}
                />
                <div className="flex gap-2 flex-wrap items-center">
                  <Button size="sm" onClick={readPasted} disabled={!pasted.trim()}>
                    <ClipboardPaste className="w-4 h-4 mr-1.5" /> Read this menu
                  </Button>
                  <Button variant="outline" size="sm" onClick={startBlank}>
                    <Plus className="w-4 h-4 mr-1.5" /> Write the menu myself
                  </Button>
                </div>
              </div>

              {status && <p className="text-xs text-accent">{status}</p>}
              {lastError && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-1">
                  <p className="text-sm text-destructive font-semibold">That did not work</p>
                  <p className="text-xs text-foreground break-words">{lastError}</p>
                  <button className="text-[11px] text-muted-foreground underline"
                          onClick={() => setLastError("")}>Dismiss</button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Hindi menus are fine — dish names are kept exactly as written.
              </p>
            </CardContent>
          </Card>
        )}

        {step === "review" && (
          <>
            {dateClash && (
              <Card className="border-none shadow-sm bg-amber-500/10">
                <CardContent className="p-3">
                  <p className="text-xs font-semibold">Check the dates before publishing</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    The dates printed on the chart do not fall on the weekdays it lists them
                    under — a printed sheet often keeps last week's dates. The days below have
                    been placed by their weekday names instead. Set "Week starts on" to the
                    correct date if this week is wrong.
                  </p>
                </CardContent>
              </Card>
            )}
            <Card className="border-none shadow-sm">
              <CardContent className="p-4 flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Expected people (applies where left blank)</Label>
                  <Input type="number" min={0} className="w-40" placeholder="e.g. 250"
                    value={defaultHeads} onChange={(e) => setDefaultHeads(e.target.value)} />
                </div>
                {/* The units cook the same menu, so it is published to all of
                    them at once. Only the headcount differs, and that is set
                    per unit on Menu & Production afterwards. */}
                {(canteens?.length ?? 0) > 1 && (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox" className="w-4 h-4 accent-current"
                      checked={toAllUnits}
                      onChange={(e) => setToAllUnits(e.target.checked)}
                    />
                    <span className="text-xs">
                      Publish to all {canteens!.length} units
                      <span className="block text-[10px] text-muted-foreground">
                        same dishes on every unit · the count is recorded once, here
                      </span>
                    </span>
                  </label>
                )}
                {hasWeekdays && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Week starts on</Label>
                    <Input
                      type="date" className="w-44" min={todayIso()} value={startFrom}
                      onChange={(e) => e.target.value && respread(e.target.value)}
                    />
                  </div>
                )}
                <p className="text-xs text-muted-foreground flex-1 min-w-[220px]">
                  Correct anything the scan misread, then publish. The chef sees each meal on its
                  date and raises the raw-material requisition against it.
                </p>
              </CardContent>
            </Card>

            {grouped.map(([date, dayRows]) => (
              <Card key={date} className="border-none shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <CalendarDays className="w-4 h-4" />
                    {fmtDayDate(date)}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {dayRows.map((r) => (
                    <div key={r.id} className="border-b last:border-0 pb-3 space-y-2">
                      <div className="flex gap-2 items-center flex-wrap">
                        <Select value={r.meal_period} onValueChange={(v) => update(r.id, { meal_period: v })}>
                          <SelectTrigger className="w-40 h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {MEAL_PERIODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <div className="flex items-center gap-1.5">
                          <Users className="w-3.5 h-3.5 text-muted-foreground" />
                          <Input type="number" min={0} className="w-24 h-8 text-sm" placeholder="people"
                            value={r.headcount} onChange={(e) => update(r.id, { headcount: e.target.value })} />
                          <span className="text-xs text-muted-foreground">expected</span>
                        </div>
                        <Input type="date" className="w-36 h-8 text-xs" min={todayIso()}
                          value={r.date} onChange={(e) => update(r.id, { date: e.target.value })} />
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive ml-auto"
                          onClick={() => setRows((p) => p.filter((x) => x.id !== r.id))}
                          title="Remove this meal">
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>

                      {/* How much of each dish to cook */}
                      <div className="pl-2 space-y-1.5">
                        {r.dishes.map((d, di) => (
                          <div key={di} className="flex gap-1.5 items-center">
                            <Input className="flex-1 min-w-[140px] h-8 text-sm" placeholder="Dish"
                              value={d.name}
                              onChange={(e) => update(r.id, {
                                dishes: r.dishes.map((x, i) => i === di ? { ...x, name: e.target.value } : x),
                              })} />
                            <Input type="number" min={0} className="w-24 h-8 text-sm" placeholder="qty"
                              value={d.qty}
                              onChange={(e) => update(r.id, {
                                dishes: r.dishes.map((x, i) => i === di ? { ...x, qty: e.target.value } : x),
                              })} />
                            <Select value={d.unit}
                              onValueChange={(v) => update(r.id, {
                                dishes: r.dishes.map((x, i) => i === di ? { ...x, unit: v } : x),
                              })}>
                              <SelectTrigger className="w-20 h-8 text-xs"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                              </SelectContent>
                            </Select>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground"
                              onClick={() => update(r.id, { dishes: r.dishes.filter((_, i) => i !== di) })}>
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        ))}
                        <Button variant="ghost" size="sm" className="text-xs h-7"
                          onClick={() => update(r.id, { dishes: [...r.dishes, { name: "", qty: "", unit: "kg" }] })}>
                          <Plus className="w-3 h-3 mr-1" /> Add dish
                        </Button>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex gap-2">
                <Button variant="outline" onClick={reset}>Start over</Button>
                <Button variant="outline" onClick={() => setRows((p) => [...p, {
                  id: `${Date.now()}`, date: startFrom, meal_period: "lunch", dishes: [{ name: "", qty: "", unit: "kg" }], headcount: "",
                }])}>
                  <Plus className="w-4 h-4 mr-1.5" /> Add a meal
                </Button>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="text-xs">{rows.length} meals</Badge>
                <Button onClick={publish} disabled={busy || savePlan.isPending}>
                  <Send className="w-4 h-4 mr-1.5" /> {busy ? "Publishing…" : "Publish to chef"}
                </Button>
              </div>
            </div>
          </>
        )}

        {step === "done" && (
          <Card className="border-none shadow-sm">
            <CardContent className="p-8 text-center space-y-3">
              <div className="w-14 h-14 rounded-2xl bg-success/10 flex items-center justify-center mx-auto">
                <Check className="w-7 h-7 text-success" />
              </div>
              <h3 className="font-semibold">{savedCount} meals published</h3>
              <p className="text-sm text-muted-foreground">
                The chef can see the menu now and can raise the raw-material requisition against it.
              </p>
              <Button variant="outline" onClick={reset}>
                <ScanLine className="w-4 h-4 mr-1.5" /> Scan another menu
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}
