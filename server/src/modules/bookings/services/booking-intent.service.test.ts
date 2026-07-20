// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const createHold = vi.fn();
const releaseHold = vi.fn();
const createOrder = vi.fn();

vi.mock('./bookings.service.js', () => ({
  bookingsService: {
    createHold: (...a: unknown[]) => createHold(...a),
    releaseHold: (...a: unknown[]) => releaseHold(...a),
  },
}));
vi.mock('../../payments/services/payments.service.js', () => ({
  paymentsService: {
    createOrder: (...a: unknown[]) => createOrder(...a),
  },
}));
vi.mock('../../../common/logging/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Imported after mocks are registered.
import { bookingIntentService } from './booking-intent.service.js';

const ORDER = { orderId: 'o1', paymentId: 'p1', keyId: 'k1', amount: 3500, amountPaise: 350000, currency: 'INR' };

function holdReturning(agreedPricePaise: number, bookingId = 'bk1') {
  return {
    data: {
      booking: { id: bookingId, agreed_price_paise: agreedPricePaise },
      hold: { expiresAt: '2026-07-15T10:05:00.000Z' },
    },
  };
}

describe('bookingIntentService.executeHoldAndOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // releaseHold is always awaited with `.catch(...)` — return a promise.
    releaseHold.mockResolvedValue(undefined);
  });

  it('creates the hold, then the order against the SERVER price, and returns the combined result', async () => {
    createHold.mockResolvedValue(holdReturning(350000, 'bk1'));
    createOrder.mockResolvedValue(ORDER);

    const result = await bookingIntentService.executeHoldAndOrder(
      { hold: { listingId: 'l1' } as never, insuranceOptIn: false, orderIdempotencyKeyPrefix: 'assistant-order-u1' },
      'u1',
    );

    // Hold is created with the caller's payload + userId.
    expect(createHold).toHaveBeenCalledWith({ listingId: 'l1' }, 'u1');
    // Order uses the SERVER-stored price (agreed_price_paise/100), not any client number,
    // and the idempotency key is "<prefix>-<bookingId>".
    expect(createOrder).toHaveBeenCalledWith(
      { bookingId: 'bk1', amount: 3500, currency: 'INR', insuranceOptIn: false, idempotencyKey: 'assistant-order-u1-bk1' },
      'u1',
    );
    expect(result.agreedPrice).toBe(3500);
    expect(result.agreedPricePaise).toBe(350000);
    expect(result.holdExpiresAt).toBe('2026-07-15T10:05:00.000Z');
    expect(result.order).toEqual(ORDER);
    expect((result.booking as { id: string }).id).toBe('bk1');
    // No release on the happy path.
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it('forwards insuranceOptIn to createOrder', async () => {
    createHold.mockResolvedValue(holdReturning(350000, 'bk1'));
    createOrder.mockResolvedValue(ORDER);
    await bookingIntentService.executeHoldAndOrder(
      { hold: {} as never, insuranceOptIn: true, orderIdempotencyKeyPrefix: 'pfx' },
      'u1',
    );
    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ insuranceOptIn: true }), 'u1');
  });

  it('releases the hold and throws when the server price is missing/zero (never orders at ₹0)', async () => {
    createHold.mockResolvedValue(holdReturning(0, 'bk2'));

    await expect(
      bookingIntentService.executeHoldAndOrder(
        { hold: {} as never, orderIdempotencyKeyPrefix: 'pfx' },
        'u1',
      ),
    ).rejects.toThrow(/pricing was not available/i);

    expect(createOrder).not.toHaveBeenCalled();
    expect(releaseHold).toHaveBeenCalledWith('bk2', 'u1');
  });

  it('releases the hold and rethrows when order creation fails (no phantom pending booking)', async () => {
    createHold.mockResolvedValue(holdReturning(350000, 'bk3'));
    createOrder.mockRejectedValue(new Error('razorpay down'));

    await expect(
      bookingIntentService.executeHoldAndOrder(
        { hold: {} as never, orderIdempotencyKeyPrefix: 'pfx' },
        'u1',
      ),
    ).rejects.toThrow('razorpay down');

    expect(releaseHold).toHaveBeenCalledWith('bk3', 'u1');
  });
});

