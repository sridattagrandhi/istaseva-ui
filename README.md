# IstaSeva — India-First Marketplace Platform

A production-intent marketplace app combining home services, service providers, property listings, booking/scheduling, payments, trust & safety, and AI-assisted workflows. Built for the Indian market, targeting 1 million users.

> **Naming note:** the product/brand is **IstaSeva** (domain `istaseva.com`, app bundle `com.istaseva.app`). Two pre-existing infrastructure identifiers keep their original spelling because they name **live** resources and renaming them would break deploys/auth: the AWS stack + buckets use the `instaserve-*` prefix, and the Firebase/GCP project is `istasewa-93903`. Treat those two strings as opaque resource IDs, not brand.

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────────────────┐
│  React SPA       │────▶│  API Gateway /   │────▶│  Core Transactional Platform │
│  (Vite + TS)     │     │  Express Server   │     │  ┌────────┬─────────┐       │
│                  │     │  (server/)        │     │  │ Auth   │ Users   │       │
│  CloudFront CDN  │     │  ECS Fargate      │     │  │ Booking│ Payments│       │
└─────────────────┘     └──────────────────┘     │  │ Listing│ Reviews │       │
                                                  │  └────────┴─────────┘       │
                                                  └──────────────────────────────┘
                                                           │
                    ┌──────────────────────────────────────┼──────────────────┐
                    ▼                  ▼                    ▼                  ▼
              ┌──────────┐    ┌──────────────┐    ┌─────────────┐    ┌─────────────┐
              │PostgreSQL│    │    Redis      │    │  OpenSearch  │    │     S3      │
              │  (RDS)   │    │(ElastiCache)  │    │  (Search)   │    │  (Storage)  │
              └──────────┘    └──────────────┘    └─────────────┘    └─────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18 + TypeScript + Vite + TailwindCSS + shadcn/ui |
| **Backend** | Express.js + TypeScript (Node 20) |
| **Database** | PostgreSQL 15 (AWS RDS) |
| **Cache** | Redis 7 (AWS ElastiCache) |
| **Auth** | Firebase (Cognito wiring exists but is not the default) |
| **Storage** | AWS S3 |
| **Search** | AWS OpenSearch |
| **Payments** | Razorpay (India) / Stripe (International) |
| **CDN** | AWS CloudFront |
| **Compute** | AWS ECS Fargate (auto-scaling) |
| **Messaging** | AWS SQS + SNS |
| **Email** | AWS SES |
| **IaC** | AWS CDK (TypeScript) |

## Project Structure

```
├── src/                    # Frontend (React SPA)
│   ├── config/             #   Environment & provider config
│   ├── providers/          #   Client-side adapters (auth, realtime, analytics only)
│   ├── domains/            #   Business logic (domain services over the API)
│   ├── redesign/           #   Redesigned marketplace & booking surfaces
│   ├── components/         #   Reusable UI components
│   ├── pages/              #   Route-level pages
│   ├── contexts/           #   React contexts
│   └── types/              #   Domain types (provider-agnostic)
│
├── server/                 # Backend (Express API)
│   ├── src/
│   │   ├── app/            #   create-app, register-routes
│   │   ├── common/         #   Config, db, cache, auth, logging
│   │   └── modules/        #   Domain modules (routes/controllers/services/repositories)
│   ├── migrations/         #   SQL migrations — schema source of truth
│   ├── Dockerfile
│   └── package.json
│
├── infrastructure/         # AWS CDK (Infrastructure as Code)
│   ├── lib/
│   │   └── instaserve-stack.ts  # All AWS resources defined here
│   ├── bin/app.ts
│   └── package.json
│
├── docs/                   # Architecture & migration docs
├── docker-compose.yml      # Local development stack
└── .env.example            # Environment variable template
```

## Quick Start

### Option A: Local Development (Docker)

