# IstaSeva Architecture

This document is the longer architecture reference for agents and contributors. The root `ARCHITECTURE.md` is the short version.

## Overview

IstaSeva is an India-first marketplace for stays, local services, and transport. The current architecture is a modular monolith designed to stay simple while preserving clear boundaries for future extraction.

```text
Web SPA (src/)          Mobile app (mobile/)
        \                    /
         \ HTTPS + Bearer tokens
          v
Express API monolith (server/src/)
          |
          +-- PostgreSQL: transactional source of truth
          +-- Redis: cache, locks, rate limits
          +-- DynamoDB/event providers: append-only logs/events
          +-- S3/local storage: files
          +-- WebSocket provider: realtime messaging/voice when enabled
          +-- External adapters: Firebase, Razorpay, Gemini/OpenAI, etc.
```

The target deployment path is AWS-backed: ECS Fargate, RDS PostgreSQL, ElastiCache Redis, S3, CloudFront, DynamoDB, OpenSearch where needed, SNS/SES/SQS-style messaging, and Cognito-capable auth. The app is not architected around Supabase anymore.

## Repository Map

```text
src/                    # React 18 + Vite web app
server/                 # Express 4 + Node 20 API server
  src/
    app/                # create-app/register-routes
    common/             # config, db, cache, auth, providers, logging
    modules/            # domain modules
  migrations/           # PostgreSQL migrations, source of truth
  scripts/migrate.js    # migration runner
mobile/                 # Expo 51 + React Native 0.74 app
infrastructure/         # AWS CDK
docs/                   # architecture and migration docs
scripts/                # local/ops helper scripts
loadtest/               # k6 load testing
```

`server/migrations/` is the only migration path. Do not add a `supabase/migrations/`.

## Backend Architecture

Entrypoints:

- `server/src/index.ts` starts the HTTP server, connects Redis, checks PostgreSQL, attaches WebSockets, starts background work, and handles graceful shutdown.
- `server/src/app/create-app.ts` builds the Express app and common middleware.
- `server/src/app/register-routes.ts` mounts all API routers.

Shared infrastructure:

| Path | Responsibility |
|---|---|
| `server/src/common/config/` | Typed config/env loading and schemas. |
| `server/src/common/db/` | PostgreSQL pool, query helpers, transactions. |
| `server/src/common/cache/` | Redis client and cache/lock helpers. |
| `server/src/common/auth/` | Auth middleware and token verification helpers. |
| `server/src/common/errors/` | App error classes. |
| `server/src/common/http/` | HTTP middleware and global error handling. |
| `server/src/common/logging/` | Winston logging. |
| `server/src/common/providers/` | Provider interfaces, implementations, registry, event models. |
| `server/src/common/aws/` | AWS SDK client setup. |

Module shape:

```text
server/src/modules/<module>/
  routes/
  controllers/
  services/
  repositories/
  schemas/
  adapters/
```

Some modules have extra folders for complex behavior, such as chat agents or payment pricing helpers. Preserve local patterns when extending them.

## Backend Modules

Core transactional modules:

| Module | Responsibility |
|---|---|
| `bookings` | Holds, booking lifecycle, cleanup, invoice/receipt behavior. |
| `payments` | Payment orders, verification, status, refunds, fee/discount calculations. |
| `guarantees` | Service guarantee lifecycle and claims. |
| `providers` | Provider profile, scheduling, smart schedule routes. |
| `listings` | Stay/service listings, room types, availability-related listing data. |
| `users` | User profile and current-user APIs. |
| `reviews` | Ratings/reviews. |
| `coupons` | Coupon validation and discounts. |
| `wishlists` | Saved listings/services. |
| `transport-quotes` | Transport quote workflows. |

Supporting or more separable modules:

