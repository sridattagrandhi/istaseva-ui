import { UnauthorizedError } from '../errors/app-error.js';
import { getAuthProvider } from '../providers/registry.js';
import { cacheGet, cacheSet } from '../cache/redis.js';
import { logger } from '../logging/logger.js';

/**
 * Token-revocation check, run by require-auth on every authenticated request.
 *
 * Firebase ID tokens stay cryptographically valid for up to ~1 h after they're
 * issued, even once the underlying session has been revoked (by a password
 * reset or a "sign out everywhere"). `verifyIdToken(token, true)` would reject
 * them, but it does a `getUser` lookup on EVERY call — latency + cost on the
 * hot path. Instead we replicate Firebase's own check (a token is revoked when
 * its `auth_time` predates the user's `tokensValidAfterTime`) but cache the
 * per-user `tokensValidAfterTime` in Redis for a short window, so we pay at
 * most one IdP lookup per user per TTL instead of one per request. This mirrors
 * the suspension check exactly.
 *
 * The window means enforcement lags a revocation by at most TTL seconds — the
 * "sign out everywhere" and password-reset paths call `setRevokedNowCache` to
 * overwrite the cached value immediately, so those act instantly.
 *
 * Fail-open on infrastructure errors and when the provider can't supply the
 * data (e.g. the local default provider has no admin API): a Redis/IdP blip
 * must not take down auth for everyone. `authTimeMs` absent → nothing to
 * compare → skip.
 *
 * Cache values are strings: the ms timestamp, or 'none' when the IdP reports no
 * revocation time — never a number, so a Redis miss (null) refills from the IdP
 * rather than being read as "not revoked".
 */

const TTL_SECONDS = 60;

const cacheKey = (userId: string) => `auth:revoked-after:${userId}`;

async function resolveValidAfterMs(userId: string): Promise<string | null> {
  let cached: string | null = null;
  try {
    cached = await cacheGet<string>(cacheKey(userId));
  } catch {
    // fall through to the IdP lookup
  }
  if (cached !== null) return cached;

  const provider = await getAuthProvider();
  if (!provider.getTokensValidAfterTime) return null; // provider can't tell us → skip
  const ms = await provider.getTokensValidAfterTime(userId);
  const value = ms == null ? 'none' : String(ms);
  try {
    await cacheSet(cacheKey(userId), value, TTL_SECONDS);
  } catch {
    // best-effort cache fill
  }
  return value;
}

export async function assertNotRevoked(userId: string, authTimeMs?: number): Promise<void> {
  if (authTimeMs == null) return; // no auth_time to compare → can't evaluate

  let value: string | null;
  try {
    value = await resolveValidAfterMs(userId);
  } catch (err) {
    logger.warn('Revocation check failed open', { userId, err: String(err) });
    return;
  }

  if (value === null || value === 'none') return;
  const validAfterMs = Number(value);
  if (!Number.isFinite(validAfterMs)) return;

  // Firebase's own rule: a token is revoked when it was authenticated before
  // the cutoff. Allow a 5 s skew so a token minted in the same instant as the
  // revocation timestamp isn't spuriously rejected.
  if (authTimeMs < validAfterMs - 5000) {
    throw new UnauthorizedError('Session has been signed out. Please sign in again.');
  }
}

/**
 * Called by the "sign out everywhere" / password-reset paths right after
 * revoking, so the cutoff applies immediately instead of within the TTL. `now`
 * defaults to the current time — any token authenticated before it is revoked.
 */
export async function setRevokedNowCache(userId: string, now: number = Date.now()): Promise<void> {
  try {
    await cacheSet(cacheKey(userId), String(now), TTL_SECONDS);
  } catch (err) {
    // Non-fatal: the IdP was already updated; the cache refills within TTL.
    logger.warn('Revocation cache write failed', { userId, err: String(err) });
  }
}
