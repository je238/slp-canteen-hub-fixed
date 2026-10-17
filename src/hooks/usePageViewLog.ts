import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

// Records which screen a signed-in user has open, for the owner's "who
// looked at what" list on Audit & Changes. Opening a report changes nothing,
// so action_logs never saw it.
//
// One row per screen visit. While the screen is visible it is pinged every
// minute; going to the background pings once more (that stretch counted),
// and coming back pings without counting the time away. Failures are
// ignored: this must never get in the way of the screen itself.
const PING_MS = 60_000;

export function usePageViewLog(userId: string | undefined, title: string, canteenId: string | null) {
  const { pathname } = useLocation();

  useEffect(() => {
    if (!userId) return;
    let id: string | null = null;
    let stopped = false;
    const ping = (counts: boolean) => {
      if (id) void supabase.rpc("page_view_ping" as any, { p_id: id, p_counts: counts }).then(() => {}, () => {});
    };

    supabase.rpc("page_view_open" as any, { p_path: pathname, p_title: title, p_canteen_id: canteenId })
      .then(({ data }) => { if (!stopped) id = (data as string | null) ?? null; else if (data) { id = data as string; ping(true); } },
        () => {});

    const timer = window.setInterval(() => { if (document.visibilityState === "visible") ping(true); }, PING_MS);
    const onVisibility = () => ping(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      if (document.visibilityState === "visible") ping(true);
    };
    // The title can settle a render after the path; key the visit on the path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, pathname]);
}
