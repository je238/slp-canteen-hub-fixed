import { Navigate, useLocation } from "react-router-dom";
import { useAuth, rankOf, ROLE_LABEL } from "@/contexts/AuthContext";
import { canOpen, homeFor } from "@/lib/navigation";

interface ProtectedRouteProps {
  children: React.ReactNode;
  /** Lowest role allowed here. Kept as a floor; the role list decides. */
  minRole?: string;
}

// Note: this is a UX guard only. The database enforces the same limits through
// RLS, so a user who edits their way past this screen still gets nothing back.
export default function ProtectedRoute({ children, minRole }: ProtectedRouteProps) {
  const { session, loading, rank, roleData } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto" />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  // The role list is what decides — a chef outranks a store keeper on the
  // ladder but has no business on the store's screens.
  const allowed = canOpen(location.pathname, roleData?.role)
    && (!minRole || rank >= rankOf(minRole));

  if (!allowed) {
    const home = homeFor(roleData?.role);
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="max-w-md text-center space-y-3">
          <h2 className="text-lg font-semibold">This screen isn't part of your role</h2>
          <p className="text-sm text-muted-foreground">
            You're signed in as <b>{ROLE_LABEL[String(roleData.role).toLowerCase()] || roleData.role}</b>,
            which doesn't have access here. Ask an admin if you think this is wrong.
          </p>
          <a href={home} className="inline-block text-sm underline text-accent">Go to my dashboard</a>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
