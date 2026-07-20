import { config } from '../../../common/config/index.js';
import { logger } from '../../../common/logging/logger.js';
import { logAuditEvent } from '../../../common/logging/audit-log.js';
import { getAuthProvider } from '../../../common/providers/registry.js';
import { setRevokedNowCache } from '../../../common/auth/revocation.js';
import { AppError } from '../../../common/errors/app-error.js';
import { sendNotificationEmail } from '../../notifications/services/email.service.js';

// Firebase Admin lazy init — mirrors the pattern in email.service / fcm.service
// so we don't eagerly initialize the SDK at module load.
let adminApp: any = null;
async function getAdmin() {
  if (adminApp) return adminApp;
  const { default: admin } = await import('firebase-admin');
  if (admin.apps.length > 0) { adminApp = admin.apps[0]; return adminApp; }
  adminApp = admin.initializeApp();
  return adminApp;
}

/**
 * Build the Firebase ActionCodeSettings for a reset link.
 *
 * The `url` is where the user lands to finish the reset — the web
 * `/reset-password` page, which reads the `oobCode` and calls
 * `confirmPasswordReset`. When mobile deep-linking is enabled (and the
 * Dynamic Links / App Links config exists) we set `handleCodeInApp` + the
 * iOS/Android identifiers so the same link opens the native app instead.
 */
function buildActionCodeSettings() {
  const pr = config.auth.passwordReset;
  const url = `${config.app.frontendUrl}${pr.webPath}`;
  const acs: Record<string, any> = { url, handleCodeInApp: false };

  if (pr.mobileDeepLink) {
    acs.handleCodeInApp = true;
    if (pr.iosBundleId) acs.iOS = { bundleId: pr.iosBundleId };
    if (pr.androidPackageName) acs.android = { packageName: pr.androidPackageName, installApp: true };
    if (pr.dynamicLinkDomain) acs.dynamicLinkDomain = pr.dynamicLinkDomain;
  }

  return acs;
}

/**
 * Request a password reset for `email`.
 *
 * Returns `{ delivered }` — whether the branded reset email was actually sent
 * through our own SES/SMTP pipeline. It NEVER signals whether the account
 * exists (an unknown email reports `delivered: true` with nothing sent), so
 * the response can't be used to enumerate registered users.
 *
 * `delivered: false` means our email pipeline is unavailable (no AWS/SES
 * creds, no SMTP, transient send failure) — the caller should fall back to
 * Firebase's built-in sender so a link still reaches the user. This keeps the
 * branded path in configured environments (prod) while staying functional in
 * dev where SES isn't set up.
 *
 * Firebase only mints the one-time link here; delivery is ours.
 */
export async function requestPasswordReset(email: string): Promise<{ delivered: boolean }> {
  let link: string;
  try {
    const admin = await getAdmin();
    link = await admin.auth().generatePasswordResetLink(email, buildActionCodeSettings());
  } catch (err: any) {
    const code = err?.code || err?.errorInfo?.code || '';
    if (code === 'auth/user-not-found' || code === 'auth/email-not-found') {
      // Unknown email — nothing to send, but report "handled" so the caller
      // does NOT fall back (which would also no-op) and existence stays hidden.
      logger.debug('requestPasswordReset: no account for email', { code });
      return { delivered: true };
    }
    // Admin unavailable/misconfigured — let the caller fall back.
    logger.error('requestPasswordReset: failed to generate reset link', { code, err: String(err) });
    return { delivered: false };
  }

  try {
    await sendNotificationEmail({
      toEmail: email,
      type: 'password_reset',
      data: {
        title: 'Reset your password',
        message:
          'We received a request to reset your IstaSeva password. Use the button below to choose a new one. ' +
          'This link expires in 1 hour. If you didn’t request this, you can safely ignore this email.',
        link,
      },
    });
    return { delivered: true };
  } catch (err) {
    // Link generated but our pipeline couldn't deliver (e.g. no SES creds in
    // dev). Report undelivered so the caller falls back to Firebase's sender.
    logger.error('requestPasswordReset: failed to send reset email', { err: String(err) });
    return { delivered: false };
  }
}

