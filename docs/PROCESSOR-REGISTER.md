# Processor / Sub-processor Register

> **Status:** engineering-maintained record (LEG-015 / PRIV-005). Review with counsel before
> general availability; re-review whenever a processor is added, removed, or its data scope
> changes. The customer-facing summary lives in the Privacy Policy ("Who we share it with" and
> "Where your data is processed").
>
> Last reviewed: 2026-07-14

## How to use this register

Every third party that processes personal data on IstaSeva's behalf must have a row here BEFORE
it receives production personal data. "DPA" = data-processing agreement / equivalent terms.
Vendor erasure column = what happens on account deletion (PRIV-002).

## Active processors

| Processor | Purpose | Personal data shared | Region(s) | DPA / terms | On account deletion |
|---|---|---|---|---|---|
| **Amazon Web Services** (RDS, S3, DynamoDB, ElastiCache, SES, SNS, CloudFront, ECS) | Core hosting, storage, email/SMS delivery | All platform data (system of record) | India (ap-south-1) | AWS GDPR DPA (Service Terms §1.15) — **verify account acceptance** | First-party erase by the deletion orchestrator (Postgres scrub/delete, S3 version purge, DynamoDB delete) |
| **Razorpay** | Payment processing, refunds, payment links | Name, contact, payment instrument (held by Razorpay), order amounts, booking reference | India | Merchant agreement — **verify DPA annex** | Retained — statutory financial records (payments/GST); documented in retention schedule, not deleted |
| **Google Firebase Authentication** | Sign-in (email/password, phone OTP), session tokens | Email, phone number, display name, UID, auth metadata | Global (US) | Firebase Data Processing and Security Terms | IdP user deleted by the deletion orchestrator (`authProvider.deleteUser`) |
| **Firebase Cloud Messaging** | Push notifications (web + mobile) | FCM device tokens keyed to UID | Global (US) | Firebase Data Processing and Security Terms | Token rows deleted first-party; tokens expire vendor-side once unregistered |
| **Google Maps Platform** | Geocoding, place autocomplete, static maps | User-typed location/address queries, listing addresses | Global (US) | Google Maps Platform terms — controller-to-controller; minimise queries | No stored user profile at vendor (request-scoped) |
| **Google Vertex AI / Gemini** | AI assistant (chat + live voice), onboarding agent, TTS | Conversation text/audio the user sends to the assistant | Global (US) | Google Cloud Data Processing Addendum; Vertex does not train on customer data per GCP terms | Conversations stored first-party (deleted by orchestrator); vendor retention per GCP DPA |
| **Mixpanel** (only when `VITE_ANALYTICS_PROVIDER=mixpanel`) | Product analytics | UID as `$distinct_id`, event stream (no PII in props by policy); **gated on the analytics consent banner/toggle** | US | Mixpanel DPA — **execute before enabling in production** | GDPR deletion-task API called by the deletion orchestrator (`MIXPANEL_GDPR_TOKEN`); no-op while unconfigured |

## Not processors (for clarity)

- **Hosts / providers / guests** — independent parties who receive counterparty booking details
  needed to deliver the service (disclosed in the Privacy Policy).
- **OpenStreetMap / Nominatim** (dev geocoding fallback) — dev-only; not used in production.

## Cross-border transfer summary

Primary processing: India (AWS ap-south-1). Transfers outside India: Google (Firebase, Maps,
Vertex AI) and Mixpanel — global/US infrastructure. Disclosed in the Privacy Policy
("Where your data is processed"). DPDP §16 restrictions (negative-list countries) to be
re-checked with counsel when the government notifies the list.

## Adding a processor — checklist

1. Confirm necessity and data minimisation (what fields, why).
2. Execute/verify a DPA or equivalent processing terms.
3. Add the row above with region + deletion behavior.
4. Update the Privacy Policy processor list (web `src/pages/Privacy.tsx` + mobile
   `mobile/src/design/screens/LegalScreens.tsx`) and bump `LEGAL_DOCS_VERSION`
   (server `server/src/modules/users/legal-docs-version.ts` is the source of truth).
5. If it holds user-keyed data: wire vendor erasure into
   `server/src/modules/users/services/account-deletion.job.ts`.
