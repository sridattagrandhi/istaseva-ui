/**
 * Device/analytics tracking consent (LEG-014).
 *
 * Non-essential tracking (first-party behavioural analytics + third-party
 * analytics like Mixpanel) must not run before the user makes a choice in
 * the cookie/tracking banner. State is per-device in localStorage:
 *
 *   'granted' — user accepted analytics
 *   'denied'  — user declined (default action of the banner)
 *   'unset'   — no choice yet → treat as denied, banner is showing
 *
 * Essential/functional storage (auth session, language, recent searches) is
 * NOT gated here — only measurement.
 */

const CONSENT_KEY = "istaseva:tracking-consent:v1";
const CONSENT_VERSION_KEY = "istaseva:tracking-consent-version:v1";
const ANALYTICS_DEVICE_ID_KEY = "istaseva:analytics:device-id:v1";

/**
 * Which analytics/cookie disclosure the stored choice was made against.
 * MIRROR of the server's ANALYTICS_CONSENT_VERSION in
 * server/src/modules/users/legal-docs-version.ts (and the mobile copy in
 * mobile/src/design/api/analyticsEvents.ts) — a parity test keeps the three
 * in lockstep. Bumping it re-opens the banner: a choice recorded under an
 * older version reads as 'unset', so tracking stays suppressed until the
 * user re-decides against the new disclosure.
 */
export const ANALYTICS_CONSENT_VERSION = "1.0.0";

// Choices stored before versioning shipped have no version key. They were
// made against 1.0.0, so they grandfather to that LITERAL (not to "current"
// — otherwise pre-versioning users would be skipped by every future bump).
const GRANDFATHERED_VERSION = "1.0.0";

export type TrackingConsent = "granted" | "denied" | "unset";

type Listener = (state: TrackingConsent) => void;
const listeners = new Set<Listener>();

export function getTrackingConsent(): TrackingConsent {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    if (v !== "granted" && v !== "denied") return "unset";
    const chosenAt = localStorage.getItem(CONSENT_VERSION_KEY) ?? GRANDFATHERED_VERSION;
    // Stale disclosure version → re-ask. The stored choice is left in place
    // (syncAnalyticsConsent no-ops on 'unset', so no register row is written).
    if (chosenAt !== ANALYTICS_CONSENT_VERSION) return "unset";
    return v;
  } catch {
    return "unset";
  }
}

/** Convenience: true only after an explicit accept. */
export function hasTrackingConsent(): boolean {
  return getTrackingConsent() === "granted";
}

export function setTrackingConsent(granted: boolean): void {
  try {
    localStorage.setItem(CONSENT_KEY, granted ? "granted" : "denied");
    localStorage.setItem(CONSENT_VERSION_KEY, ANALYTICS_CONSENT_VERSION);
    if (!granted) {
      // Withdraw = also drop the persistent analytics device id, so a later
      // grant starts a fresh identity instead of resurrecting the old trail.
      localStorage.removeItem(ANALYTICS_DEVICE_ID_KEY);
    }
  } catch {
    /* storage unavailable — stay 'unset', banner will re-ask */
  }
  const state = getTrackingConsent();
  listeners.forEach((fn) => fn(state));
}

/** Subscribe to consent changes; returns an unsubscribe. */
export function onTrackingConsentChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
