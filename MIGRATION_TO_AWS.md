# Migration to AWS

> **Historical document — this migration is complete.** It is kept as a record of how the move off Lovable/Supabase was planned and executed. Statements below written in the present tense describe the repo *before* the migration, not today. Supabase is fully removed: there is no `supabase/` directory, no `src/integrations/supabase/`, and no `@supabase/*` dependency. For current-state architecture see `ARCHITECTURE.md`; for the schema see `server/migrations/`.

## Purpose

This document describes how to move this repo from its Lovable/Supabase-origin setup to an AWS-owned stack without rewriting the app again.

It was based on the repo as it existed at the time of writing:

- backend modular monolith in `server/src/`
- AWS-leaning provider abstractions already present
- frontend still carrying some Supabase-compatible auth/realtime options
- schema history still mostly under `supabase/migrations/`

## Current migration status

Already in place:

- modular monolith backend structure
- backend provider interfaces and lazy provider registry
- centralized backend config in `server/src/common/config/`
- API-first frontend domain services for booking, verification, safety, reviews, and similar flows
- S3-oriented backend storage path
- Cognito-capable backend auth verification path
- Postgres-backed search provider (`SEARCH_PROVIDER=postgres`)
- Razorpay-capable payment path

Still Lovable/Supabase-specific:

- `supabase/migrations/` remains the main schema source
- `supabase/functions/` still contains historical backend logic
- frontend can still run against Supabase auth/realtime providers
- `src/integrations/supabase/` still exists

## Replace auth

### Current state

Frontend auth providers:

- `src/providers/auth/supabase-auth.provider.ts`
- `src/providers/auth/cognito-auth.provider.ts`

Backend auth verification:

- `server/src/common/providers/implementations/auth/default-auth.provider.ts`
- `server/src/common/auth/require-auth.ts`

Config:

- backend: `AUTH_PROVIDER`, `COGNITO_*`, `JWT_SECRET`
- frontend: `VITE_AUTH_PROVIDER`, `VITE_COGNITO_*`

### AWS target

Use Cognito as the primary auth system.

What to do:

1. Set backend `AUTH_PROVIDER=cognito`.
2. Configure Cognito env vars in backend and frontend.
3. Make `src/config/providers.ts` resolve auth to Cognito in the target environment.
4. Remove any remaining user/session assumptions tied to Supabase token names once Cognito is the only active frontend auth provider.
5. Plan a cleanup pass for `src/contexts/AuthContext.tsx` if it still contains demo or non-provider-auth behavior.

What can stay:

- local JWT fallback on the backend is still useful for dev, but should not be the prod path.

## Replace DB

### Current state

Backend DB access is PostgreSQL-first:

- `server/src/common/db/postgres.ts`
- repositories under `server/src/modules/*/repositories`

Frontend business calls mostly use backend APIs now.

Schema history still lives in:

- `supabase/migrations/`

### AWS target

Use PostgreSQL on RDS or Aurora PostgreSQL.

What to do:

1. Move the live schema source of truth from “Supabase migration directory by convention” to “Postgres migration workflow owned by this repo”.
2. Keep repository access patterns in the modular monolith.
3. Point `DATABASE_URL` to RDS/Aurora.
4. Audit any Supabase-specific SQL features/functions left in migrations and replace or retain them explicitly.
5. Validate extensions you rely on, especially if `pg_cron` or similar is used.

What still needs replacement later:

- the migration story is not AWS-native yet even though runtime DB access is already Postgres-native.

## Replace storage

### Current state

Backend storage is already S3-oriented:

- `server/src/common/providers/implementations/storage/s3-storage.provider.ts`
- `server/src/modules/infrastructure/services/storage.service.ts`
- `server/src/modules/infrastructure/routes/storage.routes.ts`

Frontend document/file flows should call the backend storage endpoints rather than direct provider SDKs.

### AWS target

Use S3 buckets for:

- uploads
- verification documents
- frontend assets if desired

What to do:

1. Set `STORAGE_PROVIDER=s3`.
2. Configure `S3_BUCKET_UPLOADS`, `S3_BUCKET_VERIFICATION`, `S3_BUCKET_FRONTEND`.
3. Provide AWS credentials or IAM role access.
4. Ensure frontend flows that still assume direct Supabase storage are fully removed.

## Replace payments

### Current state

Payment orchestration is backend-owned in:

- `server/src/modules/payments/services/payments.service.ts`
- `server/src/modules/payments/repositories/payments.repository.ts`
- `server/src/modules/payments/adapters/razorpay.adapter.ts`

Frontend payment actions now go through:

- `src/domains/payments/payment.service.ts`

### AWS target

AWS does not provide the payment gateway itself, so this is “AWS-hosted app + external payment provider”.

Current realistic path:

- keep Razorpay if India-first
- optionally add Stripe later behind the same payment provider interface

