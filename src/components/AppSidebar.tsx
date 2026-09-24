import { useLocation, useNavigate } from "react-router-dom";
import { useAppContext } from "@/contexts/AppContext";
import { useAuth, ROLE_LABEL } from "@/contexts/AuthContext";
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  ChefHat,
  Truck,
  ScanLine,
  Wallet,
  Users,
  BarChart3,
  Menu,
  X,
  ClipboardCheck,
  Shield,
  Key,
  LogOut,
  MessageCircle,
  Activity,
  Flame,
  QrCode,
  Store,
  FileText,
  CalendarDays,
  ClipboardList,
  FileUp,
  Target,
} from "lucide-react";
import { toast } from "sonner";
import UnitSwitcher from "@/components/UnitSwitcher";

import { navFor } from "@/lib/navigation";

export default function AppSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { sidebarOpen, setSidebarOpen } = useAppContext();
  const { roleData, user, signOut } = useAuth();

  // A link shows only if this exact role is on its list — no inheriting a
  // screen just for outranking someone.
  const navItems = navFor(roleData?.role);

  const handleSignOut = async () => {
    await signOut();
    toast.success("Signed out");
    navigate("/login");
  };

  return (
    <>
      {sidebarOpen && (
        <div className="fixed inset-0 bg-foreground/30 z-40 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <aside
        // h-screen is 100vh, which on a phone browser includes the strip
        // behind the address bar. The sidebar is fixed, so anything past the
        // real bottom of the window — Sign out, and the last menu item —
        // simply could not be reached. The installed app has no address bar,
        // which is why it only happened on the website. h-dvh measures the
        // window that is actually visible; h-screen stays as the fallback for
        // browsers that do not know dvh.
        // Keep h-screen as the old-browser fallback. The inline dynamic
        // viewport height wins on modern phones, regardless of Tailwind's
        // generated class order, so the footer cannot sit behind the browser
        // toolbar. maxHeight also prevents a stale mobile viewport from
        // stretching the sidebar after the address bar changes size.
        style={{ height: "100dvh", maxHeight: "100dvh" }}
        className={`fixed top-0 left-0 z-50 h-screen w-64 sidebar-gradient flex flex-col overflow-hidden transition-transform duration-200 lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-5 py-5 border-b border-sidebar-border">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="h-11 w-11 shrink-0 overflow-hidden rounded-xl border border-white/15 bg-[#f8f7ef] p-1 shadow-sm">
              <img src="/slp-logo.png" alt="SLP logo" className="h-full w-full object-contain" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-bold tracking-wide text-sidebar-accent-foreground">SLP Canteen Hub</h1>
              <p className="text-[10px] text-sidebar-foreground">by SLP Hospitality</p>
            </div>
          </div>
          <button className="lg:hidden text-sidebar-foreground" onClick={() => setSidebarOpen(false)}>
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Site selector. The rule is what you can reach, not what you
            outrank: a chef cooking for three Eicher units was pinned to the
            first one and had no way to switch, so a menu published on unit 2
            sent them a notification for a screen that could never show it. */}
        <div className="px-4 py-3"><UnitSwitcher variant="sidebar" /></div>

        <nav className="flex-1 min-h-0 px-3 py-2 overflow-y-auto overscroll-contain space-y-0.5">
          {navItems.map((item) => {
            const active = location.pathname === item.path;
            return (
              <button
                key={item.path}
                onClick={() => { navigate(item.path); setSidebarOpen(false); }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors ${
                  active
                    ? "bg-accent text-accent-foreground font-semibold"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                }`}
              >
                <item.icon className="w-4 h-4 shrink-0" />
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* User info + sign out. shrink-0 so a long menu squeezes the list
            above rather than this block, which is what pushed Sign out off
            the bottom of the screen for admins with sixteen links. */}
        <div className="shrink-0 border-t border-sidebar-border bg-sidebar px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-sidebar-accent flex items-center justify-center text-xs font-bold text-sidebar-accent-foreground">
              {user?.email?.[0]?.toUpperCase() || "?"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-sidebar-accent-foreground truncate">{user?.email}</p>
              <p className="text-[10px] text-sidebar-foreground">
                {ROLE_LABEL[String(roleData?.role).toLowerCase()] || roleData?.role || "—"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            aria-label="Sign out"
            className="min-h-10 w-full touch-manipulation flex items-center gap-2 px-2 py-2 rounded text-xs text-sidebar-foreground hover:bg-sidebar-accent hover:text-destructive transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" /> Sign out
          </button>
        </div>
      </aside>
    </>
  );
}

export function MobileMenuButton() {
  const { setSidebarOpen } = useAppContext();
  return (
    <button className="lg:hidden p-2 rounded-md hover:bg-secondary" onClick={() => setSidebarOpen(true)}>
      <Menu className="w-5 h-5" />
    </button>
  );
}
