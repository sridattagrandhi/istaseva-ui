import { describe, expect, it } from "vitest";
import { bookingKindOf } from "./booking-kind";

// The classifier must handle BOTH stored category formats: web's booking
// modals write "stay:<type>", mobile (and the assistant) write the bare
// property type. Keep in lock-step with mobile's kindOf
// (mobile/src/design/api/bookings.ts) — the two share no code.
describe("bookingKindOf", () => {
  it("classifies web-format stay categories (stay:-prefixed)", () => {
    for (const t of ["stay:hotel", "stay:homestay", "stay:lodge", "stay:village-stay", "stay:farm-stay", "stay:heritage", "stay:sathram", "stay"]) {
      expect(bookingKindOf(t)).toBe("stay");
    }
  });

  it("classifies mobile-format stay categories (bare property type)", () => {
    for (const t of ["hotel", "homestay", "lodge", "village-stay", "farm-stay", "heritage", "sathram"]) {
      expect(bookingKindOf(t)).toBe("stay");
    }
  });

  it("classifies transport categories, including legacy bare ones", () => {
    for (const t of ["driver-hourly", "driver-day", "driver-package", "driver-cab", "driver-quote", "cab", "auto", "van"]) {
      expect(bookingKindOf(t)).toBe("transport");
    }
  });

  it("everything else is a service", () => {
    for (const t of ["plumber", "electrician", "cleaning", "mehendi", "priest", ""]) {
      expect(bookingKindOf(t)).toBe("service");
    }
    expect(bookingKindOf(null)).toBe("service");
    expect(bookingKindOf(undefined)).toBe("service");
  });

  it("is case-insensitive", () => {
    expect(bookingKindOf("Stay:Hotel")).toBe("stay");
    expect(bookingKindOf("HOMESTAY")).toBe("stay");
    expect(bookingKindOf("Driver-Day")).toBe("transport");
  });
});
