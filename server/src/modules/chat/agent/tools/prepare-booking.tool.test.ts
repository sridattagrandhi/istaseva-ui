// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../../../common/errors/app-error.js';

const prepare = vi.fn();
const listForListing = vi.fn();

vi.mock('../../services/assistant-booking.service.js', () => ({
  assistantBookingService: { prepare },
}));
vi.mock('../../../listings/repositories/room-types.repository.js', () => ({
  roomTypesRepository: { listForListing },
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

describe('prepareBookingTool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes through roomTypeId, guestCount, insuranceOptIn to the service', async () => {
    const { prepareBookingTool } = await import('./prepare-booking.tool.js');
    prepare.mockResolvedValue({
      bookingId: 'b1',
      holdExpiresAt: '2026-05-21T00:00:00Z',
      orderId: 'o1',
      paymentId: 'p1',
      keyId: 'rzp_test',
      amount: 4800,
      amountPaise: 480000,
      currency: 'INR',
      listing: { id: 'l1', name: 'Marriott' },
      schedule: { scheduledDate: '2026-05-21', startTime: '14:00', endTime: '23:59' },
      room: { id: 'rt1', name: 'Deluxe', pricePerNight: 4800 },
      insurance: { included: true, amount: 48 },
    });
    const args = {
      listingId: 'l1',
      scheduledDate: '2026-05-21',
      checkOutDate: '2026-05-22',
      roomTypeId: 'rt1',
      guestCount: 2,
      insuranceOptIn: true,
    } as any;
    const result = await prepareBookingTool.execute(args, ctx);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId: 'l1',
        roomTypeId: 'rt1',
        guestCount: 2,
        insuranceOptIn: true,
      }),
      'u1',
    );
    expect(result.success).toBe(true);
  });

  it('hydrates roomOptions when the service throws room_required', async () => {
    const { prepareBookingTool } = await import('./prepare-booking.tool.js');
    prepare.mockRejectedValue(new ValidationError('This stay has multiple room types — which one? Options: Deluxe (₹4800/night), Suite (₹8200/night)'));
    listForListing.mockResolvedValue({
      rows: [
        { id: 'rt1', name: 'Deluxe', base_price_paise: 480000, max_guests: 2 },
        { id: 'rt2', name: 'Suite', base_price_paise: 820000, max_guests: 3 },
      ],
    });
    const result = await prepareBookingTool.execute(
      { listingId: 'l1', scheduledDate: '2026-05-21', checkOutDate: '2026-05-22' } as any,
      ctx,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('room_required');
      // The agent gets structured options it can map directly to a roomTypeId
      // on the user's next reply, without a fresh get_listing_details call.
      expect(result.roomOptions).toEqual([
        { id: 'rt1', name: 'Deluxe', pricePerNight: 4800, maxGuests: 2 },
        { id: 'rt2', name: 'Suite', pricePerNight: 8200, maxGuests: 3 },
      ]);
    }
  });

  it('returns auth_required without hitting the service when no user', async () => {
    const { prepareBookingTool } = await import('./prepare-booking.tool.js');
    const result = await prepareBookingTool.execute(
      { listingId: 'l1', scheduledDate: '2026-05-21' } as any,
      { ...ctx, userId: undefined },
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('auth_required');
  });
});

describe('prepareBookingTool — service/transport pass-through', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards serviceMode and serviceAddress for at-home services', async () => {
    const { prepareBookingTool } = await import('./prepare-booking.tool.js');
    prepare.mockResolvedValue({
      bookingId: 'b2',
      holdExpiresAt: '2026-05-21T00:00:00Z',
      orderId: 'o2',
      paymentId: 'p2',
      keyId: 'rzp_test',
      amount: 500,
      amountPaise: 50000,
      currency: 'INR',
      listing: { id: 'l2', name: 'Cleaning Co' },
      schedule: { scheduledDate: '2026-05-21', startTime: '11:00', endTime: '12:00' },
      insurance: { included: false, amount: 0 },
    });
    await prepareBookingTool.execute({
      listingId: 'l2',
      scheduledDate: '2026-05-21',
      startTime: '11:00',
      endTime: '12:00',
      serviceMode: 'at-home',
      serviceAddress: '12 MG Road, Hyderabad',
    } as any, ctx);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceMode: 'at-home',
        serviceAddress: '12 MG Road, Hyderabad',
      }),
      'u1',
    );
  });

  it('forwards transportMode + transportHours + pickupLocation for hourly cab', async () => {
    const { prepareBookingTool } = await import('./prepare-booking.tool.js');
    prepare.mockResolvedValue({
      bookingId: 'b3',
      holdExpiresAt: '2026-05-21T00:00:00Z',
      orderId: 'o3',
      paymentId: 'p3',
      keyId: 'rzp_test',
      amount: 2800,
      amountPaise: 280000,
      currency: 'INR',
      listing: { id: 'l3', name: 'Suresh Cab' },
      schedule: { scheduledDate: '2026-05-21', startTime: '09:00', endTime: '17:00' },
      insurance: { included: false, amount: 0 },
    });
    await prepareBookingTool.execute({
      listingId: 'l3',
      scheduledDate: '2026-05-21',
      transportMode: 'hourly',
      transportHours: 8,
      pickupLocation: 'Banjara Hills',
    } as any, ctx);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        transportMode: 'hourly',
        transportHours: 8,
        pickupLocation: 'Banjara Hills',
      }),
      'u1',
    );
  });

  it('classifies service-mode validation failures as invalid_dates with the service message', async () => {
    const { prepareBookingTool } = await import('./prepare-booking.tool.js');
    prepare.mockRejectedValue(new ValidationError('Where should the provider come to? Share the address you\'d like them at.'));
    const result = await prepareBookingTool.execute({
      listingId: 'l2',
      scheduledDate: '2026-05-21',
      serviceMode: 'at-home',
    } as any, ctx);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.userMessage).toMatch(/address/i);
    }
  });

  it('maps AddOnOfferRequiredError to a structured addon_offer_required failure (oral, no action)', async () => {
    const { prepareBookingTool } = await import('./prepare-booking.tool.js');
    const { AddOnOfferRequiredError } = await import('../../services/assistant-booking.errors.js');
    prepare.mockRejectedValue(new AddOnOfferRequiredError("Truefitt & Hill", "Women's Haircut", [
      { id: 'a-blow', label: 'Blow Dry', price: 300 },
      { id: 'a-wash', label: 'Hair Wash', price: 147 },
    ]));
    const args = {
      listingId: 'l-salon',
      scheduledDate: '2026-07-01',
      serviceMode: 'visit-provider',
      serviceCatalogId: 'svc-1',
    } as any;
    const result = await prepareBookingTool.execute(args, ctx);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('addon_offer_required');
      expect(result.addOns).toEqual([
        { id: 'a-blow', label: 'Blow Dry', price: 300 },
        { id: 'a-wash', label: 'Hair Wash', price: 147 },
      ]);
      // bookingArgs echoed so the retry reuses everything already collected.
      expect(result.bookingArgs).toMatchObject({ listingId: 'l-salon', serviceCatalogId: 'svc-1' });
      // userMessage names the extras + prices and asks whether to add them.
      expect(result.userMessage).toMatch(/Blow Dry/);
      expect(result.userMessage).toMatch(/300/);
      expect(result.userMessage).toMatch(/Women's Haircut/);
    }
  });

});
