/**
 * SINGLE SOURCE OF TRUTH for DynamoDB event-trail retention (PRIV-004).
 *
 * Every writer that stamps an `expiresAt` TTL must take its duration from
 * here — previously five call sites carried private constants (90/365/730
 * days, with audit_events getting TWO different values depending on writer),
 * which is exactly the "retention inconsistent/undocumented" audit finding.
 *
 * The human-readable schedule (with legal basis per store) lives in
 * docs/DATA-RETENTION.md — update both together.
 */

export const RETENTION_DAYS = {
  /** Compliance/audit trail (account lifecycle, admin actions). Longest-lived. */
  auditEvents: 730,
  /** AI agent observability events (same table as auditEvents, shorter need). */
  agentEvents: 90,
  /** API request log (path + userId + IP). CERT-In floor is 180 days. */
  apiRequestLogs: 180,
  /** Fraud signals — velocity/risk features. */
  fraudSignals: 365,
  /** Search analytics events. */
  searchEvents: 365,
  /** Behavioural analytics events (raw; rollups live in Postgres). */
  analyticsEvents: 365,
} as const;

const DAY_SECONDS = 24 * 60 * 60;

/** DynamoDB TTL epoch-seconds value, `days` from now. */
export function ttlEpochSeconds(days: number): number {
  return Math.floor(Date.now() / 1000) + days * DAY_SECONDS;
}
