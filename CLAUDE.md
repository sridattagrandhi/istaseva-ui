# IstaSeva — AI Agent Guide

This file is the short, practical briefing for AI agents working in this repo. Keep it current when architecture changes; stale guidance here causes bad code.

## What This Is

IstaSeva is an India-focused marketplace for stays, local services, and transport. It is a modular monolith with:

- `src/` — React 18 + Vite web app.
- `server/` — Express 4 + Node 20 API server.
- `mobile/` — Expo 51 + React Native 0.74 app.
- `infrastructure/` — AWS CDK infrastructure.
- `server/migrations/` — PostgreSQL schema migrations and the source of truth for DB changes.
- `src/redesign/` — redesigned client surfaces (marketplace, booking modals, controls) wired into the main web app.

The codebase started from Lovable/Supabase, but the current direction is AWS-backed, Express-owned business logic, and PostgreSQL-owned transactional state. Supabase is fully removed — there is no `supabase/` directory, no `@supabase/*` dependency, and no Supabase code in any of the three apps.

## First Rules For Agents

- Read nearby code before changing patterns. This repo has several legacy paths that should not be copied.
- Do not reintroduce Supabase in any form — dependencies, migrations, or RPC/data escape hatches.
- Frontend product data should flow through domain services and `src/lib/api-client.ts`, not direct SDK calls.
- Backend business rules belong in module services; SQL belongs in repositories.
- Database state transitions and invariants should be enforced by migrations/triggers where needed, not only by UI checks.
- The worktree may be dirty. Do not revert unrelated changes.

## Cross-cutting invariants (recently load-bearing)

These rules were established through specific incidents — breaking them re-introduces real, debugged-in-prod bugs. Update them in lockstep when the underlying behavior actually changes.

**Booking scope is per-LISTING, not per-host/provider.**
A host can own multiple listings under one `provider_profile` (a cab + a salon, two cars, two stylists). Schedule/blocking/conflict checks must scope by `listing_id`, never by `provider_id` or `user_id`. The authoritative paths:
- Host-blocked days live in `listings.metadata.blockedDates` (the row, not the profile).
- Backend conflict check: `findConflictingBookingsForUpdate` in `server/src/modules/bookings/repositories/bookings.repository.ts` uses `scopeCol = listingId ? 'listing_id' : 'provider_id'` — always pass `listingId`.
- `server/src/modules/listings/services/listings.service.ts:update()` deliberately does NOT mirror `metadata.workingHours` / `bufferMinutes` to `provider_profiles`. Reading code: smart-schedule's listing-scoped path now reads `listing_metadata.workingHours` and falls back to `provider.working_hours` only when listing metadata is empty.
- Frontend React-Query keys are `["service-bookings", listingId]` / `["transport-bookings", listingId]`. Invalidate both (plus `["bookings"]` / `["partner-bookings"]`) on every booking-success path.

**Pricing parity: the modal's breakdown must equal the Razorpay order amount.**
The breakdown the user sees on the Review screen has historically drifted from the actual charge. The current single sources of truth:
- Backend: `applyFees` in `server/src/modules/payments/pricing/booking-price.ts` — fee/tax computed on the *discounted* subtotal.
- **The platform fee is RULE-DRIVEN, not a constant.** Admin fee rules live in `fee_rules`/`fee_city_tiers` (admin `/admin/fees` panel; API `/api/admin/fees/*`). Resolution is most-specific-wins — listing > city > city_tier > state > global, category-specific beats category-NULL at the same level — in `server/src/modules/payments/services/fee-rules.service.ts`; the fee math (`percent_bps` + `fixed_paise`, clamped to min/max caps) is `computePlatformFeePaise` in `pricing/fees.ts`. createHold resolves the rule, passes the spec into `applyFees`, and snapshots `fee_rule_id` on the booking. Any resolution failure falls back to the legacy flat ₹3 (`LEGACY_PLATFORM_FEE_SPEC`) — the seeded global default reproduces the same ₹3, so a fresh DB behaves identically.
- Clients DON'T hardcode the fee: they fetch the resolved spec once per listing from `GET /api/listings/:id/fee-quote` (web `src/hooks/use-fee-spec.ts`, mobile `useFeeSpec` in `mobile/src/design/api/hooks.ts`) and apply the mirrored `computePlatformFeePaise` (web `src/lib/pricing.ts`, mobile `mobile/src/design/pricing.ts`) to the discounted subtotal. On fetch failure they fall back to the same legacy flat spec the server falls back to. Keep the three `computePlatformFeePaise` copies byte-identical.
- Frontend mirror for stays: `computeBookingFees` / `computeStayBreakdownPaise` in `src/lib/pricing.ts` / `src/lib/stay-pricing.ts` (both take an optional `feeSpec`). Services + transport use inline math in `src/redesign/MarketplaceBookingModal.tsx` — keep them aligned with `applyFees` when changing fee structure.
- **Insurance / trip protection is a flat ₹2**, added AFTER tax to the order amount. Helpers: `insurancePremiumRupees` in `server/src/modules/payments/pricing/fees.ts` + the matching client mirror at `src/lib/pricing.ts`. Both ignore their argument and return `INSURANCE_FLAT_RUPEES`. Never inline-compute insurance as a percentage; it falls out of sync with the order.
- Never tax the protect fee. It sits OUTSIDE `taxableSubtotal` in every modal body.

