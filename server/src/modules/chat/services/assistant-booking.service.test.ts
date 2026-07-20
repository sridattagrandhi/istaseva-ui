// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../../common/errors/app-error.js';
import {
  subtotalForTransportHourlyPaise,
  subtotalForTransportDayPaise,
  subtotalForTransportPackagePaise,
} from '../../payments/pricing/booking-price.js';

// ── mocks ─────────────────────────────────────────────────────────────────
//
// We exercise the real assistantBookingService.prepare() so its mode-mapping
// + notes-building logic is genuinely under test. The collaborators it calls
// are mocked so the test runs without Postgres/Redis/Razorpay.
const getById = vi.fn();
const roomTypesGetById = vi.fn();
const createHold = vi.fn();
const releaseHold = vi.fn();
const createOrder = vi.fn();

vi.mock('../../listings/services/listings.service.js', () => ({
  listingsService: { getById },
}));
vi.mock('../../listings/repositories/room-types.repository.js', () => ({
  roomTypesRepository: { getById: roomTypesGetById },
}));
vi.mock('../../bookings/services/bookings.service.js', () => ({
  bookingsService: { createHold, releaseHold },
}));
vi.mock('../../payments/services/payments.service.js', () => ({
  paymentsService: { createOrder },
}));
vi.mock('../../../common/logging/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// At-home address gate — defaults to "resolves fine" so the existing at-home
// tests exercise their own concern; the gate tests below override per-call.
const verifyAtHomeAddress = vi.fn(async () => ({ allow: true, resolved: { lat: 17.4, lng: 78.4 }, degraded: false }));
vi.mock('./address-verification.js', () => ({
  verifyAtHomeAddress: (...args: unknown[]) => verifyAtHomeAddress(...(args as [])),
}));

const USER = 'u1';

function setupSuccessfulCreateHold(agreedPricePaise: number, bookingId = 'b1') {
  createHold.mockResolvedValue({
    data: {
      booking: { id: bookingId, agreed_price_paise: agreedPricePaise },
      hold: { expiresAt: '2026-05-21T00:05:00Z' },
    },
  });
  createOrder.mockResolvedValue({
    orderId: 'order_1',
    paymentId: 'pay_1',
    keyId: 'rzp_test',
    amount: agreedPricePaise / 100,
    amountPaise: agreedPricePaise,
    currency: 'INR',
  });
}

function listing(overrides: Record<string, unknown>) {
  return {
    data: {
      id: 'l1',
      title: 'Test',
      is_active: true,
      category: 'transport',
      price: 100,
      metadata: {},
      ...overrides,
    },
  };
}

// Pull captured createHold args for assertions on notes + serviceCategory.
function lastHoldCall(): { serviceCategory: string; notes: Record<string, unknown> | null } {
  expect(createHold).toHaveBeenCalled();
  const args = createHold.mock.calls[createHold.mock.calls.length - 1][0];
  let notes: Record<string, unknown> | null = null;
  try { notes = args.notes ? JSON.parse(args.notes) : null; } catch { notes = null; }
  return { serviceCategory: args.serviceCategory, notes };
}

describe('assistantBookingService.prepare — transport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps hourly mode to driver-hourly and writes notes.durationHours', async () => {
    getById.mockResolvedValue(listing({
      category: 'transport',
      metadata: { transportMode: 'hourly', pricePerHour: '350' },
    }));
    setupSuccessfulCreateHold(280_000);
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await assistantBookingService.prepare({
      listingId: 'l1',
      scheduledDate: '2026-05-21',
      transportMode: 'hourly',
      transportHours: 8,
      pickupLocation: 'Banjara Hills',
      // passengerCount is required for every transport booking — the
      // customer must say how many will be riding. Confirmed product
      // requirement, not a test artifact.
      passengerCount: 1,
    }, USER);
    const { serviceCategory, notes } = lastHoldCall();
    expect(serviceCategory).toBe('driver-hourly');
    expect(notes).toMatchObject({ durationHours: 8, pickupLocation: 'Banjara Hills' });
    // Cross-check against the real pricing helper — 8 hours × ₹350 = ₹2,800.
    expect(subtotalForTransportHourlyPaise({ pricePerHourRupees: 350, durationHours: 8 })).toBe(280_000);
  });

  it('infers hourly from a time window when transportMode is omitted — never the advertised day default', async () => {
    // The "2pm–5pm booked as a ₹500 full-day rental" bug: model omitted
    // transportMode, server fell back to the listing's advertised mode (day).
    // A request carrying a start+end window on an hourly-priced listing must
    // book hourly for that window instead.
    getById.mockResolvedValue(listing({
      category: 'transport',
      metadata: { transportMode: 'day', pricePerHour: 100, pricePerDay: 500 },
    }));
    setupSuccessfulCreateHold(subtotalForTransportHourlyPaise({ pricePerHourRupees: 100, durationHours: 3 }));
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await assistantBookingService.prepare({
      listingId: 'l1',
      scheduledDate: '2026-06-15',
      startTime: '14:00',
      endTime: '17:00',
      pickupLocation: 'Charminar, Hyderabad',
      passengerCount: 3,
    }, USER);
    const { serviceCategory, notes } = lastHoldCall();
    expect(serviceCategory).toBe('driver-hourly');
    expect(notes).toMatchObject({ durationHours: 3 });
  });

  it('maps day mode to driver-day and writes notes.days = 1', async () => {
    getById.mockResolvedValue(listing({
      category: 'transport',
      metadata: { transportMode: 'day', pricePerDay: '4500' },
    }));
    setupSuccessfulCreateHold(450_000);
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await assistantBookingService.prepare({
      listingId: 'l1',
      scheduledDate: '2026-05-21',
      transportMode: 'day',
      pickupLocation: 'Banjara Hills',
      passengerCount: 1,
    }, USER);
    const { serviceCategory, notes } = lastHoldCall();
    expect(serviceCategory).toBe('driver-day');
    expect(notes).toMatchObject({ days: 1 });
    expect(subtotalForTransportDayPaise({ pricePerDayRupees: 4500, days: 1 })).toBe(450_000);
  });

  it('day mode honours transportDays in the notes payload (2 days)', async () => {
    getById.mockResolvedValue(listing({
      category: 'transport',
      metadata: { transportMode: 'day', pricePerDay: '4500' },
    }));
    // 4500 × 2 = 9000 → fee 900 → 5% GST on 9900 = 495 → total 10395 (1,039,500 paise)
    setupSuccessfulCreateHold(1_039_500);
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await assistantBookingService.prepare({
      listingId: 'l1',
      scheduledDate: '2026-05-21',
      transportMode: 'day',
      transportDays: 2,
      pickupLocation: 'Banjara Hills',
      passengerCount: 1,
    }, USER);
    const { serviceCategory, notes } = lastHoldCall();
    expect(serviceCategory).toBe('driver-day');
    expect(notes).toMatchObject({ days: 2 });
    expect(subtotalForTransportDayPaise({ pricePerDayRupees: 4500, days: 2 })).toBe(900_000);
  });

  it('rejects transportDays out of the 1–30 range', async () => {
    getById.mockResolvedValue(listing({
      category: 'transport',
      metadata: { transportMode: 'day', pricePerDay: '4500' },
    }));
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await expect(assistantBookingService.prepare({
      listingId: 'l1',
      scheduledDate: '2026-05-21',
      transportMode: 'day',
      transportDays: 99,
      pickupLocation: 'Banjara Hills',
    }, USER)).rejects.toBeInstanceOf(ValidationError);
    expect(createHold).not.toHaveBeenCalled();
  });

  it('maps package mode to driver-package and writes notes.packageId', async () => {
    const packageOptions = [
      { id: 'coorg-8hr', label: 'Coorg 8hr', price: 3500 },
      { id: 'mysore-day', label: 'Mysore day', price: 5000 },
    ];
    getById.mockResolvedValue(listing({
      category: 'transport',
      metadata: { transportMode: 'package', packageOptions },
    }));
    setupSuccessfulCreateHold(350_000);
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await assistantBookingService.prepare({
      listingId: 'l1',
      scheduledDate: '2026-05-21',
      transportMode: 'package',
      transportPackageId: 'coorg-8hr',
      pickupLocation: 'Banjara Hills',
      passengerCount: 1,
    }, USER);
    const { serviceCategory, notes } = lastHoldCall();
    expect(serviceCategory).toBe('driver-package');
    expect(notes).toMatchObject({ packageId: 'coorg-8hr' });
    expect(subtotalForTransportPackagePaise({ packageOptions, packageId: 'coorg-8hr' })).toBe(350_000);
  });

  it('rejects with a user-safe message when pickupLocation is missing', async () => {
    getById.mockResolvedValue(listing({
      metadata: { transportMode: 'hourly', pricePerHour: '350' },
    }));
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await expect(assistantBookingService.prepare({
      listingId: 'l1',
      scheduledDate: '2026-05-21',
      transportMode: 'hourly',
      transportHours: 8,
    }, USER)).rejects.toBeInstanceOf(ValidationError);
    expect(createHold).not.toHaveBeenCalled();
  });

  it('falls back to driver-cab for legacy transport listings without a mode', async () => {
    // No transportMode + no input.transportMode → resolver should ask for mode.
    getById.mockResolvedValue(listing({
      category: 'transport',
      metadata: {},
    }));
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await expect(assistantBookingService.prepare({
      listingId: 'l1',
      scheduledDate: '2026-05-21',
      pickupLocation: 'Banjara Hills',
    }, USER)).rejects.toThrow(/how would you like to book/i);
  });

  it('rejects a stale package id when MULTIPLE packages exist (ambiguous — must re-pick)', async () => {
    // With >1 package, an unmatched id can't be safely substituted (prices
    // vary), so we reject. A single-package listing instead resolves to its
    // sole package (see matchPackageId) — the model often guesses "pkg-0"
    // when the real id is "pkg-1", and there's nothing else it could mean.
    getById.mockResolvedValue(listing({
      metadata: {
        transportMode: 'package',
        packageOptions: [
          { id: 'coorg-8hr', label: 'Coorg 8hr', price: 3500 },
          { id: 'coorg-12hr', label: 'Coorg 12hr', price: 5000 },
        ],
      },
    }));
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    // The rejection enumerates the REAL options ("which package …: Coorg 8hr
    // (₹3500), Coorg 12hr (₹5000)") instead of claiming the package was
    // removed — a stale ref is the model's error, not a listing change.
    await expect(assistantBookingService.prepare({
      listingId: 'l1',
      scheduledDate: '2026-05-21',
      transportMode: 'package',
      transportPackageId: 'gone-stale',
      pickupLocation: 'Banjara Hills',
    }, USER)).rejects.toThrow(/which package .*Coorg 8hr \(₹3500\).*Coorg 12hr \(₹5000\)/i);
  });

  it('auto-selects the sole package when transportPackageId is missing (no which-one bounce)', async () => {
    // Single-package listing + no id from the model used to bounce with
    // "pick one from the listing's package options" — which the model relayed
    // as "they have a few options" for a one-package listing. Unambiguous →
    // just book it. Id-less row: the canonical positional id goes in notes.
    getById.mockResolvedValue(listing({
      category: 'transport',
      metadata: {
        transportMode: 'package',
        packageOptions: [{ label: 'Hyderabad Sightseeing Package', price: 3060, hours: 10 }],
      },
    }));
    setupSuccessfulCreateHold(306_000);
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await assistantBookingService.prepare({
      listingId: 'l1',
      scheduledDate: '2026-05-21',
      transportMode: 'package',
      pickupLocation: 'Trident Hotels, Hyderabad',
      passengerCount: 7,
    }, USER);
    const { serviceCategory, notes } = lastHoldCall();
    expect(serviceCategory).toBe('driver-package');
    expect(notes).toMatchObject({ packageId: 'pkg-0' });
  });

  it('enumerates the real options when transportPackageId is missing and MULTIPLE packages exist', async () => {
    getById.mockResolvedValue(listing({
      metadata: {
        transportMode: 'package',
        packageOptions: [
          { id: 'coorg-8hr', label: 'Coorg 8hr', price: 3500 },
          { id: 'coorg-12hr', label: 'Coorg 12hr', price: 5000 },
        ],
      },
    }));
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await expect(assistantBookingService.prepare({
      listingId: 'l1',
      scheduledDate: '2026-05-21',
      transportMode: 'package',
      pickupLocation: 'Banjara Hills',
    }, USER)).rejects.toThrow(/which package .*Coorg 8hr \(₹3500\).*Coorg 12hr \(₹5000\)/i);
    expect(createHold).not.toHaveBeenCalled();
  });
});

