// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  applyFees,
  applyFeesAndCoupon,
  subtotalForServicePaise,
  subtotalForStayPaise,
  subtotalForTransportDayPaise,
  subtotalForTransportHourlyPaise,
  subtotalForTransportPackagePaise,
  subtotalForTransportPrebookPaise,
  subtotalForTransportQuotePaise,
  resolveServiceAddOns,
} from './booking-price.js';

import { gstRateFor } from './fees.js';

describe('applyFees — forward platform-fee + GST math', () => {
  it('hotel (12% GST): subtotal 1000 → flat fee 3 → taxes 120.36 → total 1123.36', () => {
    const r = applyFees({ subtotalPaise: 100_000, category: 'hotel', nightlyHintPaise: 100_000 });
    expect(r.subtotalPaise).toBe(100_000);
    expect(r.discountPaise).toBe(0);
    expect(r.discountedSubtotalPaise).toBe(100_000);
    expect(r.platformFeePaise).toBe(300);
    expect(r.taxesPaise).toBe(12_036); // round((100000+300) × 0.12)
    expect(r.gstRate).toBe(0.12);
    expect(r.totalPaise).toBe(112_336);
  });

  it('premium hotel (>₹7,500/night) jumps to 18% GST', () => {
    const r = applyFees({ subtotalPaise: 1_000_000, category: 'hotel', nightlyHintPaise: 1_000_000 });
    expect(r.gstRate).toBe(0.18);
    expect(r.platformFeePaise).toBe(300);
    expect(r.taxesPaise).toBe(180_054); // round((1000000+300) × 0.18)
    expect(r.totalPaise).toBe(1_180_354);
  });

  it('transport (5% GST): subtotal 750 → flat fee 3 → taxes 37.65 → total 790.65', () => {
    const r = applyFees({ subtotalPaise: 75_000, category: 'driver-cab' });
    expect(r.gstRate).toBe(0.05);
    expect(r.platformFeePaise).toBe(300);
    expect(r.taxesPaise).toBe(3765); // round((75000+300) × 0.05)
    expect(r.totalPaise).toBe(79_065);
  });

  it('service (18% GST default): subtotal 2000 → flat fee 3 → taxes 360.54 → total 2363.54', () => {
    const r = applyFees({ subtotalPaise: 200_000, category: 'cleaning' });
    expect(r.gstRate).toBe(0.18);
    expect(r.platformFeePaise).toBe(300);
    expect(r.taxesPaise).toBe(36_054); // round((200000+300) × 0.18)
    expect(r.totalPaise).toBe(236_354);
  });

  it('parts always sum exactly to total', () => {
    for (const sub of [100, 1_234, 99_999, 1_000_000, 7_654_321]) {
      const r = applyFees({ subtotalPaise: sub, category: 'hotel', nightlyHintPaise: 100_000 });
      expect(
        r.discountedSubtotalPaise + r.platformFeePaise + r.taxesPaise,
      ).toBe(r.totalPaise);
    }
  });

  it('discount is clamped to subtotal — never goes negative', () => {
    const r = applyFees({ subtotalPaise: 100_000, discountPaise: 999_999, category: 'hotel' });
    expect(r.discountPaise).toBe(100_000);
    expect(r.discountedSubtotalPaise).toBe(1); // ≥1 paise floor
  });

  it('discount of 0 = standard math', () => {
    const a = applyFees({ subtotalPaise: 100_000, category: 'hotel' });
    const b = applyFees({ subtotalPaise: 100_000, discountPaise: 0, category: 'hotel' });
    expect(a).toEqual(b);
  });
});

describe('applyFeesAndCoupon — derives discount from coupon spec', () => {
  it('percent coupon — 20% off', () => {
    const r = applyFeesAndCoupon({
      subtotalPaise: 100_000,
      category: 'hotel',
      coupon: { discountType: 'percent', discountValue: 20 },
    });
    expect(r.discountPaise).toBe(20_000);
    expect(r.discountedSubtotalPaise).toBe(80_000);
    expect(r.platformFeePaise).toBe(300);
    expect(r.taxesPaise).toBe(9_636); // round((80000+300) * 0.12)
    expect(r.totalPaise).toBe(89_936);
  });

  it('fixed coupon — ₹100 off', () => {
    const r = applyFeesAndCoupon({
      subtotalPaise: 100_000,
      category: 'hotel',
      coupon: { discountType: 'fixed', discountValue: 100 },
    });
    expect(r.discountPaise).toBe(10_000);
    expect(r.discountedSubtotalPaise).toBe(90_000);
  });

  it('no coupon = applyFees with discountPaise=0', () => {
    const a = applyFeesAndCoupon({ subtotalPaise: 100_000, category: 'hotel' });
    const b = applyFees({ subtotalPaise: 100_000, category: 'hotel' });
    expect(a).toEqual(b);
  });
});

