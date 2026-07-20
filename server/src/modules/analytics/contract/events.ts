/**
 * CANONICAL analytics event contract (PUX-014).
 *
 * This is the single source of truth for the first-party behavioural-event
 * taxonomy — the events that flow through `POST /api/analytics/events` and
 * `trackServerEvent` into the `analytics_events` table. It does NOT cover the
 * separate Mixpanel provider path (`fraud_event`, `audit_event`, `Page View`).
 *
 * MIRRORED (this codebase shares no code across web/mobile/server, so the event
 * NAME set is duplicated and kept in lockstep — same pattern as the pricing
 * helpers):
 *   - web:    src/lib/analytics-events-contract.ts
 *   - mobile: mobile/src/design/api/analyticsEventsContract.ts
 * A parity test (src/lib/analytics-events-contract.test.ts) fails if the three
 * name sets drift. When you add/rename/remove an event, update all three files
 * AND docs/ANALYTICS_EVENTS.md in the same PR.
 *
 * VERSIONING: `EVENT_CONTRACT_VERSION` is the taxonomy-wide version (bump when
 * the shape/meaning of the envelope or a batch of events changes). Each event
 * also carries its own `version` so a single event can evolve independently.
 * The SERVER is authoritative for versions — it stamps `contractVersion` +
 * `eventVersion` onto every stored row from THIS registry, so historical rows
 * are always distinguishable regardless of client staleness.
 */

import { z } from 'zod';

/** Taxonomy-wide contract version. Bump on a breaking envelope/taxonomy change. */
export const EVENT_CONTRACT_VERSION = 1;

/**
 * Default `props` contract: any keys allowed. Used for events that carry no
 * load-bearing properties. Every schema is intentionally PERMISSIVE — all keys
 * optional and extras allowed (`.passthrough()`) — because validation is lenient
 * (a mismatch is logged, never dropped). The point is to document + type-check
 * the props the rollups actually consume, and catch a wrong TYPE (e.g.
 * `revenuePaise` sent as a string), not to reject events.
 */
const anyProps = z.record(z.unknown());

export interface EventSpec {
  /** Per-event version — bump when THIS event's props/meaning change. */
  version: number;
  /** One-line human description (surfaced in docs/ANALYTICS_EVENTS.md). */
  description: string;
  /** Permissive schema for `props` — documents the fields the rollups read. */
  props: z.ZodTypeAny;
}

/**
 * Every first-party event, its version, and what it means. Add new events here
 * FIRST (then fire them) — an event not in this registry is stored but flagged
 * as `unregistered_event` server-side.
 */
export const ANALYTICS_EVENTS = {
  // ── Auth ────────────────────────────────────────────────────────────────
  login: { version: 1, description: 'User signed in (email or phone).', props: anyProps },
  signup: { version: 1, description: 'A new account was created.', props: z.object({ role: z.string().optional() }).passthrough() },
  verify_phone: { version: 1, description: 'Phone OTP verified (mobile number linking).', props: anyProps },
  // ── Discovery / search ──────────────────────────────────────────────────
  search_performed: { version: 1, description: 'A marketplace search was executed.', props: z.object({ q: z.string().optional(), queryLength: z.number().optional(), resultCount: z.number().optional() }).passthrough() },
  card_clicked: { version: 1, description: 'A listing card was tapped in discovery/explore.', props: anyProps },
  listing_viewed: { version: 1, description: 'A listing detail page/screen was viewed.', props: anyProps },
  // ── Booking funnel ──────────────────────────────────────────────────────
  booking_modal_opened: { version: 1, description: 'The booking modal/screen was opened for a listing.', props: z.object({ destCity: z.string().optional() }).passthrough() },
  payment_started: { version: 1, description: 'Checkout / Razorpay order was initiated.', props: z.object({ destCity: z.string().optional() }).passthrough() },
  payment_failed: { version: 1, description: 'Payment failed or was dismissed by the user.', props: z.object({ reasonCode: z.string().optional() }).passthrough() },
  booking_confirmed: { version: 1, description: 'Booking confirmed & paid — funnel tail (server-emitted).', props: z.object({ revenuePaise: z.number().optional(), providerUserId: z.string().optional(), city: z.string().optional() }).passthrough() },
  booking_cancelled: { version: 1, description: 'A booking was cancelled (server-emitted).', props: z.object({ refundPaise: z.number().optional(), reason: z.string().optional() }).passthrough() },
  // ── Coupons ─────────────────────────────────────────────────────────────
  coupon_applied: { version: 1, description: 'A coupon was accepted on the booking.', props: z.object({ discountPaise: z.number().optional() }).passthrough() },
  coupon_failed: { version: 1, description: 'A coupon code was rejected.', props: anyProps },
  // ── Wishlist / engagement ───────────────────────────────────────────────
  wishlist_add: { version: 1, description: 'A listing was saved to the wishlist.', props: anyProps },
  wishlist_remove: { version: 1, description: 'A listing was removed from the wishlist.', props: anyProps },
  message_provider_clicked: { version: 1, description: 'The "message provider" CTA was tapped.', props: z.object({ roles: z.array(z.string()).optional() }).passthrough() },
  provider_call_clicked: { version: 1, description: 'The "call provider" CTA was tapped.', props: z.object({ roles: z.array(z.string()).optional() }).passthrough() },
  // ── Supply / content / assistant (server-emitted) ───────────────────────
  listing_created: { version: 1, description: 'A new listing was published (server-emitted).', props: anyProps },
  review_submitted: { version: 1, description: 'A review was submitted (server-emitted).', props: z.object({ rating: z.number().optional() }).passthrough() },
  ai_message: { version: 1, description: 'The AI assistant produced a reply (server-emitted).', props: anyProps },
  fraud_signal: { version: 1, description: 'A fraud signal was recorded (server-emitted).', props: z.object({ riskLevel: z.string().optional(), kind: z.string().optional() }).passthrough() },
} as const satisfies Record<string, EventSpec>;

/** Union of every known event name. Client `track()` uses this for typo-safety. */
export type EventName = keyof typeof ANALYTICS_EVENTS;

/** All known event names as a set (used by validation + the parity test). */
export const EVENT_NAMES: readonly EventName[] = Object.keys(ANALYTICS_EVENTS) as EventName[];

/** Registry lookup for an arbitrary (possibly unknown) event name. */
export function eventSpec(name: string): EventSpec | null {
  return (ANALYTICS_EVENTS as Record<string, EventSpec>)[name] ?? null;
}

/**
 * The booking funnel, in order. Declared here so rollups/reporting key off one
 * definition instead of scattered string literals. Each entry is a real event.
 */
export const BOOKING_FUNNEL: readonly EventName[] = [
  'card_clicked',
  'listing_viewed',
  'booking_modal_opened',
  'payment_started',
  'booking_confirmed',
];
