import React from "react";
import { useNavigate } from "react-router-dom";
import AppSidebar, { MobileMenuButton } from "@/components/AppSidebar";
import { useAppContext } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { useCanteens } from "@/hooks/useSupabaseData";
import NotificationBell from "@/components/NotificationBell";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { toast } from "sonner";
import UnitSwitcher from "@/components/UnitSwitcher";

interface AppLayoutProps {
  children: React.ReactNode;
  title: string;
}

export default function AppLayout({ children, title }: AppLayoutProps) {
  const navigate = useNavigate();
  const { selectedCanteen } = useAppContext();
  const { signOut } = useAuth();
  const { data: canteens } = useCanteens();
  const canteenName = selectedCanteen === "all"
    ? "Combined view · unit-wise data"
    : canteens?.find((c: any) => c.id === selectedCanteen)?.name || "";

  const handleSignOut = async () => {
    await signOut();
    toast.success("Signed out");
    navigate("/login");
  };

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-background">
      <AppSidebar />
      <div className="min-w-0 max-w-full lg:pl-64">
        <header className="sticky top-0 z-30 h-14 min-w-0 max-w-full bg-card/80 px-4 backdrop-blur-sm border-b lg:px-6 flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <MobileMenuButton />
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-foreground">{title}</h2>
              <p className="truncate text-[11px] text-muted-foreground">{canteenName}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <UnitSwitcher />
            <NotificationBell />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleSignOut}
              aria-label="Sign out"
              className="h-9 gap-1.5 px-2 sm:px-3"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </header>
        <main className="min-w-0 max-w-full overflow-x-hidden p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
