/**
 * Cancellation-policy copy — the single source of truth for the
 * customer-facing "free cancellation" text shown on the booking
 * confirmation email and the GST tax-invoice PDF.
 *
 * Product rule (display only for now — NOT yet enforced in the refund
 * logic; see README "Free-cancellation cutoff"): free cancellation is
 * available up to 10:00 AM IST, two days before the booking start date.
 *
 * Both surfaces know the concrete booking start date, so they render a
 * concrete cutoff ("Free cancellation until 10:00 AM IST on Mon, 08 Jun
 * 2026"). The listing detail pages (client) can't — they show the generic
 * sentence instead (mirrored in src/redesign/MarketplaceDetailPages.tsx).
 *
 * NOTE: this is COPY only. The actual refund computation still lives in
 * server/src/modules/payments/pricing/cancellation.ts and currently grants
 * a full refund regardless of timing. Wire the cutoff in there when we move
 * from "display" to "enforce".
 */

export type CancellationPolicy = 'flexible' | 'moderate' | 'strict';

/** Days before the booking start date that free cancellation closes. */
export const FREE_CANCELLATION_CUTOFF_DAYS = 2;
/** Time-of-day (India Standard Time) at which free cancellation closes. */
export const FREE_CANCELLATION_CUTOFF_TIME_LABEL = '10:00 AM IST';

/**
 * Concrete cutoff date label (e.g. "08 Jun 2026") for a booking that
 * starts on `startDateIso` (a 'YYYY-MM-DD' date or ISO timestamp). Returns
 * null when no usable start date is available, so callers fall back to the
 * generic copy.
 *
 * IST has no daylight saving, so anchoring at +05:30 and stepping back whole
 * days in milliseconds is exact.
 */
export function freeCancellationCutoffLabel(startDateIso?: string | null): string | null {
  if (!startDateIso) return null;
  const dateOnly = String(startDateIso).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return null;
  const anchor = new Date(`${dateOnly}T10:00:00+05:30`);
  if (Number.isNaN(anchor.getTime())) return null;
  const cutoff = new Date(anchor.getTime() - FREE_CANCELLATION_CUTOFF_DAYS * 24 * 60 * 60 * 1000);
  return cutoff.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

/** Self-service hint pointing the customer back to IstaSeva so they don't
 *  email support to cancel — the dashboard does it instantly. */
const CANCEL_HINT =
  "Refunds usually land in 5-7 business days. To cancel, sign in to your IstaSeva dashboard and use the booking's Cancel button.";

/**
 * Plain-English cancellation copy for receipts/emails. When the booking
 * start date is known we state the concrete free-cancellation cutoff;
 * otherwise we fall back to the generic full-refund line. The stored listing
 * policy is currently ignored — product rule is full refund on cancellation.
 */
export function describeCancellationPolicy(
  _policy: CancellationPolicy,
  startDateIso?: string | null,
): string {
  const cutoff = freeCancellationCutoffLabel(startDateIso);
  if (cutoff) {
    return `Free cancellation until ${FREE_CANCELLATION_CUTOFF_TIME_LABEL} on ${cutoff} — full refund if you cancel before then. ${CANCEL_HINT}`;
  }
  return `Full refund on cancellation. ${CANCEL_HINT}`;
}
