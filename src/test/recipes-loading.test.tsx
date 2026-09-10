import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecipesPage from "@/pages/RecipesPage";

const mocks = vi.hoisted(() => ({ recipes: vi.fn(), refetch: vi.fn() }));
vi.mock("@/components/AppLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/contexts/AppContext", () => ({ useAppContext: () => ({ selectedCanteen: "site-1" }) }));
vi.mock("@/hooks/useSupabaseData", () => ({ useRecipes: mocks.recipes, useIngredients: () => ({ data: [] }) }));
vi.mock("@/hooks/useSrsData", () => ({ useSaveDishRecipe: () => ({ isPending: false }) }));

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe("Chef recipe list", () => {
  it("shows a loading failure and retry instead of claiming there are zero recipes", () => {
    mocks.recipes.mockReturnValue({ isError: true, isLoading: false, refetch: mocks.refetch });
    render(<RecipesPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("Recipes load nahi ho paayi");
    expect(screen.queryByText("0 recipes")).not.toBeInTheDocument();
    expect(screen.queryByText("Abhi koi recipe nahi mili")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dobara load karo" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it("finds a saved Samosa with lowercase search and renders its quantities", () => {
    mocks.recipes.mockReturnValue({ data: [{ id: "r1", name: "Samosa", yield_qty: 100,
      recipe_ingredients: [{ id: "line1", ingredient_id: "i1", quantity: 5, unit: "kg", ingredients: { name: "Maida", unit: "kg" } }],
    }], isLoading: false, isError: false });
    render(<RecipesPage />);
    fireEvent.change(screen.getByPlaceholderText("Recipe search karo…"), { target: { value: "samosa" } });
    expect(screen.getByText("1 recipes")).toBeInTheDocument();
    expect(screen.getByText("Samosa")).toBeInTheDocument();
    expect(screen.getByText("Maida")).toBeInTheDocument();
    expect(screen.getByText("5 kg")).toBeInTheDocument();
  });
});