**The AI assistant uses TOOLS for side effects, ACTIONS for UI hints.**
Tools live in `server/src/modules/chat/agent/tools/*.tool.ts` and run inside the agent loop. Actions are returned in the final reply JSON and tell the frontend what to do next. The two namespaces overlap in name (`open_listing` is both a tool and an action.type) — that's intentional and documented in the prompt:
- `open_listing` is a **real tool** backed by `listingsService.getById`. It validates the id against the DB and returns `{success, listingId, listingType, listingName, navigateTo}`. `user-assistant.service.ts` then promotes a successful call into the response's `action` automatically — so the navigation fires even if the model forgets to set `action.type`.
- The agent loop's `toolCalls[]` array exposes the full tool `result` (added when wiring `open_listing`). Other post-loop hooks can read this if they need to act on tool outcomes.
- When the model invents a UUID, `get_listing_details` returns a model-actionable error pointing it back to `search_listings`. Keep this pattern for other lookup tools — bare "not found" is read as "the resource is gone" and the model gives up.
- **No eligibility/caste affirmation gate — LEG-012 removed the allow-list entirely.** `prepare_booking` has no affirmation argument, there is no `caste_affirmation_required` reason or `confirm_caste_affirmation` action, and no confirm card (the old web `CasteAffirmCard` / mobile equivalents are gone). The tool and model must NOT collect, verify, or enforce any eligibility criteria: a host may note who a sathram serves in their free-text `description`, and the assistant points users there and lets them decide — it never makes eligibility claims on anyone's behalf (see the eligibility guidance inside `user-assistant.service.ts`'s system prompt). `sathram` remains a listing TYPE; do not re-add any caste/community field, flag, or gate.

**Trip-protection / pricing helpers are mirrored across server + client.**
`server/src/modules/payments/pricing/fees.ts` and `src/lib/pricing.ts` must stay in sync. If you change one (rate, floor, ceiling, formula), change the other in the same PR — they're tested for equality in `src/lib/pricing.test.ts` and the assistant pricing-preview tools.

**Notifications: SES SDK is the default path; SMTP via nodemailer is wired but idle.**
`server/src/modules/notifications/services/email.service.ts` ships both. Setting `SMTP_HOST` (in env / staging secret) switches the runtime to nodemailer; unset = SES SDK. SES sends are wrapped in a one-shot retry on transient TCP errors (`ECONNRESET`, etc.) — keep that wrapper around any new SES call site.

