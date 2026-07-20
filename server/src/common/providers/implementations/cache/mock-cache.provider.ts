import crypto from 'crypto';
import type { ICacheProvider } from '../../interfaces/cache-provider.interface.js';

type CacheEntry = {
  value: unknown;
  expiresAt: number | null;
};

class MockCacheProvider implements ICacheProvider {
  private readonly store = new Map<string, CacheEntry>();
  private readonly locks = new Map<string, string>();

  private isExpired(entry: CacheEntry | undefined) {
    return Boolean(entry?.expiresAt && entry.expiresAt <= Date.now());
  }

  private read<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  private write(key: string, value: unknown, ttlSeconds?: number) {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + (ttlSeconds * 1000) : null,
    });
  }

  async get<T>(key: string): Promise<T | null> {
    return this.read<T>(key);
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.write(key, value, ttlSeconds);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async getBookingHold<T>(key: string): Promise<T | null> {
    return this.read<T>(`hold:${key}`);
  }

  async setBookingHold(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.write(`hold:${key}`, value, ttlSeconds);
  }

  async releaseBookingHold(key: string): Promise<void> {
    this.store.delete(`hold:${key}`);
  }

  async acquireLock(key: string, ttlMs = 10000): Promise<string | null> {
    const existing = this.read<string>(`lock:${key}`);
    if (existing) return null;

    const lockId = crypto.randomUUID();
    this.write(`lock:${key}`, lockId, Math.ceil(ttlMs / 1000));
    this.locks.set(key, lockId);
    return lockId;
  }

  async releaseLock(key: string, lockId: string): Promise<boolean> {
    const current = this.read<string>(`lock:${key}`);
    if (!current || current !== lockId) return false;
    this.store.delete(`lock:${key}`);
    this.locks.delete(key);
    return true;
  }

  async getIdempotencyValue<T>(key: string): Promise<T | null> {
    return this.read<T>(`idem:${key}`);
  }

  async reserveIdempotencyKey(key: string, ttlSeconds = 600): Promise<boolean> {
    const existing = this.read(`idem:${key}`);
    if (existing) return false;
    this.write(`idem:${key}`, { reserved: true }, ttlSeconds);
    return true;
  }

  async setIdempotencyValue(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.write(`idem:${key}`, value, ttlSeconds);
  }

  async clearIdempotencyKey(key: string): Promise<void> {
    this.store.delete(`idem:${key}`);
  }

  async consumeRateLimit(key: string, limit: number, windowSeconds: number) {
    const bucketKey = `rate:${key}`;
    const current = (this.read<number>(bucketKey) ?? 0) + 1;
    this.write(bucketKey, current, windowSeconds);
    return {
      allowed: current <= limit,
      count: current,
      remaining: Math.max(0, limit - current),
      resetAt: Date.now() + (windowSeconds * 1000),
    };
  }

  async healthcheck(): Promise<boolean> {
    return true;
  }
}

export const mockCacheProvider = new MockCacheProvider();
