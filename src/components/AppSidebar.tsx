import { useLocation, useNavigate } from "react-router-dom";
import { useAppContext } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { useCanteens } from "@/hooks/useSupabaseData";
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
  Building2,
  ClipboardCheck,
  Shield,
  Key,
  LogOut,
  MessageCircle,
  Activity,
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

const allNavItems = [
  { path: "/", icon: LayoutDashboard, label: "Dashboard", minRole: "manager" as const },
  { path: "/pos", icon: ShoppingCart, label: "POS Billing", minRole: "cashier" as const },
  { path: "/inventory", icon: Package, label: "Inventory", minRole: "manager" as const },
  { path: "/recipes", icon: ChefHat, label: "Recipes", minRole: "manager" as const },
  { path: "/purchases", icon: Truck, label: "Purchases", minRole: "manager" as const },
  { path: "/invoice-scan", icon: ScanLine, label: "Invoice Scan", minRole: "manager" as const },
  { path: "/expenses", icon: Wallet, label: "Expenses", minRole: "manager" as const },
  { path: "/stock-audit", icon: ClipboardCheck, label: "Stock Audit", minRole: "manager" as const },
  { path: "/staff", icon: Users, label: "Staff", minRole: "manager" as const },
  { path: "/reports", icon: BarChart3, label: "Reports" },
  { path: "/daily-report", icon: MessageCircle, label: "Daily Report", minRole: "cashier" as const },
  { path: "/activity", icon: Activity, label: "Activity Log", minRole: "cashier" as const },
  { path: "/canteens", icon: Building2, label: "Canteens" },
  { path: "/users", icon: Shield, label: "User Management", minRole: "owner" as const },
  { path: "/api-keys", icon: Key, label: "API Keys", minRole: "owner" as const },
  { path: "/daily-report", icon: MessageCircle, label: "Daily Report", minRole: "cashier" as const },
  { path: "/activity", icon: Activity, label: "Activity Log", minRole: "cashier" as const },
  { path: "/canteens", icon: Building2, label: "Canteens", minRole: "cashier" as const },
];

const ROLE_RANK: Record<string, number> = { owner: 3, manager: 2, cashier: 1 };

export default function AppSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { selectedCanteen, setSelectedCanteen, sidebarOpen, setSidebarOpen } = useAppContext();
  const { roleData, user, signOut } = useAuth();
  const { data: canteens } = useCanteens();

  const userRole = roleData?.role || "cashier";
  const navItems = allNavItems.filter(
    item => ROLE_RANK[userRole] >= ROLE_RANK[item.minRole]
  );

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
        className={`fixed top-0 left-0 z-50 h-screen w-64 sidebar-gradient flex flex-col transition-transform duration-200 lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-5 py-5 border-b border-sidebar-border">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-accent flex items-center justify-center">
              <Building2 className="w-5 h-5 text-accent-foreground" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-sidebar-accent-foreground tracking-wide">SLP Canteen Hub</h1>
              <p className="text-[10px] text-sidebar-foreground">Canteen Management</p>
            </div>
          </div>
          <button className="lg:hidden text-sidebar-foreground" onClick={() => setSidebarOpen(false)}>
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Canteen selector — hide for cashiers (auto-assigned) */}
        {userRole !== "cashier" && (
          <div className="px-4 py-3">
            <Select value={selectedCanteen} onValueChange={setSelectedCanteen}>
              <SelectTrigger className="bg-sidebar-accent border-sidebar-border text-sidebar-accent-foreground text-xs h-9">
                <SelectValue placeholder="Select canteen" />
              </SelectTrigger>
              <SelectContent>
                {userRole === "owner" && <SelectItem value="all">All Canteens</SelectItem>}
                {canteens?.map((c: any) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <nav className="flex-1 px-3 py-2 overflow-y-auto space-y-0.5">
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

        {/* User info + sign out */}
        <div className="px-4 py-3 border-t border-sidebar-border space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-sidebar-accent flex items-center justify-center text-xs font-bold text-sidebar-accent-foreground">
              {user?.email?.[0]?.toUpperCase() || "?"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-sidebar-accent-foreground truncate">{user?.email}</p>
              <p className="text-[10px] text-sidebar-foreground capitalize">{userRole}</p>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-sidebar-foreground hover:bg-sidebar-accent hover:text-destructive transition-colors"
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

