import { describe, expect, it } from "vitest";
import {
  computeBookingFees,
  computePlatformFeePaise,
  gstRateFor,
  formatINR,
  LEGACY_PLATFORM_FEE_SPEC,
  PLATFORM_FEE_RUPEES,
  insurancePremiumRupees,
  INSURANCE_MIN_RUPEES,
  INSURANCE_MAX_RUPEES,
} from "./pricing";

describe("frontend pricing — matches backend deriveFeeBreakdown", () => {
  it("uses a flat ₹3 platform fee", () => {
    expect(PLATFORM_FEE_RUPEES).toBe(3);
  });

  it("classifies stay GST as 12% under ₹7,500/night", () => {
    expect(gstRateFor("hotel", 5_000_00)).toBe(0.12);
    expect(gstRateFor("homestay", 7_500_00)).toBe(0.12);
  });

  it("treats every STAY_CATEGORIES entry as a stay — sathram included", () => {
    // 'sathram' has no 'stay' substring, so it once fell through to the 18%
    // services rate on mobile/assistant (raw category) while web sent
    // 'stay:sathram' and got 12% — same listing, different price per client.
    expect(gstRateFor("sathram", 2_000_00)).toBe(0.12);
    expect(gstRateFor("stay:sathram", 2_000_00)).toBe(0.12);
    expect(gstRateFor("village-stay", 2_000_00)).toBe(0.12);
    expect(gstRateFor("farm-stay", 2_000_00)).toBe(0.12);
  });

  it("classifies stay GST as 18% above ₹7,500/night", () => {
    expect(gstRateFor("hotel", 10_000_00)).toBe(0.18);
  });

  it("classifies transport GST as 5%", () => {
    expect(gstRateFor("driver-cab")).toBe(0.05);
    expect(gstRateFor("driver-quote")).toBe(0.05);
    expect(gstRateFor("auto")).toBe(0.05);
  });

  it("falls through to 18% support-services for everything else", () => {
    expect(gstRateFor("cleaning")).toBe(0.18);
    expect(gstRateFor(null)).toBe(0.18);
  });
});

describe("computeBookingFees — hotel", () => {
  it("matches the backend math for a typical stay", () => {
    // Subtotal ₹1,000 (host portion) → flat ₹3 fee → GST 12% on ₹1,003 =
    // ₹120.36 (paise-exact, like the server) → total ₹1,123.36.
    const r = computeBookingFees({
      subtotal: 1000,
      category: "hotel",
      nightlyPaise: 1000_00,
    });
    expect(r.subtotal).toBe(1000);
    expect(r.platformFee).toBe(3);
    expect(r.taxes).toBe(120.36); // (1000+3) × 0.12, rounded to the paisa
    expect(r.total).toBe(1123.36);
    expect(r.gstRate).toBe(0.12);
  });

  it("adds insurance as a passthrough on top of the breakdown", () => {
    const r = computeBookingFees({
      subtotal: 1000,
      category: "hotel",
      nightlyPaise: 1000_00,
      insurance: 20,
    });
    expect(r.insurance).toBe(20);
    expect(r.total).toBe(1123.36 + 20);
  });

  it("applies the discount to the subtotal only, not platform fee or GST", () => {
    const r = computeBookingFees({
      subtotal: 1000,
      category: "hotel",
      nightlyPaise: 1000_00,
      discount: 200,
    });
    expect(r.discount).toBe(200);
    expect(r.subtotal).toBe(800); // post-discount
    expect(r.platformFee).toBe(3);
    expect(r.taxes).toBe(96.36); // (800+3) × 0.12, rounded to the paisa
    expect(r.total).toBe(899.36);
  });

  it("uses 18% GST for premium stays (>₹7,500/night)", () => {
    const r = computeBookingFees({
      subtotal: 10000,
      category: "hotel",
      nightlyPaise: 10000_00,
    });
    expect(r.gstRate).toBe(0.18);
    expect(r.platformFee).toBe(3);
    expect(r.taxes).toBe(1800.54); // (10000+3) × 0.18, rounded to the paisa
    expect(r.total).toBe(11803.54);
  });
});

describe("computeBookingFees — transport / service categories", () => {
  it("transport uses 5% GST", () => {
    const r = computeBookingFees({ subtotal: 750, category: "driver-cab" });
    expect(r.gstRate).toBe(0.05);
    expect(r.platformFee).toBe(3);
    expect(r.taxes).toBe(37.65); // (750+3) × 0.05, rounded to the paisa
    expect(r.total).toBe(790.65);
  });

  it("service falls back to 18% GST", () => {
    const r = computeBookingFees({ subtotal: 2000, category: "cleaning" });
    expect(r.gstRate).toBe(0.18);
    expect(r.platformFee).toBe(3);
    expect(r.taxes).toBe(360.54); // (2000+3) × 0.18, rounded to the paisa
    expect(r.total).toBe(2363.54);
  });
});

describe("formatINR — Indian-style customer-facing format", () => {
  it("drops trailing zeros on whole rupees", () => {
    expect(formatINR(9000)).toBe("₹9,000");
    expect(formatINR(1620)).toBe("₹1,620");
    expect(formatINR(10620)).toBe("₹10,620");
  });

  it("uses Indian digit grouping", () => {
    expect(formatINR(125000)).toBe("₹1,25,000");
  });

  it("keeps two decimals when paise are present", () => {
    expect(formatINR(1234.5)).toBe("₹1,234.50");
  });

  it("renders zero / null / NaN as ₹0", () => {
    expect(formatINR(0)).toBe("₹0");
    expect(formatINR(null)).toBe("₹0");
    expect(formatINR(undefined)).toBe("₹0");
    expect(formatINR(Number.NaN)).toBe("₹0");
  });
});