```bash
# 1. Start infrastructure (PostgreSQL, Redis, OpenSearch)
docker compose up -d

# 2. Start the API server
cd server
cp .env.example .env
npm install
npm run dev

# 3. Start the frontend
cd ..
npm install
npm run dev
```

Frontend: http://localhost:8080
API: http://localhost:3001
API Health: http://localhost:3001/health

### Option B: Deploy to AWS

```bash
# 1. Install CDK
npm install -g aws-cdk

# 2. Configure AWS credentials
aws configure

# 3. Deploy infrastructure
cd infrastructure
npm install
cdk bootstrap
cdk deploy --context env=staging

# 4. Note the outputs (endpoints, IDs)
# 5. Update .env files with the CDK output values
# 6. Deploy frontend
npm run build
aws s3 sync dist/ s3://instaserve-frontend-staging --delete
```

## Providers

The frontend keeps a swappable provider only where the client genuinely needs one — auth, realtime, and analytics. They are instantiated in `src/config/providers.ts`:

| Provider | Current Implementation | Selected by |
|----------|------------------------|-------------|
| Auth | `FirebaseAuthProvider` | hardcoded |
| Realtime | `WebSocketRealtimeProvider` | `VITE_REALTIME_PROVIDER` |
| Analytics | `MixpanelAnalyticsProvider` / `MockAnalyticsProvider` | `VITE_ANALYTICS_PROVIDER` |

Everything else — database, storage, payments, search, KYC, LLM — is owned by the Express backend and reached over HTTP via `src/lib/api-client.ts`. Those integrations are configured with server-side environment variables, not `VITE_*` ones. See `docs/PROVIDERS.md`.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (DB + Redis status) |
| `GET` | `/api/bookings` | List user's bookings |
| `POST` | `/api/bookings` | Create booking with slot lock |
| `PATCH` | `/api/bookings/:id/status` | Update booking status |
| `POST` | `/api/payments/create-order` | Create Razorpay payment order |
| `POST` | `/api/payments/verify` | Verify payment and confirm booking |
| `POST` | `/api/payments/webhook` | Razorpay webhook handler |
| `POST` | `/api/smart-schedule` | Find optimal booking slots |
| `POST` | `/api/dynamic-pricing` | Calculate adjusted pricing |
| `POST` | `/api/onboarding-chat` | AI onboarding conversation |
| `GET` | `/api/supply-optimization` | Category metrics and optimization |
| `GET` | `/api/notifications` | List user notifications |
| `GET` | `/api/search` | Search listings and providers |
| `POST` | `/api/storage/presign-upload` | Create an S3 upload URL |
| `POST` | `/api/storage/presign-download` | Create an S3 download URL |
| `DELETE` | `/api/storage/delete` | Delete an S3 object |
| `GET` | `/api/storage/list` | List S3 objects under a prefix |
| `GET` | `/api/:table` | Generic Postgres-backed table query for provider adapters |
| `POST` | `/api/rpc/:functionName` | Allowlisted PostgreSQL RPC bridge |

## AWS Infrastructure (CDK)

The `infrastructure/` directory contains a complete AWS CDK stack that provisions:

| Service | Resource | Staging | Production |
|---------|----------|---------|------------|
| VPC | Multi-AZ with public/private/isolated subnets | 2 AZs | 3 AZs |
| RDS | PostgreSQL 15 | db.t4g.medium | db.r6g.large + read replica |
| ElastiCache | Redis 7 | cache.t4g.micro | cache.r6g.large |
| S3 | 3 buckets (uploads, verification, frontend) | ✓ | ✓ + lifecycle rules |
| CloudFront | CDN for frontend SPA | ✓ | ✓ |
| Cognito | User Pool + App Client | ✓ | ✓ |
| OpenSearch | Search cluster | t3.small (1 node) | r6g.large (2 data + 3 master) |
| ECS Fargate | API server (auto-scaling) | 1 task (256 CPU) | 2-10 tasks (1024 CPU) |
| SQS | Notification queue + DLQ | ✓ | ✓ |
| SNS | Booking events topic | ✓ | ✓ |

