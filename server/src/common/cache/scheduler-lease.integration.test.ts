// @vitest-environment node
/**
 * Live integration test for the scheduler singleton lease (ARC-003 / ENG-006).
 * Runs against the local Redis from docker-compose. Excluded from the default
 * suite (`*.integration.test.ts`); run with the integration script or directly.
 *
 * Proves the two guarantees the lease gives the background timers:
 *   1. Exactly ONE caller wins per interval — a second acquire for the same
 *      name inside the TTL is refused, so N ECS tasks don't all run the job.
 *   2. The lease expires on its own (it is never released), so the next
 *      interval re-elects a fresh leader.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { tryAcquireSchedulerLease, redis } from './redis.js';

const NAME = `arc003-itest-${process.pid}`;
const KEY = `lease:${NAME}`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterAll(async () => {
  await redis.del(KEY);
  await redis.quit();
});

describe('tryAcquireSchedulerLease (live Redis)', () => {
  it('elects a single holder and re-elects after the TTL expires', async () => {
    // Fresh key, so the first task in the fleet wins this interval.
    const first = await tryAcquireSchedulerLease(NAME, 300);
    expect(first).toBe(true);

    // A TTL was stamped, so the lease clears on its own — it is never released.
    const ttl = await redis.pttl(KEY);
    expect(ttl).toBeGreaterThan(0);

    // A second task ticking within the same interval is refused: the job runs
    // once fleet-wide, not once per task.
    const second = await tryAcquireSchedulerLease(NAME, 300);
    expect(second).toBe(false);

    // Once the lease expires, the next interval re-elects a leader.
    await sleep(350);
    const next = await tryAcquireSchedulerLease(NAME, 300);
    expect(next).toBe(true);
  });
});
