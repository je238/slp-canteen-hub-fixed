import React from "react";
import AppSidebar, { MobileMenuButton } from "@/components/AppSidebar";
import { useAppContext } from "@/contexts/AppContext";
import { useCanteens } from "@/hooks/useSupabaseData";
import { Bell } from "lucide-react";

interface AppLayoutProps {
  children: React.ReactNode;
  title: string;
}

export default function AppLayout({ children, title }: AppLayoutProps) {
  const { selectedCanteen } = useAppContext();
  const { data: canteens } = useCanteens();
  const canteenName = selectedCanteen === "all" ? "All Canteens" : canteens?.find((c: any) => c.id === selectedCanteen)?.name || "";

  return (
    <div className="min-h-screen bg-background">
      <AppSidebar />
      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 bg-card/80 backdrop-blur-sm border-b px-4 lg:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <MobileMenuButton />
            <div>
              <h2 className="text-base font-semibold text-foreground">{title}</h2>
              <p className="text-[11px] text-muted-foreground">{canteenName}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button className="relative p-2 rounded-md hover:bg-secondary">
              <Bell className="w-4 h-4 text-muted-foreground" />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-destructive" />
            </button>
          </div>
        </header>
        <main className="p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
