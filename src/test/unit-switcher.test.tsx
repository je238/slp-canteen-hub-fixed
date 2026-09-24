import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UnitSwitcher from "@/components/UnitSwitcher";

const mocks = vi.hoisted(() => ({
  selected: "all",
  setSelected: vi.fn(),
  rank: 60,
  primary: null as string | null,
  sites: [] as string[],
  canteens: [
    { id: "unit-1", name: "Unit 1" },
    { id: "unit-2", name: "Unit 2" },
    { id: "unit-3", name: "Unit 3" },
  ],
}));

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ selectedCanteen: mocks.selected, setSelectedCanteen: mocks.setSelected }),
}));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    rank: mocks.rank,
    roleData: { canteen_id: mocks.primary, sites: mocks.sites },
    canAccessCanteen: (id: string) => id === mocks.primary || mocks.sites.includes(id),
  }),
}));
vi.mock("@/hooks/useSupabaseData", () => ({
  useCanteens: () => ({ data: mocks.canteens, isLoading: false }),
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: any) => (
    <select aria-label="Unit select karein" value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
}));

afterEach(cleanup);
beforeEach(() => {
  mocks.selected = "all";
  mocks.rank = 60;
  mocks.primary = null;
  mocks.sites = [];
  mocks.setSelected.mockReset();
});

describe("global unit switcher", () => {
  it("shows the combined choice and all three units to an admin", () => {
    render(<UnitSwitcher />);
    const select = screen.getByRole("combobox", { name: "Unit select karein" });
    expect(screen.getByRole("option", { name: "All 3 Units" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(4);
    fireEvent.change(select, { target: { value: "unit-2" } });
    expect(mocks.setSelected).toHaveBeenCalledWith("unit-2");
  });

  it("locks a single-unit user to their assigned unit", async () => {
    mocks.rank = 40;
    mocks.primary = "unit-2";
    render(<UnitSwitcher />);
    expect(screen.queryByRole("option", { name: /All/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Unit 2" })).toBeInTheDocument();
    await waitFor(() => expect(mocks.setSelected).toHaveBeenCalledWith("unit-2"));
  });
});
