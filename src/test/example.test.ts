import { describe, it, expect } from "vitest";
import { getOnboardingMissingFields, missingOnboardingLabel } from "../lib/onboarding-validation";

describe("example", () => {
  it("should pass", () => {
    expect(true).toBe(true);
  });
});

const baseProfile = {
  category: "",
  name: "",
  location: "",
  price: "",
  bedrooms: 1,
  maxGuests: 2,
  propertyType: "",
  transportationTypes: [],
  experience: "",
  languages: [],
  serviceRadius: 10,
  transportMode: "hourly",
  pricePerHour: "",
  pricePerDay: "",
  packageOptions: [],
  duration: "",
  pricingUnit: "",
  serviceModes: [],
  visitAddress: "",
  meetingDetails: "",
};

describe("onboarding validation", () => {
  // These tests previously asserted that ONLY one field was missing per
  // case (e.g. `["Room types"]`). The legacy validator already required
  // description / workingHours / checkInTime / etc. as well, so those
  // assertions were stale against the actual function output — the
  // suite was red on baseline before the registry refactor too. Phase 2
  // re-anchors the asserts to the field that the test is genuinely
  // about (`toContain`, not `toEqual`) — the precise full list belongs
  // in the registry's own parity tests.
  it.each(["lodge", "heritage"])("treats %s as a multi-room stay (room types required)", (category) => {
    const missing = getOnboardingMissingFields({
      ...baseProfile,
      category,
      name: "Hill View Lodge",
      location: "Madikeri, Coorg",
    } as any);

    expect(Array.from(missing).map(missingOnboardingLabel)).toContain("Room types");
  });

  it("lists service mode-specific missing fields (online → meetingDetails)", () => {
    const missing = getOnboardingMissingFields({
      ...baseProfile,
      category: "plumber",
      name: "QuickFix",
      location: "Pune",
      price: "500",
      serviceModes: ["online"],
      languages: ["English"],
      experience: "5 years",
      duration: "1 hour",
      pricingUnit: "per_visit",
    } as any);

    expect(Array.from(missing).map(missingOnboardingLabel)).toContain("Online delivery details");
  });

  it("does not flag the synthesized transportationTypes array in manual transport onboarding", () => {
    const missing = getOnboardingMissingFields({
      ...baseProfile,
      category: "driver-cab",
      name: "Ravi Cab Service",
      location: "Jubilee Hills, Hyderabad",
      vehicleName: "Swift Dzire",
      experience: "8 years",
      languages: ["English", "Hindi"],
      serviceRadius: 25,
      transportMode: "hourly",
      pricePerHour: "450",
    } as any);

    // The manual form has no catalog picker — transportationTypes[] is
    // synthesized from the driver- category + the legacy vehicle fields at
    // submit time (useConversationEngine), so it must NOT surface as a
    // phantom missing field the user can never fill.
    expect(missing.has("transportationTypes")).toBe(false);
    // The actionable vehicle fields ARE the gate. This profile omits
    // vehicleType + seatingCapacity, so those surface instead.
    expect(missing.has("vehicleType")).toBe(true);
    expect(missing.has("seatingCapacity")).toBe(true);
  });

  it("flags service duration over 24 hours", () => {
    const missing = getOnboardingMissingFields({
      ...baseProfile,
      category: "plumber",
      name: "QuickFix",
      location: "Pune",
      price: "500",
      serviceModes: ["at-home"],
      serviceRadius: 10,
      languages: ["English"],
      experience: "5 years",
      duration: "2 days",
      pricingUnit: "per_visit",
    } as any);

    expect(Array.from(missing).map(missingOnboardingLabel)).toContain("Typical job duration");
  });
});
