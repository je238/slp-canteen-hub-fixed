import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import InventoryPage from "@/pages/InventoryPage";

const auth = vi.hoisted(() => ({ isOwner: false, roleData: { role: "store_keeper" } }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => auth }));
vi.mock("@/contexts/AppContext", () => ({ useAppContext: () => ({ selectedCanteen: "site-1" }) }));
vi.mock("@/components/AppLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/DailyRegister", () => ({ default: () => null }));
vi.mock("@/components/DuplicateItems", () => ({ default: () => null }));
vi.mock("@/components/DeliverySchedule", () => ({ default: () => null }));
vi.mock("@/components/HistoricalUnitReview", () => ({ default: () => null }));
vi.mock("@/components/IngredientLedgerDialog", () => ({ default: () => null }));
vi.mock("@/hooks/useSupabaseData", () => ({
  useIngredients: () => ({ data: [{ id: "i1", name: "Oil", category: "Oils", unit: "litre", current_stock: 10, cost_per_unit: 100 }] }),
  useAddIngredient: () => ({}),
}));
vi.mock("@/hooks/useSrsData", () => ({
  useIngredientRates: () => ({ data: [] }), useSaveInventoryItemEdit: () => ({}), useDeleteIngredient: () => ({}),
}));
afterEach(cleanup);
describe("manual inventory edit permission", () => {
  it("does not offer Edit to Store Keeper", () => {
    auth.isOwner = false; auth.roleData.role = "store_keeper";
    render(<InventoryPage />);
    expect(screen.queryByRole("columnheader", { name: /^Edit$/ })).not.toBeInTheDocument();
    expect(screen.getByText("Manual stock edit sirf Admin / Owner kar sakte hain")).toBeInTheDocument();
    expect(screen.getByText("Oil")).toBeInTheDocument();
  });
  it("keeps Edit available to Admin", () => {
    auth.isOwner = true; auth.roleData.role = "admin";
    render(<InventoryPage />);
    expect(screen.getByRole("columnheader", { name: /^Edit$/ })).toBeInTheDocument();
  });
});
