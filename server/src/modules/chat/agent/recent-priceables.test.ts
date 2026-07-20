// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory Redis stand-in — only the get/set surface recent-priceables uses.
const store = new Map<string, string>();
const failNext = { set: false, get: false };

vi.mock('../../../common/cache/redis.js', () => ({
  redis: {
    set: vi.fn(async (k: string, v: string) => {
      if (failNext.set) { failNext.set = false; throw new Error('redis down'); }
      store.set(k, v);
      return 'OK';
    }),
    get: vi.fn(async (k: string) => {
      if (failNext.get) { failNext.get = false; throw new Error('redis down'); }
      return store.get(k) ?? null;
    }),
  },
}));

const { recordListingPriceables, readListingPriceables } = await import('./recent-priceables.js');

const MENU = [
  { group: 'Services', name: "Men's Haircut", price: 700, unit: 'per_visit' },
  { group: 'Services', name: "Women's Haircut", price: 1200, unit: 'per_visit' },
  { group: 'Services', name: "Kid's Haircut", price: 396, unit: 'per_visit' },
];

describe('recent-priceables cache', () => {
  beforeEach(() => {
    store.clear();
    failNext.set = false;
    failNext.get = false;
  });

  it('round-trips the full menu for a listing', async () => {
    await recordListingPriceables('user-1', 'listing-a', MENU);
    expect(await readListingPriceables('user-1', 'listing-a')).toEqual(MENU);
  });

  it('isolates by user and listing id', async () => {
    await recordListingPriceables('user-1', 'listing-a', MENU);
    expect(await readListingPriceables('user-2', 'listing-a')).toEqual([]);
    expect(await readListingPriceables('user-1', 'listing-b')).toEqual([]);
  });

  it('skips empty / missing inputs without writing', async () => {
    await recordListingPriceables('', 'listing-a', MENU);
    await recordListingPriceables('user-1', '', MENU);
    await recordListingPriceables('user-1', 'listing-a', []);
    expect(store.size).toBe(0);
  });

  it('is best-effort — a redis write error never throws', async () => {
    failNext.set = true;
    await expect(recordListingPriceables('user-1', 'listing-a', MENU)).resolves.toBeUndefined();
  });

  it('is best-effort — a redis read error returns []', async () => {
    await recordListingPriceables('user-1', 'listing-a', MENU);
    failNext.get = true;
    expect(await readListingPriceables('user-1', 'listing-a')).toEqual([]);
  });

  it('drops malformed cached rows on read', async () => {
    store.set('assistant:listing-priceables:user-1:listing-a', JSON.stringify([
      { name: 'ok', price: 100 },
      { name: 'no price' },
      { price: 50 },
      null,
    ]));
    expect(await readListingPriceables('user-1', 'listing-a')).toEqual([{ name: 'ok', price: 100 }]);
  });
});
