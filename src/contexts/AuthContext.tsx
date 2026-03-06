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
const DEFAULT_ROLE: UserRoleData = { role: "owner", canteen_id: null };

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [roleData] = useState<UserRoleData>(DEFAULT_ROLE);
  const [loading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { error: null };
  };

  const signOut = async () => { await supabase.auth.signOut(); };

  return (
    <AuthContext.Provider value={{
      session, user, roleData, loading,
      signIn, signOut,
      isOwner: true,
      isManagerOrAbove: true,
      canAccessCanteen: () => true,
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
