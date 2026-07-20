import { describe, expect, it } from "vitest";
import {
  computeStayBreakdownPaise,
  foldAvailabilityOverrides,
  formatNightlyRowLabel,
} from "./stay-pricing";

const rupee = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

describe("computeStayBreakdownPaise — base nights", () => {
  it("matches the simple stay path when no overrides apply", () => {
    // ₹2,000/night × 2 nights → subtotal 400000 paise. Flat platform fee
    // = 300 paise (₹3). GST at 12% on (400000 + 300) = round(48036) = 48036.
    // Total = 400000 + 300 + 48036 = 448336 paise.
    const r = computeStayBreakdownPaise({
      nightlyRateRupees: 2000,
      nights: 2,
      checkIn: "2026-05-21",
    });
    expect(r.subtotalPaise).toBe(400000);
    expect(r.platformFeePaise).toBe(300);
    expect(r.taxesPaise).toBe(48036);
    expect(r.totalPaise).toBe(448336);
    expect(r.gstRate).toBe(0.12);
    expect(r.nightLineItems).toHaveLength(2);
    expect(r.nightLineItems.every((it) => !it.custom)).toBe(true);
  });
});

describe("computeStayBreakdownPaise — overrides + host discount", () => {
  it("applies the host discount factor to override nights too", () => {
    // Base ₹2000/night, host discount 10% → effective ₹1800/night.
    // Two-night range with an override of ₹3000 on the SECOND night (paise
    // form 300000). The override is a LIST price; the discount factor must
    // still apply, just like the server's subtotalForStayPaise does.
    // Expected per-night paise:
    //   night 1 → round(200000 × 0.9) = 180000
    //   night 2 → round(300000 × 0.9) = 270000
    //   subtotal = 450000
    const overrides = new Map<string, number>([["2026-05-22", 300000]]);
    const r = computeStayBreakdownPaise({
      nightlyRateRupees: 2000,
      nights: 2,
      hostDiscountPercent: 10,
      checkIn: "2026-05-21",
      nightlyPaiseByDate: overrides,
    });
    expect(r.nightLineItems).toEqual([
      { date: "2026-05-21", paise: 180000, listPaise: 200000, custom: false },
      { date: "2026-05-22", paise: 270000, listPaise: 300000, custom: true },
    ]);
    expect(r.subtotalPaise).toBe(450000);
  });

  it("matches the backend two-step semantics — applies discount once across all nights", () => {
    // Single-night override under 20% host discount.
    // listPaise 500000, factor 0.8 → 400000.
    const r = computeStayBreakdownPaise({
      nightlyRateRupees: 5000,
      nights: 1,
      hostDiscountPercent: 20,
      checkIn: "2026-05-21",
      nightlyPaiseByDate: new Map([["2026-05-21", 500000]]),
    });
    expect(r.nightLineItems[0]).toEqual({
      date: "2026-05-21",
      paise: 400000,
      listPaise: 500000,
      custom: true,
    });
  });
});

describe("foldAvailabilityOverrides — listing-level blocks are global", () => {
  it("keeps listing-level blocked date blocked even when a room has a non-block price row for the same date", () => {
    // The host took the property offline on May 21 (listing-level block).
    // A room-specific price override on the same date should NOT make the
    // room bookable — backend check_availability treats listing blocks as
    // global. The price entry should also not appear in the priceByDate map
    // because the date isn't bookable.
    const rows = [
      { roomTypeId: null, date: "2026-05-21", blocked: true, pricePaise: null },
      { roomTypeId: "rt-deluxe", date: "2026-05-21", blocked: false, pricePaise: 600000 },
    ];
    const { blockedSet, priceByDate } = foldAvailabilityOverrides(rows, "rt-deluxe");
    expect(blockedSet.has("2026-05-21")).toBe(true);
    expect(priceByDate.has("2026-05-21")).toBe(false);
  });

  it("room-specific price beats listing-level price when there's no listing-level block", () => {
    const rows = [
      { roomTypeId: null, date: "2026-05-21", blocked: false, pricePaise: 500000 },
      { roomTypeId: "rt-deluxe", date: "2026-05-21", blocked: false, pricePaise: 700000 },
    ];
    const { priceByDate, blockedSet } = foldAvailabilityOverrides(rows, "rt-deluxe");
    expect(priceByDate.get("2026-05-21")).toBe(700000);
    expect(blockedSet.size).toBe(0);
  });

  it("room-specific block trumps listing-level price override", () => {
    const rows = [
      { roomTypeId: null, date: "2026-05-21", blocked: false, pricePaise: 500000 },
      { roomTypeId: "rt-deluxe", date: "2026-05-21", blocked: true, pricePaise: null },
    ];
    const { blockedSet, priceByDate } = foldAvailabilityOverrides(rows, "rt-deluxe");
    expect(blockedSet.has("2026-05-21")).toBe(true);
    expect(priceByDate.has("2026-05-21")).toBe(false);
  });
});