describe('subtotal helpers', () => {
  it('stay: sums nights with optional host discount', () => {
    expect(subtotalForStayPaise({ nightlyPaiseList: [100_000, 100_000, 100_000] })).toBe(300_000);
    // 10% host discount per night
    expect(subtotalForStayPaise({ nightlyPaiseList: [100_000, 100_000], hostDiscountPercent: 10 })).toBe(180_000);
  });

  it('service: round(price × duration × 100)', () => {
    expect(subtotalForServicePaise({ priceRupees: 500 })).toBe(50_000);
    expect(subtotalForServicePaise({ priceRupees: 500, durationHours: 3 })).toBe(150_000);
    expect(subtotalForServicePaise({ priceRupees: '750.50' })).toBe(75_050);
    expect(subtotalForServicePaise({ priceRupees: null })).toBe(0);
  });

  it('transport prebook: perKm × distance, rupees → paise', () => {
    expect(subtotalForTransportPrebookPaise({ perKmRupees: 14, estimatedKm: 20 })).toBe(28_000);
    expect(subtotalForTransportPrebookPaise({ perKmRupees: '12', estimatedKm: 5 })).toBe(6_000);
    expect(subtotalForTransportPrebookPaise({ perKmRupees: null, estimatedKm: null })).toBe(0);
  });

  it('transport quote: passthrough', () => {
    expect(subtotalForTransportQuotePaise({ providerQuotePaise: 75_000 })).toBe(75_000);
    expect(subtotalForTransportQuotePaise({ providerQuotePaise: 0 })).toBe(0);
    expect(subtotalForTransportQuotePaise({ providerQuotePaise: null })).toBe(0);
  });

  it('transport hourly: rate × hours (rupees → paise)', () => {
    expect(subtotalForTransportHourlyPaise({ pricePerHourRupees: 350, durationHours: 4 })).toBe(140_000);
    // string rupee input (chat-extracted metadata) tolerated
    expect(subtotalForTransportHourlyPaise({ pricePerHourRupees: '300', durationHours: 2 })).toBe(60_000);
    // zero / nullish inputs return 0 (caller upgrades to ValidationError)
    expect(subtotalForTransportHourlyPaise({ pricePerHourRupees: 0, durationHours: 4 })).toBe(0);
    expect(subtotalForTransportHourlyPaise({ pricePerHourRupees: 350, durationHours: 0 })).toBe(0);
    expect(subtotalForTransportHourlyPaise({ pricePerHourRupees: null, durationHours: null })).toBe(0);
  });

  it('transport day: rate × days (rupees → paise)', () => {
    expect(subtotalForTransportDayPaise({ pricePerDayRupees: 4500, days: 1 })).toBe(450_000);
    expect(subtotalForTransportDayPaise({ pricePerDayRupees: 4500, days: 3 })).toBe(1_350_000);
    expect(subtotalForTransportDayPaise({ pricePerDayRupees: '4500', days: 1 })).toBe(450_000);
    expect(subtotalForTransportDayPaise({ pricePerDayRupees: 0, days: 1 })).toBe(0);
    expect(subtotalForTransportDayPaise({ pricePerDayRupees: 4500, days: 0 })).toBe(0);
    expect(subtotalForTransportDayPaise({ pricePerDayRupees: null, days: null })).toBe(0);
  });

  it('transport package: lookup-by-id, returns matched price in paise', () => {
    const opts = [
      { id: 'goa-1d', label: 'Goa Day Tour', price: 3500, hours: 8 },
      { id: 'temple', label: 'Temple loop', price: 1500, hours: 4 },
    ];
    expect(subtotalForTransportPackagePaise({ packageOptions: opts, packageId: 'goa-1d' })).toBe(350_000);
    expect(subtotalForTransportPackagePaise({ packageOptions: opts, packageId: 'temple' })).toBe(150_000);
    // case-sensitive id match
    expect(subtotalForTransportPackagePaise({ packageOptions: opts, packageId: 'Goa-1d' })).toBe(0);
    // missing / unknown id → 0 (caller upgrades to ValidationError)
    expect(subtotalForTransportPackagePaise({ packageOptions: opts, packageId: 'unknown' })).toBe(0);
    expect(subtotalForTransportPackagePaise({ packageOptions: opts, packageId: '' })).toBe(0);
    expect(subtotalForTransportPackagePaise({ packageOptions: opts, packageId: null })).toBe(0);
    // empty / non-array options → 0
    expect(subtotalForTransportPackagePaise({ packageOptions: [], packageId: 'goa-1d' })).toBe(0);
    expect(subtotalForTransportPackagePaise({ packageOptions: null, packageId: 'goa-1d' })).toBe(0);
    expect(subtotalForTransportPackagePaise({ packageOptions: 'not an array', packageId: 'goa-1d' })).toBe(0);
    // matched entry with invalid price → 0
    expect(subtotalForTransportPackagePaise({
      packageOptions: [{ id: 'free', label: 'Free', price: 0, hours: 1 }],
      packageId: 'free',
    })).toBe(0);
  });

  it('transport package: id-less rows resolve via the canonical positional "pkg-<i>" id', () => {
    // AI-onboarded listings save packageOptions WITHOUT ids; every reader
    // (get_listing_details, matchPackageId, web/mobile adapters) synthesizes
    // pkg-<index> for them — the matcher must accept it or these rows are
    // unbookable ("that package isn't available anymore").
    const idless = [
      { label: 'Hyderabad Sightseeing Package', price: 3060, hours: 10 },
      { label: 'Charminar Night Loop', price: 1800, hours: 4 },
    ];
    expect(subtotalForTransportPackagePaise({ packageOptions: idless, packageId: 'pkg-0' })).toBe(306_000);
    expect(subtotalForTransportPackagePaise({ packageOptions: idless, packageId: 'pkg-1' })).toBe(180_000);
    // out-of-range positional → 0
    expect(subtotalForTransportPackagePaise({ packageOptions: idless, packageId: 'pkg-2' })).toBe(0);
    // a row carrying its OWN id is never positionally re-mapped: pkg-0 must
    // not silently select a different package than the one the user was shown
    const withIds = [{ id: 'goa-1d', label: 'Goa Day Tour', price: 3500 }];
    expect(subtotalForTransportPackagePaise({ packageOptions: withIds, packageId: 'pkg-0' })).toBe(0);
    // ...and exact ids still win over the positional interpretation
    const pkgIds = [{ id: 'pkg-1', label: 'First (id pkg-1)', price: 1000 }];
    expect(subtotalForTransportPackagePaise({ packageOptions: pkgIds, packageId: 'pkg-1' })).toBe(100_000);
  });
});

