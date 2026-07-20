
## Phase 1: Core Infrastructure Layer (this session)
Create the foundational abstraction layers and folder structure:

### 1a. Service/Provider Abstractions (`src/services/`)
- **Auth adapter** — wraps Supabase auth, interface for future Cognito/Clerk
- **Database repositories** — one per domain (users, bookings, listings, etc.), wrapping Supabase queries
- **Storage adapter** — wraps Supabase storage, interface for future S3
- **Realtime adapter** — wraps Supabase realtime, interface for future WebSocket
- **Payment adapter** — interface + mock for future Stripe/Razorpay
- **Notification adapter** — interface + mock for future email/SMS/push
- **Search adapter** — interface + mock for future OpenSearch
- **KYC adapter** — interface + mock for future Aadhaar/DigiLocker
- **LLM adapter** — wraps Lovable AI gateway, interface for future OpenAI/Bedrock

### 1b. Domain Services (`src/domains/`)
Business logic separated from UI and infrastructure:
- auth, users, providers, listings, bookings, payments, reviews, guarantees, verification, notifications, chat, search, fraud, analytics, admin

### 1c. Configuration Layer (`src/config/`)
- Environment config with provider switching
- Feature flags
- Provider registry

### 1d. Shared Types (`src/types/`)
- Domain entities, enums, status machines
- API contracts
- Validation schemas

## Phase 2: Frontend Refactor
- Move page-level business logic into domain hooks
- Centralize API calls through repositories
- Add proper error boundaries, loading states
- Add legal/consent tracking UI

## Phase 3: New Features
- Fraud event logging
- Audit log hooks  
- Legal consent tracking
- Enhanced communication logging
- Improved homepage sections

## Phase 4: Documentation
- `docs/ARCHITECTURE.md` — modular monolith overview
- `docs/MIGRATION.md` — AWS migration guide
- `docs/PROVIDERS.md` — how to swap each provider
- `docs/SCALING.md` — path to 1M users

## What stays the same
- All existing UI pages and components
- All existing Supabase tables and edge functions
- All existing routes and navigation
- Current auth flow (refactored behind abstraction)

## What changes
- Business logic moves from components → domain services
- Supabase calls move from components → repository layer
- External integrations get adapter interfaces
- Config becomes centralized and environment-driven