What to do:

1. Set `PAYMENT_PROVIDER=razorpay` when ready.
2. Configure `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.
3. Terminate HTTPS properly and expose webhook handling safely.
4. Keep payment verification idempotency and booking confirmation orchestration in the backend monolith.

What not to do:

- do not move booking confirmation back into the frontend.

## Replace notifications

### Current state

Notification sending is abstracted through:

- `server/src/modules/notifications/services/notifications.service.ts`
- `server/src/modules/notifications/adapters/notification-channels.adapter.ts`
- `server/src/common/providers/interfaces/notification-provider.interface.ts`

### AWS target

Use:

- SES for email
- SNS for SMS
- optionally SQS for async fanout/worker buffering

What to do:

1. Keep `NOTIFICATION_PROVIDER=default` if that adapter is your AWS-backed default.
2. Configure `SES_FROM_EMAIL`, `SNS_SMS_SENDER_ID`, `SQS_NOTIFICATION_QUEUE_URL`.
3. Replace any demo-only UI assumptions with real notification retrieval/dispatch semantics as needed.

## Replace chat and realtime

### Current state

Backend:

- `server/src/modules/chat/`
- backend realtime provider is currently a noop placeholder

Frontend:

- realtime providers in `src/providers/realtime/`
- provider selection in `src/config/providers.ts`
- `src/pages/Messages.tsx` is still largely demo-oriented

### AWS target

Use one of:

- API Gateway WebSocket
- AppSync
- ECS/WebSocket service behind ALB
- event-driven fallback plus polling for less realtime-critical features

What to do:

1. Set `VITE_REALTIME_PROVIDER=websocket` when your WS service exists.
2. Implement a real backend realtime provider if the backend needs to publish realtime events itself.
3. Replace the demo messaging page with a backend-backed messaging flow in `server/src/modules/chat/`.

What still needs replacement later:

- the messaging product flow is not fully production-backed yet.

## Replace search

### Current state

Backend search abstraction:

- `server/src/common/providers/interfaces/search-provider.interface.ts`
- `server/src/common/providers/implementations/search/postgres-search.provider.ts`
- `server/src/modules/search/`

### AWS target

Postgres full-text search on RDS (default). OpenSearch was removed in favour of paying only for RDS, which is already in the stack.

What to do:

1. Keep `SEARCH_PROVIDER=postgres` (the default).
2. When query volume or relevance quality warrants it, add a `tsvector` GIN index + `pg_trgm` extension in a migration, or add a Meilisearch/Typesense sidecar.

## Replace KYC

### Current state

KYC abstraction:

- `server/src/common/providers/interfaces/kyc-provider.interface.ts`
- `server/src/common/providers/implementations/kyc/mock-kyc.provider.ts`
- `server/src/modules/verification/`

### AWS target

There is no built-in AWS KYC provider here. The likely path is:

- AWS-hosted backend
- external Indian KYC provider such as DigiLocker

What to do:

1. Set `KYC_PROVIDER=digilocker` when real integration is ready.
2. Implement a DigiLocker provider implementation alongside the mock provider.
3. Configure `DIGILOCKER_CLIENT_ID`, `DIGILOCKER_CLIENT_SECRET`, `DIGILOCKER_REDIRECT_URI`.
4. Keep document storage on S3 and verification workflow in the `verification` module.

## Replace LLM integrations

### Current state

Backend LLM abstraction:

- `server/src/common/providers/interfaces/llm-provider.interface.ts`
- `server/src/common/providers/implementations/llm/default-llm.provider.ts`
- `server/src/modules/chat/services/onboarding-chat.service.ts`

Frontend still carries AI-related env/config shape, but LLM behavior should be backend-owned.

### AWS target

Use one of:

- OpenAI behind your backend
- Anthropic behind your backend
- AWS Bedrock

What to do:

1. Set `LLM_PROVIDER` to `openai`, `anthropic`, or later `bedrock`.
2. Keep prompts and orchestration in the backend module/service layer.
3. Avoid direct frontend API key usage for production-intent flows.

## What still needs to be replaced later

These are the main remaining migration leftovers:

- `src/integrations/supabase/`
- `src/providers/auth/supabase-auth.provider.ts`
- `src/providers/realtime/supabase-realtime.provider.ts`
- `supabase/functions/`
- `supabase/migrations/` as the long-term migration story unless intentionally retained
- `.lovable/`
- `lovable-tagger` dependency if you no longer use the Lovable workflow

## Recommended AWS migration order

1. Finalize RDS/Postgres as the durable backend DB target.
2. Finalize Cognito for auth.
3. Finalize S3 for uploads and verification docs.
4. Finalize Redis/ElastiCache.
5. Keep payments on Razorpay but run them entirely through the AWS-hosted backend.
7. Replace demo chat/realtime later, after the transactional platform is fully stable.
