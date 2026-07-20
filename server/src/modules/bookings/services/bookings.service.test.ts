// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, ValidationError } from '../../../common/errors/app-error.js';

const acquireLock = vi.fn();
const releaseLock = vi.fn();
const del = vi.fn();
const setBookingHold = vi.fn();
const releaseBookingHold = vi.fn();
const getIdempotencyValue = vi.fn();
const setIdempotencyValue = vi.fn();
const dbTransaction = vi.fn(async (fn: any) => fn({}));
const listForUser = vi.fn();
const countForUser = vi.fn();
const countPendingForUser = vi.fn();
const getAccessibleBookingById = vi.fn();
const getById = vi.fn();
const getByIdForUpdate = vi.fn();
const findByIdempotencyKey = vi.fn();
const findConflictingBookingsForUpdate = vi.fn();
const findActiveSlotLocksForUpdate = vi.fn();
const findActiveLockForUserProvider = vi.fn();
const acquireProviderDateAdvisoryLock = vi.fn();
const createPendingBookingHold = vi.fn();
const releaseHoldByBookingId = vi.fn();
const updateStatus = vi.fn();
const expireStaleLocksForUser = vi.fn();
const expireStaleBookingsForUser = vi.fn();
const getCompletedPaymentSummary = vi.fn();
const getCancellationContext = vi.fn();
const confirmBooking = vi.fn();
const expireBooking = vi.fn();
const cleanupExpiredHolds = vi.fn();

const refundCompletedBooking = vi.fn();

vi.mock('../../../common/repositories/database.js', () => ({
  dbTransaction,
}));

vi.mock('../../../common/providers/registry.js', () => ({
  getCacheProvider: vi.fn(async () => ({
    acquireLock,
    releaseLock,
    del,
    setBookingHold,
    releaseBookingHold,
    getIdempotencyValue,
    setIdempotencyValue,
  })),
  // updateStatus fires a fire-and-forget trackServerEvent() analytics call,
  // which resolves getEventProvider() from the registry. Stub it so the
  // side-effect is a no-op instead of throwing on the unmocked export.
  getEventProvider: vi.fn(async () => ({ putEvent: vi.fn(async () => undefined) })),
}));

vi.mock('../repositories/bookings.repository.js', () => ({
  bookingsRepository: {
    listForUser,
    countForUser,
    countPendingForUser,
    getAccessibleBookingById,
    getById,
    getByIdForUpdate,
    findByIdempotencyKey,
    findConflictingBookingsForUpdate,
    findActiveSlotLocksForUpdate,
    findActiveLockForUserProvider,
    acquireProviderDateAdvisoryLock,
    createPendingBookingHold,
    releaseHoldByBookingId,
    updateStatus,
    expireStaleLocksForUser,
    expireStaleBookingsForUser,
    getCompletedPaymentSummary,
    getCancellationContext,
    confirmBooking,
    expireBooking,
    cleanupExpiredHolds,
  },
}));

vi.mock('../../../common/logging/audit-log.js', () => ({
  logAuditEvent: vi.fn(),
}));

vi.mock('../../payments/index.js', () => ({
  paymentsService: {
    refundCompletedBooking,
  },
}));

const listingGetById = vi.fn();
vi.mock('../../listings/repositories/listings.repository.js', () => ({
  listingsRepository: { getById: listingGetById },
}));

const roomTypeGetById = vi.fn();
vi.mock('../../listings/repositories/room-types.repository.js', () => ({
  roomTypesRepository: { getById: roomTypeGetById },
}));

const providerGetByUserId = vi.fn();
vi.mock('../../providers/repositories/providers.repository.js', () => ({
  providersRepository: { getByUserId: providerGetByUserId },
}));

const couponConsume = vi.fn();
const couponRecordRedemption = vi.fn(async () => undefined);
vi.mock('../../coupons/services/coupons.service.js', () => ({
  couponsService: { consume: couponConsume, recordRedemption: couponRecordRedemption },
}));

const availabilityListForListing = vi.fn();
vi.mock('../../listings/repositories/availability-overrides.repository.js', () => ({
  availabilityOverridesRepository: { listForListing: availabilityListForListing },
}));

// ─── Isolation: stub side-effectful modules so tests don't dial out ─────────
//
// Geocoding hits Google / Nominatim over HTTPS. Without this stub, any test
// that runs createHold with an `address` falls through to the real network,
// which times out on isolated CI runs.
vi.mock('../../../common/services/geocode.service.js', () => ({
  geocodeAddress: vi.fn(async () => null),
}));

// Redis is initialized at module import time (see common/cache/redis.ts).
// In Node test envs without a Redis daemon the client retries forever and
// logs "Redis reconnect" noise that bleeds across files. Stub the export
// surface so nothing here ever instantiates a real connection.
vi.mock('../../../common/cache/redis.ts', () => ({
  redis: {
    on: () => {},
    quit: async () => {},
  },
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => undefined),
  cacheDel: vi.fn(async () => undefined),
  cacheDelByPattern: vi.fn(async () => undefined),
}));

// FCM push tries to look up tokens via dbQuery; the warn it logs is harmless
// but the import chain pulls in real DB code. Stub the dispatcher.
vi.mock('../../notifications/services/fcm.service.js', () => ({
  sendPushToUser: vi.fn(async () => undefined),
}));