describe("insurancePremiumRupees — flat ₹2 regardless of cart size", () => {
  it("returns ₹2 for mid-range bookings", () => {
    expect(insurancePremiumRupees(1000)).toBe(2);
    expect(insurancePremiumRupees(1500)).toBe(2);
  });

  it("returns ₹2 for tiny bookings", () => {
    expect(insurancePremiumRupees(50)).toBe(INSURANCE_MIN_RUPEES);
    expect(insurancePremiumRupees(0)).toBe(INSURANCE_MIN_RUPEES);
  });

  it("returns ₹2 for luxury bookings (no ceiling escalation)", () => {
    expect(insurancePremiumRupees(50_000)).toBe(INSURANCE_MAX_RUPEES);
    expect(insurancePremiumRupees(1_00_000)).toBe(INSURANCE_MAX_RUPEES);
  });

  it("returns ₹2 even on non-finite input", () => {
    expect(insurancePremiumRupees(Number.NaN)).toBe(INSURANCE_MIN_RUPEES);
  });
});

// Add-ons are summed into the subtotal BEFORE the platform fee + GST are
// applied — same contract as the backend's `subtotalForServicePaise` helper
// (server/src/modules/payments/pricing/booking-price.ts). The booking modal
// pre-sums them and passes the combined `subtotal` to computeBookingFees, so
// this test validates the parity by emulating that pre-sum.
describe("computeBookingFees — service with add-ons", () => {
  it("haircut ₹200 + beard trim ₹100 + shaving ₹80 totals correctly", () => {
    const base = 200;
    const addOns = 100 + 80;
    const r = computeBookingFees({
      subtotal: base + addOns,
      category: "salon",
    });
    // 380 + flat ₹3 fee → GST 18% on (380 + 3) = 68.94 (paise-exact) →
    // total 380 + 3 + 68.94 = 451.94
    expect(r.subtotal).toBe(380);
    expect(r.platformFee).toBe(3);
    expect(r.taxes).toBe(68.94); // (380+3) × 0.18, rounded to the paisa
    expect(r.total).toBe(451.94);
  });

  it("base-only equals service charge alone (no add-ons regression)", () => {
    const r = computeBookingFees({ subtotal: 200, category: "salon" });
    expect(r.subtotal).toBe(200);
    expect(r.platformFee).toBe(3);
    expect(r.taxes).toBe(36.54); // (200+3) × 0.18, rounded to the paisa
    expect(r.total).toBe(239.54);
  });
});

// Admin fee-rules: the RULE-DRIVEN spec path. This mirror of the server's
// computePlatformFeePaise (server/src/modules/payments/pricing/fees.ts) must
// produce identical numbers — the expected values below are hand-computed
// from the shared formula:
//   fee = clamp(round(subtotal × percentBps / 10000) + fixedPaise, min, max)
describe("computePlatformFeePaise — rule-driven fee specs", () => {
  it("legacy fallback spec reproduces the flat ₹3", () => {
    expect(computePlatformFeePaise(100_000, LEGACY_PLATFORM_FEE_SPEC)).toBe(300);
    expect(computePlatformFeePaise(0, LEGACY_PLATFORM_FEE_SPEC)).toBe(300);
  });

  it("percent + fixed: 2.5% + ₹10 on ₹1,000", () => {
    // round(100000 × 250 / 10000) + 1000 = 2500 + 1000 = 3500 paise
    expect(computePlatformFeePaise(100_000, { percentBps: 250, fixedPaise: 1000 })).toBe(3500);
  });

  it("bps rounding is to the nearest paisa", () => {
    // 999 × 33 / 10000 = 3.2967 → 3 paise
    expect(computePlatformFeePaise(999, { percentBps: 33, fixedPaise: 0 })).toBe(3);
    // 1515 × 33 / 10000 = 4.9995 → 5 paise
    expect(computePlatformFeePaise(1515, { percentBps: 33, fixedPaise: 0 })).toBe(5);
  });

  it("min/max caps clamp the computed fee", () => {
    const spec = { percentBps: 100, fixedPaise: 0, minFeePaise: 500, maxFeePaise: 2000 };
    expect(computePlatformFeePaise(10_000, spec)).toBe(500); // 1% = 100 → floor 500
    expect(computePlatformFeePaise(100_000, spec)).toBe(1000); // 1% = 1000, inside caps
    expect(computePlatformFeePaise(500_000, spec)).toBe(2000); // 1% = 5000 → cap 2000
  });

  it("defensive clamps: negative inputs and >100% bps never produce a bad fee", () => {
    expect(computePlatformFeePaise(-5_000, { percentBps: 250, fixedPaise: 100 })).toBe(100);
    // bps capped at 10000 (100%)
    expect(computePlatformFeePaise(10_000, { percentBps: 25_000, fixedPaise: 0 })).toBe(10_000);
  });

  it("computeBookingFees applies the spec to the DISCOUNTED subtotal", () => {
    // ₹1,000 service, ₹200 coupon → discounted ₹800. 2% + ₹5 spec:
    // fee = round(80000 × 200/10000) + 500 = 1600 + 500 = 2100 paise = ₹21.
    // GST 18% on (800 + 21) = 147.78 → total 800 + 21 + 147.78 = 968.78.
    const r = computeBookingFees({
      subtotal: 1000,
      category: "cleaning",
      discount: 200,
      feeSpec: { percentBps: 200, fixedPaise: 500 },
    });
    expect(r.platformFee).toBe(21);
    expect(r.taxes).toBe(147.78);
    expect(r.total).toBe(968.78);
  });
});