describe('assistantBookingService.prepare — service per_hour', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes notes.serviceHours when listing.metadata.pricingUnit === "per_hour"', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l-svc-hr',
        title: 'Yoga session',
        is_active: true,
        category: 'yoga-instructor',
        listing_type: 'service',
        price: 600,
        metadata: { pricingUnit: 'per_hour', serviceModes: ['at-home'] },
      },
    });
    // 600 × 3 = 1800 → fee 180 → 18% GST on 1980 = 356.4 → total 2336 (233_640 paise)
    setupSuccessfulCreateHold(233_640);
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await assistantBookingService.prepare({
      listingId: 'l-svc-hr',
      scheduledDate: '2026-05-21',
      serviceMode: 'at-home',
      serviceAddress: 'Plot 4, Banjara Hills, Hyderabad',
      serviceHours: 3,
    }, USER);
    const { notes } = lastHoldCall();
    expect(notes).toMatchObject({ serviceHours: 3, serviceMode: 'at-home' });
  });

  it('anchors the default service slot to the listing\'s opening time, not 09:00', async () => {
    // The "can't book the salon on Monday" bug: no user-supplied time meant a
    // global 09:00 default, which fell before a 10:00 opening and bounced the
    // hold. 2026-06-15 is a Monday; workingHours say mon opens at 10:00.
    getById.mockResolvedValue({
      data: {
        id: 'l-salon',
        title: 'Truefitt & Hill Banjara Hills',
        is_active: true,
        category: 'mens-haircut',
        listing_type: 'service',
        price: 400,
        metadata: { serviceModes: ['visit-provider'], workingHours: { mon: ['10:00', '20:00'], sun: null } },
      },
    });
    setupSuccessfulCreateHold(48_000);
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await assistantBookingService.prepare({
      listingId: 'l-salon',
      scheduledDate: '2026-06-15',
    }, USER);
    const args = createHold.mock.calls[createHold.mock.calls.length - 1][0];
    expect(args.startTime).toBe('10:00');
  });

  it('rejects per_hour services without serviceHours', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l-svc-hr',
        title: 'Yoga session',
        is_active: true,
        category: 'yoga-instructor',
        listing_type: 'service',
        price: 600,
        metadata: { pricingUnit: 'per_hour', serviceModes: ['at-home'] },
      },
    });
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await expect(assistantBookingService.prepare({
      listingId: 'l-svc-hr',
      scheduledDate: '2026-05-21',
      serviceMode: 'at-home',
      serviceAddress: 'Plot 4, Banjara Hills, Hyderabad',
    }, USER)).rejects.toBeInstanceOf(ValidationError);
    expect(createHold).not.toHaveBeenCalled();
  });
});

