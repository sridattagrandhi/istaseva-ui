# Data Retention Schedule & Inventory

> **Status:** engineering-maintained (PRIV-004 / LEG-004 / LEG-007). Periods marked
> **TBD-counsel** need sign-off from Indian counsel before general availability.
> Code sources of truth: `server/src/common/config/retention.ts` (DynamoDB TTLs) and
> `infrastructure/lib/instaserve-stack.ts` (S3 lifecycle, CloudWatch retention).
>
> Last reviewed: 2026-07-14

## CERT-In obligations (Directions of 28 Apr 2022)

- **180-day rolling log retention within Indian jurisdiction** — satisfied by the
  `instaserve-access-logs-<stage>` bucket (ap-south-1, 400-day lifecycle) receiving VPC flow
  logs, ALB access logs, CloudFront access logs (frontend + media) and CloudTrail; WAF logs go
  to `aws-waf-logs-instaserve-<stage>` (us-east-1 — WAF requirement; CloudFront/WAF logs are
  edge-generated, primary systems log in-region). App logs: CloudWatch 180 days in prod.
- **Clock sync (NTP)** — ECS Fargate tasks and RDS sync to the Amazon Time Sync Service
  (169.254.169.123) built into AWS infrastructure; no extra configuration required. Documented
  here as the NTP answer for audits.
- **6-hour incident reporting** — see `docs/INCIDENT-RESPONSE.md`.

## Retention by store

### PostgreSQL (RDS, ap-south-1) — system of record

| Data | Retention | Basis / mechanism |
|---|---|---|
| User profile, listings, messages, reviews, wishlist | Life of account | Deleted/anonymized by the deletion orchestrator (48h grace) |
| Bookings, payments, invoices, payouts, guarantees, coupon redemptions | **7 years after transaction (TBD-counsel)** — GST/income-tax record-keeping | PII scrubbed on account deletion; financial fields retained |
| Consent records (`consent_records`) | Life of account + retained post-deletion as proof of processing | Append-only ledger |
| Verification document rows | Life of account | Hard-deleted by orchestrator |
| Analytics rollups (daily/RFM) | **24 months, then aggregate-only (TBD-counsel)** | No purge job yet — pending counsel sign-off on periods |
| Inactive-account purge | **TBD-counsel** — no age-based purge implemented; DPDP purpose-limitation duties commence 2027-05-13 | Decision deferred deliberately |

### DynamoDB (event trails) — TTLs from `retention.ts`

| Table | TTL | Notes |
|---|---|---|
| `audit_events` (compliance trail) | 730 days | Longest-lived; deletion tombstones live here |
| `audit_events` (agent observability rows) | 90 days | Same table, shorter need |
| `api_request_logs` | 180 days | CERT-In floor; path + userId + IP, no query strings |
| `fraud_signals` | 365 days | |
| `search_events` | 365 days | |
| `analytics_events` (raw) | 365 days | Consent-gated at collection (LEG-014) |

### S3 (ap-south-1) — lifecycle in CDK

| Bucket | Current objects | Noncurrent versions |
|---|---|---|
| `uploads` (avatars, DSAR exports) | Life of account (deletion sweep purges versions) | 30 days |
| `verification` (KYC) | 365 days max, or account deletion | 30 days |
| `listings` (media) | Life of listing/account | 30 days |
| `chat-media` | Life of account | n/a (unversioned) |
| `reports` | 90 days | n/a |
| `backups` | 180 days | 30 days |
| `access-logs` | 400 days | n/a |
| `aws-waf-logs-*` (us-east-1) | 400 days | n/a |

### CloudWatch Logs

| Log group | Prod | Staging |
|---|---|---|
| `/instaserve/<stage>/api` | 180 days | 30 days |
| Migration / moderation logs | 30 / 7 days | short-lived operational |

### Redis (ElastiCache)

Cache-only: ws tickets 60s, rate-limit windows (minutes), booking holds 300s, idempotency keys
600s. No durable PII.

### Third parties

See `docs/PROCESSOR-REGISTER.md` — vendor-side retention is governed by each DPA; Mixpanel data
is erased on account deletion via its GDPR API; Razorpay records are statutorily retained.

## On account deletion (PRIV-002)

48-hour grace window (cancellable) → lockout → erase: Postgres hard-delete + PII scrub on
retained financial rows, S3 **version-aware** purge across all user prefixes, DynamoDB
per-user delete across event tables, Mixpanel erasure request, IdP user deletion, anonymized
tombstone. Evidence: `account.deletion_*` audit events (730-day trail).
