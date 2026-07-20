// @vitest-environment node

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  applyFees,
  subtotalForServicePaise,
  subtotalForTransportHourlyPaise,
  subtotalForTransportDayPaise,
} from '../../../payments/pricing/booking-price.js';

const getById = vi.fn();
vi.mock('../../../listings/services/listings.service.js', () => ({
  listingsService: { getById },
}));
vi.mock('../../../../common/logging/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ctx = {
  userId: 'u1',
  displayLang: 'en',
  requestId: 'r',
  abortSignal: new AbortController().signal,
  toolResultCache: new Map(),
} as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('get_booking_price_preview', () => {
  it('prices a per-visit service with platform fee + GST', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l1',
        listing_type: 'service',
        category: 'plumber',
        price: 500,
        metadata: { pricingUnit: 'per_visit' },
      },
    });
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'l1', serviceMode: 'at-home' } as any,
      ctx,
    ) as { available: boolean; total: number; breakdown: string[] };
    expect(res.available).toBe(true);
    // subtotal=500*100=50000; flat fee=300; gst on (50000+300)*0.18=9054 → total=59354 paise = ₹593.54 (exact, no rounding)
    expect(res.total).toBe(593.54);
    expect(res.breakdown.join(' ')).toContain('Total: ₹593.54');
  });

  it('prices a transport hourly booking', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l2',
        listing_type: 'transport',
        category: 'driver-cab',
        metadata: { transportMode: 'hourly', pricePerHour: 350 },
      },
    });
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'l2', transportMode: 'hourly', transportHours: 4 } as any,
      ctx,
    ) as { available: boolean; total: number };
    expect(res.available).toBe(true);
    expect(res.total).toBeGreaterThan(1400); // 1400 + fees/gst > 1400
  });

  it('refuses hourly transport without hours', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l3',
        listing_type: 'transport',
        metadata: { transportMode: 'hourly', pricePerHour: 350 },
      },
    });
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'l3', transportMode: 'hourly' } as any,
      ctx,
    ) as { available: boolean; reason: string };
    expect(res.available).toBe(false);
    expect(res.reason).toBe('missing_input');
  });

  it('per_hour service: preview total = applyFees(price × hours) — parity with createHold', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l-svc-hr',
        listing_type: 'service',
        category: 'yoga-instructor',
        price: 600,
        metadata: { pricingUnit: 'per_hour' },
      },
    });
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    const HOURS = 3;
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'l-svc-hr', serviceMode: 'at-home', serviceHours: HOURS } as any,
      ctx,
    ) as { available: boolean; total: number };
    expect(res.available).toBe(true);
    // Recompute the canonical hold total — must equal the preview.
    const subtotalPaise = subtotalForServicePaise({ priceRupees: 600, durationHours: HOURS });
    const expected = applyFees({ subtotalPaise, category: 'yoga-instructor', nightlyHintPaise: null }).totalPaise / 100;
    expect(res.total).toBeCloseTo(expected, 2);
  });

  it('day transport: preview total = applyFees(rate × days) — parity with createHold (2 days)', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l-day',
        listing_type: 'transport',
        category: 'driver-day',
        metadata: { transportMode: 'day', pricePerDay: 4500 },
      },
    });
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    const DAYS = 2;
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'l-day', transportMode: 'day', transportDays: DAYS } as any,
      ctx,
    ) as { available: boolean; total: number };
    expect(res.available).toBe(true);
    const subtotalPaise = subtotalForTransportDayPaise({ pricePerDayRupees: 4500, days: DAYS });
    const expected = applyFees({ subtotalPaise, category: 'driver-day', nightlyHintPaise: null }).totalPaise / 100;
    expect(res.total).toBeCloseTo(expected, 2);
  });

  it('transport hourly with listing.category="transport" applies 5% GST (driver-* remap)', async () => {
    // Critical: without the feeCategory remap to driver-hourly the listing's
    // raw "transport" category falls through to the 18% support-services GST
    // branch — preview total would diverge from the hold by 13 percentage
    // points of GST. With the fix, both are 5%.
    getById.mockResolvedValue({
      data: {
        id: 'l-th',
        listing_type: 'transport',
        category: 'transport', // generic — NOT a driver-* prefix
        metadata: { transportMode: 'hourly', pricePerHour: 350 },
      },
    });
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    const HOURS = 4;
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'l-th', transportMode: 'hourly', transportHours: HOURS } as any,
      ctx,
    ) as { available: boolean; total: number; gstRatePct: number };
    expect(res.available).toBe(true);
    expect(res.gstRatePct).toBe(5);
    const subtotalPaise = subtotalForTransportHourlyPaise({ pricePerHourRupees: 350, durationHours: HOURS });
    const expected = applyFees({ subtotalPaise, category: 'driver-hourly', nightlyHintPaise: null }).totalPaise / 100;
    expect(res.total).toBeCloseTo(expected, 2);
    // 4h × ₹350 = 1400 → + flat ₹3 fee → +5% GST on 1403 = 70.15 → ₹1473.15 (exact)
    expect(res.total).toBe(1473.15);
  });

  it('infers listing type from metadata.listingType when listing_type column is absent', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l-meta',
        // No listing_type, no `type` — only metadata.listingType.
        category: 'transport',
        metadata: { listingType: 'transport', transportMode: 'hourly', pricePerHour: 200 },
      },
    });
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'l-meta', transportMode: 'hourly', transportHours: 2 } as any,
      ctx,
    ) as { available: boolean; category?: string; gstRatePct?: number };
    expect(res.available).toBe(true);
    expect(res.category).toBe('transport');
    expect(res.gstRatePct).toBe(5);
  });

  it('prices a transport package by id', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l4',
        listing_type: 'transport',
        category: 'driver-cab',
        metadata: {
          transportMode: 'package',
          packageOptions: [{ id: 'p1', label: 'Coorg loop', price: 3500, hours: 8 }],
        },
      },
    });
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'l4', transportMode: 'package', transportPackageId: 'p1' } as any,
      ctx,
    ) as { available: boolean; total: number };
    expect(res.available).toBe(true);
    expect(res.total).toBeGreaterThan(3500);
  });

  it('resolves a package by LABEL (the model rarely echoes the ugly id)', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l4b',
        listing_type: 'transport',
        category: 'driver-cab',
        metadata: {
          transportMode: 'package',
          packageOptions: [{ id: 'pkg-seed7-1', label: 'Hyderabad Sightseeing Package', price: 3060, hours: 10 }],
        },
      },
    });
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'l4b', transportMode: 'package', transportPackageId: 'Hyderabad Sightseeing Package' } as any,
      ctx,
    ) as { available: boolean; total: number };
    expect(res.available).toBe(true);
    expect(res.total).toBeGreaterThan(3060);
  });

  it('single-package listing: even a junk ref resolves (parity with prepare_booking)', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l4c',
        listing_type: 'transport',
        category: 'driver-cab',
        // id-less row, as AI onboarding saves them
        metadata: { transportMode: 'package', packageOptions: [{ label: 'City loop', price: 2000, hours: 6 }] },
      },
    });
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'l4c', transportMode: 'package', transportPackageId: 'the-city-tour' } as any,
      ctx,
    ) as { available: boolean; total: number };
    expect(res.available).toBe(true);
    expect(res.total).toBeGreaterThan(2000);
  });

  it('multi-package unknown ref: names the REAL options, never says the package was removed', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l4d',
        listing_type: 'transport',
        category: 'driver-cab',
        metadata: {
          transportMode: 'package',
          packageOptions: [
            { id: 'a', label: 'Goa Day Tour', price: 3500 },
            { id: 'b', label: 'Temple loop', price: 1500 },
          ],
        },
      },
    });
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'l4d', transportMode: 'package', transportPackageId: 'beach-day' } as any,
      ctx,
    ) as { available: boolean; reason?: string; userMessage?: string };
    expect(res.available).toBe(false);
    expect(res.reason).toBe('unknown_package');
    expect(res.userMessage).toContain('Goa Day Tour');
    expect(res.userMessage).toContain('Temple loop');
    expect(res.userMessage?.toLowerCase()).not.toContain('anymore');
    expect(res.userMessage?.toLowerCase()).not.toContain('removed');
  });

  it('shows EXACT paise (no whole-rupee rounding) so the quote reconciles to the charge', async () => {
    getById.mockResolvedValue({
      data: { id: 'l-exact', listing_type: 'service', category: 'plumber', price: 500, metadata: { pricingUnit: 'per_visit' } },
    });
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'l-exact', serviceMode: 'at-home' } as any,
      ctx,
    ) as { available: boolean; total: number; taxes: number; breakdown: string[] };
    // GST = 9054 paise = ₹90.54 (not ₹91); total = ₹593.54 (not ₹594).
    expect(res.taxes).toBe(90.54);
    expect(res.total).toBe(593.54);
    // The breakdown lines must sum to the total exactly: 500 + 3 + 90.54 = 593.54.
    expect(res.breakdown.join(' ')).toContain('GST (18%): ₹90.54');
    expect(res.breakdown.join(' ')).toContain('Total: ₹593.54');
  });

  // ── Service variants (servicesCatalog) ──────────────────────────────────
  const salonCatalog = {
    pricingUnit: 'per_visit',
    price: 396, // headline = cheapest variant (Kid's)
    addOns: [{ id: 'addon-0', label: 'Beard Trim', price: 200 }],
    servicesCatalog: [
      { id: 'svc-men', name: "Men's Haircut", basePrice: 700, addOns: [{ id: 'addon-0', label: 'Beard Trim', price: 200 }] },
      { id: 'svc-women', name: "Women's Haircut", basePrice: 1200, addOns: [{ id: 'addon-w', label: 'Blow Dry', price: 300 }] },
      { id: 'svc-kid', name: "Kid's Haircut", basePrice: 396, addOns: [] },
    ],
  };

  it('multi-variant service WITHOUT serviceCatalogId → asks which one (no misquote)', async () => {
    getById.mockResolvedValue({ data: { id: 'l-cat', listing_type: 'service', category: 'salon', price: 396, metadata: salonCatalog } });
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'l-cat', serviceMode: 'visit-provider' } as any,
      ctx,
    ) as { available: boolean; reason: string; userMessage: string };
    expect(res.available).toBe(false);
    expect(res.reason).toBe('missing_input');
    expect(res.userMessage).toContain("Men's Haircut (₹700)");
    expect(res.userMessage).toContain("Women's Haircut (₹1200)");
  });

  it('prices the CHOSEN variant (Men\'s ₹700), not the headline ₹396 — parity with createHold', async () => {
    getById.mockResolvedValue({ data: { id: 'l-cat', listing_type: 'service', category: 'salon', price: 396, metadata: salonCatalog } });
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'l-cat', serviceMode: 'visit-provider', serviceCatalogId: 'svc-men' } as any,
      ctx,
    ) as { available: boolean; total: number; breakdown: string[] };
    expect(res.available).toBe(true);
    // Canonical hold total for the Men's variant base price.
    const subtotalPaise = subtotalForServicePaise({ priceRupees: 700, durationHours: 1 });
    const expected = applyFees({ subtotalPaise, category: 'salon', nightlyHintPaise: null }).totalPaise / 100;
    expect(res.total).toBeCloseTo(expected, 2);
    expect(res.total).toBe(829.54); // 700 + ₹3 fee + 18% GST on 703 = 829.54 (exact, matches the charge)
    expect(res.breakdown.join(' ')).toContain("Men's Haircut");
  });

  it('add-ons resolve from the CHOSEN variant (Women\'s Blow Dry), not another variant', async () => {
    getById.mockResolvedValue({ data: { id: 'l-cat', listing_type: 'service', category: 'salon', price: 396, metadata: salonCatalog } });
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'l-cat', serviceMode: 'visit-provider', serviceCatalogId: 'svc-women', serviceAddOnIds: ['addon-w'] } as any,
      ctx,
    ) as { available: boolean; total: number };
    expect(res.available).toBe(true);
    // Women's 1200 + Blow Dry 300 = 1500 base.
    const subtotalPaise = subtotalForServicePaise({ priceRupees: 1200, durationHours: 1, addOnsRupees: 300 });
    const expected = applyFees({ subtotalPaise, category: 'salon', nightlyHintPaise: null }).totalPaise / 100;
    expect(res.total).toBeCloseTo(expected, 2);
  });

  it('unknown listing returns a safe message that never mentions ids', async () => {
    getById.mockResolvedValue({ data: undefined }); // listing not found
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'made-up-id', serviceMode: 'visit-provider' } as any,
      ctx,
    ) as { available: boolean; reason: string; userMessage?: string };
    expect(res.available).toBe(false);
    expect(res.reason).toBe('unknown_listing');
    // The model must not be able to quote anything about ids being "incorrect".
    expect(res.userMessage ?? '').not.toMatch(/\bid\b|listing id|incorrect/i);
    expect(res.userMessage).toBeTruthy();
  });

  it('tolerantly resolves an invented slug/name ("mens haircut") to the right variant', async () => {
    getById.mockResolvedValue({ data: { id: 'l-cat', listing_type: 'service', category: 'salon', price: 396, metadata: salonCatalog } });
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'l-cat', serviceMode: 'visit-provider', serviceCatalogId: 'mens haircut' } as any,
      ctx,
    ) as { available: boolean; total: number; breakdown: string[] };
    expect(res.available).toBe(true);
    expect(res.total).toBe(829.54); // resolved Men's ₹700, not the ₹396 headline
    expect(res.breakdown.join(' ')).toContain("Men's Haircut");
  });

  it("rejects an add-on id that belongs to a DIFFERENT variant", async () => {
    getById.mockResolvedValue({ data: { id: 'l-cat', listing_type: 'service', category: 'salon', price: 396, metadata: salonCatalog } });
    const { getBookingPricePreviewTool } = await import('./get-booking-price-preview.tool.js');
    // 'addon-w' (Blow Dry) is Women's; picking it under Men's must fail.
    const res = await getBookingPricePreviewTool.execute(
      { listingId: 'l-cat', serviceMode: 'visit-provider', serviceCatalogId: 'svc-men', serviceAddOnIds: ['addon-w'] } as any,
      ctx,
    ) as { available: boolean; reason: string };
    expect(res.available).toBe(false);
    expect(res.reason).toBe('missing_input');
  });
});
