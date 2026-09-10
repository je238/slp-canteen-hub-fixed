import { describe, expect, it, vi } from "vitest";
import { useRecipes } from "@/hooks/useSupabaseData";

const mocks = vi.hoisted(() => ({ useQuery: vi.fn(), from: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery, useMutation: vi.fn(), useQueryClient: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: mocks.from } }));

describe("recipe relationship query", () => {
  it("uses the parent FK, preserves site filtering and propagates API failures", async () => {
    const response = { data: null, error: { code: "PGRST201", message: "Ambiguous relationship" } };
    const eq = vi.fn().mockResolvedValue(response);
    const order = vi.fn().mockReturnValue({ eq });
    const select = vi.fn().mockReturnValue({ order });
    mocks.from.mockReturnValue({ select });
    useRecipes("site-1");
    const options = mocks.useQuery.mock.calls.at(-1)![0];
    await expect(options.queryFn()).rejects.toEqual(response.error);
    expect(select).toHaveBeenCalledWith("*, recipe_ingredients!recipe_ingredients_recipe_id_fkey(*, ingredients(name, unit))");
    expect(eq).toHaveBeenCalledWith("canteen_id", "site-1");
  });
});
