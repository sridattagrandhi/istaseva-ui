import { Request, Response, NextFunction } from 'express';
import { getAuthProvider } from '../providers/registry.js';
import { UnauthorizedError } from '../errors/app-error.js';
import { assertNotSuspended } from './suspension.js';
import { assertNotDeleted } from './account-deletion.js';
import { assertNotRevoked } from './revocation.js';
import { logger } from '../logging/logger.js';
import { dbQuery } from '../repositories/database.js';
import { cacheGet, cacheSet } from '../cache/redis.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role?: string;
  name?: string;
  /** OTP-verified phone from the IdP, synced to user_profiles.phone. */
  phone?: string;
  /** When the token was authenticated (ms since epoch). Used by the
   *  revocation check to reject sessions killed by a password reset or a
   *  "sign out everywhere". */
  authTimeMs?: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      /** Authenticated user id for rate-limit keying, populated pre-auth by
       *  `identifyForRateLimit` so limiters can key per-user (SEC-007). This
       *  is intentionally separate from `req.user` — it must NOT grant route
       *  access, only a stable throttle key. */
      rateLimitUserId?: string;
      /** Per-request memo of a verified principal, so the pre-auth identify
       *  pass and a later `requireAuth` on the same request don't verify the
       *  same token twice. */
      _authMemo?: { token: string; user: AuthenticatedUser };
    }
  }
}

async function resolveAuthenticatedUser(token: string): Promise<AuthenticatedUser> {
  const authProvider = await getAuthProvider();
  return authProvider.verifyAccessToken(token);
}

/**
 * Verify a bearer token at most once per request. `identifyForRateLimit` runs
 * before the limiters and `requireAuth` runs inside the route chain; both call
 * this, so the (potentially non-trivial) signature check happens a single time.
 */
async function verifyMemoized(req: Request, token: string): Promise<AuthenticatedUser> {
  if (req._authMemo && req._authMemo.token === token) return req._authMemo.user;
  const user = await resolveAuthenticatedUser(token);
  req._authMemo = { token, user };
  return user;
}

/**
 * Best-effort pre-auth identification for rate limiting (SEC-007). Runs BEFORE
 * the rate limiters so an authenticated request is throttled per-user instead
 * of per-IP — the fix for CGNAT collateral throttling and IP-rotation cost
 * evasion. Never rejects: a missing/invalid token just leaves the request
 * IP-keyed, and `requireAuth` (where mounted) still returns the real 401.
 */
export async function identifyForRateLimit(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const user = await verifyMemoized(req, authHeader.slice(7));
      req.rateLimitUserId = user.id;
    } catch {
      // Invalid/expired token → fall through to IP-keyed limiting.
    }
  }
  next();
}

/**
 * Denormalize the signed-in user's email onto user_profiles so the SES
 * notification path can resolve a recipient without a Firebase Admin
 * round-trip. Best-effort — never blocks the request on failure.
 *
 * user_profiles.user_id is TEXT, so Firebase UIDs work directly.
 */
async function upsertUserEmail(user: AuthenticatedUser): Promise<void> {
  if (!user.id || !user.email) return;

  // Skip the write if we already persisted this (user, email, name) tuple
  // recently. Every authenticated request hit this UPSERT, which at any real
  // QPS became a large chunk of the hot write path. A short-TTL Redis marker
  // lets us serve the denormalization without hammering Postgres; if any
  // tracked field changes the key no longer matches and we write once.
  const markerKey = `auth:email-synced:${user.id}:${user.email}:${user.name || ''}:${user.phone || ''}`;
  try {
    const marker = await cacheGet<string>(markerKey);
    if (marker) return;
  } catch {
    // best-effort cache lookup
  }

  try {
    // The schema defaults display_name to 'User'. Seed it from the IdP's
    // display name on first sight, and overwrite it later only if the row
    // still holds the placeholder default — never clobber a name a user has
    // edited from their profile. Phone follows the same rule: seed the
    // OTP-verified `phone_number` claim when the profile has none, but never
    // clobber a number the user set from their profile.
    await dbQuery(
      `INSERT INTO user_profiles (user_id, email, display_name, phone)
       VALUES ($1, $2, COALESCE(NULLIF($3, ''), 'User'), NULLIF($4, ''))
       ON CONFLICT (user_id) DO UPDATE
         SET email = EXCLUDED.email,
             display_name = CASE
               WHEN user_profiles.display_name IN ('User', 'Anonymous') AND COALESCE(NULLIF($3, ''), '') <> ''
                 THEN $3
               ELSE user_profiles.display_name
             END,
             phone = COALESCE(user_profiles.phone, EXCLUDED.phone),
             updated_at = NOW()
         WHERE user_profiles.email IS DISTINCT FROM EXCLUDED.email
            OR (user_profiles.display_name IN ('User', 'Anonymous') AND COALESCE(NULLIF($3, ''), '') <> '')
            OR (user_profiles.phone IS NULL AND EXCLUDED.phone IS NOT NULL)`,
      [user.id, user.email, user.name || '', user.phone || '']
    );
    try {
      await cacheSet(markerKey, '1', 3600); // 1 hour — re-sync roughly hourly
    } catch {
      // cache write failure is non-fatal
    }
  } catch (err) {
    logger.debug('upsertUserEmail skipped', { err: String(err) });
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new UnauthorizedError('Missing or invalid Authorization header'));
  }

  const token = authHeader.slice(7);

  try {
    req.user = await verifyMemoized(req, token);
  } catch (err: any) {
    logger.warn('JWT verification failed', { error: err.message });
    return next(new UnauthorizedError('Invalid or expired token'));
  }

  // Admin-suspended accounts are rejected on every request (Redis-cached DB
  // flag — instant on suspend, ~1 DB read per user per 5 min otherwise).
  // Throws ForbiddenError(403); must NOT be swallowed into the 401 above.
  try {
    await assertNotSuspended(req.user.id);
  } catch (err) {
    return next(err);
  }

  // Accounts mid-deletion (PRIV-002) are rejected the same way — the Redis
  // cache is primed by the deletion-request endpoint, so enforcement is
  // instant even while the ID token is still valid. Throws ForbiddenError.
  try {
    await assertNotDeleted(req.user.id);
  } catch (err) {
    return next(err);
  }

  // Reject tokens from sessions revoked by a password reset or "sign out
  // everywhere" (Redis-cached tokensValidAfterTime — ~1 IdP read per user per
  // min, instant when the revoke path primes the cache). Throws
  // UnauthorizedError(401) → re-authenticate. Fail-open on infra errors.
  try {
    await assertNotRevoked(req.user.id, req.user.authTimeMs);
  } catch (err) {
    return next(err);
  }

  // Fire-and-forget denormalization. upsertUserEmail has its own try/catch,
  // but an explicit .catch here defends against any throw before the try block
  // so this never surfaces as an unhandledRejection.
  upsertUserEmail(req.user).catch((err) => {
    logger.debug('upsertUserEmail threw synchronously', { err: String(err) });
  });
  next();
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next();
  }

  try {
    const token = authHeader.slice(7);
    req.user = await verifyMemoized(req, token);
  } catch {
    // Continue without user
  }

  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new UnauthorizedError());
    if (!roles.includes(req.user.role || '')) {
      return next(new UnauthorizedError(`Requires role: ${roles.join(' or ')}`));
    }
    next();
  };
}
