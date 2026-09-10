import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};
const rank: Record<string, number> = {
  vendor: 10, store_keeper: 20, chef: 30, cashier: 30, unit_manager: 40,
  manager: 40, ops_manager: 50, admin: 60, super_admin: 70, owner: 70,
};
const allowedRoles = ["admin", "ops_manager", "unit_manager", "chef", "store_keeper", "vendor"];
const siteRoles = new Set(["ops_manager", "unit_manager", "chef", "store_keeper"]);
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not authenticated" }, 401);
    const { data: caller, error: callerError } = await service.auth.getUser(jwt);
    if (callerError || !caller.user) return json({ error: "Not authenticated" }, 401);
    const { data: callerRole } = await service.from("user_roles").select("role").eq("user_id", caller.user.id).maybeSingle();
    const callerRank = rank[callerRole?.role || ""] || 0;
    if (callerRank < 60) return json({ error: "Only Super Admin or Admin can manage users" }, 403);

    if (req.method === "GET") {
      const { data: authPage, error: listError } = await service.auth.admin.listUsers({ perPage: 1000 });
      if (listError) throw listError;
      const { data: roles, error: rolesError } = await service.from("user_roles")
        .select("id,user_id,role,canteen_id,supplier_id,created_at").order("created_at", { ascending: false });
      if (rolesError) throw rolesError;
      const authById = new Map(authPage.users.map((u) => [u.id, u]));
      return json({ users: (roles || []).map((r) => {
        const user = authById.get(r.user_id);
        return { ...r, email: user?.email || null, last_sign_in_at: user?.last_sign_in_at || null };
      }) });
    }

    const body = await req.json();
    const targetRole = String(body.role || "");
    const validateAssignment = () => {
      if (!allowedRoles.includes(targetRole)) return "Invalid role";
      if ((rank[targetRole] || 0) >= callerRank) return "You cannot assign a role equal to or above your own";
      if (siteRoles.has(targetRole) && !body.canteen_id) return "Select a site for this role";
      if (targetRole === "vendor" && !body.supplier_id) return "Select a supplier for the vendor";
      return null;
    };

    if (req.method === "POST") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!email || password.length < 8) return json({ error: "Valid email and an 8-character password are required" }, 400);
      const assignmentError = validateAssignment();
      if (assignmentError) return json({ error: assignmentError }, 400);
      const { data: created, error: createError } = await service.auth.admin.createUser({ email, password, email_confirm: true });
      if (createError) return json({ error: createError.message }, 400);
      const { error: roleError } = await service.from("user_roles").insert({
        user_id: created.user.id, role: targetRole,
        canteen_id: siteRoles.has(targetRole) ? body.canteen_id : null,
        supplier_id: targetRole === "vendor" ? body.supplier_id : null,
      });
      if (roleError) {
        await service.auth.admin.deleteUser(created.user.id);
        return json({ error: roleError.message }, 400);
      }
      return json({ user_id: created.user.id, email });
    }

    const targetId = String(body.user_id || "");
    if (!targetId || targetId === caller.user.id) return json({ error: "You cannot change your own account here" }, 400);
    const { data: existing } = await service.from("user_roles").select("id,role").eq("user_id", targetId).maybeSingle();
    if (!existing) return json({ error: "User not found" }, 404);
    if ((rank[existing.role] || 0) >= callerRank) return json({ error: "You cannot manage a user equal to or above your role" }, 403);

    if (req.method === "PATCH") {
      const assignmentError = validateAssignment();
      if (assignmentError) return json({ error: assignmentError }, 400);
      const password = String(body.password || "");
      if (password && password.length < 8) return json({ error: "New password must be at least 8 characters" }, 400);
      if (password) {
        const { error } = await service.auth.admin.updateUserById(targetId, { password });
        if (error) return json({ error: error.message }, 400);
      }
      const { error } = await service.from("user_roles").update({
        role: targetRole, canteen_id: siteRoles.has(targetRole) ? body.canteen_id : null,
        supplier_id: targetRole === "vendor" ? body.supplier_id : null,
      }).eq("user_id", targetId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (req.method === "DELETE") {
      const { error } = await service.auth.admin.deleteUser(targetId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("admin-create-user error", error instanceof Error ? error.message : "unknown");
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

