import { ForbiddenError } from '../errors/app-error.js';
import { cacheGet, cacheSet } from '../cache/redis.js';
import { dbQuery } from '../repositories/database.js';
import { logger } from '../logging/logger.js';

/**
 * User suspension check, run by require-auth on every authenticated request.
 *
 * Source of truth is user_profiles.is_suspended; a short-TTL Redis copy keeps
 * the hot path off Postgres (one DB read per user per TTL window, not per
 * request). The admin suspend/unsuspend endpoints overwrite the cached value
 * immediately, so enforcement is instant even mid-TTL. Cache values are the
 * strings 'suspended' | 'ok' — never booleans, so a Redis flush (miss) is
 * distinguishable from "not suspended" and refills from the DB.
 *
 * Fail-open on infrastructure errors: Firebase-disable already blocks new
 * sign-ins for suspended users, so a Redis/DB blip should not take down auth
 * for everyone else.
 */

const TTL_SECONDS = 300;

const cacheKey = (userId: string) => `auth:suspension:${userId}`;

export async function assertNotSuspended(userId: string): Promise<void> {
  let state: string | null = null;
  try {
    state = await cacheGet<string>(cacheKey(userId));
  } catch {
    // fall through to DB
  }

  if (state === null) {
    try {
      const result = await dbQuery<{ is_suspended: boolean }>(
        'SELECT is_suspended FROM user_profiles WHERE user_id = $1',
        [userId]
      );
      state = result.rows[0]?.is_suspended ? 'suspended' : 'ok';
      try {
        await cacheSet(cacheKey(userId), state, TTL_SECONDS);
      } catch {
        // best-effort cache fill
      }
    } catch (err) {
      logger.warn('Suspension check failed open', { userId, err: String(err) });
      return;
    }
  }

  if (state === 'suspended') {
    throw new ForbiddenError('This account has been suspended. Contact support for help.');
  }
}

/** Called by the admin suspend/unsuspend endpoints so the flag applies immediately. */
export async function setSuspensionCache(userId: string, suspended: boolean): Promise<void> {
  try {
    await cacheSet(cacheKey(userId), suspended ? 'suspended' : 'ok', TTL_SECONDS);
  } catch (err) {
    // Non-fatal: the DB row is already updated; the cache refills within TTL.
    logger.warn('Suspension cache write failed', { userId, err: String(err) });
  }
}
