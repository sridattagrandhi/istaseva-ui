// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const listForUser = vi.fn();

vi.mock('../../../bookings/services/bookings.service.js', () => ({
  bookingsService: { listForUser: (...args: unknown[]) => listForUser(...args) },
}));

const ctx = { userId: 'u1' } as never;

// Far-past / far-future so isFuture is deterministic regardless of the clock.
const PAST = '2020-01-01';
const FUTURE = '2099-12-31';
const SOONER_FUTURE = '2099-06-01';

describe('get_booking_insights', () => {
  beforeEach(() => vi.clearAllMocks());

  async function run() {
    const { getBookingInsightsTool } = await import('./get-booking-insights.tool.js');
    return getBookingInsightsTool.execute({}, ctx);
  }

  it('reports empty when the user has no bookings', async () => {
    listForUser.mockResolvedValue({ data: [] });
    const r = await run();
    expect(r.empty).toBe(true);
    expect(r.counts.total).toBe(0);
    expect(r.totalSpentPaise).toBe(0);
    expect(r.nextTrip).toBeUndefined();
  });

  it('counts buckets, sums charged spend, and picks the earliest future trip', async () => {
    listForUser.mockResolvedValue({
      data: [
        { id: 'b1', status: 'confirmed', scheduled_date: FUTURE, listing_name: 'Far Trip', payment_amount_paise: 500000 },
        { id: 'b2', status: 'confirmed', scheduled_date: SOONER_FUTURE, listing_name: 'Soon Trip', payment_amount_paise: 300000 },
        { id: 'b3', status: 'completed', scheduled_date: PAST, listing_name: 'Old Trip', payment_amount_paise: 200000 },
        { id: 'b4', status: 'cancelled', scheduled_date: FUTURE, listing_name: 'Dropped', payment_amount_paise: 999999 },
      ],
    });
    const r = await run();
    expect(r.empty).toBe(false);
    expect(r.counts).toMatchObject({ upcoming: 2, past: 1, cancelled: 1, total: 4 });
    // Spend excludes the cancelled booking (999999) — only b1+b2+b3.
    expect(r.totalSpentPaise).toBe(1000000);
    expect(r.totalSpent).toBe('₹10,000');
    // Earliest future non-cancelled = b2 (SOONER_FUTURE), not b1.
    expect(r.nextTrip).toMatchObject({ id: 'b2', listing: 'Soon Trip', date: SOONER_FUTURE });
  });

  it('ignores pending/expired holds in counts and spend', async () => {
    listForUser.mockResolvedValue({
      data: [
        { id: 'h1', status: 'pending', scheduled_date: FUTURE, payment_amount_paise: 111111 },
        { id: 'h2', status: 'expired', scheduled_date: FUTURE, payment_amount_paise: 222222 },
        { id: 'b1', status: 'confirmed', scheduled_date: FUTURE, payment_amount_paise: 100000 },
      ],
    });
    const r = await run();
    expect(r.counts.total).toBe(1);
    expect(r.totalSpentPaise).toBe(100000);
  });

  it('handles bookings with no completed payment (spend stays 0 but still counted)', async () => {
    listForUser.mockResolvedValue({
      data: [{ id: 'b1', status: 'confirmed', scheduled_date: FUTURE, listing_name: 'Seeded' }],
    });
    const r = await run();
    expect(r.counts.upcoming).toBe(1);
    expect(r.totalSpentPaise).toBe(0);
    expect(r.nextTrip).toMatchObject({ id: 'b1', listing: 'Seeded' });
  });
});
