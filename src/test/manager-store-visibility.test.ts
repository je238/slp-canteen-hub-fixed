import { describe, expect, it } from "vitest";
import { canOpen, navFor } from "@/lib/navigation";

describe("manager store visibility", () => {
  it.each(["unit_manager", "manager", "ops_manager"])(
    "lets %s view purchases, inventory and vendors",
    (role) => {
      const paths = navFor(role).map((entry) => entry.path);

      expect(paths).toEqual(expect.arrayContaining([
        "/purchases",
        "/inventory",
        "/vendors",
      ]));
      expect(canOpen("/purchases", role)).toBe(true);
      expect(canOpen("/inventory", role)).toBe(true);
      expect(canOpen("/vendors", role)).toBe(true);
    },
  );
});
