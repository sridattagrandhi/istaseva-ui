# Provider Overview

## Why providers exist in this repo

Providers are the swap points between business logic and external systems.

The goal is:

- business logic should not depend directly on provider SDKs
- switching a vendor should be mostly a provider/config change, not a rewrite of product code

This repo currently uses provider abstractions in two places:

- backend provider system in `server/src/common/providers/`
- smaller frontend provider system in `src/config/providers.ts`

## Backend provider system

### Interfaces

Backend provider interfaces live in:

- `server/src/common/providers/interfaces/auth-provider.interface.ts`
- `server/src/common/providers/interfaces/database-provider.interface.ts`
- `server/src/common/providers/interfaces/cache-provider.interface.ts`
- `server/src/common/providers/interfaces/storage-provider.interface.ts`
- `server/src/common/providers/interfaces/payment-provider.interface.ts`
- `server/src/common/providers/interfaces/notification-provider.interface.ts`
- `server/src/common/providers/interfaces/realtime-provider.interface.ts`
- `server/src/common/providers/interfaces/search-provider.interface.ts`
- `server/src/common/providers/interfaces/kyc-provider.interface.ts`
- `server/src/common/providers/interfaces/llm-provider.interface.ts`
- `server/src/common/providers/interfaces/event-provider.interface.ts`

### Registry

Lazy provider selection happens in:

- `server/src/common/providers/registry.ts`

Config for provider selection comes from:

- `server/src/common/config/index.ts`

### Current implementations

Auth:

- current implementation: `server/src/common/providers/implementations/auth/default-auth.provider.ts`
- current options: JWT fallback, Cognito-capable verification path
- later replacement path: dedicated Cognito implementation if auth complexity grows

Database:

- current implementation: `server/src/common/providers/implementations/database/postgres-database.provider.ts`
- current reality: repositories mostly use `pg` directly through `server/src/common/db/postgres.ts`
- later replacement path: keep Postgres, or introduce Prisma/Drizzle behind repositories, not in business services

Cache:

- current implementation: `server/src/common/providers/implementations/cache/redis-cache.provider.ts`
- current target: Redis / ElastiCache
- later replacement path: managed Redis or alternate cache provider if needed

Storage:

- current implementation: `server/src/common/providers/implementations/storage/s3-storage.provider.ts`
- current target: S3
- later replacement path: alternate object storage if ever needed

Event / NoSQL:

- current implementation: `server/src/common/providers/implementations/events/dynamodb-event.provider.ts`
- local fallback: `server/src/common/providers/implementations/events/mock-event.provider.ts`
- current target: DynamoDB tables for append-only audit, fraud, request-log, and search events
- later replacement path: alternate event store if needed, without moving transactional domains out of PostgreSQL

Payment:

- current implementation: module adapter `server/src/modules/payments/adapters/razorpay.adapter.ts`
- current options: `mock`, `razorpay`
- later replacement path: add Stripe or another payment gateway adapter

Notification:

- current implementation: module adapter `server/src/modules/notifications/adapters/notification-channels.adapter.ts`
- current target: SES/SNS-style sending under one adapter
- later replacement path: split channels further or queue via SQS workers

Realtime:

- current implementation: `server/src/common/providers/implementations/realtime/noop-realtime.provider.ts`
- current reality: backend realtime is not fully implemented
- later replacement path: real WebSocket/AppSync/event publisher provider

Search:

- current implementations:
  - `server/src/common/providers/implementations/search/postgres-search.provider.ts`
  - `server/src/common/providers/implementations/search/opensearch-search.provider.ts`
- later replacement path: keep OpenSearch, or add Algolia/Typesense if desired

KYC:

- current implementation: `server/src/common/providers/implementations/kyc/mock-kyc.provider.ts`
- current reality: still mock-oriented
- later replacement path: DigiLocker provider implementation

LLM:

- current implementation: `server/src/common/providers/implementations/llm/default-llm.provider.ts`
- current options: `mock`, `openai`, `anthropic`, later `bedrock`
- later replacement path: Bedrock or more specialized providers behind the same interface

