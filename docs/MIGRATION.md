# Migration Guide: Lovable → AWS / Custom Infrastructure

> **Historical document — this migration is complete.** Every "Current:" line below refers to the pre-migration state and names files that no longer exist. Supabase is fully removed. For the real provider layout see `docs/PROVIDERS.md`; for current-state architecture see `ARCHITECTURE.md`.

## Overview

This codebase was designed for easy export from Lovable. External dependencies sat behind provider interfaces in `src/providers/`, swapped in `src/config/providers.ts`. Today only auth, realtime, and analytics remain as client-side providers — everything else moved behind the Express API.

---

## 1. Auth: Supabase → AWS Cognito / Clerk

**Current**: `src/providers/auth/supabase-auth.provider.ts`  
**Interface**: `src/providers/auth/auth.interface.ts`

**Steps**:
1. Create `src/providers/auth/cognito-auth.provider.ts` implementing `IAuthProvider`
2. Update `src/config/providers.ts`:
   ```ts
   import { CognitoAuthProvider } from '@/providers/auth/cognito-auth.provider';
   export function getAuthProvider(): IAuthProvider {
     return new CognitoAuthProvider(env.auth.cognitoPoolId, env.auth.cognitoClientId);
   }
   ```
3. Update `src/config/environment.ts` with Cognito env vars
4. Update `src/contexts/AuthContext.tsx` to use `getAuthProvider()`

---

## 2. Database: Supabase → PostgreSQL / Prisma

**Current**: `src/providers/database/supabase-database.provider.ts`  
**Interface**: `src/providers/database/database.interface.ts`

**Steps**:
1. Create `src/providers/database/postgres-database.provider.ts`
2. The provider wraps `pg` or Prisma client calls
3. All domain services already use the `IDatabaseProvider` interface
4. No domain service changes needed

**Schema**: The current Supabase schema maps directly to PostgreSQL. Export with:
```bash
pg_dump --schema-only $DATABASE_URL > schema.sql
```

---

## 3. Storage: Supabase Storage → AWS S3

**Current**: `src/providers/storage/supabase-storage.provider.ts`  
**Interface**: `src/providers/storage/storage.interface.ts`

**Steps**:
1. Create `src/providers/storage/s3-storage.provider.ts` using `@aws-sdk/client-s3`
2. Implement `upload`, `download`, `getPublicUrl`, `delete`, `list`
3. Swap in `providers.ts`

---

## 4. Realtime: Supabase Realtime → WebSocket

**Current**: `src/providers/realtime/supabase-realtime.provider.ts`  
**Interface**: `src/providers/realtime/realtime.interface.ts`

**Steps**:
1. Create WebSocket provider connecting to your own WS server
2. Implement `subscribeToTable`, `subscribeToChannel`, `broadcast`
3. The chat domain service (`src/domains/chat/`) will work unchanged

---

## 5. Payments: Mock → Stripe / Razorpay

**Current**: `src/providers/payment/mock-payment.provider.ts`  
**Interface**: `src/providers/payment/payment.interface.ts`

**Steps**:
1. Create `src/providers/payment/stripe-payment.provider.ts`
2. Implement `createPaymentIntent`, `confirmPayment`, `refundPayment`, `createPayout`
3. Add Stripe publishable key to `environment.ts`
4. Add Stripe secret key to backend environment

---

## 6. Notifications: Mock → SNS / Firebase / Twilio

**Current**: `src/providers/notification/mock-notification.provider.ts`  
**Interface**: `src/providers/notification/notification.interface.ts`

**Steps**:
1. Create provider implementing `send` and `sendBulk`
2. Route by channel: email → SES, SMS → SNS, push → Firebase, WhatsApp → Twilio

---

## 7. Search: Local → OpenSearch / Algolia

**Current**: `src/providers/search/local-search.provider.ts`  
**Interface**: `src/providers/search/search.interface.ts`

**Steps**:
1. Create `src/providers/search/opensearch-search.provider.ts`
2. Implement `search`, `index`, `deleteDocument`
3. Set up index mapping for listings, providers, services

---

## 8. KYC: Mock → DigiLocker / Aadhaar

**Current**: `src/providers/kyc/mock-kyc.provider.ts`  
**Interface**: `src/providers/kyc/kyc.interface.ts`

**Steps**:
1. Create provider calling DigiLocker/Aadhaar API
2. Implement `verifyDocument`, `getVerificationStatus`
3. The verification domain service will work unchanged

---

## 9. LLM: Lovable AI → OpenAI / Bedrock

**Current**: `src/providers/llm/lovable-llm.provider.ts`  
**Interface**: `src/providers/llm/llm.interface.ts`

**Steps**:
1. Create `src/providers/llm/openai-llm.provider.ts`
2. Implement `chatCompletion`, `structuredCompletion`
3. Update the onboarding edge function to call your own API

---

## 10. Analytics: Mock → Mixpanel / Amplitude

**Current**: `src/providers/analytics/mock-analytics.provider.ts`  
**Interface**: `src/providers/analytics/analytics.interface.ts`

**Steps**:
1. Create provider calling your analytics SDK
2. Implement `track`, `identify`, `page`

---

## Environment Variables

When migrating, update `src/config/environment.ts` to read from your env:

```ts
// Before (Lovable)
supabaseUrl: import.meta.env.VITE_SUPABASE_URL,

// After (AWS)
postgresUrl: process.env.DATABASE_URL,
cognitoPoolId: process.env.COGNITO_POOL_ID,
s3Bucket: process.env.S3_BUCKET,
```

## Edge Functions → API Routes

The Supabase edge functions in `supabase/functions/` can be converted to:
- Express/Fastify routes
- AWS Lambda functions
- Any serverless platform

Each function is self-contained and can be lifted out as-is.

## Database Tables

All tables are standard PostgreSQL. The schema in `supabase/migrations/` contains the complete DDL. Run migrations against any PostgreSQL instance.
