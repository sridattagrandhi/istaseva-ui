# Provider Reference

## Scope

The frontend keeps a provider abstraction only for capabilities that genuinely need client-side polymorphism: auth, realtime, and analytics. Everything else — database, storage, payments, search, KYC, LLM — is owned by the Express backend and reached over HTTP through `src/lib/api-client.ts`.

If you are adding a capability that needs a vendor SDK, the answer is almost always a backend module, not a new frontend provider. See `ARCHITECTURE.md`.

## Provider Registry

The three client-side providers are instantiated in `src/config/providers.ts`:

| Provider | Interface | Current Implementation | Selected by |
|----------|-----------|------------------------|-------------|
| Auth | `IAuthProvider` | `FirebaseAuthProvider` | hardcoded |
| Realtime | `IRealtimeProvider` | `WebSocketRealtimeProvider` | `VITE_REALTIME_PROVIDER` |
| Analytics | `IAnalyticsProvider` | `MixpanelAnalyticsProvider` / `MockAnalyticsProvider` | `VITE_ANALYTICS_PROVIDER` |

`src/providers/` contains exactly these three interface/implementation pairs plus `index.ts`. There are no database, storage, payment, search, KYC, or LLM providers on the client — do not add any.

## Backend Integrations

These are configured on the server, not through the frontend registry:

| Capability | Where it lives |
|------------|----------------|
| Database (PostgreSQL) | `server/src/**/repositories/` via `pg` |
| Storage (S3 / local) | `server/src/modules/infrastructure/` |
| Payments (Razorpay / mock) | `server/src/modules/payments/` |
| Search | `server/src/modules/search/` |
| Verification / KYC | `server/src/modules/verification/` |
| LLM | `server/src/modules/chat/` (provider registry + agent tools) |
| Notifications (SES / SMTP) | `server/src/modules/notifications/` |

## Adding a Frontend Provider

Only for auth, realtime, or analytics:

1. Implement the interface (e.g. `src/providers/analytics/segment-analytics.provider.ts`).
2. Add a branch in the relevant getter in `src/config/providers.ts`.
3. Add any required `VITE_*` vars to `src/config/environment.ts` and `src/config/frontend.ts`.
4. No domain service or UI changes needed.

## Domain Services

Frontend domain services live in `src/domains/<name>/`. Nearly all of them are thin clients over the backend API; only the three listed below touch a provider directly.

| Domain | Reaches the backend via | Also uses |
|--------|------------------------|-----------|
| `chat` | `api-client` | Realtime provider |
| `fraud` | `api-client` | Analytics provider |
| `audit` | — | Analytics provider |
| `admin`, `analytics`, `bookings`, `coupons`, `guarantees`, `insurance`, `legal`, `listings`, `notifications`, `payments`, `pricing`, `providers`, `reviews`, `safety`, `users`, `verification`, `wishlist` | `api-client` | — |
