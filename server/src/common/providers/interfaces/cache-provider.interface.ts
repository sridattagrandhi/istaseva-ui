/**
 * Future implementations:
 * - Redis
 * - Memory cache for local development
 * - ElastiCache / managed cache wrappers
 */
export interface ICacheProvider {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  getBookingHold<T>(key: string): Promise<T | null>;
  setBookingHold(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  releaseBookingHold(key: string): Promise<void>;
  acquireLock(key: string, ttlMs?: number): Promise<string | null>;
  releaseLock(key: string, lockId: string): Promise<boolean>;
  getIdempotencyValue<T>(key: string): Promise<T | null>;
  reserveIdempotencyKey(key: string, ttlSeconds?: number): Promise<boolean>;
  setIdempotencyValue(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  clearIdempotencyKey(key: string): Promise<void>;
  consumeRateLimit(
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<{ allowed: boolean; count: number; remaining: number; resetAt: number }>;
  healthcheck(): Promise<boolean>;
}
