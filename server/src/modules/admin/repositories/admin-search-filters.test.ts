// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the SQL + params the repositories build without a database.
const queryMock = vi.fn(async () => ({ rows: [] as unknown[] }));
vi.mock('../../../common/db/postgres.js', () => ({ query: (...args: unknown[]) => queryMock(...args) }));

const { adminBookingsRepository } = await import('./admin-bookings.repository.js');
const { adminListingsRepository } = await import('./admin-listings.repository.js');

const lastCall = () => {
  const call = queryMock.mock.calls.at(-1) as unknown as [string, unknown[]];
  return { sql: call[0].replace(/\s+/g, ' '), params: call[1] };
};

beforeEach(() => queryMock.mockClear());

describe('admin bookings multi-select filters', () => {
  it('lowercases state/city/category values and compares case-insensitively', async () => {
    await adminBookingsRepository.search({
      states: ['Karnataka', ' TELANGANA '],
      cities: ['Bengaluru'],
      categories: ['Salon'],
      limit: 10,
      offset: 0,
    });
    const { sql, params } = lastCall();
    expect(sql).toContain('lower(btrim(l.state)) = ANY($1)');
    expect(sql).toContain('lower(btrim(l.city)) = ANY($2)');
    expect(sql).toContain('lower(btrim(COALESCE(b.service_category, l.category))) = ANY($3)');
    expect(params[0]).toEqual(['karnataka', 'telangana']);
    expect(params[1]).toEqual(['bengaluru']);
    expect(params[2]).toEqual(['salon']);
  });

  it('filters providerIds to valid UUIDs but keeps the clause (never widens)', async () => {
    const good = '11111111-2222-3333-4444-555555555555';
    await adminBookingsRepository.search({ providerIds: [good, 'not-a-uuid'], limit: 10, offset: 0 });
    const { sql, params } = lastCall();
    expect(sql).toContain('b.provider_id = ANY($1::uuid[])');
    expect(params[0]).toEqual([good]);

    await adminBookingsRepository.search({ providerIds: ['junk'], limit: 10, offset: 0 });
    const all = lastCall();
    expect(all.sql).toContain('b.provider_id = ANY($1::uuid[])'); // matches nothing
    expect(all.params[0]).toEqual([]);
  });

  it('adds no multi-select clauses when the arrays are absent', async () => {
    await adminBookingsRepository.search({ limit: 10, offset: 0 });
    const { sql } = lastCall();
    expect(sql).not.toContain('ANY(');
  });
});

describe('admin listings multi-select filters', () => {
  it('scopes to the listing geo/category columns, independent of moderation state', async () => {
    await adminListingsRepository.search({
      state: 'live',
      states: ['Kerala'],
      cities: ['Kochi', 'Thrissur'],
      categories: ['plumbing'],
      limit: 10,
      offset: 0,
    });
    const { sql, params } = lastCall();
    expect(sql).toContain('lower(btrim(l.state)) = ANY($1)');
    expect(sql).toContain('lower(btrim(l.city)) = ANY($2)');
    expect(sql).toContain('lower(btrim(l.category)) = ANY($3)');
    expect(sql).toContain('l.banned_at IS NULL AND l.archived_at IS NULL AND l.is_active = true'); // moderation filter intact
    expect(params[0]).toEqual(['kerala']);
    expect(params[1]).toEqual(['kochi', 'thrissur']);
    expect(params[2]).toEqual(['plumbing']);
  });
});
