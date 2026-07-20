// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, ValidationError } from '../../../common/errors/app-error.js';

const getByUserId = vi.fn();
const create = vi.fn();

vi.mock('../repositories/providers.repository.js', () => ({
  providersRepository: {
    getByUserId,
    create,
  },
}));

const rows = (r: unknown[] = []) => Promise.resolve({ rows: r });
const insightsRepo = {
  bookingSeries: vi.fn(() => rows()),
  statusMix: vi.fn(() => rows()),
  cancelReasons: vi.fn(() => rows()),
  paymentFailures: vi.fn(() => rows()),
  repeatStats: vi.fn(() => rows([{ bookers: '4', repeat_bookers: '1', median_days_to_second: '12.4' }])),
  leadTime: vi.fn(() => rows([{ median_days: '3', avg_days: '4.2' }])),
  searchDemand: vi.fn(() => rows()),
  ownerListingProfile: vi.fn(() => rows()),
  searchPlaceDemand: vi.fn(() => rows()),
  listingFunnel: vi.fn(() => rows()),
  demandHeatmap: vi.fn(() => rows()),
  stayOccupancy: vi.fn(() => rows()),
  stayRoomInventory: vi.fn(() => rows([{ rooms: '0' }])),
  transportDemand: vi.fn(() => rows()),
};

vi.mock('../repositories/provider-insights.repository.js', () => ({
  providerInsightsRepository: insightsRepo,
}));

// getMyEarnings talks to the DB directly (module-level SQL, not a repository).
const dbQuery = vi.fn(() => rows());
vi.mock('../../../common/repositories/database.js', () => ({
  dbQuery: (...args: unknown[]) => dbQuery(...(args as [])),
}));

