// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generatePasswordResetLink = vi.fn();
const getUserByEmail = vi.fn();
const sendNotificationEmail = vi.fn();
const logAuditEvent = vi.fn();
const setRevokedNowCache = vi.fn();
const revokeSessions = vi.fn();
let authProvider: any;
const getAuthProvider = vi.fn(async () => authProvider);

vi.mock('../../common/config/index.js', () => ({
  config: {
    app: { frontendUrl: 'https://app.example.com' },
    auth: { passwordReset: { webPath: '/reset-password', mobileDeepLink: false } },
  },
}));
vi.mock('../../common/logging/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));
vi.mock('../../common/logging/audit-log.js', () => ({ logAuditEvent }));
vi.mock('../../common/providers/registry.js', () => ({ getAuthProvider }));
vi.mock('../../common/auth/revocation.js', () => ({ setRevokedNowCache }));
vi.mock('../notifications/services/email.service.js', () => ({ sendNotificationEmail }));
vi.mock('firebase-admin', () => ({
  default: {
    apps: [],
    initializeApp: () => ({ auth: () => ({ generatePasswordResetLink, getUserByEmail }) }),
  },
}));

describe('requestPasswordReset — service (enumeration-safe)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a branded reset email pointing the link at the web reset page', async () => {
    generatePasswordResetLink.mockResolvedValue('https://firebase/reset?oobCode=abc');
    sendNotificationEmail.mockResolvedValue(undefined);
    const { requestPasswordReset } = await import('./services/auth.service.js');

    const result = await requestPasswordReset('known@example.com');

    expect(result).toEqual({ delivered: true });
    // Link is generated against our frontend continue URL...
    expect(generatePasswordResetLink).toHaveBeenCalledWith(
      'known@example.com',
      expect.objectContaining({ url: 'https://app.example.com/reset-password' }),
    );
    // ...and delivered through our own pipeline, not Firebase's sender.
    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    const arg = sendNotificationEmail.mock.calls[0][0];
    expect(arg.type).toBe('password_reset');
    expect(arg.toEmail).toBe('known@example.com');
    expect(arg.data.link).toContain('oobCode');
  });

  it('reports delivered (no leak) and sends nothing for an unknown account', async () => {
    const err: any = new Error('no user'); err.code = 'auth/user-not-found';
    generatePasswordResetLink.mockRejectedValue(err);
    const { requestPasswordReset } = await import('./services/auth.service.js');

    await expect(requestPasswordReset('ghost@example.com')).resolves.toEqual({ delivered: true });
    expect(sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('reports delivered=false (→ client fallback) when email delivery fails', async () => {
    generatePasswordResetLink.mockResolvedValue('https://firebase/reset?oobCode=abc');
    sendNotificationEmail.mockRejectedValue(new Error('SES down'));
    const { requestPasswordReset } = await import('./services/auth.service.js');

    await expect(requestPasswordReset('known@example.com')).resolves.toEqual({ delivered: false });
  });

  it('reports delivered=false when link generation fails (admin misconfigured)', async () => {
    generatePasswordResetLink.mockRejectedValue(new Error('no credentials'));
    const { requestPasswordReset } = await import('./services/auth.service.js');

    await expect(requestPasswordReset('known@example.com')).resolves.toEqual({ delivered: false });
    expect(sendNotificationEmail).not.toHaveBeenCalled();
  });
});

describe('notifyPasswordChanged — service (audit + security alert)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('audits the change and emails an alert for a known account', async () => {
    getUserByEmail.mockResolvedValue({ uid: 'uid-123' });
    sendNotificationEmail.mockResolvedValue(undefined);
    const { notifyPasswordChanged } = await import('./services/auth.service.js');

    const result = await notifyPasswordChanged('known@example.com', { via: 'reset', ip: '9.9.9.9' });

    expect(result).toEqual({ notified: true });
    // Durable audit record keyed on the resolved uid.
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'auth.password_changed',
      user_id: 'uid-123',
      metadata: { via: 'reset', ip: '9.9.9.9' },
    }));
    // Security-alert email with a re-lock link back to the reset page.
    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    const arg = sendNotificationEmail.mock.calls[0][0];
    expect(arg.type).toBe('password_changed');
    expect(arg.toEmail).toBe('known@example.com');
    expect(arg.data.link).toBe('https://app.example.com/reset-password');
  });

  it('no-ops silently for an unknown account (enumeration-safe, no audit/email)', async () => {
    const err: any = new Error('no user'); err.code = 'auth/user-not-found';
    getUserByEmail.mockRejectedValue(err);
    const { notifyPasswordChanged } = await import('./services/auth.service.js');

    await expect(notifyPasswordChanged('ghost@example.com')).resolves.toEqual({ notified: false });
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect(sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('no-ops (notified:false) when admin is misconfigured, without throwing', async () => {
    getUserByEmail.mockRejectedValue(new Error('no credentials'));
    const { notifyPasswordChanged } = await import('./services/auth.service.js');

    await expect(notifyPasswordChanged('known@example.com')).resolves.toEqual({ notified: false });
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect(sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('still reports notified:true (audit landed) when the alert email fails', async () => {
    getUserByEmail.mockResolvedValue({ uid: 'uid-123' });
    sendNotificationEmail.mockRejectedValue(new Error('SES down'));
    const { notifyPasswordChanged } = await import('./services/auth.service.js');

    await expect(notifyPasswordChanged('known@example.com')).resolves.toEqual({ notified: true });
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
  });
});

describe('logoutAllDevices — service (sign out everywhere)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authProvider = { revokeSessions };
    revokeSessions.mockResolvedValue(undefined);
    setRevokedNowCache.mockResolvedValue(undefined);
  });

  it('revokes sessions, primes the revocation cache, and audits', async () => {
    const { logoutAllDevices } = await import('./services/auth.service.js');

    await logoutAllDevices('uid-9');

    expect(revokeSessions).toHaveBeenCalledWith('uid-9');
    expect(setRevokedNowCache).toHaveBeenCalledWith('uid-9');
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'auth.sessions_revoked',
      user_id: 'uid-9',
    }));
  });

  it('throws 501 when the provider has no revoke capability, without auditing', async () => {
    authProvider = {}; // e.g. the local default provider
    const { logoutAllDevices } = await import('./services/auth.service.js');

    await expect(logoutAllDevices('uid-9')).rejects.toMatchObject({ statusCode: 501 });
    expect(setRevokedNowCache).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});
