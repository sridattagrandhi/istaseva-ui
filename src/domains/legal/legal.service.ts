/**
 * Legal / Consent Service
 *
 * Backend-routed consent state (consent_records table, append-only trail).
 * 'marketing' is the opt-in toggle; 'terms' records signup-time acceptance of
 * the Terms + Privacy Policy; 'analytics' mirrors the device cookie/analytics
 * choice (LEG-014). The server rejects other types — widen the union here and
 * in users.controller.ts together.
 */

import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { LEGAL_DOCS_VERSION } from "@/lib/legal";
import { getTrackingConsent } from "@/lib/tracking-consent";
import type { ServiceResult } from "@/types/domain";

// 'analytics' mirrors the device cookie/analytics choice (LEG-014) into the
// server trail; 'age_confirmation' is the 18+ attestation (LEG-003). Keep
// this union in lockstep with the server enum in users.controller.ts.
export type ToggleableConsentType = "marketing" | "terms" | "analytics" | "age_confirmation";

export interface ConsentState {
  consentType: string;
  version: string;
  granted: boolean;
  createdAt: string;
}

// Server row shape (snake_case, from users.repository).
interface ConsentRow {
  consent_type: string;
  version: string;
  granted: boolean;
  created_at: string;
}

const toState = (r: ConsentRow): ConsentState => ({
  consentType: r.consent_type,
  version: r.version,
  granted: !!r.granted,
  createdAt: r.created_at,
});