**Recent searches are client-only UI state, mirrored across web + mobile.**
This is the "last 3 searches" recall chips under the Explore/marketplace search bar — NOT analytics (that's the separate `search_events` path). It's per-device, per-user, and kept in its OWN list per marketplace category, so searching one tab never evicts another's.
- Web: `src/lib/recent-searches.ts` (localStorage) + `src/hooks/use-recent-searches.ts`, consumed in `src/redesign/ClientRedesign.tsx`. Mobile: `mobile/src/design/api/recentSearches.ts` (AsyncStorage), consumed in `mobile/src/design/screens/ExploreScreen.tsx`. The two libs mirror each other — change both in the same PR (mobile and web share no code).
- Storage key is per-category: `istaseva:recent-searches:{stays|services|transport}:v1:<userId>`, capped at 3, dedup on the picked place (rounded lat/lng) or the normalized free-text query.
- Only **stays** searches carry place/dates/guests. Services and transport are keyword-only (no Google Places autocomplete); their recents carry the query text plus the single availability day as `dateRange.start` (end stays null) — shown on the chip and re-applied on tap. Do not re-add a passenger/guest count to transport/services recents — that was tried and removed.

## Local Setup

```bash
npm install
cd server && npm install
cd ../mobile && npm install

# from repo root: postgres, redis, dynamodb-local, image-moderation (NSFW gate), then DB migrations
npm run dev:setup
```

Run the apps:

```bash
# backend, from server/
npm run dev

# web, from repo root
npm run dev

# mobile, from mobile/
npm start
```

Default ports:

- Backend: `http://localhost:3001` with dev fallback to later ports if busy.
- Web: Vite default from `npm run dev`.
- Mobile: Expo/Metro.

## Web App

Stack:

- React 18, Vite 5, TypeScript.
- shadcn/ui, Radix UI, Tailwind CSS.
- TanStack Query for server state.
- React Hook Form + Zod for forms.
- i18next with locale files in `src/locales/`.

Important paths:

- `src/pages/` — route-level screens.
- `src/components/` — reusable UI.
- `src/domains/` — frontend domain services. Current domains: `analytics`, `audit`, `bookings`, `chat`, `coupons`, `fraud`, `guarantees`, `insurance`, `legal`, `listings`, `notifications`, `payments`, `pricing`, `providers`, `reviews`, `safety`, `users`, `verification`, `wishlist`.
- `src/redesign/` — redesigned marketplace + booking surfaces consumed by `src/pages/`.
- `src/lib/api-client.ts` — authenticated API client and localhost API port discovery.
- `src/config/frontend.ts` — validated `VITE_*` config.
- `src/config/providers.ts` — only auth, realtime, and analytics provider factories.
- `src/contexts/AuthContext.tsx` — application auth state.

Current frontend provider reality:

- Active client-side providers are Firebase auth, WebSocket realtime, and Mixpanel/mock analytics.
- Database, storage, payments, search, KYC, and AI should go through backend APIs/domain services.
- `src/providers/` contains only `auth/`, `realtime/`, and `analytics/` (exported via `src/providers/index.ts`). There are no `database/`, `llm/`, or `payment/` folders — do not add new client-side providers; route the capability through the backend instead.

## Backend

Stack:

- Express 4, Node 20, TypeScript strict mode.
- PostgreSQL via `pg`.
- Redis via `ioredis`.
- DynamoDB for append-only events/log-style data.
- Firebase Admin/JWT auth. Cognito support exists in provider wiring but Firebase is the current default.
- Razorpay payments, mock payments in dev.
- S3/local storage providers.
- Winston logging.
- Bull/SQS-style notification infrastructure, depending on env.

Entrypoints:

- `server/src/index.ts` — starts HTTP server, Redis, DB check, WebSocket provider, background jobs, graceful shutdown.
- `server/src/app/create-app.ts` — Express middleware/app wiring.
- `server/src/app/register-routes.ts` — route mounting.

Modules live in `server/src/modules/<name>/` and follow this pattern:

- `routes/` — Express route definitions (the file `register-routes.ts` imports from here, not from `server/src/routes/`).
- `controllers/` — parse request, shape response, call services.
- `services/` — business logic and state transitions.
- `repositories/` — SQL/data access.
- `schemas/` — Zod schemas.
- `adapters/` — third-party SDK wrappers.

Current modules: `admin`, `analytics`, `auth`, `bookings`, `chat`, `coupons`, `fraud`, `guarantees`, `infrastructure` (health/storage/geocode), `listings`, `notifications`, `payments`, `providers`, `reviews`, `search`, `speech` (tts), `translation`, `transport-quotes`, `users`, `verification`, `wishlists`.

Note: `server/src/routes/` (top-level) contains legacy route files that are **not** mounted by `register-routes.ts`. Add new routes under the appropriate module's `routes/` directory.

Keep SQL out of controllers/services. Keep business decisions out of repositories.

## Database And Migrations

- Add migrations to `server/migrations/` only.
- Run migrations with `cd server && npm run db:migrate`.
- Root `npm run dev:setup` starts local dependencies and applies pending migrations.
- Migrations are tracked in `public.schema_migrations`.
- `supabase/migrations/` does not exist and should not be recreated.
- If behavior depends on a DB invariant, add or update a migration. Do not rely only on UI or route-level validation.

## Current API Areas

Routes are mounted in `server/src/app/register-routes.ts`. Current areas include:

- `/health`
- `/api/bookings`
- `/api/payments`
- `/api/guarantees`
- `/api/providers`
- `/api/smart-schedule`
- `/api/onboarding-chat`
- `/api/assistant`
- `/api/tts`
- `/api/chat`
- `/api/supply-optimization`
- `/api/notifications`
- `/api/search`
- `/api/users`
- `/api/listings`
- `/api/reviews`
- `/api/verification`
- `/api/safety`
- `/api/fraud`
- `/api/storage`
- `/api/geocode`
- `/api/coupons`
- `/api/wishlist`
- `/api/translation`

## Mobile

The mobile app is an Expo app that talks to the same Express backend. It does not share TypeScript code with the web app.

Important paths:

- `mobile/src/navigation/` — React Navigation stacks/tabs.
- `mobile/src/screens/` — screen components by domain.
- `mobile/src/components/` — RN UI components.
- `mobile/src/lib/api.ts` and `mobile/src/lib/config.ts` — backend client/config.
- `mobile/src/contexts/AuthContext.tsx` — mobile auth state.

See `mobile/CLAUDE.md` before mobile changes.

## AWS Direction

AWS CDK lives in `infrastructure/`. The target platform uses ECS Fargate, RDS PostgreSQL, ElastiCache Redis, S3, CloudFront, Cognito-capable auth, OpenSearch, DynamoDB, SNS/SES/SQS-style messaging, and related managed services.

Production automation is not fully mature. Treat deployment and migration docs as operational references, then verify against current code and infra before acting.

## Tests And Checks

```bash
npm run lint
npm run test
npx playwright test

cd server && npm run build
cd mobile && npm run typecheck
```

Backend tests live near modules as `*.test.ts` where present. Add focused tests when changing booking, payment, auth, pricing, or migration-sensitive behavior.

## Docs Map

- `ARCHITECTURE.md` — concise current architecture.
- `docs/ARCHITECTURE.md` — longer architecture reference.
- `LOCAL_DEVELOPMENT.md` — setup details.
- `DEPLOYMENT.md` — deployment procedures.
- `PROVIDER_OVERVIEW.md` and `docs/PROVIDERS.md` — provider reference; verify against code before trusting older claims.