describe('ProvidersService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a provider profile for the authenticated user', async () => {
    create.mockResolvedValueOnce({ rows: [{ id: 'provider-1', user_id: 'user-1', display_name: 'Spark Works' }] });
    const { providersService } = await import('./providers.service.js');

    const result = await providersService.createProfile('user-1', {
      display_name: 'Spark Works',
      service_categories: ['Electrical'],
    });

    expect(result.data.user_id).toBe('user-1');
  });

  it('returns my provider profile', async () => {
    getByUserId.mockResolvedValueOnce({ rows: [{ id: 'provider-1', user_id: 'user-1' }] });
    const { providersService } = await import('./providers.service.js');

    const result = await providersService.getMyProfile('user-1');
    expect(result.data.id).toBe('provider-1');
  });

  it('throws when the provider profile does not exist', async () => {
    getByUserId.mockResolvedValueOnce({ rows: [] });
    const { providersService } = await import('./providers.service.js');

    await expect(providersService.getMyProfile('user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  describe('getMyInsights', () => {
    it('rejects an unknown category before touching any data', async () => {
      const { providersService } = await import('./providers.service.js');

      await expect(providersService.getMyInsights('user-1', { category: 'everything' })).rejects.toBeInstanceOf(ValidationError);
      expect(insightsRepo.bookingSeries).not.toHaveBeenCalled();
      expect(insightsRepo.searchDemand).not.toHaveBeenCalled();
    });

    it("scopes booking queries to the caller's provider id and the funnel to the caller's user id", async () => {
      getByUserId.mockResolvedValueOnce({ rows: [{ id: 'provider-1', user_id: 'user-1' }] });
      const { providersService } = await import('./providers.service.js');

      const result = await providersService.getMyInsights('user-1', { category: 'stay', days: '30' });

      // The authorization boundary: every booking-derived query is keyed by the
      // resolved provider_profiles.id, never by anything client-supplied.
      // bookingSeries/repeatStats/leadTime run twice (current + previous window).
      for (const fn of [insightsRepo.statusMix, insightsRepo.cancelReasons, insightsRepo.paymentFailures]) {
        expect(fn).toHaveBeenCalledTimes(1);
      }
      for (const fn of [insightsRepo.bookingSeries, insightsRepo.repeatStats, insightsRepo.leadTime]) {
        expect(fn).toHaveBeenCalledTimes(2);
      }
      for (const fn of [insightsRepo.bookingSeries, insightsRepo.statusMix, insightsRepo.cancelReasons, insightsRepo.paymentFailures, insightsRepo.repeatStats, insightsRepo.leadTime, insightsRepo.demandHeatmap]) {
        for (const call of fn.mock.calls) {
          expect(call[0]).toBe('provider-1');
          expect(call[1]).toBe('stay');
        }
      }
      // Stay occupancy is provider-scoped (current + previous window); room
      // inventory is ownership-scoped like the funnel.
      expect(insightsRepo.stayOccupancy).toHaveBeenCalledTimes(2);
      expect(insightsRepo.stayOccupancy.mock.calls[0][0]).toBe('provider-1');
      expect(insightsRepo.stayRoomInventory).toHaveBeenCalledTimes(1);
      expect(insightsRepo.stayRoomInventory.mock.calls[0][0]).toBe('user-1');
      expect(insightsRepo.transportDemand).not.toHaveBeenCalled();
      // The rollup funnel has no owner column — ownership comes from the
      // listings join keyed on the caller's user id.
      expect(insightsRepo.listingFunnel).toHaveBeenCalledTimes(1);
      expect(insightsRepo.listingFunnel.mock.calls[0][0]).toBe('user-1');
      expect(result.data.repeat).toEqual({ bookers: 4, repeatBookers: 1, repeatRate: 25, medianDaysToSecond: 12.4 });
      expect(result.data.leadTime).toEqual({ medianDays: 3, avgDays: 4.2 });
      // Same-length previous window, computed from the same repeat/lead mocks.
      expect(result.data.prev.repeat.repeatRate).toBe(25);
      expect(result.data.prev.leadTime.medianDays).toBe(3);
      expect(result.data.stay).toEqual({
        rooms: 0,
        series: [],
        totals: { roomNights: 0, occupancyPct: null, adrPaise: null },
        prevTotals: { occupancyPct: null, adrPaise: null },
      });
      expect(result.data.transport).toBeNull();
    });

    it('skips booking queries (but not search demand) when no provider profile exists', async () => {
      getByUserId.mockResolvedValueOnce({ rows: [] });
      const { providersService } = await import('./providers.service.js');

      const result = await providersService.getMyInsights('user-1', { category: 'service' });

      expect(insightsRepo.bookingSeries).not.toHaveBeenCalled();
      expect(insightsRepo.searchDemand).toHaveBeenCalledTimes(1);
      expect(result.data.series).toEqual([]);
      expect(result.data.repeat.bookers).toBe(0);
      // No listings → no niche keywords, no place scope.
      expect(insightsRepo.searchDemand.mock.calls[0][3]).toBeUndefined();
      expect(insightsRepo.searchPlaceDemand).not.toHaveBeenCalled();
      expect(result.data.searchDemandScope).toBe('category');
      expect(result.data.searchPlaces).toEqual([]);
    });

    it("narrows search demand to the caller's listing keywords and operating places", async () => {
      getByUserId.mockResolvedValueOnce({ rows: [{ id: 'provider-1', user_id: 'user-1' }] });
      insightsRepo.ownerListingProfile.mockImplementationOnce(() =>
        rows([{ name: 'Sparkle Salon', category: 'salon', service_categories: ['haircut', 'salon'], city: 'Hyderabad', state: 'Telangana' }]),
      );
      insightsRepo.searchDemand.mockImplementationOnce(() => rows([{ term: 'salon near me', count: '7' }]));
      insightsRepo.searchPlaceDemand.mockImplementationOnce(() =>
        rows([{ region_type: 'city', region: 'hyderabad', count: '12' }]),
      );
      const { providersService } = await import('./providers.service.js');

      const result = await providersService.getMyInsights('user-1', { category: 'service' });

      // Keywords derive from listing category/subtypes/name, lowercased.
      expect(insightsRepo.searchDemand).toHaveBeenCalledTimes(1);
      const keywords = insightsRepo.searchDemand.mock.calls[0][3] as string[];
      expect(keywords).toEqual(expect.arrayContaining(['salon', 'haircut', 'sparkle']));
      // Place scope is the listing's city/state, lowercased.
      expect(insightsRepo.searchPlaceDemand).toHaveBeenCalledTimes(1);
      expect(insightsRepo.searchPlaceDemand.mock.calls[0][3]).toEqual(['hyderabad']);
      expect(insightsRepo.searchPlaceDemand.mock.calls[0][4]).toEqual(['telangana']);
      expect(result.data.searchDemandScope).toBe('niche');
      expect(result.data.searchDemand).toEqual([{ term: 'salon near me', count: 7 }]);
      expect(result.data.searchPlaces).toEqual([{ regionType: 'city', region: 'hyderabad', count: 12 }]);
    });

    it('falls back to the unfiltered category list when the niche filter matches nothing', async () => {
      getByUserId.mockResolvedValueOnce({ rows: [{ id: 'provider-1', user_id: 'user-1' }] });
      insightsRepo.ownerListingProfile.mockImplementationOnce(() =>
        rows([{ name: null, category: 'plumbing', service_categories: null, city: null, state: null }]),
      );
      // First (keyword-filtered) query is empty; the retry returns platform terms.
      insightsRepo.searchDemand
        .mockImplementationOnce(() => rows())
        .mockImplementationOnce(() => rows([{ term: 'cleaning', count: '4' }]));
      const { providersService } = await import('./providers.service.js');

      const result = await providersService.getMyInsights('user-1', { category: 'service' });

      expect(insightsRepo.searchDemand).toHaveBeenCalledTimes(2);
      expect(insightsRepo.searchDemand.mock.calls[1][3]).toBeUndefined();
      // No city/state on the listing → the place query is skipped entirely.
      expect(insightsRepo.searchPlaceDemand).not.toHaveBeenCalled();
      expect(result.data.searchDemandScope).toBe('category');
      expect(result.data.searchDemand).toEqual([{ term: 'cleaning', count: 4 }]);
    });
  });

  describe('getMyEarnings', () => {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const daysAgo = (n: number) => {
      const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - n);
      return d;
    };
    /** Queue the 3 dbQuery results: per-day earnings, byListing, allTime. */
    const queueEarnings = (dayRows: Array<{ day: string; earnings: string; commission?: string; refunds?: string; discounts?: string; bookings: string }>) => {
      dbQuery.mockReset();
      dbQuery
        .mockResolvedValueOnce({ rows: dayRows.map((r) => ({ commission: '0', refunds: '0', discounts: '0', ...r })) })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ earnings: '999900', commission: '0' }] });
    };

    it('emits a zero-filled DAILY dated series for 30d and totals that equal the day sums', async () => {
      getByUserId.mockResolvedValueOnce({ rows: [{ id: 'provider-1' }] });
      queueEarnings([
        { day: iso(daysAgo(0)), earnings: '150000', bookings: '2' },
        { day: iso(daysAgo(5)), earnings: '50000', bookings: '1' },
      ]);
      const { providersService } = await import('./providers.service.js');

      const result = await providersService.getMyEarnings('user-1', { range: '30d' });

      expect(result.data.series).toHaveLength(30); // one point per day, zero-filled
      expect(result.data.series[0].date).toBe(iso(daysAgo(29)));
      expect(result.data.series[29]).toMatchObject({ date: iso(daysAgo(0)), earnings: 1500 });
      expect(result.data.series[24].earnings).toBe(500);
      expect(result.data.series.filter((p: { earnings: number }) => p.earnings > 0)).toHaveLength(2);
      expect(result.data.totals.earnings).toBe(2000);
      expect(result.data.totals.bookings).toBe(3);
      expect(result.data.allTime).toBe(9999);
    });

    it('rolls a 365d window up into calendar-month buckets', async () => {
      getByUserId.mockResolvedValueOnce({ rows: [{ id: 'provider-1' }] });
      queueEarnings([
        { day: iso(daysAgo(3)), earnings: '100000', bookings: '1' },
        { day: iso(daysAgo(200)), earnings: '200000', bookings: '2' },
      ]);
      const { providersService } = await import('./providers.service.js');

      const result = await providersService.getMyEarnings('user-1', { range: '365d' });

      expect(result.data.series.length).toBeGreaterThanOrEqual(12);
      expect(result.data.series.length).toBeLessThanOrEqual(13); // months touched by a rolling year
      expect(result.data.totals.earnings).toBe(3000); // both days land in some month bucket
      const bucketSum = result.data.series.reduce((a: number, p: { earnings: number }) => a + p.earnings, 0);
      expect(bucketSum).toBe(3000);
    });

    it('applies the vertical (type) filter to every query, mirroring bookingKindOf', async () => {
      getByUserId.mockResolvedValueOnce({ rows: [{ id: 'provider-1' }] });
      queueEarnings([]);
      const { providersService } = await import('./providers.service.js');

      await providersService.getMyEarnings('user-1', { range: '30d', type: 'stay' });

      const sqls = dbQuery.mock.calls.map((c) => String(c[0]));
      expect(sqls).toHaveLength(3);
      for (const sql of sqls) {
        // stay = NOT transport-ish AND stay-ish, exactly like the client classifier
        expect(sql).toContain("NOT (LOWER(COALESCE(b.service_category, '')) LIKE 'driver%'");
        expect(sql).toContain('homestay|hotel|lodge|village-stay|farm-stay|heritage|sathram');
      }
    });

    it('omits the vertical filter when no type is passed (legacy callers unchanged)', async () => {
      getByUserId.mockResolvedValueOnce({ rows: [{ id: 'provider-1' }] });
      queueEarnings([]);
      const { providersService } = await import('./providers.service.js');

      await providersService.getMyEarnings('user-1', { range: '30d' });

      for (const call of dbQuery.mock.calls) {
        expect(String(call[0])).not.toContain('driver%');
      }
    });
  });
});
