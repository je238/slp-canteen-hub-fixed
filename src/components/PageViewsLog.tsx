import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, UserRound, CalendarDays, Clock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useUserDirectory } from "@/hooks/useSupabaseData";
import { readableDuration, summarisePageViews, type PageViewRow } from "@/lib/pageViews";

const ROLE_NAME: Record<string, string> = {
  owner: "Owner", super_admin: "Super Admin", admin: "Admin", ops_manager: "Operations Manager",
  unit_manager: "Manager", manager: "Manager", head_supervisor: "Head Supervisor", head_chef: "Head Chef",
  chef: "Chef", store_keeper: "Store Keeper", cashier: "Cashier", vendor: "Vendor",
};

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", {
  timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
});
const dayLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });

/** "Kisne kya dekha" — every screen each person opened since `from`. */
export default function PageViewsLog({ from, canteenId, search }: { from: string; canteenId: string; search: string }) {
  const { data: users = {} } = useUserDirectory();
  const [open, setOpen] = useState<string | null>(null);
  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: ["pageViews", from, canteenId],
    queryFn: async () => {
      let q = supabase.from("page_views" as any).select("user_id,role,path,title,opened_at,active_seconds,canteen_id")
        .gte("opened_at", `${from}T00:00:00+05:30`).order("opened_at", { ascending: false }).limit(5000);
      // A screen opened on the combined view has no site; keep it either way.
      if (canteenId !== "all") q = q.or(`canteen_id.eq.${canteenId},canteen_id.is.null`);
      const { data, error: e } = await q;
      if (e) throw e;
      return (data || []) as unknown as PageViewRow[];
    },
  });

  const people = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return summarisePageViews(rows).filter((p) => !needle ||
      [users[p.userId], ROLE_NAME[p.role || ""], ...p.screens.map((s) => s.title)].join(" ").toLowerCase().includes(needle));
  }, [rows, users, search]);

  if (error) return <Card><CardContent className="p-8 text-center text-sm text-destructive">Ye record sirf Admin aur upar wale dekh sakte hain.</CardContent></Card>;
  if (isLoading) return <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Load ho raha hai…</CardContent></Card>;
  if (!people.length) return <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Is date se kisi ne koi screen nahi kholi. (Ye record 20 Oct 2026 se shuru hua hai.)</CardContent></Card>;

  return <div className="space-y-2">
    <p className="text-xs text-muted-foreground px-1">Ye record 20 Oct 2026 se hai. Samay = jitni der screen saamne khuli rahi (phone band ya app peeche ho to nahi gina).</p>
    {people.map((p) => {
      const isOpen = open === p.userId;
      return <Card key={p.userId} className="border-none shadow-sm"><CardContent className="p-4 space-y-3">
        <button type="button" className="w-full text-left" onClick={() => setOpen(isOpen ? null : p.userId)}>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold text-sm flex items-center gap-1.5 break-all"><UserRound className="w-4 h-4 shrink-0 text-accent" />{users[p.userId] || "User account"}</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Badge variant="outline" className="text-[10px]">{ROLE_NAME[p.role || ""] || p.role || "—"}</Badge>
                <Badge variant="secondary" className="text-[10px]"><CalendarDays className="w-3 h-3 mr-1" />{p.days.length} din</Badge>
                <Badge variant="secondary" className="text-[10px]"><Eye className="w-3 h-3 mr-1" />{p.visits} baar</Badge>
                <Badge variant="secondary" className="text-[10px]"><Clock className="w-3 h-3 mr-1" />{readableDuration(p.seconds)}</Badge>
              </div>
            </div>
            <p className="text-xs text-muted-foreground shrink-0">Aakhri baar: {when(p.lastOpened)}</p>
          </div>
        </button>
        <div className="divide-y rounded-lg border">
          {(isOpen ? p.screens : p.screens.slice(0, 4)).map((s) => <div key={s.path} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
            <span className="min-w-0 truncate font-medium">{s.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{s.visits} baar · {readableDuration(s.seconds)} · {when(s.lastOpened)}</span>
          </div>)}
        </div>
        {isOpen
          ? <p className="text-xs text-muted-foreground">Din jab app khola: {p.days.map(dayLabel).join(", ")}</p>
          : p.screens.length > 4 && <button type="button" className="text-xs text-accent font-medium" onClick={() => setOpen(p.userId)}>Saari {p.screens.length} screens aur din dikhao</button>}
      </CardContent></Card>;
    })}
  </div>;
}
