import React, { createContext, useCallback, useContext, useState } from "react";

interface AppContextType {
  selectedCanteen: string;
  setSelectedCanteen: (id: string) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);
const SELECTED_UNIT_KEY = "slp-selected-unit-v1";

function readSelectedUnit() {
  if (typeof window === "undefined") return "all";
  try {
    return window.localStorage.getItem(SELECTED_UNIT_KEY) || "all";
  } catch {
    return "all";
  }
}

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [selectedCanteen, setSelectedCanteenState] = useState(readSelectedUnit);
  const setSelectedCanteen = useCallback((id: string) => {
    setSelectedCanteenState(id);
    try {
      window.localStorage.setItem(SELECTED_UNIT_KEY, id);
    } catch {
      // Browsers can disable storage; the current session still keeps working.
    }
  }, []);
  // Open on a desktop, where it is a fixed column and the page is inset to
  // make room for it. Closed on a phone, where it is an overlay 256px wide
  // across a 390px screen — starting it open put it, and its z-50, on top of
  // whatever the person had come to do. A dialog would open behind it with
  // its left side swallowed: the dish-name box was there all along, under the
  // sidebar, which is why it could neither be read nor typed into.
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 1024);

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
