import { describe, expect, it } from "vitest";
import { requisitionMenuDishes } from "@/lib/requisitionMenu";

describe("requisition menu dishes", () => {
  it("shows the linked menu dishes without blanks or duplicate names", () => {
    expect(requisitionMenuDishes({
      menu_plan_items: [
        { dish_name: " Poha " },
        { dish_name: "Chutney" },
        { dish_name: "Poha" },
        { dish_name: "" },
      ],
    })).toEqual(["Poha", "Chutney"]);
  });

  it("returns an empty list when the requisition has no readable menu dishes", () => {
    expect(requisitionMenuDishes(null)).toEqual([]);
    expect(requisitionMenuDishes({ menu_plan_items: [] })).toEqual([]);
  });
});