| Module | Responsibility |
|---|---|
| `notifications` | Notification records, email/SNS/SQS-style worker paths. |
| `chat` | Messages, assistant, onboarding chat, voice-session integration. |
| `search` | Backend search APIs and provider-backed search. |
| `verification` | Provider/user verification flows. |
| `fraud` | Safety/fraud routes and risk event handling. |
| `analytics` | Supply optimization and analytics-style endpoints. |
| `admin` | Admin operations. |
| `speech` | TTS/voice-related endpoints. |
| `translation` | Translation/cache endpoints. |
| `infrastructure` | Health, storage, geocoding, infrastructure-ish routes. |

## Route Map

The source of truth is `server/src/app/register-routes.ts`.

```text
/health
/api/bookings
/api/payments
/api/guarantees
/api/smart-schedule
/api/providers
/api/onboarding-chat
/api/assistant
/api/tts
/api/chat
/api/supply-optimization
/api/notifications
/api/search
/api/users
/api/listings
/api/reviews
/api/verification
/api/safety
/api/fraud
/api/storage
/api/geocode
/api/coupons
/api/wishlist
/api/translation
/api/transport-quotes
```

Check each module route file for exact HTTP methods, request schemas, and auth requirements.

## Frontend Architecture

Web layers:

| Path | Responsibility |
|---|---|
| `src/pages/` | Route-level screens. |
| `src/components/` | Reusable UI and feature components. |
| `src/hooks/` | UI/data hooks. |
| `src/domains/` | Frontend domain services and API-facing business helpers. |
| `src/lib/api-client.ts` | Authenticated API calls and local API port discovery. |
| `src/config/frontend.ts` | Validated `VITE_*` config. |
| `src/config/environment.ts` | App-facing environment object. |
| `src/config/providers.ts` | Client-side provider registry for auth, realtime, analytics. |
| `src/contexts/AuthContext.tsx` | Auth state used by the app. |
| `src/locales/` | i18n files. |

Important boundary:

- UI should not call backend endpoints with raw `fetch`.
- Prefer `src/domains/*` service classes and `apiRequest()` from `src/lib/api-client.ts`.
- Do not add new frontend SDK providers for database, storage, payments, search, KYC, or LLM. Those now route through backend APIs.

Current active frontend providers:

- `FirebaseAuthProvider`
- `WebSocketRealtimeProvider`
- `MixpanelAnalyticsProvider`
- `MockAnalyticsProvider`

## Mobile Architecture

Mobile app layers:

| Path | Responsibility |
|---|---|
| `mobile/src/navigation/` | Root navigator, auth stack, tabs, nested stacks, route types. |
| `mobile/src/screens/` | Screen components grouped by domain. |
| `mobile/src/components/` | RN UI components. |
| `mobile/src/contexts/AuthContext.tsx` | Mobile auth state. |
| `mobile/src/lib/api.ts` | Mobile API client. |
| `mobile/src/lib/config.ts` | Mobile config. |
| `mobile/src/lib/firebase.ts` | Firebase setup. |
| `mobile/src/theme/` | Colors, spacing, typography. |
| `mobile/src/data/` | Mock/static data. |

Mobile uses the same Express backend and Firebase bearer-token auth model as web. It does not share TypeScript types with web or server, so contract changes require manual updates.

## Provider Architecture

Backend provider interfaces live in `server/src/common/providers/interfaces/`; lookup lives in `server/src/common/providers/registry.ts`.

Backend provider implementation families include:

- auth: default/firebase.
- cache: Redis/mock.
- database: PostgreSQL.
- events: DynamoDB/mock.
- storage: S3/local.
- realtime: WebSocket/noop.
- search: PostgreSQL.
- KYC: mock.
- LLM: mock/default/Gemini.
- payment: mock plus module-owned Razorpay adapter.

Frontend provider selection is intentionally smaller and lives in `src/config/providers.ts`. Active frontend polymorphism is limited to:

- auth
- realtime
- analytics

This is the main correction from the older Lovable/Supabase-era design.

## Data Placement

PostgreSQL is the source of truth for:

- users and profiles
- providers and onboarding state
- listings, room types, availability overrides
- bookings and booking state transitions
- payments, fee snapshots, discounts, refunds
- guarantees and claims
- reviews
- coupons
- wishlists
- transport quotes
- verification status
- legal consent and transactional audit records

