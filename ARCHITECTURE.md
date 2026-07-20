# Architecture

This is the concise current architecture. See `docs/ARCHITECTURE.md` for the longer reference.

## System Shape

IstaSeva is a modular monolith:

- `src/` — React/Vite web client.
- `server/src/` — Express API monolith.
- `mobile/` — Expo React Native client.
- `infrastructure/` — AWS CDK.
- `server/migrations/` — PostgreSQL migration history and schema source of truth.

The architectural direction is AWS-backed infrastructure with core marketplace consistency inside the Express/PostgreSQL monolith.

## Core Principles

- Keep booking, payment, provider, listing, guarantee, coupon, wishlist, and user state strongly consistent in PostgreSQL.
- Keep SDK-specific code behind backend providers or module adapters.
- Keep frontend product data access behind domain services and `src/lib/api-client.ts`.
- Keep client-side provider polymorphism small: auth, realtime, analytics only.
- Use DynamoDB/event providers for append-only logs/events, not transactional state.
- Do not add new Supabase architecture.

## Backend

Entrypoints:

- `server/src/index.ts`
- `server/src/app/create-app.ts`
- `server/src/app/register-routes.ts`

Shared backend infrastructure:

- `server/src/common/config/`
- `server/src/common/db/`
- `server/src/common/cache/`
- `server/src/common/auth/`
- `server/src/common/errors/`
- `server/src/common/http/`
- `server/src/common/logging/`
- `server/src/common/providers/`
- `server/src/common/aws/`

Business modules live under `server/src/modules/<name>/` and usually contain:

- `routes/`
- `controllers/`
- `services/`
- `repositories/`
- `schemas/`
- `adapters/`

Current module families include auth, users, providers, listings, bookings, payments, guarantees, reviews, coupons, wishlists, transport quotes, notifications, chat, search, verification, fraud, analytics, admin, speech, translation, and infrastructure.

## Frontend

Frontend layers:

- `src/pages/` — route screens.
- `src/components/` — reusable UI.
- `src/hooks/` — UI/data hooks.
- `src/domains/` — frontend domain services.
- `src/lib/api-client.ts` — authenticated backend API client.
- `src/config/frontend.ts` — validated runtime env config.
- `src/config/providers.ts` — auth/realtime/analytics provider factories.
- `src/contexts/AuthContext.tsx` — auth state and app-facing auth behavior.

Active frontend providers:

- Firebase auth.
- WebSocket realtime.
- Mixpanel or mock analytics.

Everything else should call the backend. Do not resurrect frontend database/storage/payment/search/KYC/LLM providers.

## Mobile

The Expo app mirrors product flows for mobile but has separate source and types:

- `mobile/src/navigation/`
- `mobile/src/screens/`
- `mobile/src/components/`
- `mobile/src/contexts/`
- `mobile/src/lib/`
- `mobile/src/theme/`

Mobile uses the same Express API and Firebase auth token model. Keep API contracts in sync manually.

## Route Areas

Mounted API areas:

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
- `/api/transport-quotes`

`server/src/app/register-routes.ts` is the source of truth.

## Data Placement

Use PostgreSQL for:

- users/profiles
- providers
- listings and room types
- availability and holds
- bookings
- payments, fee snapshots, refunds
- guarantees/claims
- reviews
- coupons/wishlists
- transport quotes
- verification status
- legal consent and transactional audit data

Use Redis for:

- cache
- slot locks
- rate-limit state
- short-lived coordination

Use DynamoDB/event providers for:

- audit events
- fraud signals
- API request logs
- search/event streams
- recommendation/communication-style append-only records

Use S3/local storage providers for files. Use OpenSearch only behind backend search providers when configured.

## Migrations

Migrations live in `server/migrations/` and are applied by `server/scripts/migrate.js`.

```bash
npm run dev:setup
cd server && npm run db:migrate
```

Applied migrations are recorded in `public.schema_migrations`.

## Known Gaps

- The migration docs (`MIGRATION_TO_AWS.md`, `docs/MIGRATION.md`) describe the Lovable/Supabase era on purpose — they are historical records, not current-state guides.
- Legacy directories under `server/src/config`, `server/src/middleware`, `server/src/routes`, and `server/src/utils` still exist. Prefer `common/` and `modules/` for new code.
- Mobile and web types are duplicated manually.
- Deployment/migration automation should be verified before production operations.
- Some UI flows are still demo/MVP-level even when backend modules exist.

## Contributor Rule Of Thumb

When adding or changing behavior:

- put backend business rules in `server/src/modules/*/services`
- put backend data access in `server/src/modules/*/repositories`
- put shared infrastructure in `server/src/common/*`
- put frontend API-facing behavior in `src/domains/*` or focused hooks
- put mobile API behavior in `mobile/src/lib/*` or a small mobile-specific helper
- add migrations for persistent schema or invariant changes