export class LegalService {
  /** Latest state per consent type for the signed-in user. */
  async getConsents(): Promise<ServiceResult<ConsentState[]>> {
    const result = await apiRequest<{ data: ConsentRow[] }>("/api/users/me/consents", {
      headers: getJsonHeaders(),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: (result.data.data || []).map(toState) };
  }

  /** Record a grant/withdrawal. Appends to the trail; latest row wins. */
  async setConsent(type: ToggleableConsentType, granted: boolean): Promise<ServiceResult<ConsentState>> {
    const result = await apiRequest<{ data: ConsentRow }>(`/api/users/me/consents/${type}`, {
      method: "PUT",
      headers: getJsonHeaders(),
      body: JSON.stringify({ granted }),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: toState(result.data.data) };
  }

  /**
   * Mirror the device cookie/analytics choice (LEG-014) into the append-only
   * consent register, so there's an auditable, versioned, cross-device record
   * of when it was granted/withdrawn. The device localStorage gate
   * (tracking-consent.ts) stays the authoritative RUNTIME switch — it works
   * pre-login and is what actually suppresses analytics; this only adds the
   * server trail. Best-effort: never throws, analytics consent must never
   * block the UI or a network failure lose the device choice.
   */
  async recordAnalyticsConsent(granted: boolean): Promise<void> {
    await this.setConsent("analytics", granted).catch(() => undefined);
  }

  /**
   * On an authenticated load, reconcile the device analytics choice into the
   * register. Appends a row only when the device has an explicit choice that
   * differs from the latest recorded 'analytics' state — covers "chose in the
   * banner before signing in" and a fresh device, without writing a duplicate
   * row on every session. No-op if the device is still 'unset' or the read
   * fails (don't guess).
   */
  async syncAnalyticsConsent(): Promise<void> {
    const device = getTrackingConsent();
    if (device === "unset") return;
    const granted = device === "granted";
    const current = await this.getConsents();
    if (!current.success || !current.data) return;
    const latest = current.data.find((c) => c.consentType === "analytics");
    if (latest && latest.granted === granted) return;
    await this.recordAnalyticsConsent(granted);
  }

  /** Convenience: latest 'marketing' state, defaulting to false when unset. */
  async hasMarketingConsent(): Promise<boolean> {
    const result = await this.getConsents();
    if (!result.success || !result.data) return false;
    return result.data.find((c) => c.consentType === "marketing")?.granted ?? false;
  }

  /**
   * Signup-time consent writes with a durable retry (LEG-001 / LEG-003): the
   * terms row and the 18+ attestation row must exist for every account, so we
   * flag each write as pending BEFORE attempting it and only clear the flag on
   * success. If a write drops (network blip, closed tab),
   * retryPendingTermsConsent() re-fires it on the next authenticated app load.
   */
  async recordSignupConsents(marketingOptIn: boolean): Promise<boolean> {
    try {
      localStorage.setItem(PENDING_TERMS_KEY, "1");
      localStorage.setItem(PENDING_AGE_KEY, "1");
    } catch { /* still attempt */ }
    const result = await this.setConsent("terms", true).catch(() => ({ success: false as const }));
    if (result.success) {
      try { localStorage.removeItem(PENDING_TERMS_KEY); } catch { /* noop */ }
    }
    // The signup form requires the 18+ checkbox before submitting (LEG-003).
    const age = await this.setConsent("age_confirmation", true).catch(() => ({ success: false as const }));
    if (age.success) {
      try { localStorage.removeItem(PENDING_AGE_KEY); } catch { /* noop */ }
    }
    if (marketingOptIn) {
      // Marketing is optional — best-effort, the profile toggle is the recovery path.
      void this.setConsent("marketing", true).catch(() => undefined);
    }
    return result.success;
  }

  /** Re-fire dropped signup consent writes (terms + 18+ attestation). Call once per authed session. */
  async retryPendingTermsConsent(): Promise<void> {
    const pending = (key: string) => {
      try { return localStorage.getItem(key) === "1"; } catch { return false; }
    };
    if (pending(PENDING_TERMS_KEY)) {
      const result = await this.setConsent("terms", true).catch(() => ({ success: false as const }));
      if (result.success) {
        try { localStorage.removeItem(PENDING_TERMS_KEY); } catch { /* noop */ }
      }
    }
    if (pending(PENDING_AGE_KEY)) {
      const result = await this.setConsent("age_confirmation", true).catch(() => ({ success: false as const }));
      if (result.success) {
        try { localStorage.removeItem(PENDING_AGE_KEY); } catch { /* noop */ }
      }
    }
  }

  /**
   * Terms re-consent check (LEG-003, general mechanism): true when the
   * signed-in user's latest recorded 'terms' acceptance predates the current
   * LEGAL_DOCS_VERSION (or is missing/withdrawn) — the blocking re-accept
   * dialog keys off this. Fail-quiet: a failed read returns false so a
   * network blip never locks the app; the check re-runs next session.
   * Skipped while a signup write is still pending (the retry path is about
   * to record the CURRENT version, so prompting would be a false positive).
   */
  async needsTermsReconsent(): Promise<boolean> {
    try {
      if (localStorage.getItem(PENDING_TERMS_KEY) === "1") return false;
    } catch { /* fall through to the server read */ }
    const current = await this.getConsents();
    if (!current.success || !current.data) return false;
    const latest = current.data.find((c) => c.consentType === "terms");
    return !latest || !latest.granted || latest.version !== LEGAL_DOCS_VERSION;
  }

  /**
   * Accept the current Terms + record the 18+ attestation in one step — used
   * by the re-consent dialog, which doubles as the age-attestation backfill
   * for accounts that predate LEG-003. Both rows must land: returns false
   * (dialog stays up) if either write fails.
   */
  async acceptCurrentTerms(): Promise<boolean> {
    const terms = await this.setConsent("terms", true).catch(() => ({ success: false as const }));
    const age = await this.setConsent("age_confirmation", true).catch(() => ({ success: false as const }));
    return terms.success && age.success;
  }
}

const PENDING_TERMS_KEY = "istaseva:pending-terms-consent:v1";
const PENDING_AGE_KEY = "istaseva:pending-age-consent:v1";

let _instance: LegalService | null = null;
export function getLegalService(): LegalService {
  if (!_instance) _instance = new LegalService();
  return _instance;
}
