// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const consumeRateLimit = vi.fn();
const requestPasswordReset = vi.fn();
const notifyPasswordChanged = vi.fn();
const logoutAllDevices = vi.fn();

vi.mock('../../common/cache/redis.js', () => ({ consumeRateLimit }));
vi.mock('./services/auth.service.js', () => ({ requestPasswordReset, notifyPasswordChanged, logoutAllDevices }));
vi.mock('../../common/logging/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    json(payload: unknown) { this.body = payload; return this; },
    status(code: number) { this.statusCode = code; return this; },
  };
}

const allowed = { allowed: true, count: 1, remaining: 2, resetAt: 0 };
const blocked = { allowed: false, count: 99, remaining: 0, resetAt: 0 };

describe('POST /api/auth/forgot-password — controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumeRateLimit.mockResolvedValue(allowed);
    requestPasswordReset.mockResolvedValue({ delivered: true });
  });

  async function invoke(body: unknown, ip = '1.2.3.4') {
    const { authController } = await import('./controllers/auth.controller.js');
    const req = { body, ip } as any;
    const res = makeRes();
    const next = vi.fn();
    await authController.forgotPassword(req, res as any, next);
    return { res, next };
  }

  it('returns generic success for a valid email and triggers the reset', async () => {
    const { res, next } = await invoke({ email: 'user@example.com' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, delivered: true });
    expect(requestPasswordReset).toHaveBeenCalledWith('user@example.com');
  });

  it('surfaces delivered=false so the client falls back to Firebase', async () => {
    requestPasswordReset.mockResolvedValue({ delivered: false });
    const { res } = await invoke({ email: 'user@example.com' });
    expect(res.body).toEqual({ success: true, delivered: false });
  });

  it('lowercases the email before use', async () => {
    await invoke({ email: 'User@Example.COM' });
    expect(requestPasswordReset).toHaveBeenCalledWith('user@example.com');
  });

  it('rejects a malformed email with a validation error (400) and never sends', async () => {
    const { next } = await invoke({ email: 'not-an-email' });
    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it('returns 429 when the per-email limit is tripped', async () => {
    consumeRateLimit.mockResolvedValueOnce(blocked).mockResolvedValueOnce(allowed);
    const { next } = await invoke({ email: 'user@example.com' });
    expect(next.mock.calls[0][0].statusCode).toBe(429);
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it('returns 429 when the per-IP limit is tripped', async () => {
    consumeRateLimit.mockResolvedValueOnce(allowed).mockResolvedValueOnce(blocked);
    const { next } = await invoke({ email: 'user@example.com' });
    expect(next.mock.calls[0][0].statusCode).toBe(429);
  });
});

describe('POST /api/auth/logout-all — controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logoutAllDevices.mockResolvedValue(undefined);
  });

  async function invoke(userId: string | undefined) {
    const { authController } = await import('./controllers/auth.controller.js');
    const req = { user: userId ? { id: userId } : undefined } as any;
    const res = makeRes();
    const next = vi.fn();
    await authController.logoutAll(req, res as any, next);
    return { res, next };
  }

  it('revokes the caller\'s sessions and returns success', async () => {
    const { res, next } = await invoke('uid-42');
    expect(next).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: true });
    expect(logoutAllDevices).toHaveBeenCalledWith('uid-42');
  });

  it('forwards a service error to next (e.g. provider unsupported → 501)', async () => {
    const err: any = new Error('unsupported'); err.statusCode = 501;
    logoutAllDevices.mockRejectedValue(err);
    const { next } = await invoke('uid-42');
    expect(next.mock.calls[0][0].statusCode).toBe(501);
  });
});

describe('POST /api/auth/password-changed — controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumeRateLimit.mockResolvedValue(allowed);
    notifyPasswordChanged.mockResolvedValue({ notified: true });
  });

  async function invoke(body: unknown, ip = '1.2.3.4') {
    const { authController } = await import('./controllers/auth.controller.js');
    const req = { body, ip } as any;
    const res = makeRes();
    const next = vi.fn();
    await authController.passwordChanged(req, res as any, next);
    return { res, next };
  }

  it('returns generic success and audits/alerts the change', async () => {
    const { res, next } = await invoke({ email: 'user@example.com' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    // Enumeration-safe: no `notified` leak in the response body.
    expect(res.body).toEqual({ success: true });
    expect(notifyPasswordChanged).toHaveBeenCalledWith('user@example.com', { via: 'reset', ip: '1.2.3.4' });
  });

  it('lowercases the email before use', async () => {
    await invoke({ email: 'User@Example.COM' });
    expect(notifyPasswordChanged).toHaveBeenCalledWith('user@example.com', expect.objectContaining({ via: 'reset' }));
  });

  it('still returns success (never fails the completed reset) if the service throws', async () => {
    notifyPasswordChanged.mockRejectedValue(new Error('dynamo down'));
    const { res, next } = await invoke({ email: 'user@example.com' });
    expect(next).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: true });
  });

  it('rejects a malformed email with a validation error (400) and never notifies', async () => {
    const { next } = await invoke({ email: 'not-an-email' });
    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(notifyPasswordChanged).not.toHaveBeenCalled();
  });

  it('returns 429 when the per-email limit is tripped', async () => {
    consumeRateLimit.mockResolvedValueOnce(blocked).mockResolvedValueOnce(allowed);
    const { next } = await invoke({ email: 'user@example.com' });
    expect(next.mock.calls[0][0].statusCode).toBe(429);
    expect(notifyPasswordChanged).not.toHaveBeenCalled();
  });

  it('returns 429 when the per-IP limit is tripped', async () => {
    consumeRateLimit.mockResolvedValueOnce(allowed).mockResolvedValueOnce(blocked);
    const { next } = await invoke({ email: 'user@example.com' });
    expect(next.mock.calls[0][0].statusCode).toBe(429);
  });
});
