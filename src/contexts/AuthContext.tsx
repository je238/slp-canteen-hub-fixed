import React, { createContext, useContext, useEffect, useState } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type UserRole = "owner" | "manager" | "cashier";

interface UserRoleData {
  role: UserRole;
  canteen_id: string | null;
}

interface AuthContextType {
  session: Session | null;
  user: User | null;
  roleData: UserRoleData | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  isOwner: boolean;
  isManagerOrAbove: boolean;
  canAccessCanteen: (canteenId: string) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [roleData, setRoleData] = useState<UserRoleData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchRole = async (userId: string) => {
    const { data, error } = await supabase
      .from("user_roles")
      .select("role, canteen_id")
      .eq("user_id", userId)
      .single();

    if (error || !data) {
      setRoleData(null);
    } else {
      setRoleData({ role: data.role as UserRole, canteen_id: data.canteen_id });
    }
  };

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        fetchRole(session.user.id).finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        setSession(session);
        setUser(session?.user ?? null);
        if (session?.user) {
          await fetchRole(session.user.id);
        } else {
          setRoleData(null);
        }
        setLoading(false);
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  const signIn = async (email: string, password: string): Promise<{ error: string | null }> => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { error: null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const isOwner = roleData?.role === "owner";
  const isManagerOrAbove = roleData?.role === "owner" || roleData?.role === "manager";

  const canAccessCanteen = (canteenId: string) => {
    if (!roleData) return false;
    if (roleData.role === "owner") return true;
    return roleData.canteen_id === canteenId;
  };

  return (
    <AuthContext.Provider value={{
      session, user, roleData, loading,
      signIn, signOut,
      isOwner, isManagerOrAbove, canAccessCanteen,
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
