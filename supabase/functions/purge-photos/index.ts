// Delivery photos are kept for one month and then deleted.
//
// This has to run outside the database: Postgres refuses direct deletes from
// storage.objects, and even with the escape hatch it would only drop the row
// and leave the file itself sitting in storage forever. The Storage API is
// the only thing that removes the actual image.
//
// Called nightly by the purge-stock-photos cron job. Every run is written to
// action_logs so an admin can see it happened — a retention rule nobody can
// check is the same as no retention rule.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const BUCKET = "stock-photos";

serve(async (req) => {
  // Only the scheduler may call this. The token lives in the function's
  // secrets and in the cron command, nowhere the app can reach.
  const token = Deno.env.get("PURGE_TOKEN") ?? "";
  const given = req.headers.get("x-purge-token") ?? "";
  if (!token || given !== token) {
    return new Response(JSON.stringify({ error: "not authorised" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const { data: expired, error } = await db
      .from("stock_photos")
      .select("id, image_path")
      .lt("expires_at", new Date().toISOString())
      .limit(1000);
    if (error) throw error;

    if (expired && expired.length > 0) {
      // Remove the files first. If this fails the rows stay, so the next run
      // tries again rather than losing track of a file that is still there.
      const paths = expired.map((p) => p.image_path).filter(Boolean);
      if (paths.length > 0) {
        const { error: sErr } = await db.storage.from(BUCKET).remove(paths);
        if (sErr) throw sErr;
      }

      const { error: dErr } = await db
        .from("stock_photos").delete().in("id", expired.map((p) => p.id));
      if (dErr) throw dErr;
    }

    // Logged even when nothing expired. A retention rule that only leaves a
    // trace on the nights it deletes something is one you cannot tell apart
    // from a job that stopped running.
    await db.from("action_logs").insert({
      action: "photos_purged", entity_type: "stock_photos",
      details: { count: expired?.length ?? 0, ran_at: new Date().toISOString() },
    });

    return new Response(JSON.stringify({ purged: expired?.length ?? 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("purge-photos:", message);
    await db.from("action_logs").insert({
      action: "photos_purge_failed", entity_type: "stock_photos",
      details: { error: message, ran_at: new Date().toISOString() },
    });
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
