// @vitest-environment node
/**
 * Live integration test for the atomic consumeRateLimit (SEC-007 hardening).
 * Runs against the local Redis from docker-compose. Excluded from the default
 * suite (`*.integration.test.ts`); run with the integration script or directly.
 *
 * Proves the two guarantees the Lua rewrite gives us:
 *   1. The counter key ALWAYS gets a TTL on the first hit (the old INCR-then-
 *      EXPIRE could leave a key TTL-less → a permanent block).
 *   2. `allowed` flips to false exactly when the count exceeds the limit.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { consumeRateLimit, redis } from './redis.js';

const KEY = `sec007-itest-${process.pid}`;

afterAll(async () => {
  await redis.del(`ratelimit:${KEY}`);
  await redis.quit();
});

describe('consumeRateLimit (live Redis)', () => {
  it('sets a TTL on the first hit and enforces the limit', async () => {
    const limit = 3;
    const window = 60;

    const first = await consumeRateLimit(KEY, limit, window);
    expect(first.count).toBe(1);
    expect(first.allowed).toBe(true);
    // The atomicity guarantee: a TTL exists immediately after the first hit.
    const ttl = await redis.pttl(`ratelimit:${KEY}`);
    expect(ttl).toBeGreaterThan(0);
    expect(first.resetAt).toBeGreaterThan(Date.now());

    const second = await consumeRateLimit(KEY, limit, window);
    const third = await consumeRateLimit(KEY, limit, window);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);

    // 4th hit exceeds the limit of 3.
    const fourth = await consumeRateLimit(KEY, limit, window);
    expect(fourth.count).toBe(4);
    expect(fourth.allowed).toBe(false);
  });
});
