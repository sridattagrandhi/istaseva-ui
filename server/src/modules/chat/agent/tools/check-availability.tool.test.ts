// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listForListing = vi.fn();
const listRoomsForListing = vi.fn();
const listBookedDatesForListing = vi.fn();

vi.mock('../../../listings/services/availability-overrides.service.js', () => ({
  availabilityOverridesService: { listForListing },
}));
vi.mock('../../../listings/repositories/room-types.repository.js', () => ({
  roomTypesRepository: { listForListing: listRoomsForListing },
}));
vi.mock('../../../bookings/repositories/bookings.repository.js', () => ({
  bookingsRepository: { listBookedDatesForListing },
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
  listForListing.mockResolvedValue({ data: [] });
  listRoomsForListing.mockResolvedValue({ rows: [] });
  listBookedDatesForListing.mockResolvedValue({ rows: [] });
});

describe('check_availability — inventory awareness', () => {
  it('homestay with no overrides and no bookings: available', async () => {
    const { checkAvailabilityTool } = await import('./check-availability.tool.js');
    const result = await checkAvailabilityTool.execute(
      { listingId: 'l1', date: '2026-05-21', checkOutDate: '2026-05-22' } as any,
      ctx,
    );
    expect(result.available).toBe(true);
  });

  it('listing-level block: every room is unavailable, reason=blocked', async () => {
    listRoomsForListing.mockResolvedValue({
      rows: [
        { id: 'rt1', name: 'Deluxe', base_price_paise: 400_000, max_guests: 2, quantity: 3 },
        { id: 'rt2', name: 'Suite', base_price_paise: 800_000, max_guests: 4, quantity: 2 },
      ],
    });
    listForListing.mockResolvedValue({
      data: [{ date: '2026-05-21', blocked: true, price_paise: null, room_type_id: null }],
    });
    const { checkAvailabilityTool } = await import('./check-availability.tool.js');
    const result = await checkAvailabilityTool.execute(
      { listingId: 'l1', date: '2026-05-21', checkOutDate: '2026-05-22' } as any,
      ctx,
    );
    expect(result.available).toBe(false);
    expect(result.reason).toBe('blocked');
    expect(result.blockedDates).toContain('2026-05-21');
    // BOTH rooms should be marked unavailable.
    expect(result.roomTypes?.every((rt) => !rt.available)).toBe(true);
  });

  it('room-level block on rt1: rt1 unavailable, rt2 still available', async () => {
    listRoomsForListing.mockResolvedValue({
      rows: [
        { id: 'rt1', name: 'Deluxe', base_price_paise: 400_000, max_guests: 2, quantity: 3 },
        { id: 'rt2', name: 'Suite', base_price_paise: 800_000, max_guests: 4, quantity: 2 },
      ],
    });
    listForListing.mockResolvedValue({
      data: [{ date: '2026-05-21', blocked: true, price_paise: null, room_type_id: 'rt1' }],
    });
    const { checkAvailabilityTool } = await import('./check-availability.tool.js');
    const result = await checkAvailabilityTool.execute(
      { listingId: 'l1', date: '2026-05-21', checkOutDate: '2026-05-22' } as any,
      ctx,
    );
    expect(result.available).toBe(true);
    const rt1 = result.roomTypes?.find((r) => r.id === 'rt1');
    const rt2 = result.roomTypes?.find((r) => r.id === 'rt2');
    expect(rt1?.available).toBe(false);
    expect(rt1?.unavailableReason).toBe('blocked');
    expect(rt2?.available).toBe(true);
  });

  it('one room sold out, another available: top-level still available with per-room status', async () => {
    listRoomsForListing.mockResolvedValue({
      rows: [
        { id: 'rt1', name: 'Deluxe', base_price_paise: 400_000, max_guests: 2, quantity: 1 },
        { id: 'rt2', name: 'Suite', base_price_paise: 800_000, max_guests: 4, quantity: 2 },
      ],
    });
    // rt1's only room is booked on 5/21.
    listBookedDatesForListing.mockImplementation((_listingId: string, roomTypeId?: string) => {
      if (roomTypeId === 'rt1') return Promise.resolve({ rows: [{ date: '2026-05-21' }] });
      return Promise.resolve({ rows: [] });
    });
    const { checkAvailabilityTool } = await import('./check-availability.tool.js');
    const result = await checkAvailabilityTool.execute(
      { listingId: 'l1', date: '2026-05-21', checkOutDate: '2026-05-22' } as any,
      ctx,
    );
    expect(result.available).toBe(true);
    const rt1 = result.roomTypes?.find((r) => r.id === 'rt1');
    const rt2 = result.roomTypes?.find((r) => r.id === 'rt2');
    expect(rt1?.available).toBe(false);
    expect(rt1?.unavailableReason).toBe('booked');
    expect(rt1?.unavailableDates).toEqual(['2026-05-21']);
    expect(rt2?.available).toBe(true);
  });

  it('all rooms fully booked: returns reason=fully_booked with unioned bookedDates', async () => {
    listRoomsForListing.mockResolvedValue({
      rows: [
        { id: 'rt1', name: 'Deluxe', base_price_paise: 400_000, max_guests: 2, quantity: 1 },
        { id: 'rt2', name: 'Suite', base_price_paise: 800_000, max_guests: 4, quantity: 1 },
      ],
    });
    listBookedDatesForListing.mockImplementation((_listingId: string, roomTypeId?: string) => {
      // BOTH rooms booked on different nights; this is exactly the case the
      // listing-wide query would miss (no night has every room booked).
      if (roomTypeId === 'rt1') return Promise.resolve({ rows: [{ date: '2026-05-21' }, { date: '2026-05-22' }] });
      if (roomTypeId === 'rt2') return Promise.resolve({ rows: [{ date: '2026-05-21' }, { date: '2026-05-22' }] });
      return Promise.resolve({ rows: [] });
    });
    const { checkAvailabilityTool } = await import('./check-availability.tool.js');
    const result = await checkAvailabilityTool.execute(
      { listingId: 'l1', date: '2026-05-21', checkOutDate: '2026-05-23' } as any,
      ctx,
    );
    expect(result.available).toBe(false);
    expect(result.reason).toBe('fully_booked');
    expect(result.bookedDates).toEqual(['2026-05-21', '2026-05-22']);
  });

  it('roomTypeId pinned + that room sold out: reason=room_full with bookedDates', async () => {
    listRoomsForListing.mockResolvedValue({
      rows: [{ id: 'rt1', name: 'Deluxe', base_price_paise: 400_000, max_guests: 2, quantity: 1 }],
    });
    listBookedDatesForListing.mockImplementation((_listingId: string, roomTypeId?: string) => {
      if (roomTypeId === 'rt1') return Promise.resolve({ rows: [{ date: '2026-05-21' }] });
      return Promise.resolve({ rows: [] });
    });
    const { checkAvailabilityTool } = await import('./check-availability.tool.js');
    const result = await checkAvailabilityTool.execute(
      { listingId: 'l1', date: '2026-05-21', checkOutDate: '2026-05-22', roomTypeId: 'rt1' } as any,
      ctx,
    );
    expect(result.available).toBe(false);
    expect(result.reason).toBe('room_full');
    expect(result.bookedDates).toEqual(['2026-05-21']);
  });
});