describe('assistantBookingService.prepare — at-home address gate', () => {
  beforeEach(() => vi.clearAllMocks());

  const atHomeListing = () => listing({
    category: 'cleaning',
    listing_type: 'service',
    metadata: { pricingUnit: 'per_visit', serviceModes: ['at-home'] },
  });

  it('bounces an unresolvable at-home address with a re-ask (no hold created)', async () => {
    getById.mockResolvedValue(atHomeListing());
    verifyAtHomeAddress.mockResolvedValueOnce({ allow: false, resolved: null, degraded: false });
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await expect(assistantBookingService.prepare({
      listingId: 'l1',
      scheduledDate: '2026-05-21',
      startTime: '10:00',
      endTime: '11:00',
      serviceMode: 'at-home',
      serviceAddress: 'my house near the temple',
    }, USER)).rejects.toThrow(/couldn't find that address/i);
    expect(verifyAtHomeAddress).toHaveBeenCalledWith(USER, 'my house near the temple');
    expect(createHold).not.toHaveBeenCalled();
  });

  it('proceeds when the address resolves — and when the gate degrades after repeated failures', async () => {
    getById.mockResolvedValue(atHomeListing());
    setupSuccessfulCreateHold(50_000);
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    // resolves fine (default mock) — and the resolved pin is snapshotted
    // into the notes so the provider gets a mappable location.
    await assistantBookingService.prepare({
      listingId: 'l1',
      scheduledDate: '2026-05-21',
      startTime: '10:00',
      endTime: '11:00',
      serviceMode: 'at-home',
      serviceAddress: 'Plot 4, Banjara Hills, Hyderabad',
    }, USER);
    expect(createHold).toHaveBeenCalledTimes(1);
    expect(lastHoldCall().notes).toMatchObject({ serviceAddressGeo: { lat: 17.4, lng: 78.4 } });
    // degraded (two prior bounces) — unresolvable but allowed through
    getById.mockResolvedValue(atHomeListing());
    setupSuccessfulCreateHold(50_000);
    verifyAtHomeAddress.mockResolvedValueOnce({ allow: true, resolved: null, degraded: true });
    await assistantBookingService.prepare({
      listingId: 'l1',
      scheduledDate: '2026-05-21',
      startTime: '10:00',
      endTime: '11:00',
      serviceMode: 'at-home',
      serviceAddress: 'my house near the temple',
    }, USER);
    expect(createHold).toHaveBeenCalledTimes(2);
  });

  it('never geocodes for visit-provider / online modes', async () => {
    getById.mockResolvedValue(listing({
      category: 'cleaning',
      listing_type: 'service',
      metadata: { pricingUnit: 'per_visit', serviceModes: ['visit-provider'], visitAddress: 'Studio 5, Jubilee Hills' },
    }));
    setupSuccessfulCreateHold(50_000);
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await assistantBookingService.prepare({
      listingId: 'l1',
      scheduledDate: '2026-05-21',
      startTime: '10:00',
      endTime: '11:00',
      serviceMode: 'visit-provider',
    }, USER);
    expect(verifyAtHomeAddress).not.toHaveBeenCalled();
    expect(createHold).toHaveBeenCalled();
  });
});

describe('assistantBookingService.prepare — add-on offer gate', () => {
  beforeEach(() => vi.clearAllMocks());

  const SALON = () => ({
    data: {
      id: 'l-salon',
      title: 'Truefitt & Hill',
      is_active: true,
      category: 'mens-haircut',
      listing_type: 'service',
      price: 700,
      metadata: {
        serviceModes: ['visit-provider'],
        servicesCatalog: [
          { id: 'svc-0', name: "Men's Haircut", basePrice: 700, addOns: [] },
          { id: 'svc-1', name: "Women's Haircut", basePrice: 1200, addOns: [
            { id: 'a-blow', label: 'Blow Dry', price: 300 },
            { id: 'a-wash', label: 'Hair Wash', price: 147 },
          ] },
        ],
      },
    },
  });

  const base = {
    listingId: 'l-salon',
    scheduledDate: '2026-05-21',
    serviceMode: 'visit-provider' as const,
  };

  it('refuses the hold when the chosen variant has add-ons and serviceAddOnIds is undefined', async () => {
    getById.mockResolvedValue(SALON());
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    const { AddOnOfferRequiredError } = await import('./assistant-booking.errors.js');
    await expect(assistantBookingService.prepare(
      { ...base, serviceCatalogId: 'svc-1' }, // Women's — has Blow Dry + Hair Wash
      USER,
    )).rejects.toBeInstanceOf(AddOnOfferRequiredError);
    expect(createHold).not.toHaveBeenCalled();
  });

  it('echoes the offerable add-ons on the gate error', async () => {
    getById.mockResolvedValue(SALON());
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    const { AddOnOfferRequiredError } = await import('./assistant-booking.errors.js');
    const err = await assistantBookingService.prepare(
      { ...base, serviceCatalogId: 'svc-1' }, USER,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AddOnOfferRequiredError);
    expect(err.variantName).toBe("Women's Haircut");
    expect(err.addOns).toEqual([
      { id: 'a-blow', label: 'Blow Dry', price: 300 },
      { id: 'a-wash', label: 'Hair Wash', price: 147 },
    ]);
  });

  it('proceeds when serviceAddOnIds is [] (asked, declined)', async () => {
    getById.mockResolvedValue(SALON());
    setupSuccessfulCreateHold(120_000);
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await assistantBookingService.prepare(
      { ...base, serviceCatalogId: 'svc-1', serviceAddOnIds: [] }, USER,
    );
    expect(createHold).toHaveBeenCalled();
  });

  it('proceeds when serviceAddOnIds carries a chosen add-on', async () => {
    getById.mockResolvedValue(SALON());
    setupSuccessfulCreateHold(150_000);
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await assistantBookingService.prepare(
      { ...base, serviceCatalogId: 'svc-1', serviceAddOnIds: ['a-blow'] }, USER,
    );
    expect(createHold).toHaveBeenCalled();
  });

  it('does NOT gate a variant with no add-ons (per-variant scoping)', async () => {
    getById.mockResolvedValue(SALON());
    setupSuccessfulCreateHold(70_000);
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    // Men's (svc-0) has empty addOns and there are no listing-level add-ons,
    // so the gate must not fire even though a SIBLING variant has add-ons.
    await assistantBookingService.prepare(
      { ...base, serviceCatalogId: 'svc-0' }, USER,
    );
    expect(createHold).toHaveBeenCalled();
  });

  it('gates on listing-level add-ons even without a variant catalog', async () => {
    getById.mockResolvedValue({
      data: {
        id: 'l-clean',
        title: 'Deep Clean',
        is_active: true,
        category: 'cleaning',
        listing_type: 'service',
        price: 999,
        metadata: { serviceModes: ['at-home'], addOns: [{ id: 'a-fridge', label: 'Fridge clean', price: 200 }] },
      },
    });
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    const { AddOnOfferRequiredError } = await import('./assistant-booking.errors.js');
    await expect(assistantBookingService.prepare({
      listingId: 'l-clean',
      scheduledDate: '2026-05-21',
      serviceMode: 'at-home',
      serviceAddress: 'Plot 4, Banjara Hills, Hyderabad',
    }, USER)).rejects.toBeInstanceOf(AddOnOfferRequiredError);
    expect(createHold).not.toHaveBeenCalled();
  });
});

describe('assistantBookingService.prepare — stay guest count', () => {
  beforeEach(() => vi.clearAllMocks());

  function stayWithRoomTypes() {
    return {
      data: {
        id: 'l-stay',
        title: 'Marriott',
        is_active: true,
        category: 'hotel',
        property_type: 'hotel',
        price_per_night: null,
        metadata: {},
        room_types: [
          { id: 'rt1', name: 'Deluxe', base_price_paise: 480000, max_guests: 2 },
          { id: 'rt2', name: 'Family Suite', base_price_paise: 820000, max_guests: 4 },
        ],
      },
    };
  }

  it('asks for guestCount when stay has room types and none was provided', async () => {
    getById.mockResolvedValue(stayWithRoomTypes());
    roomTypesGetById.mockResolvedValue({
      rows: [{ id: 'rt1', listing_id: 'l-stay', name: 'Deluxe', base_price_paise: 480000, max_guests: 2 }],
    });
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await expect(assistantBookingService.prepare({
      listingId: 'l-stay',
      scheduledDate: '2026-05-21',
      checkOutDate: '2026-05-22',
      roomTypeId: 'rt1',
    }, USER)).rejects.toThrow(/how many guests/i);
    expect(createHold).not.toHaveBeenCalled();
  });

  it('suggests a larger room when guestCount exceeds selected room capacity', async () => {
    getById.mockResolvedValue(stayWithRoomTypes());
    roomTypesGetById.mockResolvedValue({
      rows: [{ id: 'rt1', listing_id: 'l-stay', name: 'Deluxe', base_price_paise: 480000, max_guests: 2 }],
    });
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await expect(assistantBookingService.prepare({
      listingId: 'l-stay',
      scheduledDate: '2026-05-21',
      checkOutDate: '2026-05-22',
      roomTypeId: 'rt1',
      guestCount: 4,
    }, USER)).rejects.toThrow(/family suite/i);
  });

  it('proceeds when guestCount fits the selected room', async () => {
    getById.mockResolvedValue(stayWithRoomTypes());
    roomTypesGetById.mockResolvedValue({
      rows: [{ id: 'rt1', listing_id: 'l-stay', name: 'Deluxe', base_price_paise: 480000, max_guests: 2 }],
    });
    setupSuccessfulCreateHold(550_000, 'b-stay');
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    const result = await assistantBookingService.prepare({
      listingId: 'l-stay',
      scheduledDate: '2026-05-21',
      checkOutDate: '2026-05-22',
      roomTypeId: 'rt1',
      guestCount: 2,
    }, USER);
    expect(result.bookingId).toBe('b-stay');
    expect(createHold).toHaveBeenCalled();
  });

  it('resolves a slug/name roomTypeId (e.g. "deluxe-room") to the real room id', async () => {
    // The model frequently passes a slug instead of the UUID. The service must
    // resolve it against the listing's real rooms and hand createHold the REAL
    // id — never the slug (which would crash a uuid column).
    getById.mockResolvedValue(stayWithRoomTypes());
    setupSuccessfulCreateHold(550_000, 'b-slug');
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    const result = await assistantBookingService.prepare({
      listingId: 'l-stay',
      scheduledDate: '2026-05-21',
      checkOutDate: '2026-05-22',
      roomTypeId: 'deluxe-room', // slug, not the real id 'rt1'
      guestCount: 2,
    }, USER);
    expect(result.bookingId).toBe('b-slug');
    // createHold received the RESOLVED real id, not the slug.
    const holdArg = createHold.mock.calls[0][0] as Record<string, unknown>;
    expect(holdArg.roomTypeId).toBe('rt1');
    const notes = JSON.parse(String(holdArg.notes));
    expect(notes.roomTypeId).toBe('rt1');
    expect(notes.roomName).toBe('Deluxe');
  });

  it('asks "which room?" for an unmatched room ref instead of silently picking one', async () => {
    getById.mockResolvedValue(stayWithRoomTypes());
    const { assistantBookingService } = await import('./assistant-booking.service.js');
    await expect(assistantBookingService.prepare({
      listingId: 'l-stay',
      scheduledDate: '2026-05-21',
      checkOutDate: '2026-05-22',
      roomTypeId: 'penthouse-that-does-not-exist',
      guestCount: 2,
    }, USER)).rejects.toThrow(/which one|room option/i);
    expect(createHold).not.toHaveBeenCalled();
  });
});
