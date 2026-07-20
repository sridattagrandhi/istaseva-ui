// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  computePlatformFeePaise,
  feeVerticalFor,
  LEGACY_PLATFORM_FEE_SPEC,
} from '../pricing/fees.js';
import { applyFees } from '../pricing/booking-price.js';
import { pickWinningRule, specFromRule } from './fee-rules.service.js';
import type { FeeRuleRow } from '../repositories/fee-rules.repository.js';

function rule(overrides: Partial<FeeRuleRow>): FeeRuleRow {
  return {
    id: overrides.id ?? 'rule-x',
    audience: 'customer',
    category: null,
    subcategory: null,
    scope_type: 'global',
    scope_state: null,
    scope_city: null,
    scope_tier: null,
    scope_listing_id: null,
    percent_bps: 0,
    fixed_paise: 300,
    min_fee_paise: null,
    max_fee_paise: null,
    effective_from: '2026-01-01T00:00:00.000Z',
    effective_to: null,
    active: true,
    reason: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    deactivated_at: null,
    deactivated_by: null,
    ...overrides,
  };
}

describe('computePlatformFeePaise', () => {
  it('legacy spec reproduces the flat ₹3 fee at any subtotal', () => {
    expect(computePlatformFeePaise(0, LEGACY_PLATFORM_FEE_SPEC)).toBe(300);
    expect(computePlatformFeePaise(100, LEGACY_PLATFORM_FEE_SPEC)).toBe(300);
    expect(computePlatformFeePaise(1_000_000, LEGACY_PLATFORM_FEE_SPEC)).toBe(300);
  });

  it('percent + fixed compose (2% + ₹5 on ₹1,000 → ₹25)', () => {
    expect(
      computePlatformFeePaise(100_000, { percentBps: 200, fixedPaise: 500 })
    ).toBe(2_500);
  });

  it('applies the min cap (floor)', () => {
    expect(
      computePlatformFeePaise(100, { percentBps: 100, fixedPaise: 0, minFeePaise: 300 })
    ).toBe(300);
  });

  it('applies the max cap (ceiling)', () => {
    expect(
      computePlatformFeePaise(10_000_000, { percentBps: 500, fixedPaise: 0, maxFeePaise: 9_900 })
    ).toBe(9_900);
  });

  it('rounds the percent component to the nearest paise', () => {
    // 1.5% of 333 paise = 4.995 → 5
    expect(computePlatformFeePaise(333, { percentBps: 150, fixedPaise: 0 })).toBe(5);
  });

  it('never returns a negative fee and ignores bad inputs', () => {
    expect(computePlatformFeePaise(-500, { percentBps: 100, fixedPaise: 0 })).toBe(0);
    expect(computePlatformFeePaise(NaN, { percentBps: NaN, fixedPaise: NaN })).toBe(0);
  });
});

describe('feeVerticalFor mirrors gstRateFor category buckets', () => {
  it('transport categories', () => {
    for (const cat of ['cab', 'auto', 'bike', 'tempo', 'driver-cab', 'driver-quote', 'van']) {
      expect(feeVerticalFor(cat)).toBe('transport');
    }
  });
  it('stay categories', () => {
    for (const cat of ['hotel', 'homestay', 'lodge', 'farmstay', 'heritage']) {
      expect(feeVerticalFor(cat)).toBe('stays');
    }
  });
  it('everything else is services', () => {
    for (const cat of ['salon', 'cleaning', 'plumber', '', null, undefined]) {
      expect(feeVerticalFor(cat as string | null | undefined)).toBe('services');
    }
  });
});

