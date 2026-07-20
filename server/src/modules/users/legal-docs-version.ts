/**
 * SINGLE SOURCE OF TRUTH for legal-document versioning (PRIV-001 / LEG-001).
 *
 * The server stamps this version onto every 'terms' consent row — clients
 * never send a version, so this constant is what the ledger records. The two
 * client copies exist only to DISPLAY the version on the legal pages:
 *
 *   - web:    src/lib/legal.ts                    → LEGAL_DOCS_VERSION
 *   - mobile: mobile/src/design/screens/LegalScreens.tsx → LEGAL_DOCS_VERSION
 *
 * Bump all three IN THE SAME PR whenever the Terms or Privacy Policy text
 * materially changes; the page copy and the ledger must agree on which
 * wording a user accepted.
 */
export const LEGAL_DOCS_VERSION = '1.3.0-draft';

/**
 * Marketing consent isn't tied to a legal document; its version only changes
 * if the marketing-consent copy itself changes.
 */
export const MARKETING_CONSENT_VERSION = '1.0.0';

/**
 * Cookie / device-analytics consent (LEG-014). Stamped onto every 'analytics'
 * consent row so the append-only register records WHICH cookie/analytics
 * disclosure the user accepted. This value is MIRRORED on the clients
 * (web `src/lib/tracking-consent.ts`, mobile
 * `mobile/src/design/api/analyticsEvents.ts` — parity-tested): a device
 * choice recorded under an older version reads as unset/withdrawn, so
 * bumping this re-opens the web banner and suppresses tracking until the
 * user re-decides. Bump it only when the analytics/cookie disclosure wording
 * itself materially changes, and bump all three copies in the same PR.
 */
export const ANALYTICS_CONSENT_VERSION = '1.0.0';

/**
 * 18+ age attestation (LEG-003). The platform is adults-only: signup (and the
 * terms re-consent flow, which backfills existing accounts) requires an
 * affirmative "I am 18 or older" attestation, recorded as its own
 * 'age_confirmation' row in consent_records — deliberately NOT bundled into
 * the terms row, so the ledger shows WHICH representation the user made.
 * We store an attestation (boolean + version + timestamp), never a date of
 * birth — a DOB is sensitive PII retained forever to answer a yes/no
 * question. Bump only if the attestation wording itself changes.
 */
export const AGE_CONFIRMATION_VERSION = '1.0.0';