## Frontend provider system

The frontend intentionally has fewer active providers now.

Provider selection file:

- `src/config/providers.ts`

Active frontend provider categories:

- auth
- realtime
- analytics

These stay on the frontend because they affect browser runtime behavior directly.

### Frontend auth providers

- `src/providers/auth/firebase-auth.provider.ts` — the only implementation; `getAuthProvider()` constructs it unconditionally

Replace later:

- swapping to Cognito means adding a `cognito-auth.provider.ts` and a selection branch in `getAuthProvider()`; the backend already has Cognito wiring, but the frontend does not

### Frontend realtime providers

- `src/providers/realtime/websocket-realtime.provider.ts` — the only implementation

Replace later:

- `VITE_REALTIME_PROVIDER` already gates the selection, so an AppSync/Pusher implementation can be added alongside it without touching product logic

### Frontend analytics providers

- `src/providers/analytics/mock-analytics.provider.ts`
- `src/providers/analytics/mixpanel-analytics.provider.ts`

Replace later:

- Mixpanel can be swapped for Amplitude or Segment without touching product logic

## What is no longer an active frontend provider

The frontend used to have broader provider abstractions for database/storage/payment/search/KYC/LLM and similar categories.

Current intended pattern is different:

- those flows should go through backend APIs
- frontend uses domain services in `src/domains/`

Examples:

- bookings: `src/domains/bookings/booking.service.ts`
- payments: `src/domains/payments/payment.service.ts`
- verification: `src/domains/verification/verification.service.ts`
- reviews: `src/domains/reviews/review.service.ts`
- safety: `src/domains/safety/safety.service.ts`

This is important for AWS migration because it prevents browser code from being tightly bound to vendor SDKs.

## What is still Lovable-specific

Supabase is fully removed — there is no `supabase/` directory, no `@supabase/*` dependency, and no Supabase provider in `src/providers/`. These are the only Lovable-era leftovers:

- `.lovable/`
- `lovable-tagger` dev dependency

## Replacement guide by area

### Replace auth

Backend:

- set `AUTH_PROVIDER`
- use Cognito config in `server/src/common/config/`

Frontend:

- `getAuthProvider()` in `src/config/providers.ts` currently constructs `FirebaseAuthProvider` unconditionally — it does not read `VITE_AUTH_PROVIDER`. Swapping auth means adding the implementation and a selection branch there, and widening the `VITE_AUTH_PROVIDER` enum in `src/config/frontend.ts` (today: `firebase | custom`).

### Replace DB

Keep business logic in services and repositories.

Use:

- repositories under `server/src/modules/*/repositories`
- `server/src/common/db/postgres.ts`

Do not add direct SDK/database calls to frontend components.

### Replace NoSQL / event store

Use:

- `server/src/common/providers/interfaces/event-provider.interface.ts`
- `server/src/common/providers/registry.ts`
- backend middleware/services that write append-only event records after transactional work succeeds

Do not move bookings, payments, holds, or guarantees into DynamoDB.

### Replace storage

Use:

- backend storage routes
- `server/src/modules/infrastructure/services/storage.service.ts`
- `server/src/common/providers/implementations/storage/s3-storage.provider.ts`

### Replace payments

Use:

- `server/src/modules/payments/adapters/`
- `server/src/modules/payments/services/payments.service.ts`

Keep booking confirmation orchestration in the backend.

### Replace notifications

Use:

- `server/src/modules/notifications/adapters/`
- `server/src/modules/notifications/services/notifications.service.ts`

### Replace chat/realtime

Use:

- `server/src/modules/chat/`
- `src/providers/realtime/`

Be aware that product chat is still not fully production-backed.

### Replace search

Use:

- backend search provider registry and implementations
- `server/src/modules/search/`

### Replace KYC

Use:

- `server/src/common/providers/implementations/kyc/`
- `server/src/modules/verification/`

### Replace LLM integrations

Use:

- `server/src/common/providers/implementations/llm/`
- `server/src/modules/chat/services/onboarding-chat.service.ts`

Keep model/provider calls server-side.