describe('BookingsService', () => {
  // createHold now rejects past dates (compared against "today" in Asia/Kolkata).
  // These fixtures use fixed 2026 dates, so freeze the clock to before them.
  // toFake:['Date'] fakes only Date — real setTimeout/Promise timing is untouched.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    acquireLock.mockResolvedValue('cache-lock');
    releaseLock.mockResolvedValue(true);
    del.mockResolvedValue(undefined);
    setBookingHold.mockResolvedValue(undefined);
    releaseBookingHold.mockResolvedValue(undefined);
    getIdempotencyValue.mockResolvedValue(null);
    setIdempotencyValue.mockResolvedValue(undefined);
    countPendingForUser.mockResolvedValue({ rows: [{ count: '0' }] });
    findActiveLockForUserProvider.mockResolvedValue({ rows: [] });
    expireStaleLocksForUser.mockResolvedValue({ rows: [] });
    expireStaleBookingsForUser.mockResolvedValue({ rows: [] });
    findByIdempotencyKey.mockResolvedValue({ rows: [] });
    findConflictingBookingsForUpdate.mockResolvedValue({ rows: [] });
    findActiveSlotLocksForUpdate.mockResolvedValue({ rows: [] });
    createPendingBookingHold.mockResolvedValue({
      booking: {
        id: 'booking-1',
        provider_id: 'provider-1',
        scheduled_date: '2026-04-11',
        start_time: '10:00',
        status: 'pending',
        user_id: 'user-1',
      },
      lock: {
        id: 'lock-1',
        expires_at: '2026-04-11T10:05:00.000Z',
      },
    });
    getById.mockResolvedValue({ rows: [] });
    getByIdForUpdate.mockResolvedValue({ rows: [] });
    updateStatus.mockResolvedValue({ rows: [{ id: 'booking-1', status: 'cancelled' }] });
    getCompletedPaymentSummary.mockResolvedValue({ rows: [] });
    getCancellationContext.mockResolvedValue({
      rows: [{ id: 'booking-1', user_id: 'user-1', status: 'confirmed', scheduled_date: '2026-04-11', start_time: '10:00', cancellation_policy: 'flexible' }],
    });
    confirmBooking.mockResolvedValue({ rows: [{ id: 'booking-1', status: 'confirmed', user_id: 'user-1' }] });
    expireBooking.mockResolvedValue({ rows: [{ id: 'booking-1', status: 'expired', user_id: 'user-1' }] });
    listingGetById.mockResolvedValue({ rows: [] });
    roomTypeGetById.mockResolvedValue({ rows: [] });
    providerGetByUserId.mockResolvedValue({ rows: [] });
    couponConsume.mockResolvedValue({ couponId: null, discountAmount: 0 });
    availabilityListForListing.mockResolvedValue({ rows: [] });
  });

  it('creates a booking hold when the slot is available', async () => {
    const { bookingsService } = await import('./bookings.service.js');

    const result = await bookingsService.createHold(
      {
        providerId: 'provider-1',
        serviceCategory: 'Electrical',
        scheduledDate: '2026-04-11',
        startTime: '10:00',
        endTime: '11:00',
        address: '123 Street',
      },
      'user-1'
    );

    expect(createPendingBookingHold).toHaveBeenCalled();
    expect(result.data.booking.id).toBe('booking-1');
    expect(result.data.hold.lockId).toBe('lock-1');
    expect(releaseLock).toHaveBeenCalledWith('booking:provider-1:2026-04-11:10:00', 'cache-lock');
  });

  // Same-day lead-time gate. The clock is frozen to 2026-01-01T00:00:00Z, which
  // is 05:30 IST — so a same-day booking must start at or after 06:00 IST.
  describe('same-day lead-time gate', () => {
    it('rejects a same-day booking that starts within the 30-minute buffer', async () => {
      const { bookingsService } = await import('./bookings.service.js');

      await expect(
        bookingsService.createHold(
          {
            providerId: 'provider-1',
            serviceCategory: 'Electrical',
            scheduledDate: '2026-01-01', // IST-today
            startTime: '05:45',          // 05:30 now + 30 buffer → 06:00 earliest
            endTime: '06:45',
          } as any,
          'user-1',
        ),
      ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });

      expect(createPendingBookingHold).not.toHaveBeenCalled();
    });

    it('allows a same-day booking that starts past the buffer', async () => {
      const { bookingsService } = await import('./bookings.service.js');

      const result = await bookingsService.createHold(
        {
          providerId: 'provider-1',
          serviceCategory: 'Electrical',
          scheduledDate: '2026-01-01',
          startTime: '08:00', // well past the 06:00 earliest-bookable time
          endTime: '09:00',
          address: '123 Street',
        } as any,
        'user-1',
      );

      expect(createPendingBookingHold).toHaveBeenCalled();
      expect(result.data.booking.id).toBe('booking-1');
    });
  });

  it('blocks users from creating more than three pending bookings', async () => {
    countPendingForUser.mockResolvedValue({ rows: [{ count: '3' }] });
    const { bookingsService } = await import('./bookings.service.js');

    await expect(
      bookingsService.createHold(
        {
          providerId: 'provider-1',
          serviceCategory: 'Electrical',
          scheduledDate: '2026-04-11',
          startTime: '10:00',
          endTime: '11:00',
        },
        'user-1'
      )
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('cancels a booking and initiates a refund when a completed payment exists', async () => {
    getAccessibleBookingById.mockResolvedValue({
      rows: [
        {
          id: 'booking-1',
          status: 'confirmed',
          user_id: 'user-1',
          provider_id: 'provider-1',
          provider_user_id: 'provider-user-1',
          scheduled_date: '2026-04-11',
        },
      ],
    });
    getCompletedPaymentSummary.mockResolvedValue({
      rows: [{ id: 'payment-1', status: 'completed' }],
    });

    const { bookingsService } = await import('./bookings.service.js');
    const result = await bookingsService.updateStatus('booking-1', 'cancelled', 'user-1');

    expect(refundCompletedBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: 'booking-1',
        paymentId: 'payment-1',
        userId: 'user-1',
      })
    );
    expect(result.data.status).toBe('cancelled');
  });

  it('threads the guest cancellation reason to the repository write', async () => {
    getAccessibleBookingById.mockResolvedValue({
      rows: [
        {
          id: 'booking-1',
          status: 'confirmed',
          user_id: 'user-1',
          provider_id: 'provider-1',
          provider_user_id: 'provider-user-1',
          scheduled_date: '2026-04-11',
        },
      ],
    });

    const { bookingsService } = await import('./bookings.service.js');
    const result = await bookingsService.updateStatus('booking-1', 'cancelled', 'user-1', 'guest', {
      cancellationReason: 'plans_changed',
    });

    expect(result.data.status).toBe('cancelled');
    expect(updateStatus).toHaveBeenCalledWith('booking-1', 'cancelled', expect.anything(), 'plans_changed');
  });

  it('still cancels when no reason is provided (host/assistant paths)', async () => {
    getAccessibleBookingById.mockResolvedValue({
      rows: [
        {
          id: 'booking-1',
          status: 'confirmed',
          user_id: 'user-1',
          provider_id: 'provider-1',
          provider_user_id: 'provider-user-1',
          scheduled_date: '2026-04-11',
        },
      ],
    });

    const { bookingsService } = await import('./bookings.service.js');
    const result = await bookingsService.updateStatus('booking-1', 'cancelled', 'user-1');

    expect(result.data.status).toBe('cancelled');
    expect(updateStatus).toHaveBeenCalledWith('booking-1', 'cancelled', expect.anything(), undefined);
  });

  it('prevents invalid state transitions', async () => {
    getAccessibleBookingById.mockResolvedValue({
      rows: [{ id: 'booking-1', status: 'completed', user_id: 'user-1', provider_user_id: 'provider-user-1' }],
    });
    const { bookingsService } = await import('./bookings.service.js');

    await expect(bookingsService.updateStatus('booking-1', 'cancelled', 'user-1')).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects updateStatus when the caller is not the guest or provider', async () => {
    const { NotFoundError } = await import('../../../common/errors/app-error.js');
    getAccessibleBookingById.mockResolvedValue({ rows: [] });
    const { bookingsService } = await import('./bookings.service.js');

    await expect(bookingsService.updateStatus('booking-1', 'cancelled', 'attacker')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('forbids the guest from confirming a booking', async () => {
    const { ForbiddenError } = await import('../../../common/errors/app-error.js');
    getAccessibleBookingById.mockResolvedValue({
      rows: [{ id: 'booking-1', status: 'pending', user_id: 'user-1', provider_user_id: 'provider-user-1' }],
    });
    const { bookingsService } = await import('./bookings.service.js');

    await expect(bookingsService.updateStatus('booking-1', 'confirmed', 'user-1')).rejects.toBeInstanceOf(ValidationError);
    await expect(bookingsService.updateStatus('booking-1', 'expired', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  describe('multi-night stay overlap', () => {
    // Simulate availability-overrides repo (dynamic-imported by the service).
    const listForListing = vi.fn();
    beforeEach(() => {
      listForListing.mockReset();
      listForListing.mockResolvedValue({ rows: [] });
      vi.doMock('../../listings/repositories/availability-overrides.repository.js', () => ({
        availabilityOverridesRepository: { listForListing },
      }));
    });

    it('rejects a stay whose range overlaps an existing booking', async () => {
      findConflictingBookingsForUpdate.mockResolvedValueOnce({ rows: [{ id: 'conflict-1' }] });
      const { bookingsService } = await import('./bookings.service.js');

      await expect(
        bookingsService.createHold(
          {
            providerId: 'provider-1',
            serviceCategory: 'stay:hotel',
            scheduledDate: '2026-06-10',
            endDate: '2026-06-14',
            startTime: '14:00',
            endTime: '11:00',
          },
          'user-2',
        ),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });

      // Ensure the conflict check was called with the date range, not just
      // the single check-in date.
      const lastCall = findConflictingBookingsForUpdate.mock.calls.at(-1);
      expect(lastCall?.[6]).toBe('2026-06-14');
    });

    it('allows a stay that begins exactly when an existing booking ends', async () => {
      // No conflicts because the existing booking's end_date equals our
      // scheduledDate — the half-open ranges meet but don't overlap.
      findConflictingBookingsForUpdate.mockResolvedValueOnce({ rows: [] });
      const { bookingsService } = await import('./bookings.service.js');

      const result = await bookingsService.createHold(
        {
          providerId: 'provider-1',
          serviceCategory: 'stay:hotel',
          scheduledDate: '2026-06-14',
          endDate: '2026-06-17',
          startTime: '14:00',
          endTime: '11:00',
        },
        'user-3',
      );

      expect(result.data.booking.id).toBe('booking-1');
      // Repository receives endDate so it can store it on the new row.
      const insertCall = createPendingBookingHold.mock.calls.at(-1);
      expect(insertCall?.[1]).toMatchObject({ scheduledDate: '2026-06-14', endDate: '2026-06-17' });
    });

    it('rejects a stay when a host-blocked date falls inside the range', async () => {
      // createHold now always loads the listing when a listingId is given —
      // give the mock a real row so pricing can proceed long enough to hit
      // the host-block check below.
      listingGetById.mockResolvedValue({
        rows: [{
          id: '00000000-0000-0000-0000-000000000001',
          user_id: 'host-1', category: 'hotel', listing_type: 'stay',
          price_per_night: 1000, price: 1000, provider_profile_id: 'provider-1',
          metadata: {}, discount_percent: 0,
        }],
      });
      listForListing.mockResolvedValueOnce({
        rows: [
          { listing_id: '00000000-0000-0000-0000-000000000001', room_type_id: null, date: '2026-06-12', blocked: true, price_paise: null },
        ],
      });
      const { bookingsService } = await import('./bookings.service.js');

      await expect(
        bookingsService.createHold(
          {
            providerId: 'provider-1',
            listingId: '00000000-0000-0000-0000-000000000001',
            serviceCategory: 'stay:hotel',
            scheduledDate: '2026-06-10',
            endDate: '2026-06-14',
            startTime: '14:00',
            endTime: '11:00',
          },
          'user-4',
        ),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    });
  });

  describe('service host-blocked date', () => {
    // A provider can block whole days on a SERVICE listing via the same
    // listing_availability_overrides table stays/transport use (room_type_id
    // NULL = listing-level). createHold's block check is listing-type-agnostic,
    // so a single-day service booking on a blocked date must be rejected — this
    // is the server-side enforcement behind the provider "Schedule" UI.
    const listForListing = vi.fn();
    beforeEach(() => {
      listForListing.mockReset();
      listForListing.mockResolvedValue({ rows: [] });
      vi.doMock('../../listings/repositories/availability-overrides.repository.js', () => ({
        availabilityOverridesRepository: { listForListing },
      }));
    });

    it('rejects a service booking on a provider-blocked day', async () => {
      listingGetById.mockResolvedValue({
        rows: [{
          id: '00000000-0000-0000-0000-0000000000aa',
          user_id: 'provider-1', category: 'yoga-instructor', listing_type: 'service',
          price: 600, provider_profile_id: 'provider-1',
          metadata: {}, discount_percent: 0,
        }],
      });
      // Single-day service booking collapses the override range to one date.
      listForListing.mockResolvedValueOnce({
        rows: [
          { listing_id: '00000000-0000-0000-0000-0000000000aa', room_type_id: null, date: '2026-05-22', blocked: true, price_paise: null },
        ],
      });
      const { bookingsService } = await import('./bookings.service.js');

      await expect(
        bookingsService.createHold(
          {
            providerId: 'provider-1',
            listingId: '00000000-0000-0000-0000-0000000000aa',
            serviceCategory: 'yoga-instructor',
            scheduledDate: '2026-05-22',
            startTime: '09:00',
            endTime: '10:00',
          } as any,
          'user-5',
        ),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });

      expect(createPendingBookingHold).not.toHaveBeenCalled();
    });
  });

  it('expires a pending booking hold', async () => {
    getById.mockResolvedValue({
      rows: [{ id: 'booking-1', status: 'pending', user_id: 'user-1' }],
    });
    const { bookingsService } = await import('./bookings.service.js');

    const result = await bookingsService.expirePendingBooking('booking-1');

    expect(expireBooking).toHaveBeenCalled();
    expect(result?.status).toBe('expired');
  });

  describe('createHold — server-authoritative pricing', () => {
    it('rejects createHold when client agreedPrice is far from server total', async () => {
      listingGetById.mockResolvedValue({
        rows: [{
          id: 'L1', user_id: 'host-1', category: 'hotel', listing_type: 'stay',
          price_per_night: 1000, price: 1000, provider_profile_id: 'provider-1',
          metadata: {}, discount_percent: 0,
        }],
      });
      const { bookingsService } = await import('./bookings.service.js');

      await expect(bookingsService.createHold({
        listingId: 'L1',
        serviceCategory: 'hotel',
        scheduledDate: '2026-04-11',
        endDate: '2026-04-12',
        startTime: '14:00',
        endTime: '12:00',
        agreedPrice: 400,
      } as any, 'user-1')).rejects.toThrow(/price has changed|no longer matches|Booking price/);

      expect(createPendingBookingHold).not.toHaveBeenCalled();
    });

    it('persists server-computed total on createPendingBookingHold', async () => {
      listingGetById.mockResolvedValue({
        rows: [{
          id: 'L1', user_id: 'host-1', category: 'hotel', listing_type: 'stay',
          price_per_night: 1000, price: 1000, provider_profile_id: 'provider-1',
          metadata: {}, discount_percent: 0,
        }],
      });
      const { bookingsService } = await import('./bookings.service.js');

      await bookingsService.createHold({
        listingId: 'L1',
        serviceCategory: 'hotel',
        scheduledDate: '2026-04-11',
        endDate: '2026-04-12',
        startTime: '14:00',
        endTime: '12:00',
        // No agreedPrice — frontend doesn't have to claim a number.
      } as any, 'user-1');

      // Subtotal 100000 + flat fee 300 + 12% GST on 100300 = 12036 → 112336 paise.
      expect(createPendingBookingHold).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ agreedPricePaise: 112336 }),
      );
    });

    it('always loads listing — providerId + listingId + no coupon still loads listing for pricing', async () => {
      // Regression: previously the listing was only loaded when providerId was
      // missing OR a coupon existed. The common case (frontend sends both,
      // no coupon) left listingResolved=null → subtotal=0 → broken price.
      listingGetById.mockResolvedValue({
        rows: [{
          id: 'L1', user_id: 'host-1', category: 'hotel', listing_type: 'stay',
          price_per_night: 500, price: 500, provider_profile_id: 'provider-1',
          metadata: {}, discount_percent: 0,
        }],
      });
      const { bookingsService } = await import('./bookings.service.js');

      await bookingsService.createHold({
        providerId: 'provider-1',
        listingId: 'L1',
        serviceCategory: 'hotel',
        scheduledDate: '2026-04-11',
        endDate: '2026-04-12',
        startTime: '14:00',
        endTime: '12:00',
      } as any, 'user-1');

      // Listing was loaded once even with providerId present + no coupon.
      expect(listingGetById).toHaveBeenCalledWith('L1');
      // Backend computed the official total — not zero, not just base price.
      // subtotal 50000 → flat fee 300 → 12% GST on 50300 = 6036 → 56336 paise.
      const insertCall = createPendingBookingHold.mock.calls.at(-1);
      expect(insertCall?.[1]).toMatchObject({
        agreedPricePaise: 56_336,
        subtotalPaise: 50_000,
        platformFeePaise: 300,
        taxesPaise: 6_036,
      });
    });

    it('persists the forward breakdown on the booking row (no inverse math elsewhere)', async () => {
      listingGetById.mockResolvedValue({
        rows: [{
          id: 'L1', user_id: 'host-1', category: 'hotel', listing_type: 'stay',
          price_per_night: 1000, price: 1000, provider_profile_id: 'provider-1',
          metadata: {}, discount_percent: 0,
        }],
      });
      const { bookingsService } = await import('./bookings.service.js');

      await bookingsService.createHold({
        listingId: 'L1',
        serviceCategory: 'hotel',
        scheduledDate: '2026-04-11',
        endDate: '2026-04-12',
        startTime: '14:00',
        endTime: '12:00',
      } as any, 'user-1');

      const insertCall = createPendingBookingHold.mock.calls.at(-1);
      // Parts persisted match the forward math + sum to agreed_price_paise.
      // Discount is 0 in this no-coupon scenario, so the reconciliation
      // collapses to subtotal + fee + taxes === total.
      const params = insertCall![1] as any;
      expect(
        params.subtotalPaise - (params.discountPaise ?? 0)
          + params.platformFeePaise + params.taxesPaise,
      ).toBe(params.agreedPricePaise);
    });

    it('coupon discount is computed against the SERVER subtotal, not client total', async () => {
      listingGetById.mockResolvedValue({
        rows: [{
          id: 'L1', user_id: 'host-1', category: 'hotel', listing_type: 'stay',
          price_per_night: 1000, price: 1000, provider_profile_id: 'provider-1',
          metadata: {}, discount_percent: 0,
        }],
      });
      couponConsume.mockResolvedValue({ couponId: 'C1', discountAmount: 200 });
      const { bookingsService } = await import('./bookings.service.js');

      await bookingsService.createHold({
        listingId: 'L1',
        serviceCategory: 'hotel',
        scheduledDate: '2026-04-11',
        endDate: '2026-04-12',
        startTime: '14:00',
        endTime: '12:00',
        couponCode: 'SAVE200',
      } as any, 'user-1');

      // consume() is called with basePrice = server subtotal in rupees (1000),
      // NOT the client's claimed total. That stops a client lie from
      // inflating the discount base.
      expect(couponConsume).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ basePrice: 1000 }),
      );
      // ₹200 discount on ₹1,000 subtotal: discounted 800 → flat fee 300 paise
      // (₹3) → 12% GST on (80000+300)=80300 paise → 9636 paise → total 89936.
      // We persist the ORIGINAL subtotal + discount as separate columns so
      // the invoice / email can render "Base cost 1000 / Discount −200"
      // without subtracting the discount twice.
      const insertCall = createPendingBookingHold.mock.calls.at(-1);
      expect(insertCall?.[1]).toMatchObject({
        subtotalPaise: 100_000,   // original (pre-discount)
        platformFeePaise: 300,    // flat ₹3
        taxesPaise: 9_636,         // GST on discounted+fee
        discountPaise: 20_000,
        agreedPricePaise: 89_936,
      });
      // The parts reconcile: subtotal − discount + fee + taxes = total
      const p = insertCall![1] as any;
      expect(p.subtotalPaise - p.discountPaise + p.platformFeePaise + p.taxesPaise)
        .toBe(p.agreedPricePaise);
    });

    it('accepts client agreedPrice when it matches server total within ±₹2 drift', async () => {
      listingGetById.mockResolvedValue({
        rows: [{
          id: 'L1', user_id: 'host-1', category: 'hotel', listing_type: 'stay',
          price_per_night: 1000, price: 1000, provider_profile_id: 'provider-1',
          metadata: {}, discount_percent: 0,
        }],
      });
      const { bookingsService } = await import('./bookings.service.js');

      // Server total = 1123.36; client claims 1123.50 (₹0.14 drift) — accept.
      await expect(bookingsService.createHold({
        listingId: 'L1',
        serviceCategory: 'hotel',
        scheduledDate: '2026-04-11',
        endDate: '2026-04-12',
        startTime: '14:00',
        endTime: '12:00',
        agreedPrice: 1123.50,
      } as any, 'user-1')).resolves.toBeDefined();

      expect(createPendingBookingHold).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ agreedPricePaise: 112336 }),
      );
    });

    // ─── Phase 6A: transport hourly / day / package pricing ─────────────────
    //
    // Shared shape: the listing is a transport row with the new mode-aware
    // metadata fields (pricePerHour / pricePerDay / packageOptions). Pricing
    // math: subtotal → + flat ₹3 platform fee → +5% GST (transport HSN 9964).
    //
    //   hourly  350 × 4 = 1400 → fee 3 → 5% GST on 1403 = 70 → total 1473
    //   day     4500 × 1 = 4500 → fee 3 → 5% GST on 4503 = 225 → total 4728
    //   package 3500     → fee 3 → 5% GST on 3503 = 175 → total 3678
    describe('transport hourly mode', () => {
      const hourlyListing = {
        id: 'TH1', user_id: 'driver-1', category: 'driver-hourly',
        listing_type: 'transport',
        price: 0, provider_profile_id: 'provider-1',
        metadata: { transportMode: 'hourly', pricePerHour: 350 },
        discount_percent: 0,
      };

      it('happy path: persists hourly subtotal × fees', async () => {
        listingGetById.mockResolvedValue({ rows: [hourlyListing] });
        const { bookingsService } = await import('./bookings.service.js');

        await bookingsService.createHold({
          listingId: 'TH1',
          serviceCategory: 'driver-hourly',
          scheduledDate: '2026-05-22',
          startTime: '09:00',
          endTime: '13:00',
          agreedPrice: 1473,
          notes: JSON.stringify({ durationHours: 4, pickup: 'Hotel Lobby' }),
        } as any, 'user-1');

        expect(createPendingBookingHold).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            subtotalPaise: 140_000,
            platformFeePaise: 300,
            taxesPaise: 7_015,
            agreedPricePaise: 147_315,
          }),
        );
      });

      it('rejects when client agreedPrice drifts beyond ±₹2', async () => {
        listingGetById.mockResolvedValue({ rows: [hourlyListing] });
        const { bookingsService } = await import('./bookings.service.js');

        await expect(bookingsService.createHold({
          listingId: 'TH1',
          serviceCategory: 'driver-hourly',
          scheduledDate: '2026-05-22',
          startTime: '09:00',
          endTime: '13:00',
          agreedPrice: 2500, // server says 1473; drift > ₹2 → reject
          notes: JSON.stringify({ durationHours: 4 }),
        } as any, 'user-1')).rejects.toThrow(/price has changed|Booking price/);

        expect(createPendingBookingHold).not.toHaveBeenCalled();
      });

      it('rejects when metadata.pricePerHour is missing', async () => {
        listingGetById.mockResolvedValue({
          rows: [{ ...hourlyListing, metadata: { transportMode: 'hourly' } }],
        });
        const { bookingsService } = await import('./bookings.service.js');

        await expect(bookingsService.createHold({
          listingId: 'TH1',
          serviceCategory: 'driver-hourly',
          scheduledDate: '2026-05-22',
          startTime: '09:00',
          endTime: '13:00',
          notes: JSON.stringify({ durationHours: 4 }),
        } as any, 'user-1')).rejects.toThrow(/pricePerHour|isn't priced for hourly/);
      });

      it('prices fractional same-day hourly durations without rounding to a whole hour', async () => {
        listingGetById.mockResolvedValue({ rows: [hourlyListing] });
        const { bookingsService } = await import('./bookings.service.js');

        await bookingsService.createHold({
          listingId: 'TH1',
          serviceCategory: 'driver-hourly',
          scheduledDate: '2026-05-22',
          startTime: '09:30',
          endTime: '11:00',
          notes: JSON.stringify({ durationHours: 1.5 }),
        } as any, 'user-1');

        expect(createPendingBookingHold).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            subtotalPaise: 52_500,
            platformFeePaise: 300,
            taxesPaise: 2_640,
            agreedPricePaise: 55_440,
          }),
        );
      });

      it('rejects when durationHours is out of range', async () => {
        listingGetById.mockResolvedValue({ rows: [hourlyListing] });
        const { bookingsService } = await import('./bookings.service.js');

        await expect(bookingsService.createHold({
          listingId: 'TH1',
          serviceCategory: 'driver-hourly',
          scheduledDate: '2026-05-22',
          startTime: '09:00',
          endTime: '13:00',
          notes: JSON.stringify({ durationHours: 50 }),
        } as any, 'user-1')).rejects.toThrow(/durationHours/);
      });
    });

    describe('transport day mode', () => {
      const dayListing = {
        id: 'TD1', user_id: 'driver-1', category: 'driver-day',
        listing_type: 'transport',
        price: 0, provider_profile_id: 'provider-1',
        metadata: { transportMode: 'day', pricePerDay: 4500 },
        discount_percent: 0,
      };

      it('happy path: persists day subtotal × fees (single day, no days field sent)', async () => {
        listingGetById.mockResolvedValue({ rows: [dayListing] });
        const { bookingsService } = await import('./bookings.service.js');

        await bookingsService.createHold({
          listingId: 'TD1',
          serviceCategory: 'driver-day',
          scheduledDate: '2026-05-22',
          startTime: '09:00',
          endTime: '19:00',
          agreedPrice: 4728.15,
          notes: JSON.stringify({ pickup: 'Hotel Lobby', passengers: 2 }),
        } as any, 'user-1');

        expect(createPendingBookingHold).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            subtotalPaise: 450_000,
            platformFeePaise: 300,
            taxesPaise: 22_515,
            agreedPricePaise: 472_815,
          }),
        );
      });

      it('rejects when client agreedPrice drifts beyond ±₹2', async () => {
        listingGetById.mockResolvedValue({ rows: [dayListing] });
        const { bookingsService } = await import('./bookings.service.js');

        await expect(bookingsService.createHold({
          listingId: 'TD1',
          serviceCategory: 'driver-day',
          scheduledDate: '2026-05-22',
          startTime: '09:00',
          endTime: '19:00',
          agreedPrice: 3000, // server says 4728 → reject
        } as any, 'user-1')).rejects.toThrow(/price has changed|Booking price/);
      });

      it('rejects when metadata.pricePerDay is missing', async () => {
        listingGetById.mockResolvedValue({
          rows: [{ ...dayListing, metadata: { transportMode: 'day' } }],
        });
        const { bookingsService } = await import('./bookings.service.js');

        await expect(bookingsService.createHold({
          listingId: 'TD1',
          serviceCategory: 'driver-day',
          scheduledDate: '2026-05-22',
          startTime: '09:00',
          endTime: '19:00',
        } as any, 'user-1')).rejects.toThrow(/pricePerDay|isn't priced for day/);
      });
    });

    describe('transport day mode — multi-day parity', () => {
      // Proves notes.days flows through computeHoldSubtotalPaise so a
      // 2-day hold = 4500 × 2 = 9000 subtotal → flat fee 3 → 5% GST on 9003
      // = 450 → total ₹9,453.15 (945,315 paise). Matches what the agent's
      // get_booking_price_preview reports for transportDays=2.
      it('honours notes.days for multi-day day bookings', async () => {
        listingGetById.mockResolvedValue({
          rows: [{
            id: 'TD2', user_id: 'driver-1', category: 'driver-day',
            listing_type: 'transport',
            price: 0, provider_profile_id: 'provider-1',
            metadata: { transportMode: 'day', pricePerDay: 4500 },
            discount_percent: 0,
          }],
        });
        const { bookingsService } = await import('./bookings.service.js');

        await bookingsService.createHold({
          listingId: 'TD2',
          serviceCategory: 'driver-day',
          scheduledDate: '2026-05-22',
          startTime: '09:00',
          endTime: '19:00',
          notes: JSON.stringify({ days: 2, pickup: 'Hotel Lobby' }),
        } as any, 'user-1');

        expect(createPendingBookingHold).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            subtotalPaise: 900_000,
            platformFeePaise: 300,
            taxesPaise: 45_015,
            agreedPricePaise: 945_315,
          }),
        );
      });
    });

    describe('service per_hour pricing', () => {
      // Hold reads notes.serviceHours when metadata.pricingUnit === "per_hour"
      // so a multi-hour booking's total matches what the preview tool quoted.
      it('multiplies price × hours when metadata.pricingUnit is per_hour', async () => {
        listingGetById.mockResolvedValue({
          rows: [{
            id: 'SVCH1', user_id: 'provider-1', category: 'yoga-instructor',
            listing_type: 'service', price: 600, provider_profile_id: 'provider-1',
            metadata: { pricingUnit: 'per_hour' }, discount_percent: 0,
          }],
        });
        const { bookingsService } = await import('./bookings.service.js');

        // 600 × 3 = 1800 → flat fee 3 → 18% GST on 1803 = 324.54 → rounds to
        // 32454 paise → total 2127.54 (212,754 paise). The applyFees rounding
        // is exactly Math.round so the expected total here uses that.
        await bookingsService.createHold({
          listingId: 'SVCH1',
          serviceCategory: 'yoga-instructor',
          scheduledDate: '2026-05-22',
          startTime: '09:00',
          endTime: '10:00',
          notes: JSON.stringify({ serviceHours: 3, serviceMode: 'at-home' }),
        } as any, 'user-1');

        expect(createPendingBookingHold).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            subtotalPaise: 180_000,
            platformFeePaise: 300,
            agreedPricePaise: 212_754,
          }),
        );
      });
    });

    describe('transport package mode', () => {
      const packageListing = {
        id: 'TP1', user_id: 'driver-1', category: 'driver-package',
        listing_type: 'transport',
        price: 0, provider_profile_id: 'provider-1',
        metadata: {
          transportMode: 'package',
          packageOptions: [
            { id: 'goa-1d', label: 'Goa Day Tour', price: 3500, hours: 8 },
            { id: 'temple', label: 'Temple loop', price: 1500, hours: 4 },
          ],
        },
        discount_percent: 0,
      };

      it('happy path: persists matched package price × fees', async () => {
        listingGetById.mockResolvedValue({ rows: [packageListing] });
        const { bookingsService } = await import('./bookings.service.js');

        await bookingsService.createHold({
          listingId: 'TP1',
          serviceCategory: 'driver-package',
          scheduledDate: '2026-05-22',
          startTime: '09:00',
          endTime: '17:00',
          agreedPrice: 3678.15,
          notes: JSON.stringify({
            packageId: 'goa-1d', packageLabel: 'Goa Day Tour', pickup: 'Hotel Lobby',
          }),
        } as any, 'user-1');

        expect(createPendingBookingHold).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            subtotalPaise: 350_000,
            platformFeePaise: 300,
            taxesPaise: 17_515,
            agreedPricePaise: 367_815,
          }),
        );
      });

      it('rejects when client agreedPrice drifts beyond ±₹2', async () => {
        listingGetById.mockResolvedValue({ rows: [packageListing] });
        const { bookingsService } = await import('./bookings.service.js');

        await expect(bookingsService.createHold({
          listingId: 'TP1',
          serviceCategory: 'driver-package',
          scheduledDate: '2026-05-22',
          startTime: '09:00',
          endTime: '17:00',
          agreedPrice: 2000, // server says 3678 → reject
          notes: JSON.stringify({ packageId: 'goa-1d' }),
        } as any, 'user-1')).rejects.toThrow(/price has changed|Booking price/);
      });

      it('rejects when packageId is missing from notes', async () => {
        listingGetById.mockResolvedValue({ rows: [packageListing] });
        const { bookingsService } = await import('./bookings.service.js');

        await expect(bookingsService.createHold({
          listingId: 'TP1',
          serviceCategory: 'driver-package',
          scheduledDate: '2026-05-22',
          startTime: '09:00',
          endTime: '17:00',
          notes: JSON.stringify({ pickup: 'Hotel Lobby' }),
        } as any, 'user-1')).rejects.toThrow(/packageId/);
      });

      it('rejects when packageId does not match any option', async () => {
        listingGetById.mockResolvedValue({ rows: [packageListing] });
        const { bookingsService } = await import('./bookings.service.js');

        await expect(bookingsService.createHold({
          listingId: 'TP1',
          serviceCategory: 'driver-package',
          scheduledDate: '2026-05-22',
          startTime: '09:00',
          endTime: '17:00',
          notes: JSON.stringify({ packageId: 'unknown-id' }),
        } as any, 'user-1')).rejects.toThrow(/Selected package not found/);
      });

      it('rejects when metadata.packageOptions is empty', async () => {
        listingGetById.mockResolvedValue({
          rows: [{ ...packageListing, metadata: { transportMode: 'package', packageOptions: [] } }],
        });
        const { bookingsService } = await import('./bookings.service.js');

        await expect(bookingsService.createHold({
          listingId: 'TP1',
          serviceCategory: 'driver-package',
          scheduledDate: '2026-05-22',
          startTime: '09:00',
          endTime: '17:00',
          notes: JSON.stringify({ packageId: 'goa-1d' }),
        } as any, 'user-1')).rejects.toThrow(/packageOptions|isn't priced for package/);
      });

      it('rejects when listing.metadata.transportMode conflicts with requested category', async () => {
        // Operator switched the listing to hourly and no package prices remain.
        // The backend now gates each requested mode by its concrete price field,
        // not by the listing's primary/default transportMode alone.
        listingGetById.mockResolvedValue({
          rows: [{ ...packageListing, metadata: { transportMode: 'hourly', pricePerHour: 350 } }],
        });
        const { bookingsService } = await import('./bookings.service.js');

        await expect(bookingsService.createHold({
          listingId: 'TP1',
          serviceCategory: 'driver-package',
          scheduledDate: '2026-05-22',
          startTime: '09:00',
          endTime: '17:00',
          notes: JSON.stringify({ packageId: 'goa-1d' }),
        } as any, 'user-1')).rejects.toThrow(/isn't priced for package/);
      });
    });

    // ─── Existing prebook path still works (regression guard) ────────────────
    it('regression: driver-cab prebook still prices base + perKm × km (unchanged)', async () => {
      listingGetById.mockResolvedValue({
        rows: [{
          id: 'TC1', user_id: 'driver-1', category: 'driver-cab',
          listing_type: 'transport',
          price: 0, provider_profile_id: 'provider-1',
          // No transportMode set — legacy listing pre-Phase-1.
          metadata: { pricePerKm: 14 },
          discount_percent: 0,
        }],
      });
      const { bookingsService } = await import('./bookings.service.js');

      // Subtotal: 14 × 20 = 280 → flat fee ₹3 → 5% GST on (280+3)=283 = 14.15
      // → total 297.15 → 29_715 paise.
      await bookingsService.createHold({
        listingId: 'TC1',
        serviceCategory: 'driver-cab',
        scheduledDate: '2026-05-22',
        startTime: '09:00',
        endTime: '10:00',
        notes: JSON.stringify({ estimatedKm: 20, pickup: 'A', drop: 'B' }),
      } as any, 'user-1');

      expect(createPendingBookingHold).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          subtotalPaise: 28_000,
          platformFeePaise: 300,
          // 5% GST on (28000+300) = 1415
          taxesPaise: 1_415,
          agreedPricePaise: 29_715,
        }),
      );
    });

    // ─── Existing driver-quote path still works (regression guard) ───────────
    it('regression: driver-quote still uses transport_quotes.provider_quote_paise', async () => {
      listingGetById.mockResolvedValue({
        rows: [{
          id: 'TQ1', user_id: 'driver-1', category: 'driver-quote',
          listing_type: 'transport',
          price: 0, provider_profile_id: 'provider-1',
          metadata: {},
          discount_percent: 0,
        }],
      });
      // The quote repo is dynamic-imported by computeHoldSubtotalPaise; mock it
      // the same way the multi-night-stay block mocks availability overrides.
      vi.doMock('../../transport-quotes/repositories/transport-quotes.repository.js', () => ({
        transportQuotesRepository: {
          getById: vi.fn(async () => ({ rows: [{ provider_quote_paise: 75_000 }] })),
        },
      }));
      // Re-import service so the doMock takes effect for the dynamic import
      // chain inside computeHoldSubtotalPaise.
      vi.resetModules();
      const { bookingsService } = await import('./bookings.service.js');

      await bookingsService.createHold({
        listingId: 'TQ1',
        serviceCategory: 'driver-quote',
        scheduledDate: '2026-05-22',
        startTime: '09:00',
        endTime: '17:00',
        notes: JSON.stringify({ quoteId: 'Q1', pickup: 'A', drop: 'B' }),
      } as any, 'user-1');

      // Subtotal 750 → flat fee ₹3 → 5% GST on 753 = 37.65 → 3765 paise → total 790.65 → 79_065 paise.
      expect(createPendingBookingHold).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          subtotalPaise: 75_000,
          platformFeePaise: 300,
          taxesPaise: 3_765,
          agreedPricePaise: 79_065,
        }),
      );
    });
  });
});