Redis is for:

- cache
- slot locks
- rate-limit state
- short-lived coordination

DynamoDB/event providers are for:

- audit events
- fraud signals
- API request logs
- search events
- communication/recommendation-style append-only records

S3/local storage providers are for uploaded/generated files. OpenSearch should be used only through backend search provider paths when configured.

## Booking And Payment Consistency

Booking and payment flows are the highest-risk transactional area.

General shape:

```text
Client
  -> booking hold/create API
  -> backend validates listing/provider/availability/pricing
  -> Redis short-lived slot coordination where applicable
  -> PostgreSQL transaction persists booking/hold/snapshots
  -> payment order/verification APIs
  -> PostgreSQL transaction updates payment and booking state
  -> guarantee/invoice/notification side effects as applicable
```

Rules of thumb:

- Never trust client-calculated prices for final settlement.
- Persist fee/discount/tax snapshots needed for invoices and receipts.
- Make payment and booking status changes idempotent where webhooks/retries can repeat.
- Keep DB constraints/triggers aligned with service-layer state machines.
- Update web and mobile callers when API shape changes.

## Migrations

Migrations live in `server/migrations/` and run in filename order.

```bash
# root: starts local services and migrates
npm run dev:setup

# server only
cd server && npm run db:migrate
```

The runner is `server/scripts/migrate.js`. It supports:

- `DATABASE_URL`
- `DB_HOST`/`DB_USER`/`DB_PASSWORD`/`DB_PORT`/`DB_NAME`
- local default `postgres://instaserve:instaserve_dev@localhost:5432/instaserve`

Applied migrations are tracked in `public.schema_migrations`.

## AWS Infrastructure

CDK lives in `infrastructure/`. The target AWS shape includes:

- VPC
- ECS Fargate for API
- RDS PostgreSQL
- ElastiCache Redis
- S3
- CloudFront for frontend assets
- Cognito-capable auth
- DynamoDB
- OpenSearch where needed
- SNS/SES/SQS-style messaging

Verify `infrastructure/` before deployment decisions; operational docs can lag code.

## Legacy Carryover

Still present:

- `.lovable/`
- `lovable-tagger` dev dependency
- The migration docs (`MIGRATION_TO_AWS.md`, `docs/MIGRATION.md`), which describe the Supabase/Lovable era as history
- Comments in a few migrations explaining which columns the Supabase-era schema failed to carry over
- Some legacy backend folders outside the current module/common pattern

Not present/current:

- `supabase/` — the directory is gone; the three edge functions it held (`smart-schedule`, `onboarding-chat`, `supply-optimization`) are superseded by the Express modules mounted at `/api/smart-schedule`, `/api/onboarding-chat`, and `/api/supply-optimization`
- Supabase as the schema source of truth
- Frontend Supabase auth/realtime/database/storage providers
- A frontend "single swap point for all backends"

## Known Gaps

- Mobile/web/server types are not generated from a shared API schema.
- Some routes and modules are more mature than others.
- Deployment/migration automation should be verified before production use.
- Notification, chat, assistant, and analytics flows contain MVP-era behavior.
- Provider overview docs should be checked against `src/config/providers.ts` and `server/src/common/providers/registry.ts` before making changes.

## Contributor Rules

- New backend business behavior: `server/src/modules/<module>/services`.
- New backend SQL: `server/src/modules/<module>/repositories`.
- New backend schemas: `server/src/modules/<module>/schemas`.
- New external SDK logic: backend provider implementation or module adapter.
- New frontend API behavior: `src/domains/*` plus `src/lib/api-client.ts`.
- New mobile API behavior: `mobile/src/lib/*` or small mobile-specific helpers.
- Persistent schema/invariant change: add a migration in `server/migrations/`.
- Architecture-sensitive change: update `CLAUDE.md`, root `ARCHITECTURE.md`, and this file in the same PR.
