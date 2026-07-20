import { ForbiddenError } from '../errors/app-error.js';
import { cacheGet, cacheSet } from '../cache/redis.js';
import { dbQuery } from '../repositories/database.js';
import { logger } from '../logging/logger.js';

/**
 * Deleted-account check, run by require-auth on every authenticated request
 * (mirrors suspension.ts). Source of truth is user_profiles.is_deleted; the
 * deletion-request endpoint overwrites the cached value immediately so a
 * just-deleted account is rejected even while its ID token is still
 * cryptographically valid. The Firebase user is also disabled+deleted by the
 * orchestrator, but that only bites at the next token refresh — this check
 * is the instant enforcement inside that window.
 *
 * Fail-open on infrastructure errors, same rationale as suspension.
 */

const TTL_SECONDS = 300;

const cacheKey = (userId: string) => `auth:deleted:${userId}`;

export async function assertNotDeleted(userId: string): Promise<void> {
  let state: string | null = null;
  try {
    state = await cacheGet<string>(cacheKey(userId));
  } catch {
    // fall through to DB
  }

  if (state === null) {
    try {
      const result = await dbQuery<{ is_deleted: boolean }>(
        'SELECT is_deleted FROM user_profiles WHERE user_id = $1',
        [userId]
      );
      state = result.rows[0]?.is_deleted ? 'deleted' : 'ok';
      try {
        await cacheSet(cacheKey(userId), state, TTL_SECONDS);
      } catch {
        // best-effort cache fill
      }
    } catch (err) {
      logger.warn('Deleted-account check failed open', { userId, err: String(err) });
      return;
    }
  }

  if (state === 'deleted') {
    throw new ForbiddenError('This account has been deleted.');
  }
}

/** Called by the deletion-request endpoint so the flag applies immediately. */
export async function setDeletedCache(userId: string, deleted: boolean): Promise<void> {
  try {
    await cacheSet(cacheKey(userId), deleted ? 'deleted' : 'ok', TTL_SECONDS);
  } catch (err) {
    // Non-fatal: the DB row is already updated; the cache refills within TTL.
    logger.warn('Deleted-account cache write failed', { userId, err: String(err) });
  }
}