describe('GST routing for new transport modes', () => {
  // The existing /^driver-/ regex in fees.ts:gstRateFor already matches the
  // three new categories; this test pins that behavior so a future refactor
  // can't silently bump the rate.
  it('returns 5% (passenger transport HSN 9964) for driver-hourly / driver-day / driver-package', () => {
    expect(gstRateFor('driver-hourly')).toBe(0.05);
    expect(gstRateFor('driver-day')).toBe(0.05);
    expect(gstRateFor('driver-package')).toBe(0.05);
  });
});

describe('hotel room-type GST hint — frontend and server must agree', () => {
  // Regression: hotels store the nightly on `room_types.base_price_paise`,
  // not `listings.price_per_night` (which is NULL for hotel rows). If
  // createHold uses the listing's NULL price as the GST hint, it falls
  // through to 12% while the frontend preview (which sees the selected
  // room's per-night) computes 18%. The ±₹2 drift guard then rejects an
  // otherwise-legit ₹8,500/night Deluxe booking. The fix is to pass the
  // room's base_price_paise as `nightlyHintPaise` whenever a roomTypeId is
  // present, which is what createHold now does — this test pins the math.
  it('hotel deluxe at ₹8,500/night → 18% GST when room paise is passed as hint', () => {
    const roomBasePricePaise = 850_000;       // ₹8,500/night > ₹7,500 threshold
    const oneNightSubtotalPaise = roomBasePricePaise;
    const r = applyFees({
      subtotalPaise: oneNightSubtotalPaise,
      category: 'hotel',
      nightlyHintPaise: roomBasePricePaise,
    });
    expect(r.gstRate).toBe(0.18);
    // Flat ₹3 platform fee. Taxes 18% of (₹8,500 + ₹3) = round(153054).
    expect(r.platformFeePaise).toBe(300);
    expect(r.taxesPaise).toBe(153_054);
    expect(r.totalPaise).toBe(roomBasePricePaise + 300 + 153_054);
  });

  it('still uses 12% when the room paise sits at/under the ₹7,500 threshold', () => {
    const r = applyFees({
      subtotalPaise: 750_000,
      category: 'hotel',
      nightlyHintPaise: 750_000,
    });
    expect(r.gstRate).toBe(0.12);
  });
});

