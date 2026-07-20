// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { deriveFeeBreakdown, gstRateFor, PLATFORM_FEE_PAISE } from './fees.js';

describe('deriveFeeBreakdown — backend payment math', () => {
  it('uses a flat ₹3 (300 paise) platform fee', () => {
    expect(PLATFORM_FEE_PAISE).toBe(300);
  });

  it('reverses out a roughly-correct subtotal/fee/taxes from a tax-inclusive total', () => {
    // Inverse math is approximate (rounding can drift slightly from the
    // forward-computed numbers the frontend showed). The forward breakdown
    // is preferred — clients pass it via createPaymentSchema.pricing and the
    // server stores it directly. The inverse path here only runs as a
    // legacy fallback for clients that don't send pricing. We assert the
    // structural contract (parts sum to total, flat fee) but not exact
    // values. Forward total for ₹1,000 subtotal: 100000 + 300 +
    // round((100300) × 0.12 = 12036) = 112336.
    const r = deriveFeeBreakdown({
      totalPaise: 112336,
      insurancePremiumPaise: 0,
      category: 'hotel',
      nightlyPaise: 1000_00,
    });
    expect(r.totalPaise).toBe(112336);
    expect(r.gstRate).toBe(0.12);
    expect(r.platformFeePaise).toBe(PLATFORM_FEE_PAISE);
    expect(
      r.subtotalPaise + r.platformFeePaise + r.taxesPaise + r.insurancePremiumPaise,
    ).toBe(r.totalPaise);
    // Sanity: the recovered subtotal is within 1% of the forward subtotal.
    expect(Math.abs(r.subtotalPaise - 1000_00)).toBeLessThan(1000_00 * 0.01);
  });

  it('parts always sum to total exactly (rounding absorbed in tax line)', () => {
    // Pick a total that doesn't divide cleanly to verify the residual approach.
    const r = deriveFeeBreakdown({
      totalPaise: 99_999,
      insurancePremiumPaise: 200,
      category: 'hotel',
      nightlyPaise: 5000_00,
    });
    expect(
      r.subtotalPaise + r.platformFeePaise + r.taxesPaise + r.insurancePremiumPaise,
    ).toBe(99_999);
  });

  it('transport uses 5% GST', () => {
    expect(gstRateFor('driver-cab')).toBe(0.05);
    expect(gstRateFor('auto')).toBe(0.05);
  });

  it('premium stays (>₹7,500/night) jump to 18%', () => {
    expect(gstRateFor('hotel', 8_000_00)).toBe(0.18);
    expect(gstRateFor('hotel', 7_500_00)).toBe(0.12);
  });

  it('every STAY_CATEGORIES entry gets the 12% stay rate — sathram included', () => {
    // 'sathram' has no 'stay' substring; before it was listed explicitly the
    // raw category (mobile/assistant bookings) fell to the 18% services rate
    // while web's 'stay:sathram' got 12% — and the invoice classifier
    // (classifyGst, which DOES know sathram) disagreed with the charge.
    for (const cat of ['hotel', 'homestay', 'lodge', 'village-stay', 'farm-stay', 'heritage', 'sathram', 'stay']) {
      expect(gstRateFor(cat, 2_000_00)).toBe(0.12);
    }
    expect(gstRateFor('stay:sathram', 2_000_00)).toBe(0.12);
  });
});
