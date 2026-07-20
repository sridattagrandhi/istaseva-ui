// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the data-access seams used by the tool. We exercise the REAL pricing
// helpers (applyFees / subtotalForStayPaise / resolveNightlyStayPaiseList /
// insurancePremiumRupees) — that's the whole point of these tests: prove the
// preview produces the same numbers prepare_booking/createHold will.

const getById = vi.fn();
const listAvailability = vi.fn();
const listBookedDatesForListing = vi.fn();

vi.mock('../../../listings/services/listings.service.js', () => ({
  listingsService: { getById },
}));
vi.mock('../../../listings/services/availability-overrides.service.js', () => ({
  availabilityOverridesService: { listForListing: listAvailability },
}));
vi.mock('../../../bookings/repositories/bookings.repository.js', () => ({
  bookingsRepository: { listBookedDatesForListing },
}));
vi.mock('../../../../common/logging/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Helpers — we re-run the canonical math here so each test can express its
// expectation as "the preview MUST equal applyFees(...).totalPaise/100".
async function loadHelpers() {
  return await import('../../../payments/pricing/booking-price.js');
}
async function loadInsurance() {
  return (await import('../../../payments/pricing/fees.js')).insurancePremiumRupees;
}

const ctx = {
  userId: 'u1',
  displayLang: 'en',
  requestId: 'r',
  abortSignal: new AbortController().signal,
  toolResultCache: new Map(),
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  listAvailability.mockResolvedValue({ data: [] });
  listBookedDatesForListing.mockResolvedValue({ rows: [] });
});

