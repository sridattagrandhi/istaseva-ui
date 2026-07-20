# Local Development

## What runs locally

This repo has two main apps:

- frontend: Vite React app in the repo root
- backend: Express API in `server/`

Supporting local services are expected through:

- PostgreSQL
- Redis
- optionally OpenSearch

There is also a `docker-compose.yml` in the repo root for local infra.

## Prerequisites

- Node.js 20+ recommended
- npm
- Docker Desktop or another Docker runtime if using `docker-compose.yml`

## Install dependencies

Frontend:

```bash
npm install
```

Backend:

```bash
cd server
npm install
```

## Environment setup

Copy the template:

```bash
cp .env.example .env
```

The backend config reads from process env via:

- `server/src/common/config/index.ts`

The frontend config reads validated `VITE_` vars via:

- `src/config/frontend.ts`

For a minimal local dev setup, pay attention to:

- `DATABASE_URL`
- `REDIS_URL`
- `JWT_SECRET`
- `NODE_ENV`
- `FRONTEND_URL`
- `API_URL`
- `VITE_API_URL`

If you want to test Cognito locally against a real pool, also set:

- `AUTH_PROVIDER=cognito`
- `COGNITO_USER_POOL_ID`
- `COGNITO_CLIENT_ID`
- `VITE_AUTH_PROVIDER=cognito`
- `VITE_COGNITO_POOL_ID`
- `VITE_COGNITO_CLIENT_ID`

## Start local infrastructure

One-shot: brings up postgres / redis / dynamodb-local AND applies any pending migrations. Idempotent — re-run after a `git pull` to pick up new schema changes.

```bash
npm run dev:setup
```

This runs `docker compose up -d postgres redis dynamodb-local` followed by `cd server && npm run db:migrate`. The migration runner (`server/scripts/migrate.js`) is the SAME runner staging and prod use, so local schema can't drift from remote.

Postgres no longer mounts `server/migrations/` as a `docker-entrypoint-initdb.d` — that approach only fires on the first boot of an empty volume, so any migration added later would silently be skipped on re-runs. Going through `db:migrate` keeps `public.schema_migrations` honest.

If you only want to bring up infra without migrating:

```bash
docker compose up -d
```

Check the exact services defined in `docker-compose.yml`.

## Run the backend

From `server/`:

```bash
npm run dev
```

If you ever need to re-run migrations against an already-running local DB (without restarting docker):

```bash
cd server && npm run db:migrate
```

Build check:

```bash
npm run build
```

The backend listens on the configured `PORT`, default `3001`.

## Run the frontend

From the repo root:

```bash
npm run dev
```

Build check:

```bash
npm run build
```

Tests:

```bash
npm test
```

## Useful architecture-aware local notes

### Booking and payment flows

The hardened booking/payment path now expects the backend API to be available.

Relevant backend modules:

- `server/src/modules/bookings/`
- `server/src/modules/payments/`

Relevant frontend files:

- `src/components/ServiceBookingModal.tsx`
- `src/hooks/useBookingFlow.ts`
- `src/domains/bookings/booking.service.ts`
- `src/domains/payments/payment.service.ts`

If the backend is down, those flows will fail even if the frontend loads.

### Chat and notifications

The UI routes exist, but parts of these flows are still not fully production-backed.

Relevant areas:

- `src/pages/Messages.tsx`
- `src/components/NotificationsDropdown.tsx`
- `server/src/modules/chat/`
- `server/src/modules/notifications/`

### Search

If OpenSearch is not configured, the backend can still use PostgreSQL-backed search depending on provider config.

### LLM/onboarding

If `LLM_PROVIDER=mock`, onboarding chat will return fallback responses instead of calling a real model.

## Current local dev modes

### Mode 1: frontend-only exploration

Useful when working on visual/UI changes.

You can run:

- frontend only

But backend-connected flows will be incomplete.

### Mode 2: frontend + backend

Useful for most product work.

Run:

- local DB
- local Redis
- backend
- frontend

This is the recommended default mode.

### Mode 3: AWS-integrated local dev

Useful when validating provider swaps.

Typical pattern:

- local frontend
- local backend
- real AWS services for Cognito/S3/OpenSearch/SES/SNS where needed

## Common issues

### Backend fails to start

Most common causes:

- invalid env config
- missing Postgres
- missing Redis
- port `3001` already in use, often because `docker compose` is already running the `api` service

Because the backend config is validated at import time, configuration errors should fail early and clearly.

If `3001` is occupied, either:

- stop the Docker `api` container if you want to run the backend directly from `server/`
- or set `PORT` in `server/.env` to another value such as `3002` and update any clients that call the API

### Frontend builds but runtime actions fail

Most common causes:

- `VITE_API_URL` points to the wrong backend
- backend is down
- auth provider mismatch between frontend and backend

### CSS warning during frontend build

There is a current warning from `src/index.css` about `@import` ordering. It does not block the build, but it should be cleaned up later.

## Files worth knowing

- `.env.example`
- `docker-compose.yml`
- `server/src/common/config/index.ts`
- `src/config/frontend.ts`
- `src/config/environment.ts`
- `server/src/app/register-routes.ts`
- `src/config/providers.ts`