**Estimated monthly cost**: Staging ~$200-400 | Production ~$2,000-5,000

## Database Schema

The PostgreSQL schema (in `server/migrations/`) includes:

- **Users**: `user_profiles`, `provider_profiles`, `provider_availability`
- **Listings**: `listings` (properties, services, vehicles)
- **Bookings**: `bookings`, `booking_queue`, `slot_locks` (with anti-double-booking)
- **Payments**: `payments`, `insurance_policies`, `insurance_claims`
- **Trust**: `reviews`, `service_guarantees`, `verification_documents`
- **Safety**: `safety_checks`, `safety_alerts`
- **Communication**: `messages`, `notifications`
- **Analytics**: `service_category_metrics`, `dynamic_pricing_config`

Key features: atomic slot booking with race condition prevention, state machine enums, automatic timestamps, cascade deletes. Authorization is enforced by the Express API, not by database row-level security.

## Booking Flow (Race-Condition Safe)

```
1. Client → POST /api/bookings
2. Server acquires Redis distributed lock on provider+date+time
3. Check for conflicting bookings in PostgreSQL
4. Check for active slot locks by other users
5. BEGIN TRANSACTION
   a. Create slot_lock (5-min TTL for payment)
   b. Create booking (status: pending)
6. COMMIT
7. Release Redis lock
8. Client → POST /api/payments/create-order (Razorpay)
9. Client completes payment in Razorpay checkout
10. Client → POST /api/payments/verify
11. BEGIN TRANSACTION
    a. Update payment (status: completed)
    b. Update booking (status: confirmed)
    c. Delete slot_lock
    d. Create service_guarantee
12. COMMIT
```

## Development

```bash
# Frontend
npm run dev          # Start dev server (localhost:8080)
npm run build        # Production build
npm run test         # Run tests (Vitest)
npm run lint         # ESLint

# Backend
cd server
npm run dev          # Start API server (localhost:3001)
npm run build        # TypeScript compile

# Infrastructure
cd infrastructure
cdk synth            # Generate CloudFormation template
cdk deploy           # Deploy to AWS
cdk diff             # Preview changes
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — System architecture and domain model
- [`docs/MIGRATION.md`](docs/MIGRATION.md) — Lovable→AWS migration record (historical; migration is complete)
- [`docs/MIGRATION_TO_AWS.md`](docs/MIGRATION_TO_AWS.md) — AWS migration playbook (historical; migration is complete)
- [`docs/PROVIDERS.md`](docs/PROVIDERS.md) — Provider interface reference
- [`docs/SCALING.md`](docs/SCALING.md) — Scaling roadmap (MVP → 1M users)

## Deferred work / TODO

### Free-cancellation cutoff — enforce in refund logic

Product rule: **free cancellation up to 10:00 AM IST, 2 days before the booking
start date.** This is currently **display copy only** — it appears on:

- Listing detail pages (generic wording, no concrete date):
  `FreeCancellationNote` in `src/redesign/MarketplaceDetailPages.tsx`.
- Booking confirmation email + GST tax-invoice PDF (concrete computed cutoff
  date): `describeCancellationPolicy` in
  `server/src/modules/bookings/services/cancellation-policy.ts`.

**Not yet enforced.** The refund computation in
`server/src/modules/payments/pricing/cancellation.ts` still grants a full
refund regardless of when the guest cancels. When moving from "display" to
"enforce": reuse `FREE_CANCELLATION_CUTOFF_DAYS` /
`FREE_CANCELLATION_CUTOFF_TIME_LABEL` from `cancellation-policy.ts` as the
single source of the rule, compare the cancellation timestamp against the
cutoff in `computeCancellationRefund`, and keep the displayed copy and the
enforced rule in lockstep.

## License

Proprietary — IstaSeva
