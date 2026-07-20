// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '../errors/app-error.js';

// Minimal request/response stand-ins — requireAuth only reads headers and
// (on success) assigns req.user, so a structural cast is all the tests need.
type AuthedRequest = Request & { user?: unknown };
const asReq = (r: object) => r as unknown as AuthedRequest;
const RES = {} as Response;

const verifyAccessToken = vi.fn();
const assertNotSuspended = vi.fn();

vi.mock('../providers/registry.js', () => ({
  getAuthProvider: vi.fn(async () => ({
    verifyAccessToken,
  })),
}));

vi.mock('../logging/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// require-auth.ts imports cacheGet/cacheSet directly — without this mock the
// REAL ioredis client in cache/redis.js is constructed and lazily connects
// during the test, leaving a live TCP connection after teardown whose
// 'connect' handler then calls logger.info (not in the mock above) as an
// uncaught exception that vitest attributes to whatever file happens to be
// running — the source of cross-file flakes. Same pattern as suspension.test.ts.
vi.mock('../cache/redis.js', () => ({
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => undefined),
}));

vi.mock('../repositories/database.js', () => ({
  dbQuery: vi.fn(async () => ({ rows: [] })),
}));

// The suspension check owns its own Redis/Postgres access — unit-tested in
// suspension.test.ts. Here we only verify require-auth's wiring of it.
vi.mock('./suspension.js', () => ({
  assertNotSuspended: (userId: string) => assertNotSuspended(userId),
}));

describe('requireAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertNotSuspended.mockResolvedValue(undefined);
  });

  it('rejects requests without a bearer token', async () => {
    const { requireAuth } = await import('./require-auth.js');
    const next = vi.fn();

    await requireAuth(asReq({ headers: {} }), RES, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    expect((next.mock.calls[0][0] as UnauthorizedError).message).toContain('Authorization');
  });

  it('attaches the authenticated user when token verification succeeds', async () => {
    verifyAccessToken.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      role: 'customer',
    });

    const { requireAuth } = await import('./require-auth.js');
    const req = asReq({
      headers: {
        authorization: 'Bearer token-123',
      },
    });
    const next = vi.fn();

    await requireAuth(req, RES, next);

    expect(req.user).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      role: 'customer',
    });
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects suspended users with the suspension error, not a 401', async () => {
    verifyAccessToken.mockResolvedValue({
      id: 'user-suspended',
      email: 'suspended@example.com',
      role: 'customer',
    });
    assertNotSuspended.mockRejectedValue(new ForbiddenError('This account has been suspended.'));

    const { requireAuth } = await import('./require-auth.js');
    const next = vi.fn();

    await requireAuth(
      asReq({ headers: { authorization: 'Bearer token-123' } }),
      RES,
      next
    );

    expect(assertNotSuspended).toHaveBeenCalledWith('user-suspended');
    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
  });

  it('maps token verification failures to UnauthorizedError', async () => {
    verifyAccessToken.mockRejectedValue(new Error('bad token'));

    const { requireAuth } = await import('./require-auth.js');
    const next = vi.fn();

    await requireAuth(
      asReq({
        headers: {
          authorization: 'Bearer bad-token',
        },
      }),
      RES,
      next
    );

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    expect((next.mock.calls[0][0] as UnauthorizedError).message).toBe('Invalid or expired token');
  });
});

// SEC-007: per-user rate-limit keying. identifyForRateLimit runs BEFORE the
// limiters and must populate req.rateLimitUserId for authenticated traffic
// without ever rejecting.
describe('identifyForRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertNotSuspended.mockResolvedValue(undefined);
  });

  it('sets rateLimitUserId from a valid bearer token, calling next() with no error', async () => {
    verifyAccessToken.mockResolvedValue({ id: 'user-42', email: 'a@b.com' });
    const { identifyForRateLimit } = await import('./require-auth.js');
    const req = asReq({ headers: { authorization: 'Bearer good' } }) as AuthedRequest & { rateLimitUserId?: string };
    const next = vi.fn();

    await identifyForRateLimit(req, RES, next);

    expect(req.rateLimitUserId).toBe('user-42');
    expect(next).toHaveBeenCalledWith(); // no error arg
  });

  it('leaves rateLimitUserId undefined (falls back to IP keying) with no token', async () => {
    const { identifyForRateLimit } = await import('./require-auth.js');
    const req = asReq({ headers: {} }) as AuthedRequest & { rateLimitUserId?: string };
    const next = vi.fn();

    await identifyForRateLimit(req, RES, next);

    expect(req.rateLimitUserId).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it('never rejects on an invalid token — just leaves the request IP-keyed', async () => {
    verifyAccessToken.mockRejectedValue(new Error('bad token'));
    const { identifyForRateLimit } = await import('./require-auth.js');
    const req = asReq({ headers: { authorization: 'Bearer bad' } }) as AuthedRequest & { rateLimitUserId?: string };
    const next = vi.fn();

    await identifyForRateLimit(req, RES, next);

    expect(req.rateLimitUserId).toBeUndefined();
    expect(next).toHaveBeenCalledWith(); // no error — must not 401 here
  });

  it('verifies the token only ONCE across identify + a later requireAuth (memoized)', async () => {
    verifyAccessToken.mockResolvedValue({ id: 'user-7', email: 'c@d.com', role: 'customer' });
    const { identifyForRateLimit, requireAuth } = await import('./require-auth.js');
    // Same request object flows through both middlewares, as in the real app.
    const req = asReq({ headers: { authorization: 'Bearer tok' } }) as AuthedRequest & { rateLimitUserId?: string };

    await identifyForRateLimit(req, RES, vi.fn());
    await requireAuth(req, RES, vi.fn());

    expect(req.rateLimitUserId).toBe('user-7');
    expect((req.user as { id: string }).id).toBe('user-7');
    expect(verifyAccessToken).toHaveBeenCalledTimes(1); // memo reused
  });
});
