import { describe, it, expect } from "vitest";
import { placeParts, placeLine } from "./marketplace-adapters";

/**
 * `location` is the server's public label (area/city/state — WS6 geo privacy)
 * and `district` defaults to the CITY, so the two-slot "{{location}},
 * {{district}}" templates would otherwise render a trailing duplicate.
 */
describe("placeParts / placeLine", () => {
  it("drops the duplicate city from a City, State label (the original bug)", () => {
    expect(placeParts("Mumbai, Maharashtra", "Mumbai")).toEqual({ location: "Mumbai", district: "Maharashtra" });
    expect(placeLine("Mumbai, Maharashtra", "Mumbai")).toBe("Mumbai, Maharashtra");
  });

  it("keeps all three parts when the label carries an area", () => {
    // The prefix-strip this replaced failed here — "Kukatpally, …" does not
    // start with "Hyderabad", so the district was appended and the city
    // rendered twice.
    expect(placeParts("Kukatpally, Hyderabad, Telangana", "Hyderabad")).toEqual({
      location: "Kukatpally",
      district: "Hyderabad, Telangana",
    });
    expect(placeLine("Kukatpally, Hyderabad, Telangana", "Hyderabad")).toBe("Kukatpally, Hyderabad, Telangana");
  });

  it("collapses an exact location == district match to one part", () => {
    expect(placeParts("Hyderabad", "Hyderabad")).toEqual({ location: "Hyderabad", district: "" });
    expect(placeLine("Hyderabad", "Hyderabad")).toBe("Hyderabad");
  });

  it("dedups case-insensitively", () => {
    expect(placeLine("Kukatpally, Hyderabad, Telangana", "hyderabad")).toBe("Kukatpally, Hyderabad, Telangana");
  });

  it("leaves non-overlapping inputs alone", () => {
    expect(placeParts("Panaji", "Goa")).toEqual({ location: "Panaji", district: "Goa" });
    expect(placeLine("Panaji", "Goa")).toBe("Panaji, Goa");
  });

  it("handles empty / null inputs", () => {
    expect(placeParts(null, null)).toEqual({ location: "", district: "" });
    expect(placeLine(null, null)).toBe("");
    expect(placeLine("Kochi", null)).toBe("Kochi");
    expect(placeLine(null, "Kerala")).toBe("Kerala");
    expect(placeLine("  ,  ", "Kerala")).toBe("Kerala");
  });

  it("dedups the raw street address a booked guest sees (geo_exact path)", () => {
    // markGeoExact keeps the raw `location`, which ends in the city — so the
    // city would otherwise be repeated by the district slot.
    expect(placeLine("Tank Bund Rd, Khairtabad, Hyderabad", "Hyderabad")).toBe("Tank Bund Rd, Khairtabad, Hyderabad");
  });
});
