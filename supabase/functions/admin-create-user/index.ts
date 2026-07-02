// Owner-only staff account creation. Creates a pre-confirmed auth user,
// assigns their role, and returns the new user id. Also supports listing
// users with emails (GET) so the User Management page can show who is who.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const service = createClient(url, serviceKey);

    // --- Authenticate the caller and require the owner role ---
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not authenticated" }, 401);

    const { data: caller, error: callerErr } = await service.auth.getUser(jwt);
    if (callerErr || !caller?.user) return json({ error: "Not authenticated" }, 401);

    const { data: callerRole } = await service
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.user.id)
      .maybeSingle();
    if (callerRole?.role !== "owner") return json({ error: "Only owners can manage users" }, 403);

    // --- GET: list users with emails + roles ---
    if (req.method === "GET") {
      const { data: usersPage, error: listErr } = await service.auth.admin.listUsers({ perPage: 200 });
      if (listErr) throw listErr;
      const { data: roles } = await service.from("user_roles").select("id, user_id, role, canteen_id, created_at");
      const users = (roles || []).map((r) => ({
        ...r,
        email: usersPage.users.find((u) => u.id === r.user_id)?.email || null,
      }));
      return json({ users });
    }

    // --- POST: create a staff account ---
    const { email, password, role, canteen_id } = await req.json();
    if (!email || !password) return json({ error: "Email and password are required" }, 400);
    if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
    if (!["owner", "manager", "cashier"].includes(role)) return json({ error: "Invalid role" }, 400);
    if (role !== "owner" && !canteen_id) return json({ error: "Managers and cashiers need a canteen" }, 400);

    const { data: created, error: createErr } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // staff shouldn't have to click a confirmation email
    });
    if (createErr) return json({ error: createErr.message }, 400);

    const { error: roleErr } = await service.from("user_roles").insert({
      user_id: created.user.id,
      role,
      canteen_id: role === "owner" ? null : canteen_id,
    });
    if (roleErr) {
      // Roll back the orphaned auth user so a retry works cleanly
      await service.auth.admin.deleteUser(created.user.id);
      return json({ error: roleErr.message }, 400);
    }

    return json({ user_id: created.user.id, email });
  } catch (e) {
    console.error("admin-create-user error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
