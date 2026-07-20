// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveBookingStatus } from "./booking-status";

// A same-day transport booking: 2026-06-15, 14:00–17:00 IST.
//   start = 2026-06-15T14:00 IST = 2026-06-15T08:30:00Z
//   end   = 2026-06-15T17:00 IST = 2026-06-15T11:30:00Z
const BOOKING = { status: "confirmed", scheduledDate: "2026-06-15", startTime: "14:00", endTime: "17:00" };

// Pin "now" to an absolute UTC instant so the result is deterministic on any
// CI timezone. The boundaries below are derived from the IST (+05:30) offset —
// if the parse ever reverts to device-local, these instants shift and the
// timezone tests fail on a non-IST runner, which is exactly the regression we
// want to catch.
const at = (utc: string) => vi.setSystemTime(new Date(utc));

afterEach(() => vi.useRealTimers());
beforeEach(() => vi.useFakeTimers());

describe("effectiveBookingStatus — passthrough", () => {
  it("returns terminal/explicit statuses unchanged", () => {
    for (const s of ["cancelled", "expired", "pending", "in_progress", "completed"]) {
      expect(effectiveBookingStatus({ ...BOOKING, status: s })).toBe(s);
    }
  });
  it("defaults empty status to confirmed", () => {
    expect(effectiveBookingStatus({ status: "" })).toBe("confirmed");
  });
  it("returns confirmed unchanged when no scheduledDate", () => {
    expect(effectiveBookingStatus({ status: "confirmed" })).toBe("confirmed");
  });
  it("passes through unknown statuses", () => {
    expect(effectiveBookingStatus({ ...BOOKING, status: "refunded" })).toBe("refunded");
  });
});

describe("effectiveBookingStatus — IST-anchored transitions", () => {
  it("before the IST start window → confirmed (upcoming)", () => {
    at("2026-06-15T08:00:00Z"); // 13:30 IST, before 14:00
    expect(effectiveBookingStatus(BOOKING)).toBe("confirmed");
  });
  it("inside the IST window → in_progress", () => {
    at("2026-06-15T09:00:00Z"); // 14:30 IST, between 14:00–17:00
    expect(effectiveBookingStatus(BOOKING)).toBe("in_progress");
  });
  it("after the IST end → completed", () => {
    at("2026-06-15T12:00:00Z"); // 17:30 IST, past 17:00
    expect(effectiveBookingStatus(BOOKING)).toBe("completed");
  });

  it("is timezone-independent: a UTC-noon 'now' that's still pre-start in IST stays confirmed", () => {
    // 2026-06-15T08:15:00Z = 13:45 IST — still before the 14:00 IST start.
    // If parsing were device-local on a UTC machine, start would be 14:00Z and
    // this would (wrongly) also be confirmed; the discriminating case is below.
    at("2026-06-15T08:15:00Z");
    expect(effectiveBookingStatus(BOOKING)).toBe("confirmed");
    // 08:45Z = 14:15 IST → in_progress. On a UTC-local parse, start would be
    // 14:00Z so 08:45Z would still read "confirmed" — this asserts IST.
    at("2026-06-15T08:45:00Z");
    expect(effectiveBookingStatus(BOOKING)).toBe("in_progress");
  });
});

describe("effectiveBookingStatus — stays (check-out from notes)", () => {
  const STAY = {
    status: "confirmed",
    scheduledDate: "2026-06-15",
    startTime: "14:00", // check-in
    endTime: "11:00",   // check-out time
    notes: JSON.stringify({ checkOut: "2026-06-17" }),
  };
  it("mid-stay → in_progress", () => {
    at("2026-06-16T06:00:00Z"); // 11:30 IST on the 16th, well within the stay
    expect(effectiveBookingStatus(STAY)).toBe("in_progress");
  });
  it("after check-out (IST) → completed", () => {
    // check-out = 2026-06-17T11:00 IST = 2026-06-17T05:30:00Z
    at("2026-06-17T06:00:00Z");
    expect(effectiveBookingStatus(STAY)).toBe("completed");
  });
  it("just before check-out (IST) → still in_progress", () => {
    at("2026-06-17T05:00:00Z"); // 10:30 IST, before the 11:00 IST checkout
    expect(effectiveBookingStatus(STAY)).toBe("in_progress");
  });
});

describe("effectiveBookingStatus — guards", () => {
  it("falls back to the stored status when the date is unparseable", () => {
    at("2026-06-15T09:00:00Z");
    expect(effectiveBookingStatus({ status: "confirmed", scheduledDate: "not-a-date" })).toBe("confirmed");
  });
});
