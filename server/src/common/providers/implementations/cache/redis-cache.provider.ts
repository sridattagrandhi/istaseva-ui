import type { ICacheProvider } from '../../interfaces/cache-provider.interface.js';
import {
  acquireLock,
  cacheDel,
  cacheGet,
  cacheSet,
  checkRedisHealth,
  clearIdempotencyKey,
  consumeRateLimit,
  getBookingHold,
  getIdempotencyValue,
  releaseBookingHold,
  releaseLock,
  reserveIdempotencyKey,
  setBookingHold,
  setIdempotencyValue,
} from '../../../cache/redis.js';

export class RedisCacheProvider implements ICacheProvider {
  get<T>(key: string): Promise<T | null> {
    return cacheGet<T>(key);
  }

  set(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
    return cacheSet(key, value, ttlSeconds);
  }

  del(key: string): Promise<void> {
    return cacheDel(key);
  }

  getBookingHold<T>(key: string): Promise<T | null> {
    return getBookingHold<T>(key);
  }

  setBookingHold(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
    return setBookingHold(key, value, ttlSeconds);
  }

  releaseBookingHold(key: string): Promise<void> {
    return releaseBookingHold(key);
  }

  acquireLock(key: string, ttlMs = 30000): Promise<string | null> {
    return acquireLock(key, ttlMs);
  }

  releaseLock(key: string, lockId: string): Promise<boolean> {
    return releaseLock(key, lockId);
  }

  getIdempotencyValue<T>(key: string): Promise<T | null> {
    return getIdempotencyValue<T>(key);
  }

  reserveIdempotencyKey(key: string, ttlSeconds = 600): Promise<boolean> {
    return reserveIdempotencyKey(key, ttlSeconds);
  }

  setIdempotencyValue(key: string, value: unknown, ttlSeconds = 600): Promise<void> {
    return setIdempotencyValue(key, value, ttlSeconds);
  }

  clearIdempotencyKey(key: string): Promise<void> {
    return clearIdempotencyKey(key);
  }

  consumeRateLimit(key: string, limit: number, windowSeconds: number) {
    return consumeRateLimit(key, limit, windowSeconds);
  }

  healthcheck(): Promise<boolean> {
    return checkRedisHealth();
  }
}

export const redisCacheProvider = new RedisCacheProvider();
