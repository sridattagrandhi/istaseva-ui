/**
 * Legal document versioning (PRIV-001 / LEG-001).
 *
 * DISPLAY MIRROR of the server's source of truth
 * (server/src/modules/users/legal-docs-version.ts) — the server stamps the
 * version onto the consent ledger; this copy only labels the legal pages.
 * Bump both (plus the mobile mirror in LegalScreens.tsx) in the same PR
 * whenever the Terms or Privacy Policy text materially changes.
 *
 * The current documents are ENGINEERING DRAFTS pending review by Indian
 * counsel — they accurately describe system behavior (what is collected,
 * retained, deleted) but the binding wording must come from Legal before
 * launch. Swap the page copy and bump this version in the same PR.
 */
export const LEGAL_DOCS_VERSION = "1.3.0-draft";

export const GRIEVANCE_EMAIL = "grievance@istaseva.com";
export const SUPPORT_EMAIL = "hello@istasewa.in";
/** Company support line — the single source for every "call us" surface
 *  (Contact page, Footer, chatbot copy). Mirrored on mobile in
 *  `mobile/src/design/support.ts` — change both together. */
export const SUPPORT_PHONE = "+91 80 1234 5678";
