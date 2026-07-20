/**
 * WEB MIRROR of the canonical analytics event contract (PUX-014).
 *
 * Canonical source: server/src/modules/analytics/contract/events.ts
 * Mobile mirror:    mobile/src/design/api/analyticsEventsContract.ts
 *
 * These three files share no code, so the event NAME set is duplicated and kept
 * byte-identical (same convention as the pricing helpers). The parity test in
 * analytics-events-contract.test.ts fails if they drift. When you add/rename an
 * event, update all three files AND docs/ANALYTICS_EVENTS.md in the same PR.
 *
 * The client only needs the NAME union (for compile-time typo-safety on
 * `track()`). Per-event version numbers live authoritatively on the server,
 * which stamps them onto every stored row.
 */

/** Taxonomy-wide contract version (mirror of the server constant). */
export const EVENT_CONTRACT_VERSION = 1;

/** Every known first-party event name. Keep in sync with the canonical registry. */
export const EVENT_NAMES = [
  // Auth
  'login',
  'signup',
  'verify_phone',
  // Discovery / search
  'search_performed',
  'card_clicked',
  'listing_viewed',
  // Booking funnel
  'booking_modal_opened',
  'payment_started',
  'payment_failed',
  'booking_confirmed',
  'booking_cancelled',
  // Coupons
  'coupon_applied',
  'coupon_failed',
  // Wishlist / engagement
  'wishlist_add',
  'wishlist_remove',
  'message_provider_clicked',
  'provider_call_clicked',
  // Supply / content / assistant (server-emitted)
  'listing_created',
  'review_submitted',
  'ai_message',
  'fraud_signal',
] as const;

/** Union of every known event name — the typed argument to `track()`. */
export type EventName = (typeof EVENT_NAMES)[number];