/**
 * Handle a client-attested "the password was just changed" signal.
 *
 * Reset completion (`confirmPasswordReset`) happens entirely client-side
 * against Firebase, so the server never observes it. The client fires this
 * afterwards with the email Firebase returned from `verifyPasswordResetCode`
 * so we can (1) write a durable audit record and (2) send a security-alert
 * email — the takeover-detection layer: if an attacker resets a victim's
 * password, the victim gets told and can immediately re-secure.
 *
 * This is best-effort and enumeration-safe. The account is looked up via
 * Firebase Admin so we only email/audit real accounts (an attacker who knows
 * a victim's address can't use this to spam arbitrary inboxes beyond the
 * rate limit, same threat profile as `forgot-password`). Unknown emails
 * no-op silently. Never throws to the caller — the reset already succeeded
 * client-side and must not be reported as failed.
 *
 * `via` distinguishes the trigger ('reset' today; 'change' once an in-app
 * change-password flow exists) so the audit trail stays meaningful.
 */
export async function notifyPasswordChanged(
  email: string,
  ctx: { via: 'reset' | 'change'; ip?: string } = { via: 'reset' },
): Promise<{ notified: boolean }> {
  let uid: string;
  try {
    const admin = await getAdmin();
    const user = await admin.auth().getUserByEmail(email);
    uid = user.uid;
  } catch (err: any) {
    const code = err?.code || err?.errorInfo?.code || '';
    if (code === 'auth/user-not-found' || code === 'auth/email-not-found') {
      // No account — nothing to alert or audit. Stay silent (enumeration-safe).
      logger.debug('notifyPasswordChanged: no account for email', { code });
      return { notified: false };
    }
    // Admin unavailable/misconfigured (e.g. no creds in dev). Can't audit or
    // email, but the reset itself already succeeded — don't surface an error.
    logger.error('notifyPasswordChanged: admin lookup failed', { code, err: String(err) });
    return { notified: false };
  }

  // Durable, server-side record of the change — the piece that was previously
  // impossible because completion is client-side. Fire-and-forget (DynamoDB).
  logAuditEvent({
    event: 'auth.password_changed',
    user_id: uid,
    metadata: { via: ctx.via, ip: ctx.ip ?? null },
  });

  // Security-alert email. Points back at the reset flow so a victim whose
  // account was taken over can re-lock it immediately.
  const reLockLink = `${config.app.frontendUrl}${config.auth.passwordReset.webPath}`;
  try {
    await sendNotificationEmail({
      toEmail: email,
      type: 'password_changed',
      data: {
        title: 'Your password was changed',
        message:
          'The password for your IstaSeva account was just changed. If this was you, no action is needed. ' +
          'If you don’t recognise this, reset your password immediately using the button below and contact support.',
        link: reLockLink,
      },
    });
  } catch (err) {
    // Email pipeline unavailable (e.g. no SES creds in dev). The audit record
    // still landed; don't fail the request.
    logger.error('notifyPasswordChanged: failed to send alert email', { err: String(err) });
  }

  return { notified: true };
}

/**
 * "Sign out everywhere" — revoke every session for `userId`.
 *
 * Revokes the user's refresh tokens at the IdP AND primes the local revocation
 * cache to `now`, so the require-auth revocation check rejects the still-valid
 * ID tokens on other devices immediately (not just at their ≤1 h expiry). The
 * caller's own current session dies too — the client signs out locally right
 * after. Audited for the account timeline.
 *
 * Throws if the active auth provider has no revoke capability (e.g. the local
 * default provider) — the caller surfaces a clear error rather than pretending
 * sessions were killed.
 */
export async function logoutAllDevices(userId: string): Promise<void> {
  const provider = await getAuthProvider();
  if (!provider.revokeSessions) {
    throw new AppError(501, 'Signing out of all devices is not available.', 'NOT_SUPPORTED');
  }

  await provider.revokeSessions(userId);
  await setRevokedNowCache(userId);

  logAuditEvent({
    event: 'auth.sessions_revoked',
    user_id: userId,
    metadata: { via: 'user' },
  });
}
