// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const cacheGet = vi.fn();
const cacheSet = vi.fn();
const cacheDel = vi.fn();
const getBookingHold = vi.fn();
const setBookingHold = vi.fn();
const releaseBookingHold = vi.fn();
const acquireLock = vi.fn();
const releaseLock = vi.fn();
const getIdempotencyValue = vi.fn();
const reserveIdempotencyKey = vi.fn();
const setIdempotencyValue = vi.fn();
const clearIdempotencyKey = vi.fn();
const consumeRateLimit = vi.fn();
const checkRedisHealth = vi.fn();

vi.mock('../../../cache/redis.js', () => ({
  cacheGet,
  cacheSet,
  cacheDel,
  getBookingHold,
  setBookingHold,
  releaseBookingHold,
  acquireLock,
  releaseLock,
  getIdempotencyValue,
  reserveIdempotencyKey,
  setIdempotencyValue,
  clearIdempotencyKey,
  consumeRateLimit,
  checkRedisHealth,
}));

describe('RedisCacheProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates booking hold operations', async () => {
    getBookingHold.mockResolvedValueOnce({ bookingId: 'booking-1' });
    const { redisCacheProvider } = await import('./redis-cache.provider.js');

    await redisCacheProvider.setBookingHold('hold-1', { bookingId: 'booking-1' }, 120);
    const hold = await redisCacheProvider.getBookingHold<{ bookingId: string }>('hold-1');
    await redisCacheProvider.releaseBookingHold('hold-1');

    expect(setBookingHold).toHaveBeenCalledWith('hold-1', { bookingId: 'booking-1' }, 120);
    expect(hold?.bookingId).toBe('booking-1');
    expect(releaseBookingHold).toHaveBeenCalledWith('hold-1');
  });

  it('delegates idempotency operations', async () => {
    reserveIdempotencyKey.mockResolvedValueOnce(true);
    getIdempotencyValue.mockResolvedValueOnce({ orderId: 'order-1' });
    const { redisCacheProvider } = await import('./redis-cache.provider.js');

    const reserved = await redisCacheProvider.reserveIdempotencyKey('payment:create:user-1:key-1', 600);
    await redisCacheProvider.setIdempotencyValue('payment:create:user-1:key-1', { orderId: 'order-1' }, 600);
    const value = await redisCacheProvider.getIdempotencyValue<{ orderId: string }>('payment:create:user-1:key-1');
    await redisCacheProvider.clearIdempotencyKey('payment:create:user-1:key-1');

    expect(reserved).toBe(true);
    expect(value?.orderId).toBe('order-1');
    expect(clearIdempotencyKey).toHaveBeenCalledWith('payment:create:user-1:key-1');
  });

  it('delegates rate limit consumption', async () => {
    consumeRateLimit.mockResolvedValueOnce({
      allowed: true,
      count: 1,
      remaining: 2,
      resetAt: Date.now() + 60000,
    });
    const { redisCacheProvider } = await import('./redis-cache.provider.js');

    const result = await redisCacheProvider.consumeRateLimit('booking:user-1', 3, 60);

    expect(result.allowed).toBe(true);
    expect(consumeRateLimit).toHaveBeenCalledWith('booking:user-1', 3, 60);
  });
});