describe("foldAvailabilityOverrides — room beats listing", () => {
  it("room-specific override wins over listing-level override on the same date", () => {
    const rows = [
      { roomTypeId: null, date: "2026-05-21", blocked: false, pricePaise: 500000 },
      { roomTypeId: "rt-deluxe", date: "2026-05-21", blocked: false, pricePaise: 700000 },
    ];
    const { priceByDate, blockedSet } = foldAvailabilityOverrides(rows, "rt-deluxe");
    expect(priceByDate.get("2026-05-21")).toBe(700000);
    expect(blockedSet.size).toBe(0);
  });

  it("room-specific block overrides listing-level price override", () => {
    const rows = [
      { roomTypeId: null, date: "2026-05-21", blocked: false, pricePaise: 500000 },
      { roomTypeId: "rt-deluxe", date: "2026-05-21", blocked: true, pricePaise: null },
    ];
    const { priceByDate, blockedSet } = foldAvailabilityOverrides(rows, "rt-deluxe");
    expect(blockedSet.has("2026-05-21")).toBe(true);
    expect(priceByDate.has("2026-05-21")).toBe(false);
  });

  it("listing-level rows apply to every room when no room is selected", () => {
    const rows = [
      { roomTypeId: null, date: "2026-05-21", blocked: false, pricePaise: 500000 },
      { roomTypeId: "rt-deluxe", date: "2026-05-21", blocked: false, pricePaise: 700000 },
    ];
    // No room selected → only listing-level row applies; the room-specific
    // row is invisible to this view.
    const { priceByDate } = foldAvailabilityOverrides(rows, null);
    expect(priceByDate.get("2026-05-21")).toBe(500000);
  });
});

describe("computeStayBreakdownPaise — GST parity with backend at the hotel room threshold", () => {
  // Companion test to server/src/modules/payments/pricing/booking-price.test.ts
  // ("hotel deluxe at ₹8,500/night → 18% GST"). Both helpers MUST agree on the
  // GST rate selected by per-room nightly when the listing-level rate is null,
  // otherwise createHold's ±₹2 drift guard rejects the booking. If this test
  // and the server one drift apart, the two pricing paths are out of sync.
  it("uses 18% GST when the selected room is above ₹7,500/night", () => {
    const r = computeStayBreakdownPaise({
      nightlyRateRupees: 8500,
      nights: 1,
      checkIn: "2026-05-21",
    });
    expect(r.gstRate).toBe(0.18);
    expect(r.subtotalPaise).toBe(850_000);
    // Flat ₹3 platform fee. GST 18% on (850000 + 300) = round(153054) = 153054.
    expect(r.platformFeePaise).toBe(300);
    expect(r.taxesPaise).toBe(153_054);
    expect(r.totalPaise).toBe(850_000 + 300 + 153_054);
  });

  it("uses 12% GST when the selected room is at/under ₹7,500/night", () => {
    const r = computeStayBreakdownPaise({
      nightlyRateRupees: 7500,
      nights: 1,
      checkIn: "2026-05-21",
    });
    expect(r.gstRate).toBe(0.12);
  });
});

describe("computeStayBreakdownPaise — total accounting", () => {
  it("totalPaise equals discountedSubtotal + platformFee + taxes (no insurance)", () => {
    const r = computeStayBreakdownPaise({
      nightlyRateRupees: 3000,
      nights: 3,
      checkIn: "2026-05-21",
      nightlyPaiseByDate: new Map([["2026-05-22", 500000]]),
    });
    expect(r.totalPaise).toBe(r.discountedSubtotalPaise + r.platformFeePaise + r.taxesPaise);
  });
});

describe("formatNightlyRowLabel — collapsed row label matches charged amount", () => {
  it("renders the bare rate × nights when there is no host discount", () => {
    expect(formatNightlyRowLabel({
      baseNightlyRupees: 4800,
      nights: 2,
      hostDiscountPercent: 0,
      formatRupees: rupee,
    })).toBe("₹4,800 × 2 nights");
  });

  it("uses singular 'night' for a single-night stay", () => {
    expect(formatNightlyRowLabel({
      baseNightlyRupees: 4800,
      nights: 1,
      formatRupees: rupee,
    })).toBe("₹4,800 × 1 night");
  });

  it("shows the discounted nightly with a 'P% off (was ₹original)' suffix when a host discount is set", () => {
    // 10% off ₹4,800 = ₹4,320 effective. Label uses the effective rate so it
    // can't disagree with the row amount the breakdown rendered.
    expect(formatNightlyRowLabel({
      baseNightlyRupees: 4800,
      nights: 2,
      hostDiscountPercent: 10,
      formatRupees: rupee,
    })).toBe("₹4,320 × 2 nights · 10% off (was ₹4,800)");
  });

  it("label's effective rate × nights agrees with the breakdown subtotal to within ₹1 of rounding noise", () => {
    // The breakdown rounds per-night at paise precision while the label
    // rounds to whole rupees for readability. Sub-paise drift can be a few
    // paise per night — well inside the ±₹2 createHold drift tolerance —
    // but the label and the row amount the user reads MUST stay within ₹1
    // of each other at every nights × rate combo, otherwise the row reads
    // as inconsistent.
    for (const [rate, pct, nights] of [
      [4800, 10, 2],    // round numbers, exact match
      [4799, 15, 3],    // paise drift case
      [8500, 22, 4],    // luxury room above 7500 threshold
      [1234, 33, 1],    // small/odd value
    ] as const) {
      const r = computeStayBreakdownPaise({
        nightlyRateRupees: rate,
        nights,
        hostDiscountPercent: pct,
        checkIn: "2026-05-21",
      });
      const label = formatNightlyRowLabel({
        baseNightlyRupees: rate,
        nights,
        hostDiscountPercent: pct,
        formatRupees: rupee,
      });
      const match = label.match(/^₹([\d,]+) × \d+/);
      expect(match).not.toBeNull();
      const labelEffective = Number((match as RegExpMatchArray)[1].replace(/,/g, ""));
      const subtotalRupees = Math.round(r.subtotalPaise / 100);
      expect(Math.abs(labelEffective * nights - subtotalRupees)).toBeLessThanOrEqual(1);
    }
  });

  it("falls back to the simple form when the nightly rate is zero", () => {
    expect(formatNightlyRowLabel({
      baseNightlyRupees: 0,
      nights: 2,
      hostDiscountPercent: 25,
      formatRupees: rupee,
    })).toBe("₹0 × 2 nights");
  });
});