describe('bookingIntentService.prepare', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseHold.mockResolvedValue(undefined);
  });

  it('builds the hold (notes + params) and assembles a stay result', async () => {
    createHold.mockResolvedValue(holdReturning(350000, 'bkS'));
    createOrder.mockResolvedValue({ ...ORDER, amount: 3678, amountPaise: 367800 });

    const result = await bookingIntentService.prepare(
      {
        listingType: 'stay',
        listingId: 'stay-1',
        serviceCategory: 'stay:hotel',
        scheduledDate: '2026-07-15',
        checkOutDate: '2026-07-17',
        startTime: '14:00',
        endTime: '11:00',
        roomTypeId: 'room-1',
        roomName: 'Deluxe',
        roomPricePerNight: 3500,
        numberOfRooms: 2,
        couponCode: 'SAVE10',
        address: 'Hyderabad',
        guestCount: 3,
        contact: { name: 'Asha', phone: '999' },
        guestName: 'Asha',
        listingName: 'Trident',
        listingImage: 'img.jpg',
        listingLocation: 'Hyderabad',
        insuranceOptIn: true,
      },
      'u1',
    );

    // Hold params resolved server-side.
    const holdArg = createHold.mock.calls[0][0] as Record<string, unknown>;
    expect(holdArg).toMatchObject({
      listingId: 'stay-1',
      serviceCategory: 'stay:hotel',
      scheduledDate: '2026-07-15',
      startTime: '14:00',
      endTime: '11:00',
      endDate: '2026-07-17',
      roomTypeId: 'room-1',
      numberOfRooms: 2,
      couponCode: 'SAVE10',
      address: 'Hyderabad',
    });
    // Notes built by the unified builder.
    const notes = JSON.parse(String(holdArg.notes));
    expect(notes).toMatchObject({ stayId: 'stay-1', guests: 3, guestName: 'Asha', contact: { name: 'Asha', phone: '999' } });

    // Result decoration.
    expect(result.bookingId).toBe('bkS');
    expect(result.amount).toBe(3678); // order amount incl. insurance
    expect(result.listing).toMatchObject({ id: 'stay-1', name: 'Trident', image: 'img.jpg', location: 'Hyderabad' });
    expect(result.schedule).toMatchObject({ scheduledDate: '2026-07-15', checkOutDate: '2026-07-17', nights: 2 });
    expect(result.room).toMatchObject({ id: 'room-1', name: 'Deluxe', pricePerNight: 3500 });
    expect(result.insurance.included).toBe(true);
    expect(result.insurance.amount).toBeGreaterThan(0); // flat protection premium
  });

  it('assembles a transport package result', async () => {
    createHold.mockResolvedValue(holdReturning(350000, 'bkT'));
    createOrder.mockResolvedValue(ORDER);

    const result = await bookingIntentService.prepare(
      {
        listingType: 'transport',
        listingId: 't-1',
        serviceCategory: 'driver-cab',
        scheduledDate: '2026-07-15',
        transportMode: 'package',
        transportPackageId: 'pkg1',
        pickupLocation: 'Banjara Hills',
        passengerCount: 2,
        listingName: 'Raji Tours',
      },
      'u1',
    );

    expect(result.transport).toMatchObject({ mode: 'package', packageId: 'pkg1', pickupLocation: 'Banjara Hills', passengerCount: 2 });
    expect(result.room).toBeUndefined();
    expect(result.insurance).toEqual({ included: false, amount: 0 });
  });

  it('throws when serviceCategory is missing', async () => {
    await expect(
      bookingIntentService.prepare(
        { listingType: 'stay', listingId: 'x', scheduledDate: '2026-07-15' } as never,
        'u1',
      ),
    ).rejects.toThrow(/serviceCategory is required/i);
    expect(createHold).not.toHaveBeenCalled();
  });
});