describe('get_stay_pricing_preview — parity with hold pricing', () => {
  it('homestay (no room types): subtotal/fees/total match applyFees exactly', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l1',
        title: 'Coorg Cottage',
        category: 'homestay',
        listing_type: 'stay',
        price_per_night: 3000, // ₹3000/night
        room_types: [],
      },
    });
    const { getStayPricingPreviewTool } = await import('./get-stay-pricing-preview.tool.js');
    const { applyFees, subtotalForStayPaise } = await loadHelpers();

    const result = await getStayPricingPreviewTool.execute(
      { listingId: 'l1', checkInDate: '2026-05-21', checkOutDate: '2026-05-23' } as any,
      ctx,
    );

    const expectedSubtotal = subtotalForStayPaise({
      nightlyPaiseList: [300_000, 300_000],
      hostDiscountPercent: 0,
    });
    const expectedFees = applyFees({
      subtotalPaise: expectedSubtotal,
      category: 'homestay',
      nightlyHintPaise: 300_000,
    });
    expect(result.available).toBe(true);
    expect(result.subtotal).toBe(expectedFees.discountedSubtotalPaise / 100);
    expect(result.platformFee).toBe(expectedFees.platformFeePaise / 100);
    expect(result.taxes).toBe(expectedFees.taxesPaise / 100);
    expect(result.total).toBe(expectedFees.totalPaise / 100);
    expect(result.insurance).toEqual({ included: false, amount: 0 });
    expect(result.nightly).toHaveLength(2);
    expect(result.nightly?.every((n) => !n.customPriceApplied)).toBe(true);
  });

  it('hotel room: uses room base_price_paise as nightly base', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l1',
        title: 'Marriott',
        category: 'hotel',
        listing_type: 'stay',
        // No listing-level price — used to break with "host hasn't set a price".
        room_types: [
          { id: 'rt1', name: 'Deluxe', base_price_paise: 480_000, max_guests: 2 },
        ],
      },
    });
    const { getStayPricingPreviewTool } = await import('./get-stay-pricing-preview.tool.js');
    const { applyFees } = await loadHelpers();

    const result = await getStayPricingPreviewTool.execute(
      {
        listingId: 'l1',
        checkInDate: '2026-05-21',
        checkOutDate: '2026-05-22',
        roomTypeId: 'rt1',
      } as any,
      ctx,
    );
    const expected = applyFees({
      subtotalPaise: 480_000,
      category: 'hotel',
      nightlyHintPaise: 480_000,
    });
    expect(result.available).toBe(true);
    expect(result.room).toEqual({ id: 'rt1', name: 'Deluxe', pricePerNight: 4800, maxGuests: 2 });
    expect(result.total).toBe(expected.totalPaise / 100);
  });

  it('listing-level custom date override replaces base nightly', async () => {
    getById.mockResolvedValue({
      data: { id: 'l1', category: 'homestay', listing_type: 'stay', price_per_night: 2000, room_types: [] },
    });
    listAvailability.mockResolvedValue({
      data: [
        { date: '2026-05-21', blocked: false, price_paise: 500_000, room_type_id: null }, // override
        { date: '2026-05-22', blocked: false, price_paise: null, room_type_id: null },
      ],
    });
    const { getStayPricingPreviewTool } = await import('./get-stay-pricing-preview.tool.js');
    const { applyFees, subtotalForStayPaise } = await loadHelpers();

    const result = await getStayPricingPreviewTool.execute(
      { listingId: 'l1', checkInDate: '2026-05-21', checkOutDate: '2026-05-23' } as any,
      ctx,
    );
    const expected = applyFees({
      subtotalPaise: subtotalForStayPaise({ nightlyPaiseList: [500_000, 200_000], hostDiscountPercent: 0 }),
      category: 'homestay',
      nightlyHintPaise: 200_000,
    });
    expect(result.total).toBe(expected.totalPaise / 100);
    expect(result.nightly?.[0].customPriceApplied).toBe(true);
    expect(result.nightly?.[0].price).toBe(5000);
    expect(result.nightly?.[1].customPriceApplied).toBe(false);
    expect(result.nightly?.[1].price).toBe(2000);
  });

  it('room-level override beats listing-level override on the same date', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l1',
        category: 'hotel',
        listing_type: 'stay',
        room_types: [{ id: 'rt1', name: 'Deluxe', base_price_paise: 400_000, max_guests: 2 }],
      },
    });
    listAvailability.mockResolvedValue({
      data: [
        { date: '2026-05-21', blocked: false, price_paise: 999_000, room_type_id: null },  // listing override
        { date: '2026-05-21', blocked: false, price_paise: 700_000, room_type_id: 'rt1' }, // room override wins
      ],
    });
    const { getStayPricingPreviewTool } = await import('./get-stay-pricing-preview.tool.js');
    const result = await getStayPricingPreviewTool.execute(
      { listingId: 'l1', checkInDate: '2026-05-21', checkOutDate: '2026-05-22', roomTypeId: 'rt1' } as any,
      ctx,
    );
    expect(result.nightly?.[0].price).toBe(7000); // ₹7000 (room override), not ₹9990 or ₹4000
  });

  it('host discount applies uniformly (matches the canonical helper)', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l1',
        category: 'homestay',
        listing_type: 'stay',
        price_per_night: 2000,
        discount_percent: 10,
        room_types: [],
      },
    });
    listAvailability.mockResolvedValue({
      data: [
        { date: '2026-05-21', blocked: false, price_paise: 500_000, room_type_id: null }, // override
      ],
    });
    const { getStayPricingPreviewTool } = await import('./get-stay-pricing-preview.tool.js');
    const { applyFees, subtotalForStayPaise } = await loadHelpers();

    const result = await getStayPricingPreviewTool.execute(
      { listingId: 'l1', checkInDate: '2026-05-21', checkOutDate: '2026-05-23' } as any,
      ctx,
    );
    // Canonical helper applies discount to BOTH the override night and the base night.
    // We're locked to that behavior — the test catches anyone who tries to fork it.
    const expected = applyFees({
      subtotalPaise: subtotalForStayPaise({
        nightlyPaiseList: [500_000, 200_000],
        hostDiscountPercent: 10,
      }),
      category: 'homestay',
      nightlyHintPaise: 200_000,
    });
    expect(result.total).toBe(expected.totalPaise / 100);
  });

  it('insurance preview matches paymentsService.createOrder helper (2% clamped ₹2-₹49)', async () => {
    getById.mockResolvedValue({
      data: { id: 'l1', category: 'homestay', listing_type: 'stay', price_per_night: 3000, room_types: [] },
    });
    const { getStayPricingPreviewTool } = await import('./get-stay-pricing-preview.tool.js');
    const insurancePremiumRupees = await loadInsurance();

    const offResult = await getStayPricingPreviewTool.execute(
      { listingId: 'l1', checkInDate: '2026-05-21', checkOutDate: '2026-05-22', insuranceOptIn: false } as any,
      ctx,
    );
    const onResult = await getStayPricingPreviewTool.execute(
      { listingId: 'l1', checkInDate: '2026-05-21', checkOutDate: '2026-05-22', insuranceOptIn: true } as any,
      ctx,
    );

    expect(offResult.insurance).toEqual({ included: false, amount: 0 });
    expect(offResult.total).toBe(onResult.total! - onResult.insurance!.amount);
    expect(onResult.insurance?.amount).toBe(insurancePremiumRupees(onResult.total! - onResult.insurance!.amount));
  });

  it('returns reason="room_required" when listing has rooms and no roomTypeId is given', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l1',
        category: 'hotel',
        listing_type: 'stay',
        room_types: [{ id: 'rt1', name: 'Deluxe', base_price_paise: 400_000, max_guests: 2 }],
      },
    });
    const { getStayPricingPreviewTool } = await import('./get-stay-pricing-preview.tool.js');
    const result = await getStayPricingPreviewTool.execute(
      { listingId: 'l1', checkInDate: '2026-05-21', checkOutDate: '2026-05-22' } as any,
      ctx,
    );
    expect(result.available).toBe(false);
    expect(result.reason).toBe('room_required');
  });

  it('returns reason="blocked" with the host-blocked date', async () => {
    getById.mockResolvedValue({
      data: { id: 'l1', category: 'homestay', listing_type: 'stay', price_per_night: 2000, room_types: [] },
    });
    listAvailability.mockResolvedValue({
      data: [{ date: '2026-05-21', blocked: true, price_paise: null, room_type_id: null }],
    });
    const { getStayPricingPreviewTool } = await import('./get-stay-pricing-preview.tool.js');
    const result = await getStayPricingPreviewTool.execute(
      { listingId: 'l1', checkInDate: '2026-05-21', checkOutDate: '2026-05-22' } as any,
      ctx,
    );
    expect(result.available).toBe(false);
    expect(result.reason).toBe('blocked');
    expect(result.blockedDates).toEqual(['2026-05-21']);
  });
});
