import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { clearAllDrafts } from "@/lib/draft";
import { disablePush, syncExistingPush } from "@/lib/pushNotifications";

// SRS role model. Legacy rows (owner/manager/cashier) keep working and map
// onto the same ranks the database uses in public.role_rank().
export type UserRole =
  | "super_admin" | "admin" | "ops_manager" | "unit_manager"
  | "chef" | "store_keeper" | "vendor"
  | "owner" | "manager" | "cashier";   // legacy

export const ROLE_RANK: Record<string, number> = {
  super_admin: 70, owner: 70,
  admin: 60,
  ops_manager: 50,
  unit_manager: 40, manager: 40,
  chef: 30, cashier: 30,
  store_keeper: 20,
  vendor: 10,
};

export const ROLE_LABEL: Record<string, string> = {
  super_admin: "Super Admin", owner: "Super Admin (legacy owner)",
  admin: "Admin",
  ops_manager: "Operations Manager",
  unit_manager: "Unit Manager", manager: "Unit Manager (legacy)",
  chef: "Chef", cashier: "Chef (legacy cashier)",
  store_keeper: "Store Keeper",
  vendor: "Vendor",
};

export const rankOf = (role?: string | null) => ROLE_RANK[String(role ?? "").toLowerCase()] ?? 0;

interface UserRoleData {
  role: UserRole;
  canteen_id: string | null;
  supplier_id: string | null;
  sites: string[];          // extra sites assigned to ops managers
}

interface AuthContextType {
  session: Session | null;
  user: User | null;
  roleData: UserRoleData;
  rank: number;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  isSuperAdmin: boolean;
  isOwner: boolean;              // admin and above (kept for existing callers)
  isManagerOrAbove: boolean;     // unit manager and above
  isStoreKeeperOrAbove: boolean;
  isChef: boolean;
  isVendor: boolean;
  /** Who may move stock out of the store. Deliberately NOT rank-based:
   *  chef outranks store keeper on the ladder but must never issue stock. */
  canIssueStock: boolean;
  canAccessCanteen: (canteenId: string) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
// Until a role row is assigned, a signed-in user gets the most restricted
// role and no site — RLS enforces the same thing on the server.
const NO_ROLE: UserRoleData = { role: "vendor", canteen_id: null, supplier_id: null, sites: [] };

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [roleData, setRoleData] = useState<UserRoleData>(NO_ROLE);
  // Must start true: rendering protected routes with loading=false and no
  // session yet bounces logged-in users to /login on every page refresh.
  const [loading, setLoading] = useState(true);
  // Who we already have a role for, so a token refresh can be told apart
  // from an actual sign-in.
  const knownUser = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadRole = async (s: Session | null) => {
      if (!s?.user) {
        knownUser.current = null;
        if (!cancelled) { setRoleData(NO_ROLE); setLoading(false); }
        return;
      }
      // Someone just signed in: stay in the loading state until their real
      // role arrives. Without this, the first render after login still holds
      // the default (lowest) role and the app redirects to the wrong home.
      //
      // But ONLY for a genuinely new user. Sending the app to the background
      // and reopening it makes Supabase refresh the token, which fires this
      // same handler for the same person. Flipping to loading there swaps
      // every screen for a spinner, and a spinner unmounts the page — the
      // menu being typed, the invoice just scanned, the half-filled form all
      // go with it, and what comes back is blank. That is the "sab gayab ho
      // jata hai" everyone was seeing. A new token is not a new user.
      const sameUser = knownUser.current === s.user.id;
      knownUser.current = s.user.id;
      if (!cancelled && !sameUser) setLoading(true);

      // Admins can read every user_roles row, so this must not assume a
      // single result — filter to our own row and take the first.
      // supplier_id only exists after the SRS role migration; fall back to
      // the legacy shape so login never breaks on an older database.
      let role: any = null;
      const full = await supabase
        .from("user_roles")
        .select("role, canteen_id, supplier_id")
        .eq("user_id", s.user.id)
        .limit(1);
      if (full.error) {
        const legacy = await supabase
          .from("user_roles").select("role, canteen_id")
          .eq("user_id", s.user.id).limit(1);
        role = legacy.data?.[0] ?? null;
      } else {
        role = full.data?.[0] ?? null;
      }

      let sites: string[] = [];
      const siteRows = await supabase
        .from("user_sites" as any).select("canteen_id").eq("user_id", s.user.id);
      if (!siteRows.error && siteRows.data) sites = (siteRows.data as any[]).map((r) => r.canteen_id);

      if (!cancelled) {
        // Already-authorized devices renew their account binding; no permission prompt.
        if (role) void syncExistingPush().catch(() => {});
        setRoleData(role
          ? {
              role: role.role as UserRole,
              canteen_id: role.canteen_id ?? null,
              supplier_id: (role as any).supplier_id ?? null,
              sites,
            }
          : NO_ROLE);
        setLoading(false);
      }
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return;
      setSession(session);
      setUser(session?.user ?? null);
      loadRole(session);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      setSession(session);
      setUser(session?.user ?? null);
      loadRole(session);
    });
    return () => { cancelled = true; subscription.unsubscribe(); };
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { error: null };
  };

  const signOut = async () => {
    await disablePush().catch(() => {}); // also revokes the browser subscription offline
    await clearAllDrafts();          // unfinished work is not the next user's
    await supabase.auth.signOut();
  };

  const rank = rankOf(roleData.role);
  const roleKey = String(roleData.role).toLowerCase();

  return (
    <AuthContext.Provider value={{
      session, user, roleData, rank, loading,
      signIn, signOut,
      isSuperAdmin: rank >= 70,
      isOwner: rank >= 60,
      isManagerOrAbove: rank >= 40,
      isStoreKeeperOrAbove: rank >= 20,
      isChef: roleKey === "chef" || roleKey === "cashier",
      isVendor: roleKey === "vendor",
      canIssueStock: roleKey === "store_keeper" || rank >= 40,
      canAccessCanteen: (canteenId: string) =>
        rank >= 60 || roleData.canteen_id === canteenId || roleData.sites.includes(canteenId),
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};