describe('resolveServiceAddOns — tolerant id/label matching', () => {
  const addOns = [
    { id: 'addon-mpnhwv8g-0', label: 'Beard Trim', price: 200 },
    { id: 'addon-mpnhx4py-1', label: 'Shaving', price: 150 },
    { id: 'addon-mpnhxlm3-2', label: 'Hair Wash', price: 100 },
  ];

  it('resolves real ids', () => {
    const r = resolveServiceAddOns({ listingAddOns: addOns, selectedIds: ['addon-mpnhwv8g-0'] });
    expect(r.sumRupees).toBe(200);
  });

  it('resolves label/slug the model invented ("beard trim", "wash") — the bug', () => {
    const r = resolveServiceAddOns({ listingAddOns: addOns, selectedIds: ['beard trim', 'wash'] });
    expect(r.items.map((i) => i.label).sort()).toEqual(['Beard Trim', 'Hair Wash']);
    expect(r.sumRupees).toBe(300); // 200 + 100
  });

  it('dedups when a label and its real id are both passed', () => {
    const r = resolveServiceAddOns({ listingAddOns: addOns, selectedIds: ['beard trim', 'addon-mpnhwv8g-0'] });
    expect(r.items).toHaveLength(1);
    expect(r.sumRupees).toBe(200);
  });

  it('still throws for a genuinely unknown add-on', () => {
    expect(() => resolveServiceAddOns({ listingAddOns: addOns, selectedIds: ['manicure'] })).toThrow(/no longer offered/i);
  });
});

describe('resolveServiceAddOns — sibling service variants as line items', () => {
  // Barber listing: Beard Trim + Hair Wash are their OWN serviceCatalog entries
  // (svc-…), not add-ons of the Men's Haircut variant.
  const servicesCatalog = [
    { id: 'svc-mpnhouso-0', name: "Men's Haircut", basePrice: 700, addOns: [] },
    { id: 'svc-mpnhouso-1', name: "Women's Haircut", basePrice: 1200, addOns: [] },
    { id: 'svc-mpnhouso-3', name: 'Beard Trim', basePrice: 200, addOns: [] },
    { id: 'svc-mpnhouso-4', name: 'Hair Wash', basePrice: 100, addOns: [] },
  ];

  it('resolves a sibling service id passed as an add-on (the reported bug)', () => {
    const r = resolveServiceAddOns({
      listingAddOns: [],
      selectedIds: ['svc-mpnhouso-3', 'svc-mpnhouso-4'],
      catalogVariants: servicesCatalog,
      baseVariantId: 'svc-mpnhouso-0',
    });
    expect(r.items.map((i) => i.label)).toEqual(['Beard Trim', 'Hair Wash']);
    expect(r.sumRupees).toBe(300); // 200 + 100, each at its own basePrice
  });

  it('resolves sibling services by name/slug too', () => {
    const r = resolveServiceAddOns({
      listingAddOns: [],
      selectedIds: ['beard trim', 'hair wash'],
      catalogVariants: servicesCatalog,
      baseVariantId: 'svc-mpnhouso-0',
    });
    expect(r.sumRupees).toBe(300);
  });

  it('never charges the chosen base variant as its own add-on', () => {
    const r = resolveServiceAddOns({
      listingAddOns: [],
      selectedIds: ['svc-mpnhouso-0', 'svc-mpnhouso-3'],
      catalogVariants: servicesCatalog,
      baseVariantId: 'svc-mpnhouso-0',
    });
    expect(r.items.map((i) => i.label)).toEqual(['Beard Trim']);
    expect(r.sumRupees).toBe(200);
  });

  it('add-ons win ties over sibling services of the same name', () => {
    const r = resolveServiceAddOns({
      listingAddOns: [{ id: 'addon-x-0', label: 'Hair Wash', price: 50 }],
      selectedIds: ['hair wash'],
      catalogVariants: servicesCatalog,
      baseVariantId: 'svc-mpnhouso-0',
    });
    expect(r.sumRupees).toBe(50); // the ₹50 add-on, not the ₹100 sibling service
  });

  it('still throws when an id matches neither an add-on nor a sibling service', () => {
    expect(() => resolveServiceAddOns({
      listingAddOns: [],
      selectedIds: ['manicure'],
      catalogVariants: servicesCatalog,
      baseVariantId: 'svc-mpnhouso-0',
    })).toThrow(/no longer offered/i);
  });
});
