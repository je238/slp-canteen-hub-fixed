import React, { createContext, useContext, useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";

interface AppContextType {
  selectedCanteen: string;
  setSelectedCanteen: (id: string) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { roleData } = useAuth();
  const [selectedCanteen, setSelectedCanteen] = useState("all");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Auto-select canteen for managers and cashiers (they only have one)
  useEffect(() => {
    if (roleData?.canteen_id && roleData.role !== "owner") {
      setSelectedCanteen(roleData.canteen_id);
    }
  }, [roleData]);

  return (
    <AppContext.Provider value={{ selectedCanteen, setSelectedCanteen, sidebarOpen, setSidebarOpen }}>
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext must be used within AppProvider");
  return ctx;
};

