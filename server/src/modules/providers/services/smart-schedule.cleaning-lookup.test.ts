// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression coverage for "no cleaning slot for May 27, 2026" — the user
 * asked Ista AI to book a cleaning service on a Wednesday and the agent
 * replied that nothing was available, despite a Home Cleaning provider
 * having Wednesday hours configured.
 *
 * The real root cause was case-sensitive SQL comparison in
 * `providers.repository.ts`: `WHERE l.category = $1` and
 * `WHERE $1 = ANY(pp.service_categories)` failed to match when the agent
 * sent "cleaning" against rows storing "Home Cleaning"/"Cleaner". This
 * test pins the repository contract — when a caller passes "cleaning",
 * the repo SQL must be case-insensitive on BOTH sides of the comparison.
 *
 * We mock the DB layer and assert on the generated SQL because spinning
 * Postgres for one test is overkill for the surface area we care about.
 */
const dbQuery = vi.fn();
vi.mock('../../../common/repositories/database.js', () => ({ dbQuery }));

beforeEach(() => {
  dbQuery.mockReset();
  dbQuery.mockResolvedValue({ rows: [] });
});

describe('providers.repository — case-insensitive category match', () => {
  it('listAvailableProvidersWithAvailability lowercases both sides of the category compare', async () => {
    const { providersRepository } = await import('../repositories/providers.repository.js');
    await providersRepository.listAvailableProvidersWithAvailability('cleaning', 3);
    const sql = String(dbQuery.mock.calls[0][0]);
    // Listing column is matched case-insensitively
    expect(sql).toMatch(/LOWER\(l\.category\)\s*=\s*LOWER\(\$1\)/i);
    // service_categories array is unnested + lowercased on both sides
    expect(sql).toMatch(/unnest\(pp\.service_categories\)/i);
    expect(sql).toMatch(/LOWER\(sc\)\s*=\s*LOWER\(\$1\)/i);
    // Parameter is the raw category string the caller passed
    expect(dbQuery.mock.calls[0][1]).toEqual(['cleaning', 3]);
  });

  it('listProvidersByCategory (fallback) is also case-insensitive', async () => {
    const { providersRepository } = await import('../repositories/providers.repository.js');
    await providersRepository.listProvidersByCategory('Cleaning');
    const sql = String(dbQuery.mock.calls[0][0]);
    expect(sql).toMatch(/LOWER\(l\.category\)\s*=\s*LOWER\(\$1\)/i);
    expect(sql).toMatch(/LOWER\(sc\)\s*=\s*LOWER\(\$1\)/i);
  });

  it('smart-schedule end-to-end: returns a Wednesday cleaning slot when a provider has Wednesday hours', async () => {
    // We mock providersRepository.listAvailableProvidersWithAvailability so
    // the service receives ONE matching row regardless of what category
    // string the caller used — proving the slot pipeline works once the
    // repo filter accepts a case-insensitive match. (The case-insensitivity
    // itself is asserted by the two SQL tests above.)
    vi.resetModules();
    vi.doMock('../repositories/providers.repository.js', () => ({
      providersRepository: {
        listAvailableProvidersWithAvailability: vi.fn().mockResolvedValue({
          rows: [{
            id: 'prov-1',
            display_name: 'Super Cleanings',
            listing_name: 'Home Cleaning',
            listing_id: 'list-1',
            lat: 18.5204,
            lng: 73.8567,
            service_radius_km: 15,
            buffer_minutes: 30,
            avail_start: '09:00',
            avail_end: '18:00',
            vehicle_class: 'scooter',
            max_jobs_per_day: 6,
            working_hours: { wed: ['09:00', '18:00'] },
          }],
        }),
        listProvidersByCategory: vi.fn().mockResolvedValue({ rows: [] }),
        listOccupiedIntervalsForProvidersOnDate: vi.fn().mockResolvedValue({ rows: [] }),
        listBookingsForProvidersOnDate: vi.fn().mockResolvedValue({ rows: [] }),
        listBlackoutDatesForProviders: vi.fn().mockResolvedValue({ rows: [] }),
      },
    }));
    vi.doMock('../../../common/cache/redis.js', () => ({
      cacheGet: vi.fn().mockResolvedValue(null),
      cacheSet: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../../../common/logging/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const { smartScheduleService } = await import('./smart-schedule.service.js');
    const result = await smartScheduleService.findSlots({
      service_category: 'cleaning', // lowercased — was the failing form
      preferred_date: '2026-05-27',  // Wednesday
      duration_minutes: 60,
    });
    expect(Array.isArray(result.slots)).toBe(true);
    expect(result.slots.length).toBeGreaterThan(0);
    // The slot surfaces the listing name via `provider_name` (smart-schedule
    // prefers the listing label over the provider's brand for the chip text).
    expect(result.slots[0].provider_name).toBe('Home Cleaning');
  });
});
