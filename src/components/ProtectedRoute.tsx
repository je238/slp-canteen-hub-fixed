import { Navigate } from "react-router-dom";
import { useAuth, UserRole } from "@/contexts/AuthContext";

interface ProtectedRouteProps {
  children: React.ReactNode;
  /** Minimum role required. If omitted, any authenticated user is allowed. */
  minRole?: UserRole;
}

const ROLE_RANK: Record<UserRole, number> = {
  owner: 3,
  manager: 2,
  cashier: 1,
};

export default function ProtectedRoute({ children, minRole }: ProtectedRouteProps) {
  const { session, roleData, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="space-y-3 text-center">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  if (!roleData) {
    // Authenticated but no role assigned yet
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="max-w-sm text-center space-y-3">
          <div className="text-4xl">🔒</div>
          <h2 className="text-lg font-semibold">No role assigned</h2>
          <p className="text-sm text-muted-foreground">
            Your account exists but hasn't been assigned a role yet. Ask the system owner to assign you a role in the dashboard.
          </p>
        </div>
      </div>
    );
  }

  if (minRole && ROLE_RANK[roleData.role] < ROLE_RANK[minRole]) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="max-w-sm text-center space-y-3">
          <div className="text-4xl">⛔</div>
          <h2 className="text-lg font-semibold">Access Denied</h2>
          <p className="text-sm text-muted-foreground">
            You need <strong>{minRole}</strong> access or above to view this page. Your current role is <strong>{roleData.role}</strong>.
          </p>
          <a href="/" className="text-sm text-accent underline">Go back to home</a>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
