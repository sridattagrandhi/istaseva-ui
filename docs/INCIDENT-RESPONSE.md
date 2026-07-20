# Incident Response Playbook (CERT-In)

> **Status:** engineering draft (LEG-007). Fill in the named contacts and register the CERT-In
> point of contact before general availability. CERT-In Directions (28 Apr 2022) require
> reporting of specified cyber incidents **within 6 hours of noticing**.
>
> Last reviewed: 2026-07-14

## Contacts

| Role | Who | How |
|---|---|---|
| Incident lead / CERT-In point of contact | **TBD — must be registered with CERT-In (name, phone, email)** | |
| Infra/on-call | TBD | CloudWatch alarms → SNS `instaserve-<stage>-alarms` |
| Legal counsel | TBD | |
| CERT-In | incident@cert-in.org.in | +91-1800-11-4949; format per Annexure-A of the Directions |

## What must be reported (subset relevant to us)

Targeted scanning/probing of critical systems, compromise of critical systems, unauthorised
access to systems/data, defacement, malicious attacks (ransomware/DoS/DDoS), attacks on
databases or cloud systems, **data breaches and data leaks**, attacks on payment systems,
unauthorised access to social-media/user accounts, malicious mobile-app impersonation.

## Severity triage

- **SEV-1** — confirmed data breach/leak, payment-system compromise, prod-wide outage from
  attack. CERT-In clock (6h) starts at detection. Page incident lead + counsel immediately.
- **SEV-2** — suspected unauthorised access, targeted scanning of critical systems, single
  tenant data exposure. Investigate within 1h; escalate to SEV-1 on confirmation.
- **SEV-3** — WAF/rate-limit anomalies, failed intrusion attempts. Log, monitor, weekly review.

## First hour (SEV-1/2)

1. **Preserve** — do NOT delete or restart-destroy evidence. Logs are already retained:
   access-logs bucket (ALB/CloudFront/VPC flow/CloudTrail), WAF logs, CloudWatch app logs
   (180d prod), `api_request_logs` (180d). Snapshot affected RDS instance if DB compromise is
   suspected.
2. **Contain** — rotate exposed credentials in Secrets Manager; disable compromised IAM keys;
   for account takeover, use admin suspend + Firebase session revocation; for storage exposure,
   tighten the bucket policy first, investigate second.
3. **Assess scope** — which users/data classes (see `docs/DATA-RETENTION.md` inventory), time
   window, entry path.
4. **Report** — SEV-1: incident lead files the CERT-In Annexure-A report **within 6 hours of
   detection** (email incident@cert-in.org.in). Counsel decides user/regulator notification
   beyond CERT-In (DPDP breach duties commence 2027-05-13 but contractual/consumer duties may
   apply earlier).
5. **Record** — open an incident doc: detection time, timeline, actions, evidence pointers
   (S3 keys, log-group/stream names, CloudTrail event IDs).

## Post-incident (within 7 days)

Root-cause analysis; corrective actions with owners; update this playbook and the threat model;
verify log coverage was sufficient — any gap found becomes a P1 infra task.

## Standing evidence sources

| Source | Where | Retention |
|---|---|---|
| ALB access logs | `s3://instaserve-access-logs-<stage>/alb/` | 400d |
| CloudFront access logs | `.../cloudfront/{frontend,media}/` | 400d |
| VPC flow logs | `.../vpc-flow-logs/` | 400d |
| CloudTrail (multi-region, validated) | `.../cloudtrail/` | 400d |
| WAF logs | `s3://aws-waf-logs-instaserve-<stage>/` (us-east-1) | 400d |
| App logs | CloudWatch `/instaserve/<stage>/api` | 180d prod |
| Per-request log (userId+IP) | DynamoDB `api_request_logs` | 180d |
| Admin/audit trail | DynamoDB `audit_events` | 730d |

## Clock sync (CERT-In NTP requirement)

All compute (ECS Fargate, RDS, ElastiCache) syncs to the **Amazon Time Sync Service**
(169.254.169.123, Stratum-1, leap-smeared) automatically — this is the documented NTP answer.