describe('pickWinningRule precedence', () => {
  it('returns null with no candidates', () => {
    expect(pickWinningRule([])).toBeNull();
  });

  it('listing beats city beats tier beats state beats global', () => {
    const global = rule({ id: 'global', scope_type: 'global' });
    const state = rule({ id: 'state', scope_type: 'state', scope_state: 'Rajasthan' });
    const tier = rule({ id: 'tier', scope_type: 'city_tier', scope_tier: 'tier2' });
    const city = rule({ id: 'city', scope_type: 'city', scope_city: 'Jaipur', scope_state: 'Rajasthan' });
    const listing = rule({ id: 'listing', scope_type: 'listing', scope_listing_id: 'l1', reason: 'deal' });

    expect(pickWinningRule([global, state])?.id).toBe('state');
    expect(pickWinningRule([global, state, tier])?.id).toBe('tier');
    expect(pickWinningRule([tier, city, global])?.id).toBe('city');
    expect(pickWinningRule([city, listing, state, global, tier])?.id).toBe('listing');
  });

  it('category-specific beats category-NULL at the same scope level', () => {
    const allCats = rule({ id: 'all', scope_type: 'state', scope_state: 'Goa' });
    const staysOnly = rule({ id: 'stays', scope_type: 'state', scope_state: 'Goa', category: 'stays' });
    expect(pickWinningRule([allCats, staysOnly])?.id).toBe('stays');
    // ...but a MORE SPECIFIC scope still beats a category match one level down.
    const cityAllCats = rule({ id: 'city-all', scope_type: 'city', scope_city: 'Panaji', scope_state: 'Goa' });
    expect(pickWinningRule([staysOnly, cityAllCats])?.id).toBe('city-all');
  });

  it('subcategory-specific beats vertical-specific beats all at the same scope level', () => {
    const allCats = rule({ id: 'all', scope_type: 'state', scope_state: 'Goa' });
    const vertical = rule({ id: 'vertical', scope_type: 'state', scope_state: 'Goa', category: 'services' });
    const subcat = rule({ id: 'subcat', scope_type: 'state', scope_state: 'Goa', category: 'services', subcategory: 'salon' });
    expect(pickWinningRule([allCats, vertical, subcat])?.id).toBe('subcat');
    expect(pickWinningRule([subcat, allCats])?.id).toBe('subcat');
    // Scope level still dominates: a city all-categories rule beats a
    // state-level subcategory rule.
    const cityAll = rule({ id: 'city-all', scope_type: 'city', scope_city: 'Panaji', scope_state: 'Goa' });
    expect(pickWinningRule([subcat, cityAll])?.id).toBe('city-all');
  });

  it('newer effective_from wins remaining ties', () => {
    const older = rule({ id: 'older', effective_from: '2026-01-01T00:00:00.000Z' });
    const newer = rule({ id: 'newer', effective_from: '2026-06-01T00:00:00.000Z' });
    expect(pickWinningRule([older, newer])?.id).toBe('newer');
  });
});

describe('applyFees with a resolved spec', () => {
  it('omitting the spec is byte-identical to the legacy flat fee', () => {
    const legacy = applyFees({ subtotalPaise: 250_000, category: 'hotel' });
    const explicit = applyFees({
      subtotalPaise: 250_000,
      category: 'hotel',
      fee: LEGACY_PLATFORM_FEE_SPEC,
    });
    expect(explicit).toEqual(legacy);
    expect(legacy.platformFeePaise).toBe(300);
  });

  it('percent fee is computed on the DISCOUNTED subtotal', () => {
    // ₹1,000 subtotal, ₹200 coupon → 5% fee on ₹800 = ₹40; GST 18% on ₹840.
    const breakdown = applyFees({
      subtotalPaise: 100_000,
      discountPaise: 20_000,
      category: 'salon',
      fee: { percentBps: 500, fixedPaise: 0 },
    });
    expect(breakdown.platformFeePaise).toBe(4_000);
    expect(breakdown.taxesPaise).toBe(Math.round((80_000 + 4_000) * 0.18));
    expect(breakdown.totalPaise).toBe(80_000 + 4_000 + breakdown.taxesPaise);
  });

  it('spec from a DB row (string-ish numerics) computes correctly', () => {
    const spec = specFromRule(
      rule({ percent_bps: 250, fixed_paise: 1_000, min_fee_paise: null, max_fee_paise: 5_000 })
    );
    // 2.5% of ₹500 (=₹12.50) + ₹10 = ₹22.50 → 2250 paise, under the ₹50 cap.
    expect(computePlatformFeePaise(50_000, spec)).toBe(2_250);
    expect(spec.ruleId).toBe('rule-x');
  });
});
