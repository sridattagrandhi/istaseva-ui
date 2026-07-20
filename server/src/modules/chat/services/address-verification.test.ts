// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { geocodeAddress, counters, redisMock } = vi.hoisted(() => {
  const counters = new Map<string, number>();
  return {
    geocodeAddress: vi.fn(),
    counters,
    redisMock: {
      incr: vi.fn(async (k: string) => {
        const next = (counters.get(k) ?? 0) + 1;
        counters.set(k, next);
        return next;
      }),
      expire: vi.fn(async () => 1),
      del: vi.fn(async (k: string) => { counters.delete(k); return 1; }),
    },
  };
});
vi.mock('../../../common/services/geocode.service.js', () => ({
  geocodeAddress: (...args: unknown[]) => geocodeAddress(...(args as [])),
}));
vi.mock('../../../common/cache/redis.js', () => ({ redis: redisMock }));
vi.mock('../../../common/logging/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { verifyAtHomeAddress } from './address-verification.js';

beforeEach(() => {
  vi.clearAllMocks();
  counters.clear();
});

describe('verifyAtHomeAddress', () => {
  it('allows a resolvable address and clears the bounce counter', async () => {
    counters.set('assistant:addr-verify-fails:u1', 1); // a prior miss
    geocodeAddress.mockResolvedValue({ lat: 17.41, lng: 78.44, formattedAddress: 'Plot 4, Banjara Hills, Hyderabad 500034' });
    const check = await verifyAtHomeAddress('u1', 'Plot 4, Banjara Hills, Hyderabad');
    expect(check).toEqual({
      allow: true,
      resolved: { lat: 17.41, lng: 78.44, formattedAddress: 'Plot 4, Banjara Hills, Hyderabad 500034' },
      degraded: false,
    });
    expect(counters.has('assistant:addr-verify-fails:u1')).toBe(false);
  });

  it('bounces the first two unresolvable attempts, then degrades open on the third', async () => {
    geocodeAddress.mockResolvedValue(null);
    expect((await verifyAtHomeAddress('u1', 'my house')).allow).toBe(false);
    expect((await verifyAtHomeAddress('u1', 'my house near temple')).allow).toBe(false);
    const third = await verifyAtHomeAddress('u1', 'my house near the big temple');
    expect(third).toEqual({ allow: true, resolved: null, degraded: true });
  });

  it('bounce counters are per-user', async () => {
    geocodeAddress.mockResolvedValue(null);
    await verifyAtHomeAddress('u1', 'x y z');
    await verifyAtHomeAddress('u1', 'x y z 2');
    // u2's first miss still bounces even though u1 is at the cap
    expect((await verifyAtHomeAddress('u2', 'a b c')).allow).toBe(false);
  });

  it('fails OPEN when the bounce counter is unavailable (Redis down ≠ blocked bookings)', async () => {
    geocodeAddress.mockResolvedValue(null);
    redisMock.incr.mockRejectedValueOnce(new Error('redis gone'));
    const check = await verifyAtHomeAddress('u1', 'my house');
    expect(check.allow).toBe(true);
    expect(check.degraded).toBe(true);
  });
});
