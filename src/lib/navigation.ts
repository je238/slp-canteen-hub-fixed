import {
  LayoutDashboard, Package, ChefHat, Truck, ScanLine, Wallet, BarChart3,
  Building2, ClipboardCheck, Shield, Store, CalendarDays, ClipboardList,
  FileUp, Target, History, AlertTriangle, ArrowLeftRight,
} from "lucide-react";

// One list drives both the sidebar and the route guards. They used to be
// written separately: the sidebar moved to explicit roles while the routes
// still used a rank floor, so a chef who typed /inventory got in even though
// the link was hidden. Anything not on an entry's `roles` cannot reach it
// either way.

export interface NavEntry {
  path: string;
  label: string;
  icon: any;
  roles: string[];
  /** Reachable by URL but deliberately kept off the sidebar. */
  hidden?: boolean;
  /**
   * Roles that may still open this, but should not see it in their menu.
   *
   * The owner's sidebar had all eighteen screens on it, including the two
   * that are somebody's daily data entry — scanning the menu is the
   * manager's morning and scanning bills is the store keeper's. An owner
   * signing in to check the money had to read past them.
   *
   * They stay reachable by URL rather than being taken away, because in a
   * business this size the owner does cover for someone off sick, and
   * finding the screen simply gone would be worse than a longer menu.
   */
  hideFrom?: string[];
}

const EVERYONE_INSIDE = [
  "chef", "cashier", "store_keeper", "unit_manager", "manager",
  "ops_manager", "admin", "super_admin", "owner",
];
const MANAGER_UP = ["unit_manager", "manager", "ops_manager", "admin", "super_admin", "owner"];
const ADMIN_UP = ["admin", "super_admin", "owner"];
const STORE_AND_ADMIN = ["store_keeper", ...ADMIN_UP];

// Neither the owner nor the admin works the counter. Screens that are
// somebody else's daily entry stay off both their menus.
const OWNER = ["super_admin", "owner"];
const OWNER_AND_ADMIN = ["admin", ...OWNER];

// The ops manager compares periods and nothing else — no entry, no
// approvals. One screen, so it is not buried under things they never touch.
const OPS_ONLY = ["ops_manager"];

export const NAV: NavEntry[] = [
  { path: "/comparison", label: "Comparison", icon: BarChart3,
    roles: ["ops_manager", ...ADMIN_UP] },

  // The vendor's own screen. An owner has no bills of their own to file.
  { path: "/vendor-portal", label: "My Bills", icon: Store,
    roles: ["vendor", ...ADMIN_UP], hideFrom: OWNER_AND_ADMIN },

  { path: "/dashboard", label: "Dashboard", icon: LayoutDashboard,
    roles: ["store_keeper", ...MANAGER_UP] },

  // Kitchen. Menu & Production and Requisitions stay on the owner's menu:
  // that is where a plate count or an approved quantity gets corrected, and
  // only an admin may correct them.
  { path: "/menu-planning", label: "Menu & Production", icon: CalendarDays,
    roles: ["chef", "cashier", ...MANAGER_UP], hideFrom: OPS_ONLY },
  { path: "/requisitions", label: "Requisitions", icon: ClipboardList,
    roles: EVERYONE_INSIDE },
  { path: "/recipes", label: "Recipes", icon: ChefHat,
    roles: ["chef", ...MANAGER_UP], hideFrom: [...OWNER_AND_ADMIN, ...OPS_ONLY] },
  // The manager's morning job.
  { path: "/menu-scan", label: "Daily Menu", icon: ScanLine,
    roles: MANAGER_UP, hideFrom: [...OWNER_AND_ADMIN, ...OPS_ONLY] },

  // Store. Scanning bills is the store keeper's job.
  { path: "/invoice-scan", label: "Invoice Scan", icon: ScanLine,
    roles: STORE_AND_ADMIN, hideFrom: OWNER_AND_ADMIN },
  { path: "/inventory", label: "Inventory", icon: Package, roles: ["store_keeper", ...MANAGER_UP] },
  { path: "/central-kitchen", label: "Central Kitchen", icon: ArrowLeftRight,
    roles: ["store_keeper", ...MANAGER_UP] },
  { path: "/purchases", label: "Purchases", icon: Truck, roles: ["store_keeper", ...MANAGER_UP] },
  { path: "/vendor-bills", label: "Vendor Bills", icon: FileUp, roles: STORE_AND_ADMIN },

  // Masters and money.
  { path: "/vendors", label: "Vendor Master", icon: Store, roles: ["store_keeper", ...MANAGER_UP] },
  { path: "/expenses", label: "Expenses", icon: Wallet, roles: ["ops_manager", ...ADMIN_UP], hideFrom: OPS_ONLY },
  { path: "/budgets", label: "Budgets", icon: Target, roles: ["ops_manager", ...ADMIN_UP], hideFrom: OPS_ONLY },
  { path: "/reports-center", label: "Reports", icon: BarChart3, roles: MANAGER_UP },
  { path: "/site-performance", label: "Site Performance", icon: LayoutDashboard,
    roles: ["ops_manager", ...ADMIN_UP] },
  { path: "/stock-audit", label: "Stock Verification", icon: ClipboardCheck, roles: STORE_AND_ADMIN },

  // Administration
  { path: "/canteens", label: "Sites", icon: Building2, roles: MANAGER_UP, hideFrom: OPS_ONLY },
  { path: "/users", label: "User Management", icon: Shield, roles: ADMIN_UP },
  { path: "/executive-alerts", label: "Executive Alerts", icon: AlertTriangle, roles: ["ops_manager",...ADMIN_UP] },
  { path: "/audit-log", label: "Audit & Changes", icon: History, roles: ["ops_manager",...ADMIN_UP] },
];

const norm = (r?: string | null) => String(r ?? "").toLowerCase();

export function navFor(role?: string | null): NavEntry[] {
  const r = norm(role);
  return NAV.filter((e) =>
    !e.hidden && e.roles.includes(r) && !(e.hideFrom ?? []).includes(r));
}

export function canOpen(path: string, role?: string | null): boolean {
  const entry = NAV.find((e) => e.path === path);
  if (!entry) return true;                 // unlisted routes fall back to the guard
  return entry.roles.includes(norm(role));
}

/** Where this role starts. First entry it is allowed to see. */
export function homeFor(role?: string | null): string {
  const r = norm(role);
  if (r === "vendor") return "/vendor-portal";
  if (["chef", "cashier"].includes(r)) return "/menu-planning";
  const allowed = navFor(r);
  if (["ops_manager", "admin", "super_admin", "owner"].includes(r)) return "/dashboard";
  const preferred = ["/dashboard", "/site-performance", "/requisitions"];
  for (const p of preferred) if (allowed.some((e) => e.path === p)) return p;
  return allowed[0]?.path ?? "/vendor-portal";
}
