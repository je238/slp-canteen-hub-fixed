import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";

// A manager was now and then shown the vendor screen: one failed role read
// fell through to the lowest role. These tests fail the read on purpose.
const session = { user: { id: "u-manager" }, access_token: "t" };
let roleReads: Array<{ data: any; error: any }> = [];

vi.mock("@/lib/pushNotifications", () => ({ syncExistingPush: async () => {}, disablePush: async () => {} }));
vi.mock("@/lib/draft", () => ({ clearAllDrafts: async () => {} }));
vi.mock("@/integrations/supabase/client", () => {
  const query = (table: string) => {
    const chain: any = {
      select: () => chain, eq: () => chain,
      limit: async () => (table === "user_roles" ? roleReads.shift() ?? { data: null, error: { message: "offline" } } : { data: [], error: null }),
      then: (resolve: any) => resolve({ data: [], error: null }),   // user_sites
    };
    return chain;
  };
  return {
    supabase: {
      from: (table: string) => query(table),
      auth: {
        getSession: async () => ({ data: { session } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      },
    },
  };
});

function Show() {
  const { roleData, loading, roleError } = useAuth();
  return <p>{loading ? "loading" : roleError ? "role-error" : roleData.role}</p>;
}

beforeEach(() => { localStorage.clear(); vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("role loading", () => {
  it("retries a failed read instead of showing the vendor screen", async () => {
    roleReads = [
      { data: null, error: { message: "network" } }, { data: null, error: { message: "network" } },   // full + legacy fail
      { data: [{ role: "manager", canteen_id: "eicher" }], error: null },
    ];
    render(<AuthProvider><Show /></AuthProvider>);
    await waitFor(() => expect(screen.getByText("manager")).toBeInTheDocument(), { timeout: 4000 });
  });

  it("keeps the role this device last saw when every read fails", async () => {
    localStorage.setItem("slp-role:u-manager", JSON.stringify({ role: "store_keeper", canteen_id: "eicher", supplier_id: null, sites: [] }));
    roleReads = [];
    render(<AuthProvider><Show /></AuthProvider>);
    await waitFor(() => expect(screen.getByText("store_keeper")).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 3200));
    expect(screen.queryByText("vendor")).not.toBeInTheDocument();
  });

  it("says it could not load rather than guessing a role", async () => {
    roleReads = [];
    render(<AuthProvider><Show /></AuthProvider>);
    await waitFor(() => expect(screen.getByText("role-error")).toBeInTheDocument(), { timeout: 5000 });
  });
});
