export interface AuthenticatedPrincipal {
  id: string;
  email: string;
  role?: string;
  /** Display name from the IdP (e.g. Firebase displayName).
   *  Used to seed user_profiles.display_name so booking cards show a real
   *  name instead of the schema default 'User'. */
  name?: string;
  /** Verified phone number from the IdP (e.g. Firebase phone-auth
   *  `phone_number` claim). Synced to user_profiles.phone so booking surfaces
   *  can show a real, OTP-verified contact (e.g. the driver's phone). */
  phone?: string;
  /** When the token's underlying authentication happened (ms since epoch,
   *  from the Firebase `auth_time` claim). require-auth compares this against
   *  the user's `tokensValidAfterTime` to reject sessions revoked by a
   *  password reset or "sign out everywhere". Absent when the IdP doesn't
   *  expose it — the revocation check then no-ops (fail-open). */
  authTimeMs?: number;
}

/**
 * Future implementations:
 * - External IdP / custom JWT validation
 */
export interface IAuthProvider {
  verifyAccessToken(token: string): Promise<AuthenticatedPrincipal>;
  /**
   * Block/unblock sign-in at the IdP (admin user suspension). Optional —
   * providers without an admin API (e.g. the local default provider) omit it
   * and enforcement falls back to the require-auth suspension check alone.
   * When disabling, implementations should also revoke refresh tokens so
   * existing sessions die at the next token refresh.
   */
  setUserDisabled?(userId: string, disabled: boolean): Promise<void>;
  /**
   * Revoke all of a user's refresh tokens ("sign out everywhere"). Existing
   * ID tokens stay cryptographically valid until they expire (≤ 1 h), so
   * immediate enforcement is the require-auth revocation check reading the
   * bumped `tokensValidAfterTime`. Optional — providers without an admin API
   * omit it (logout-all then degrades to local sign-out only).
   */
  revokeSessions?(userId: string): Promise<void>;
  /**
   * The user's `tokensValidAfterTime` as ms since epoch — tokens whose
   * `auth_time` predates it are revoked. Returns null when unknown. Optional;
   * when absent the require-auth revocation check no-ops (fail-open).
   */
  getTokensValidAfterTime?(userId: string): Promise<number | null>;
  /**
   * Permanently delete the user at the IdP (account deletion, PRIV-002).
   * Called as the LAST step of the deletion orchestrator, after app-side data
   * is gone. Optional — providers without an admin API omit it and the
   * require-auth is_deleted check remains the only enforcement. Must be
   * idempotent: deleting an already-deleted user resolves without error.
   */
  deleteUser?(userId: string): Promise<void>;
}
