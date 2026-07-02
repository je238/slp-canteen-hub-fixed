import React, { createContext, useContext, useEffect, useState } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type UserRole = "owner" | "manager" | "cashier";
interface UserRoleData { role: UserRole; canteen_id: string | null; }
interface AuthContextType {
  session: Session | null;
  user: User | null;
  roleData: UserRoleData;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  isOwner: boolean;
  isManagerOrAbove: boolean;
  canAccessCanteen: (canteenId: string) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
// Until a role row is assigned by an owner, a signed-in user gets the most
// restricted role and no canteen — RLS enforces the same on the server.
const NO_ROLE: UserRoleData = { role: "cashier", canteen_id: null };

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [roleData, setRoleData] = useState<UserRoleData>(NO_ROLE);
  // Must start true: rendering protected routes with loading=false and no
  // session yet bounces logged-in users to /login on every page refresh.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const loadRole = async (s: Session | null) => {
      if (!s?.user) {
        if (!cancelled) { setRoleData(NO_ROLE); setLoading(false); }
        return;
      }
      const { data } = await supabase
        .from("user_roles")
        .select("role, canteen_id")
        .eq("user_id", s.user.id)
        .maybeSingle();
      if (!cancelled) {
        setRoleData(data ? { role: data.role as UserRole, canteen_id: data.canteen_id } : NO_ROLE);
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

  const signOut = async () => { await supabase.auth.signOut(); };

  const isOwner = roleData.role === "owner";
  const isManagerOrAbove = isOwner || roleData.role === "manager";

  return (
    <AuthContext.Provider value={{
      session, user, roleData, loading,
      signIn, signOut,
      isOwner,
      isManagerOrAbove,
      canAccessCanteen: (canteenId: string) => isOwner || roleData.canteen_id === canteenId,
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
