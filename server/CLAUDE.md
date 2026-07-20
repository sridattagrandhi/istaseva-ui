# Server — Backend Guide

Express 4 + Node 20 + TypeScript strict mode. This API owns business logic for the web and mobile clients.

## Entrypoints

```text
server/src/index.ts              # HTTP server, Redis/DB startup checks, WebSocket attach, jobs, graceful shutdown
server/src/app/create-app.ts     # Express middleware, CORS, Helmet, compression, JSON, route registration
server/src/app/register-routes.ts # Mounts all API routers
```

Do not use the older `server/src/routes/*` shape as the model for new work. Current code is module-first under `server/src/modules/*`.

## Module Structure

Most modules follow this layout:

```text
server/src/modules/<name>/
  routes/        # Express routes and middleware chain
  controllers/   # Request parsing and response shaping
  services/      # Business logic, policies, state transitions
  repositories/  # SQL/data access
  schemas/       # Zod request/response schemas
  adapters/      # Third-party SDK wrappers
```

Rules:

- Controllers call services.
- Services own decisions and transactions.
- Repositories own SQL.
- Adapters wrap external SDKs.
- Never string-interpolate user input into SQL.

## Shared Infrastructure

| Path | Purpose |
|---|---|
| `server/src/common/config/` | Typed env/config loading. Add new env vars here first. |
| `server/src/common/db/postgres.ts` | `query<T>()`, transactions, PostgreSQL pool. |
| `server/src/common/cache/redis.ts` | Redis connection for cache, locks, and rate-limit state. |
| `server/src/common/auth/` | Auth middleware and token verification helpers. |
| `server/src/common/errors/` | App error types. Throw typed app errors where possible. |
| `server/src/common/http/` | HTTP middleware/error handling. |
| `server/src/common/logging/logger.ts` | Winston logger. Use this instead of `console.log`. |
| `server/src/common/providers/` | Backend provider interfaces, implementations, registry. |
| `server/src/common/aws/clients.ts` | AWS SDK client construction. |

There are also legacy/common compatibility paths under `server/src/config`, `server/src/middleware`, `server/src/routes`, and `server/src/utils`. Prefer `common/` and `modules/` for new code unless you are intentionally maintaining an existing legacy path.

## Core Modules

Strongly consistent transactional modules:

- `bookings`
- `payments`
- `guarantees`
- `providers`
- `listings`
- `users`
- `reviews`
- `coupons`
- `wishlists`
- `transport-quotes`

More separable/supporting modules:

- `notifications`
- `chat`
- `search`
- `verification`
- `fraud`
- `analytics`
- `admin`
- `speech`
- `translation`
- `infrastructure`

Booking/payment/pricing changes are high-risk. Check migrations, service tests, invoice/receipt behavior, payment status handling, and frontend/mobile callers.

## Auth

Clients send `Authorization: Bearer <token>`.

Current default auth is Firebase Admin token verification. Provider wiring also supports other auth implementations. Route middleware attaches the authenticated user to the request; use existing middleware rather than parsing tokens inside controllers.

Common roles include `guest`, `host`, `provider`, and `admin`, but verify role checks in the route/service you are touching.

## Database

- PostgreSQL is the source of truth for transactional state.
- Migrations live in `server/migrations/`.
- Run migrations with `npm run db:migrate` from `server/`.
- The migration runner is `server/scripts/migrate.js`.
- Applied files are tracked in `public.schema_migrations`.
- Local default DB URL matches `docker-compose.yml` if no `DATABASE_URL` is set.

Use transactions for multi-table writes and anything that must be atomic:

```ts
const result = await transaction(async (client) => {
  await client.query("UPDATE bookings SET status = $1 WHERE id = $2", [status, bookingId]);
  await client.query("INSERT INTO payments (...) VALUES (...)", values);
  return value;
});
```

DB-level invariants matter. If a state transition, uniqueness rule, fee snapshot, or payment condition must always hold, encode it in a migration as well as service logic.

## Providers

Interfaces live in `server/src/common/providers/interfaces/`. The registry lives in `server/src/common/providers/registry.ts`.

Current implementation families include:

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

Keep SDK-specific code in provider implementations or module adapters.

## Route Map

Mounted in `server/src/app/register-routes.ts`:

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
```

Check each module's route file for exact methods and auth requirements.

## Background Work And Realtime

`server/src/index.ts` currently:

- Connects Redis and checks PostgreSQL at startup.
- Attaches the WebSocket realtime provider.
- Enables `/ws/voice` when Vertex/Gemini Live config exists.
- Runs expired booking-hold cleanup every minute.
- Recalculates supply metrics every 15 minutes.
- Starts the notification worker when queue config exists.
- Handles SIGTERM/SIGINT graceful shutdown.

Be careful when adding timers or workers; they must stop cleanly on shutdown.

These timers fire in **every** ECS task (prod autoscales 2→10). To avoid each
task re-running the same rollup/supply job per interval (ARC-003 / ENG-006),
every scheduled run is wrapped in `leased(name, intervalMs, fn)`, which gates it
behind a fleet-wide Redis lease (`tryAcquireSchedulerLease` in
`common/cache/redis.ts`): the first task to grab the key runs the job, the key
is deliberately never released so it expires just before the next tick and the
next run re-elects a leader. The lease **fails open** (runs if Redis is down)
and the jobs stay idempotent, so a Redis outage degrades to the old harmless
N-way duplication rather than stopping the job. Wrap any new scheduled timer the
same way.

## Running And Checking

```bash
npm run dev       # tsx watch src/index.ts
npm run build     # TypeScript compile to dist/
npm start         # node dist/index.js
npm run db:migrate
```

There is no single backend test script in `server/package.json` right now. Run targeted tests according to the tooling present in the touched area, and at minimum run `npm run build` after backend TypeScript changes.
