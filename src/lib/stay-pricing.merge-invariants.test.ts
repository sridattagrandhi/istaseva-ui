import { describe, expect, it } from "vitest";
import { foldAvailabilityOverrides } from "./stay-pricing";

/**
 * Pins the invariants the guest BookingModal + host AvailabilityCalendar
 * now both delegate to `foldAvailabilityOverrides`. The earlier ad-hoc
 * merges in those components let a room-level price row "win" over a
 * listing-level block — surfacing the date as bookable in the UI while
 * the backend `createHold` would later reject it. These tests guard
 * against a regression to that behavior.
 */
describe("foldAvailabilityOverrides invariants (UI parity)", () => {
  it("listing-level block CANNOT be undone by a room-level non-block row", () => {
    const rows = [
      { roomTypeId: null, date: "2026-06-01", blocked: true, pricePaise: null },
      { roomTypeId: "rt-1", date: "2026-06-01", blocked: false, pricePaise: 99900 },
    ];
    const { blockedSet, priceByDate } = foldAvailabilityOverrides(rows, "rt-1");
    expect(blockedSet.has("2026-06-01")).toBe(true);
    // No price surfaces — the date isn't bookable.
    expect(priceByDate.has("2026-06-01")).toBe(false);
  });

  it("room-level price overrides listing-level price only when not listing-blocked", () => {
    const rows = [
      { roomTypeId: null, date: "2026-06-02", blocked: false, pricePaise: 500000 },
      { roomTypeId: "rt-1", date: "2026-06-02", blocked: false, pricePaise: 750000 },
    ];
    const { blockedSet, priceByDate } = foldAvailabilityOverrides(rows, "rt-1");
    expect(blockedSet.has("2026-06-02")).toBe(false);
    expect(priceByDate.get("2026-06-02")).toBe(750000);
  });

  it("a room-level block ADDS a block on top of an otherwise-bookable date", () => {
    const rows = [
      { roomTypeId: "rt-1", date: "2026-06-03", blocked: true, pricePaise: null },
    ];
    const { blockedSet } = foldAvailabilityOverrides(rows, "rt-1");
    expect(blockedSet.has("2026-06-03")).toBe(true);
  });

  it("other rooms' overrides do not bleed into this room's view", () => {
    const rows = [
      { roomTypeId: "rt-OTHER", date: "2026-06-04", blocked: true, pricePaise: null },
      { roomTypeId: "rt-OTHER", date: "2026-06-05", blocked: false, pricePaise: 999900 },
    ];
    const { blockedSet, priceByDate } = foldAvailabilityOverrides(rows, "rt-1");
    expect(blockedSet.size).toBe(0);
    expect(priceByDate.size).toBe(0);
  });

  it("listing-wide tab (selectedRoomId=null) only surfaces listing-level rows", () => {
    const rows = [
      { roomTypeId: null, date: "2026-06-06", blocked: true, pricePaise: null },
      { roomTypeId: "rt-1", date: "2026-06-06", blocked: false, pricePaise: 100000 },
      { roomTypeId: "rt-1", date: "2026-06-07", blocked: false, pricePaise: 100000 },
    ];
    const { blockedSet, priceByDate } = foldAvailabilityOverrides(rows, null);
    expect(blockedSet.has("2026-06-06")).toBe(true);
    expect(priceByDate.has("2026-06-07")).toBe(false);
  });
});
