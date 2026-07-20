import crypto from 'node:crypto';
import Redis from 'ioredis';
import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';
import type { ICacheProvider } from '../providers/interfaces/cache-provider.interface.js';

const redisConnectionOptions = {
  maxRetriesPerRequest: 3,
  retryStrategy(times: number) {
    const delay = Math.min(times * 200, 5000);
    return delay;
  },
  lazyConnect: true,
  keyPrefix: config.cache.keyPrefix ? `${config.cache.keyPrefix}:` : undefined,
  tls: config.cache.tls ? {} : undefined,
  // ElastiCache AUTH (ENG-007/SEC-009). undefined when unset so local
  // unauthenticated Redis keeps working. duplicate() (WS fanout subscriber)
  // inherits this automatically.
  password: config.cache.authToken || undefined,
};

export const redis = config.cache.url
  ? new Redis(config.cache.url, redisConnectionOptions)
  : new Redis({
      host: config.cache.host,
      port: config.cache.port,
      ...redisConnectionOptions,
    });

redis.on('connect', () => {
  logger.info('Redis connected');
});

redis.on('ready', () => {
  logger.info('Redis ready');
});

redis.on('reconnecting', () => {
  logger.info('Redis reconnecting');
});

redis.on('error', (err) => {
  logger.warn('Redis error', { error: err.message });
});

async function ensureRedisConnection(): Promise<void> {
  if (redis.status === 'ready' || redis.status === 'connect') {
    return;
  }

  if (redis.status === 'wait') {
    await redis.connect();
  }
}

function namespacedKey(namespace: string, key: string): string {
  return `${namespace}:${key}`;
}

export async function connectRedis(): Promise<void> {
  try {
    await ensureRedisConnection();
  } catch (err: any) {
    logger.warn('Redis connection failed — running without cache', { error: err.message });
  }
}

export async function checkRedisHealth(): Promise<boolean> {
  try {
    await ensureRedisConnection();
    const result = await redis.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  await ensureRedisConnection();
  const raw = await redis.get(key);
  if (!raw) return null;
  return JSON.parse(raw) as T;
}

export async function cacheSet(key: string, value: any, ttlSeconds = 300): Promise<void> {
  await ensureRedisConnection();
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds || config.cache.defaultTtlSeconds);
}

export async function cacheDel(key: string): Promise<void> {
  await ensureRedisConnection();
  await redis.del(key);
}

export async function getBookingHold<T>(key: string): Promise<T | null> {
  return cacheGet<T>(namespacedKey('hold', key));
}

export async function setBookingHold(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
  await cacheSet(namespacedKey('hold', key), value, ttlSeconds || config.cache.bookingHoldTtlSeconds);
}

export async function releaseBookingHold(key: string): Promise<void> {
  await cacheDel(namespacedKey('hold', key));
}

export async function acquireLock(
  key: string,
  ttlMs: number = 10000
): Promise<string | null> {
  const lockId = crypto.randomUUID();
  await ensureRedisConnection();
  const result = await redis.set(namespacedKey('lock', key), lockId, 'PX', ttlMs, 'NX');
  return result === 'OK' ? lockId : null;
}

export async function releaseLock(key: string, lockId: string): Promise<boolean> {
  await ensureRedisConnection();
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  const result = await redis.eval(script, 1, namespacedKey('lock', key), lockId);
  return result === 1;
}

/**
 * Scheduler singleton lease (ARC-003 / ENG-006).
 *
 * The background timers in `index.ts` fire in *every* ECS task, so with N tasks
 * running (prod autoscales 2→10) each rollup/supply job runs N times per
 * interval — N× the DynamoDB reads and Postgres aggregation for one interval's
 * useful output. This elects a single task per interval: the first to SET the
 * key wins and runs the job; the key is deliberately NOT released, so it
 * lingers and every other task's tick this interval finds it taken and skips.
 * TTL is set a shade under the interval by the caller so the key clears just
 * before the next tick and the next run re-elects.
 *
 * Fail-open: if Redis is unreachable we return `true` so the job still runs.
 * These jobs are all idempotent, so the worst case is today's harmless
 * duplication — far better than the job silently stopping fleet-wide because
 * Redis hiccuped.
 */
export async function tryAcquireSchedulerLease(name: string, ttlMs: number): Promise<boolean> {
  try {
    await ensureRedisConnection();
    const result = await redis.set(namespacedKey('lease', name), '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  } catch (err: any) {
    logger.warn('Scheduler lease acquisition failed — running unleased', { name, error: err.message });
    return true;
  }
}

export async function getIdempotencyValue<T>(key: string): Promise<T | null> {
  return cacheGet<T>(namespacedKey('idempotency', key));
}

export async function reserveIdempotencyKey(key: string, ttlSeconds = 600): Promise<boolean> {
  await ensureRedisConnection();
  const result = await redis.set(
    namespacedKey('idempotency', key),
    JSON.stringify({ status: 'pending' }),
    'EX',
    ttlSeconds || config.cache.idempotencyTtlSeconds,
    'NX'
  );
  return result === 'OK';
}

export async function setIdempotencyValue(key: string, value: unknown, ttlSeconds = 600): Promise<void> {
  await cacheSet(namespacedKey('idempotency', key), value, ttlSeconds || config.cache.idempotencyTtlSeconds);
}

export async function clearIdempotencyKey(key: string): Promise<void> {
  await cacheDel(namespacedKey('idempotency', key));
}

// INCR + set-TTL-on-first-hit + read-TTL, atomically. Doing this as separate
// commands risks a crash between INCR and EXPIRE leaving a key with no TTL —
// a permanent block for that limit key. One EVAL removes that window.
const CONSUME_RATE_LIMIT_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return {count, redis.call('PTTL', KEYS[1])}
`;

export async function consumeRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; count: number; remaining: number; resetAt: number }> {
  await ensureRedisConnection();
  const namespaced = namespacedKey('ratelimit', key);
  const [count, ttlMs] = (await redis.eval(
    CONSUME_RATE_LIMIT_LUA,
    1,
    namespaced,
    String(windowSeconds * 1000)
  )) as [number, number];

  const remaining = Math.max(0, limit - count);
  const resetAt = Date.now() + Math.max(ttlMs, 0);

  return {
    allowed: count <= limit,
    count,
    remaining,
    resetAt,
  };
}

export async function cacheDelByPattern(pattern: string): Promise<number> {
  await ensureRedisConnection();

  // SCAN instead of KEYS — KEYS is O(N) and blocks the single-threaded Redis
  // event loop on every call, which becomes a latency cliff once this cache
  // holds any meaningful number of keys. SCAN yields cursors in small batches
  // so other traffic isn't starved. COUNT is a hint; Redis may return more or
  // fewer than this per iteration.
  const prefix = config.cache.keyPrefix ? `${config.cache.keyPrefix}:` : '';
  let cursor = '0';
  let deleted = 0;
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = nextCursor;
    if (batch.length > 0) {
      const stripped = prefix
        ? batch.map((k) => (k.startsWith(prefix) ? k.slice(prefix.length) : k))
        : batch;
      // Pipeline the deletes so a single large match set doesn't require a
      // round-trip per key. del returns the count actually removed.
      const removed = await redis.del(...stripped);
      deleted += removed;
    }
  } while (cursor !== '0');
  return deleted;
}

export type CacheProvider = ICacheProvider;
