import { describe, expect, it } from "vitest";
import { canOpen, navFor } from "@/lib/navigation";

describe("store visibility after HS split", () => {
  it.each(["ops_manager", "admin", "super_admin", "owner"])(
    "lets senior read-only role %s view purchases, inventory and vendors",
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

  it.each(["unit_manager", "manager", "head_supervisor"])(
    "keeps operational store screens away from %s",
    (role) => {
      expect(canOpen("/purchases", role)).toBe(false);
      expect(canOpen("/inventory", role)).toBe(false);
      expect(canOpen("/vendors", role)).toBe(false);
    },
  );
});
