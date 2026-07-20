import fs from 'node:fs';
import path from 'node:path';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { UnauthorizedError } from '../../../errors/app-error.js';
import { config } from '../../../config/index.js';
import type { AuthenticatedPrincipal, IAuthProvider } from '../../interfaces/auth-provider.interface.js';

/**
 * Parse a Firebase service account JSON, tolerating the common Secrets Manager
 * footgun where the `private_key` field was stored with literal newline characters
 * instead of the escaped `\n` sequence that JSON requires.
 *
 * First try a plain JSON.parse. If that fails with a control-character error,
 * walk the raw string and escape newlines/tabs/CRs that appear inside string
 * literals, then retry.
 */
function parseServiceAccountJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch (err: any) {
    if (!/control character|Unexpected token/i.test(String(err?.message))) throw err;
  }

  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { out += ch; inString = !inString; continue; }
    if (inString) {
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
    }
    out += ch;
  }
  return JSON.parse(out);
}

function ensureFirebaseApp() {
  if (getApps().length > 0) {
    return getApps()[0];
  }

  // Priority:
  // 1. JSON string from Secrets Manager (ECS / production)
  // 2. File path (local development)
  // 3. Application Default Credentials (fallback / CI)
  let credential;
  if (config.auth.firebase.serviceAccountJson) {
    credential = cert(parseServiceAccountJson(config.auth.firebase.serviceAccountJson));
  } else if (config.auth.firebase.serviceAccountPath) {
    credential = cert(
      JSON.parse(fs.readFileSync(path.resolve(config.auth.firebase.serviceAccountPath), 'utf8'))
    );
  } else {
    credential = applicationDefault();
  }

  return initializeApp({
    credential,
    projectId: config.auth.firebase.projectId,
  });
}

export class FirebaseAuthProvider implements IAuthProvider {
  async verifyAccessToken(token: string): Promise<AuthenticatedPrincipal> {
    try {
      ensureFirebaseApp();
      const decodedToken = await getAuth().verifyIdToken(token);

      return {
        id: decodedToken.uid,
        email: decodedToken.email || '',
        role: typeof decodedToken.role === 'string' ? decodedToken.role : 'customer',
        name: typeof decodedToken.name === 'string' ? decodedToken.name : undefined,
        // Phone-auth users carry an OTP-verified `phone_number` claim. Capture
        // it so the require-auth sync can persist it onto user_profiles.phone.
        phone: typeof decodedToken.phone_number === 'string' ? decodedToken.phone_number : undefined,
        // `auth_time` (seconds) is when the user actually authenticated. The
        // revocation check compares it against tokensValidAfterTime.
        authTimeMs: typeof decodedToken.auth_time === 'number' ? decodedToken.auth_time * 1000 : undefined,
      };
    } catch (error: any) {
      throw new UnauthorizedError(error?.message || 'Invalid Firebase access token');
    }
  }

  /**
   * Admin suspension: `disabled: true` rejects future sign-ins, and revoking
   * refresh tokens kills existing sessions at their next token refresh
   * (≤ 1 h). Immediate enforcement inside that window is the require-auth
   * suspension check, not this.
   */
  async setUserDisabled(userId: string, disabled: boolean): Promise<void> {
    ensureFirebaseApp();
    await getAuth().updateUser(userId, { disabled });
    if (disabled) {
      await getAuth().revokeRefreshTokens(userId);
    }
  }

  /**
   * "Sign out everywhere" — revoke every refresh token. Bumps the user's
   * tokensValidAfterTime to now, which the require-auth revocation check reads
   * to reject the still-unexpired ID tokens on other devices.
   */
  async revokeSessions(userId: string): Promise<void> {
    ensureFirebaseApp();
    await getAuth().revokeRefreshTokens(userId);
  }

  /**
   * Account deletion (PRIV-002): permanently remove the Firebase user. Runs
   * as the LAST orchestrator step. Idempotent — a user-not-found error means
   * a previous attempt already succeeded, so it resolves quietly.
   */
  async deleteUser(userId: string): Promise<void> {
    ensureFirebaseApp();
    try {
      await getAuth().deleteUser(userId);
    } catch (error: any) {
      if (error?.code === 'auth/user-not-found') return;
      throw error;
    }
  }

  async getTokensValidAfterTime(userId: string): Promise<number | null> {
    ensureFirebaseApp();
    const user = await getAuth().getUser(userId);
    // Firebase returns a UTC date string; parse to ms. Always set (defaults to
    // account creation), but guard anyway.
    return user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) : null;
  }
}

export const firebaseAuthProvider = new FirebaseAuthProvider();
