/**
 * At-home address gate for agent-prepared bookings.
 *
 * The booking MODALS forward-geocode at-home addresses client-side and block
 * unresolvable ones; the agent path had no equivalent, so "my house near the
 * temple" sailed straight into a paid hold. This runs the SAME check
 * server-side, where the model can't skip or fake it.
 *
 * Graceful degradation is deliberate: genuinely rural / landmark-style Indian
 * addresses sometimes don't geocode even though a provider would find them.
 * After MAX_BOUNCES unresolvable attempts (tracked per user in Redis, short
 * TTL) the gate lets the address through — the agent then tells the user the
 * provider may call to confirm directions. A form can only say "invalid";
 * the agent can degrade politely instead of dead-ending the booking.
 *
 * Fail-open policy: geocodeAddress never throws (returns null on provider
 * errors), and a Redis hiccup while counting bounces also lets the booking
 * through — address verification must never be the reason a customer can't
 * book at all.
 */
import { geocodeAddress, type GeocodeResult } from '../../../common/services/geocode.service.js';
import { redis } from '../../../common/cache/redis.js';
import { logger } from '../../../common/logging/logger.js';

/** Unresolvable attempts before the gate stops bouncing. */
const MAX_BOUNCES = 2;
const FAILS_TTL_SECONDS = 15 * 60;

const key = (userId: string) => `assistant:addr-verify-fails:${userId}`;

export interface AtHomeAddressCheck {
  /** false = bounce with a re-ask; true = proceed with the hold. */
  allow: boolean;
  /** Resolved coordinates + canonical address when geocoding succeeded. */
  resolved: GeocodeResult;
  /** true when allowed only because the user already bounced MAX_BOUNCES
   *  times — the agent should warn that the provider may call for directions. */
  degraded: boolean;
}

export async function verifyAtHomeAddress(userId: string, address: string): Promise<AtHomeAddressCheck> {
  const resolved = await geocodeAddress(address);
  if (resolved) {
    try { await redis.del(key(userId)); } catch { /* best-effort */ }
    return { allow: true, resolved, degraded: false };
  }
  let failures = MAX_BOUNCES + 1; // Redis down → fail open (see header)
  try {
    failures = await redis.incr(key(userId));
    await redis.expire(key(userId), FAILS_TTL_SECONDS);
  } catch (err) {
    logger.warn('address-verification: bounce counter failed — allowing through', { error: (err as Error).message });
  }
  if (failures > MAX_BOUNCES) {
    logger.info('address-verification: unresolvable address allowed after repeated attempts', { userId, failures });
    return { allow: true, resolved: null, degraded: true };
  }
  return { allow: false, resolved: null, degraded: false };
}
