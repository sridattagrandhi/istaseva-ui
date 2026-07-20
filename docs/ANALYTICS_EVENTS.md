# Analytics Event Contract (PUX-014)

The versioned taxonomy for **first-party behavioural events** — the ones that flow
through `POST /api/analytics/events` (web + mobile) and `trackServerEvent` (server)
into the `analytics_events` table.

> This does **not** cover the separate Mixpanel provider path (`fraud_event`,
> `audit_event`, `Page View`), which is a different pipe.

**Contract version:** `1` (`EVENT_CONTRACT_VERSION`)

## Where it lives (single source of truth + mirrors)

The three codebases share no code, so the event **name set** is duplicated and kept
in lockstep (same convention as the pricing helpers). A parity test fails CI if they
drift. **When you add/rename/remove an event, change all four files in one PR:**

| File | Role |
|---|---|
| `server/src/modules/analytics/contract/events.ts` | **Canonical** — names, versions, descriptions, funnel |
| `src/lib/analytics-events-contract.ts` | Web mirror (name union) |
| `mobile/src/design/api/analyticsEventsContract.ts` | Mobile mirror (name union) |
| `docs/ANALYTICS_EVENTS.md` | This catalog |

## Versioning

- `contractVersion` — taxonomy-wide; bump on a breaking envelope/taxonomy change.
- `eventVersion` — per event; bump when a single event's props/meaning change.
- The **server is authoritative** — it stamps both onto every stored row from its
  registry, so historical rows are always distinguishable. Client-sent versions are
  ignored.

## Enforcement

Lenient by design (analytics is best-effort): an event name not in the registry is
**still stored**, but logged as `Unregistered analytics event(s) ingested`. On the
clients the `EventName` union catches typos at **compile time**. Add new events to
the registry *before* firing them.

## Events

| Event | Ver | Fired from | Description |
|---|---|---|---|
| `login` | 1 | web, mobile | User signed in (email or phone). |
| `signup` | 1 | web, mobile | A new account was created. |
| `verify_phone` | 1 | mobile | Phone OTP verified (mobile number linking). |
| `search_performed` | 1 | web, mobile | A marketplace search was executed. |
| `card_clicked` | 1 | web, mobile | A listing card was tapped in discovery/explore. |
| `listing_viewed` | 1 | web, mobile | A listing detail page/screen was viewed. |
| `booking_modal_opened` | 1 | web, mobile | The booking modal/screen was opened for a listing. |
| `payment_started` | 1 | web, mobile | Checkout / Razorpay order was initiated. |
| `payment_failed` | 1 | web, mobile, server | Payment failed or was dismissed. |
| `booking_confirmed` | 1 | server | Booking confirmed & paid — funnel tail. |
| `booking_cancelled` | 1 | server | A booking was cancelled. |
| `coupon_applied` | 1 | web | A coupon was accepted on the booking. |
| `coupon_failed` | 1 | web | A coupon code was rejected. |
| `wishlist_add` | 1 | web | A listing was saved to the wishlist. |
| `wishlist_remove` | 1 | web | A listing was removed from the wishlist. |
| `message_provider_clicked` | 1 | web, mobile | The "message provider" CTA was tapped. |
| `provider_call_clicked` | 1 | web, mobile | The "call provider" CTA was tapped. |
| `listing_created` | 1 | server | A new listing was published. |
| `review_submitted` | 1 | server | A review was submitted. |
| `ai_message` | 1 | server | The AI assistant produced a reply. |
| `fraud_signal` | 1 | server | A fraud signal was recorded. |

## Props contract

Each event declares a **permissive** `props` schema in the registry — every field
optional, extra keys allowed (`.passthrough()`). It documents the fields the
rollups consume and, on ingest, catches a wrong TYPE (e.g. `revenuePaise` sent as
a string) — logged as `Analytics event props did not match the contract`, but the
row is still stored (lenient). Load-bearing props today:

- `search_performed` → `q`, `queryLength`, `resultCount`
- `booking_modal_opened` / `payment_started` → `destCity`
- `payment_failed` → `reasonCode`
- `booking_confirmed` → `revenuePaise`, `providerUserId`, `city`
- `booking_cancelled` → `refundPaise`, `reason`
- `coupon_applied` → `discountPaise` · `review_submitted` → `rating`
- `fraud_signal` → `riskLevel`, `kind` · `signup` → `role`
- `provider_call_clicked` / `message_provider_clicked` → `roles`

## Booking funnel (ordered)

Declared once in `BOOKING_FUNNEL`:

`card_clicked` → `listing_viewed` → `booking_modal_opened` → `payment_started` → `booking_confirmed`

The aggregator (`analytics-rollup.ts`) is the funnel's implementation; a contract
test asserts every declared stage is handled there, so the declaration and the
aggregation can't drift. The rollup was intentionally **not** rewritten to iterate
`BOOKING_FUNNEL` — it already implements the funnel correctly (with per-type and
per-listing bucketing + revenue), and a mechanical rewrite would risk a tested,
working aggregator for no functional gain.

## Not yet done (separate ticket — net-new instrumentation)

These are new *events*, not contract work — they belong to a follow-up
instrumentation ticket, not PUX-014:

- `impression` (card seen vs clicked), client-side `payment_succeeded`,
  `checkout_abandoned`, `filters_applied` / `sort_changed`, and map-interaction
  events (`map_view_toggled`, `map_move_search`).
