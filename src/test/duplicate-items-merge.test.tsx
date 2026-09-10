import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DuplicateItems from "@/components/DuplicateItems";

const mergeAsync = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ isOwner: true, roleData: { role: "admin" } }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => auth }));
vi.mock("@/hooks/useSrsData", () => ({
  useSimilarIngredients: () => ({ data: [{
    a_id: "pumpkin-a", a_name: "Pumpkin", a_stock: 20,
    b_id: "pumpkin-b", b_name: "Pumpkin m.", b_stock: 5,
  }] }),
  useMergeIngredients: () => ({ mutateAsync: mergeAsync }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  mergeAsync.mockReset();
  auth.isOwner = true;
  auth.roleData.role = "admin";
});

describe("duplicate item merge choice", () => {
  it("lets the assigned Store Keeper see merge choices", () => {
    auth.isOwner = false;
    auth.roleData.role = "store_keeper";

    render(<DuplicateItems canteenId="site-1" />);

    expect(screen.getByRole("button", { name: "Merge into Pumpkin" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge into Pumpkin m." })).toBeInTheDocument();
  });

  it("does not offer item merging to the Chef", () => {
    auth.isOwner = false;
    auth.roleData.role = "chef";

    render(<DuplicateItems canteenId="site-1" />);

    expect(screen.queryByText(/pair of items look like/i)).not.toBeInTheDocument();
  });

  it("shows a clear destination and requires confirmation before merge", async () => {
    mergeAsync.mockResolvedValue({ new_balance: 25, ledger_rows: 2, bill_lines: 1 });
    render(<DuplicateItems canteenId="site-1" />);

    const mergeButton = screen.getByRole("button", { name: "Merge into Pumpkin" });
    fireEvent.click(mergeButton);
    expect(mergeAsync).not.toHaveBeenCalled();

    expect(screen.getByRole("heading", { name: "Items merge karein?" })).toBeInTheDocument();
    expect(screen.getByText("Stock: 20 + 5 =")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Yes, merge into Pumpkin" }));
    await waitFor(() => expect(mergeAsync).toHaveBeenCalledWith({
      from: "pumpkin-b", into: "pumpkin-a",
    }));
  });

  it("can keep the second name as the final item", async () => {
    mergeAsync.mockResolvedValue({ new_balance: 25, ledger_rows: 0, bill_lines: 0 });
    render(<DuplicateItems canteenId="site-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Merge into Pumpkin m." }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, merge into Pumpkin m." }));

    await waitFor(() => expect(mergeAsync).toHaveBeenCalledWith({
      from: "pumpkin-a", into: "pumpkin-b",
    }));
  });
});
