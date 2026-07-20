# InstaServe — Production Deployment Guide

End-to-end instructions for deploying InstaServe to AWS (`ap-south-1`).

---

## Architecture Overview

```
CloudFront (HTTPS)
├── /* → S3 (frontend — Vite React SPA)
├── /api/* → ALB → ECS Fargate (Node.js API)
└── /health → ALB → ECS Fargate

ECS Fargate connects to:
├── RDS PostgreSQL 15 (isolated subnet — search runs here via tsvector/ILIKE)
├── ElastiCache Redis 7.1 (isolated subnet)
├── S3 (6 buckets — uploads, verification, listings, chat, reports, backups)
├── SQS (notification queue)
├── DynamoDB (audit events, fraud signals, API logs, search events)
└── Secrets Manager (database creds, app secrets)

Auth: Firebase (project: istasewa-93903)
```

---

## Prerequisites

```bash
# AWS CLI v2
brew install awscli           # macOS

# Node 20 + CDK
node -v                       # must be 20.x
npm install -g aws-cdk@2

# Docker (needed to build the API container image)
docker --version
```

---

## Step 1 — AWS Account & IAM Setup

### 1a. Create a deployment IAM user (do this once)

In the AWS Console → IAM → Users → Create user:

- **Username**: `instaserve-deployer`
- **Permissions**: Attach `AdministratorAccess` (scope this down after first deploy)
- Generate **Access Keys** → save the key ID and secret

> Never put these keys in code or `.env` files committed to git.

### 1b. Configure AWS CLI

```bash
aws configure
# Enter: AWS Access Key ID, Secret Access Key, Region = ap-south-1, Output = json

# Verify
aws sts get-caller-identity
```

---

## Step 2 — Bootstrap CDK (one-time per account/region)

```bash
cd infrastructure
npm install

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
npx cdk bootstrap aws://${ACCOUNT_ID}/ap-south-1
```

Expected output: `✅  Environment aws://<account>/ap-south-1 bootstrapped`

---

## Step 3 — Deploy Staging

```bash
cd infrastructure
npm run deploy:staging
```

This takes **10–20 minutes** on first deploy (RDS is the slow step).

The command creates everything: VPC, RDS, Redis, S3 buckets, SQS, DynamoDB tables, ECS Fargate service, CloudFront distribution, ALB, and all IAM roles.

Save the outputs — you will need them (especially the CloudFront URL).

---

## Step 4 — Populate Application Secrets

Generate a JWT secret:

```bash
openssl rand -base64 32
```

Get your Firebase service account JSON from Firebase Console → Project Settings → Service Accounts → Generate New Private Key.

Then populate the secret:

```bash
cd ~/Documents/my-india-nexus-main

python3 -c "
import json
secret = {
    'JWT_SECRET': '<paste-jwt-secret-here>',
    'FIREBASE_SERVICE_ACCOUNT_JSON': json.dumps(json.load(open('firebase-service-account.json'))),
    'RAZORPAY_KEY_ID': '',
    'RAZORPAY_KEY_SECRET': '',
    'RAZORPAY_WEBHOOK_SECRET': '',
    'GEMINI_API_KEY': '<paste-gemini-key-here>'
}
print(json.dumps(secret))
" > /tmp/app-secret.json

aws secretsmanager put-secret-value \
  --secret-id "instaserve/staging/app" \
  --secret-string file:///tmp/app-secret.json \
  --region ap-south-1
```

Then force ECS to pick up the new secrets:

```bash
aws ecs update-service \
  --cluster <cluster-name> \
  --service <service-name> \
  --force-new-deployment \
  --region ap-south-1
```

**Current staging values:**
- AWS profile: `instaserve` (add `--profile instaserve` to every `aws` command, or `export AWS_PROFILE=instaserve`)
- Region: `ap-south-1`
- Cluster: `InstaServe-staging-ClusterEB0386A7-MP8RbRt97BkO`
- Service: `InstaServe-staging-ApiService199661B5-HKNHqQz2R6kO`
- Frontend S3 bucket: `instaserve-frontend-staging`
- CloudFront distribution ID: `E1FBU5O1WALCVT`
- Container name (inside task def): `web`

---

## Step 5 — Run Database Migrations

Migrations run as a one-off ECS task (RDS is in an isolated subnet — no direct access):

```bash
TASK_DEF=$(aws ecs describe-services \
  --cluster <cluster-name> \
  --services <service-name> \
  --region ap-south-1 \
  --query 'services[0].taskDefinition' \
  --output text)

SUBNETS=$(aws ecs describe-services \
  --cluster <cluster-name> \
  --services <service-name> \
  --region ap-south-1 \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.subnets' \
  --output text | tr '\t' ',')

SGS=$(aws ecs describe-services \
  --cluster <cluster-name> \
  --services <service-name> \
  --region ap-south-1 \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.securityGroups' \
  --output text | tr '\t' ',')

aws ecs run-task \
  --cluster <cluster-name> \
  --task-definition $TASK_DEF \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SGS],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"web","command":["node","scripts/migrate.js"]}]}' \
  --region ap-south-1
```

Check the result after ~60 seconds:

```bash
TASK_ID=$(aws ecs list-tasks \
  --cluster <cluster-name> \
  --desired-status STOPPED \
  --region ap-south-1 \
  --query 'taskArns[0]' \
  --output text | awk -F/ '{print $NF}')

aws ecs describe-tasks \
  --cluster <cluster-name> \
  --tasks $TASK_ID \
  --region ap-south-1 \
  --query 'tasks[0].{status:lastStatus,exitCode:containers[0].exitCode}' \
  --output json
```

You want `exitCode: 0`.

---

## Step 6 — Deploy the Frontend

### Source of truth for `.env.staging` / `.env.production`

The frontend env files are **regenerable from AWS Secrets Manager**. They are gitignored and must never be hand-maintained as the canonical copy — if anyone deletes the file (a stray `git clean -fdx`, accidental IDE "discard untracked", whatever), it's a one-command recovery.

**Source of truth:** secret `instaserve/<env>/frontend-env` in Secrets Manager (`ap-south-1`).
**Local file:** `.env.<env>` — treat as a regenerable cache.

To pull the latest values down:

```bash
npm run env:pull:staging   # writes .env.staging from Secrets Manager
npm run env:pull:prod      # writes .env.production
```

To **change** a value, edit the secret in AWS, then re-run `env:pull:*`. Do **not** edit `.env.staging` directly — the next pull would overwrite it.

```bash
# Edit the staging secret in-place (opens $EDITOR with the JSON)
aws secretsmanager get-secret-value --secret-id instaserve/staging/frontend-env \
  --query SecretString --output text --profile instaserve --region ap-south-1 > /tmp/fe.json
$EDITOR /tmp/fe.json
aws secretsmanager update-secret --secret-id instaserve/staging/frontend-env \
  --secret-string file:///tmp/fe.json --profile instaserve --region ap-south-1
rm /tmp/fe.json
```

### Build & deploy

```bash
cd ~/Documents/my-india-nexus-main

# 1. Make sure local .env.staging matches the secret (idempotent — safe to run every time)
npm run env:pull:staging

# 2. Build with staging env. The build script runs scripts/check-frontend-env.cjs first
#    and FAILS LOUDLY if the env file is missing, missing required keys, or has localhost
#    URLs. This is the guardrail that stops us shipping a broken bundle.
npm run build:staging

# 3. Upload to S3 + invalidate CloudFront, with correct cache headers.
#    Use the script — do NOT hand-run `aws s3 sync dist/ ... --delete`. A plain
#    sync sets no Cache-Control, so browsers heuristically cache index.html and
#    returning visitors paint the PREVIOUS build before the new one loads (the
#    "old version flashes first" bug). The script does the same --delete pruning
#    and invalidation, but in two passes: assets/ (fingerprinted) cached
#    immutable forever, index.html + service worker as no-cache so a new build
#    is picked up immediately. See the cache-headers note below.
./scripts/deploy-frontend.sh staging

# Production: pass the distribution id explicitly (only staging has a default).
#   DISTRIBUTION_ID=EXXXXXXXX ./scripts/deploy-frontend.sh production
```

### Frontend cache headers (why index.html must never be cached)

Vite content-hashes everything under `dist/assets/`, so those files are safe to
cache forever. `index.html` is the pointer that names the current asset hashes —
if it's cached, a returning browser serves a stale pointer → old hashed JS/CSS →
the previous UI renders, then the browser revalidates and swaps to the new build.
`scripts/deploy-frontend.sh` fixes this by uploading `assets/*` with
`Cache-Control: public,max-age=31536000,immutable` and `index.html` +
`firebase-messaging-sw.js` (and other root files) with `Cache-Control: no-cache`.
The CloudFront default behavior is `CACHING_OPTIMIZED`
([infrastructure/lib/instaserve-stack.ts](infrastructure/lib/instaserve-stack.ts)),
which respects these origin headers — so the object-level metadata is what makes
this work end to end. Never revert the deploy to a bare `aws s3 sync`.

### Required `VITE_*` keys

The pre-build check (`scripts/check-frontend-env.cjs`) enforces these as must-haves; missing any of them aborts the build:

```
VITE_API_URL                  https://staging.istaseva.com   (NEVER localhost in staging/prod)
VITE_WS_URL                   wss://staging.istaseva.com/ws
VITE_AUTH_PROVIDER            firebase
VITE_FIREBASE_API_KEY         <Firebase web API key — public-safe>
VITE_FIREBASE_AUTH_DOMAIN     istasewa-93903.firebaseapp.com
VITE_FIREBASE_PROJECT_ID      istasewa-93903
```

Other vars in the secret (storage provider, payment provider, etc.) are passed through but not required.

> **Important:** `VITE_API_URL` points to the same CloudFront domain (not the ALB directly). CloudFront routes `/api/*` to the ALB automatically, avoiding mixed-content (HTTPS→HTTP) issues.

### Recovering a deleted `.env.staging`

If `.env.staging` is missing for any reason — `git clean`, IDE accident, fresh laptop, new teammate — recovery is:

```bash
npm run env:pull:staging
```

That's it. The file is rewritten from the secret. **No need to remember the values** — they live in AWS, not in someone's head.

If `npm run build:staging` fails with a missing-keys error, the failure message tells you exactly which command to run.

---

## Step 7 — Verify Health

```bash
curl https://<cloudfront-domain>.cloudfront.net/health
```

Expected:

```json
{"status":"healthy","timestamp":"...","services":{"database":"up","redis":"up"}}
```

---

## Step 8 — Custom Domain & HTTPS (optional)

### Request ACM certificates

```bash
# For CloudFront — certificate MUST be in us-east-1
aws acm request-certificate \
  --domain-name "instaserve.in" \
  --subject-alternative-names "*.instaserve.in" \
  --validation-method DNS \
  --region us-east-1
```

Add the CNAME validation records to your DNS, then add the certificate ARN to the CDK stack's CloudFront distribution.

---

## Redeploying (day-to-day)

Once the stack exists, "deploying a change" is not a full rebuild — it's one of three flows depending on what you touched.

### A. Redeploy the backend (API code changes in `server/`)

CDK's `ContainerImage.fromAsset` rebuilds the Docker image, pushes to ECR, registers a new task def, and rolls the ECS service — all in one command. You do **not** need to run `docker build` or `aws ecr push` manually.

```bash
cd ~/Documents/my-india-nexus-main/infrastructure
AWS_PROFILE=instaserve AWS_REGION=ap-south-1 \
  npm run deploy:staging -- --require-approval never
```

Expected duration: **4–8 minutes** on an unchanged stack (most time is ECR push + ECS rolling update). Watch it in another terminal:

```bash
aws logs tail /instaserve/staging/api --follow --region ap-south-1 --profile instaserve
```

After it finishes, sanity-check:

```bash
curl -s https://<cloudfront-domain>.cloudfront.net/health | jq
```

If you added a new migration, run **Step 5** before or right after the deploy — the new container expects the new schema.

### B. Redeploy the frontend (SPA changes in `src/`)

No CDK involved — just build + S3 sync + CloudFront invalidation.

```bash
cd ~/Documents/my-india-nexus-main

# 1. Refresh local env from Secrets Manager (idempotent; safe to run every deploy)
npm run env:pull:staging

# 2. Build (this also runs the env sanity check — see Step 6)
npm run build:staging

# 3. Upload (--delete removes files no longer in dist/, including old hashed bundles)
AWS_PROFILE=instaserve AWS_REGION=ap-south-1 aws s3 sync dist/ \
  s3://instaserve-frontend-staging/ --delete

# 4. Invalidate CloudFront so users get the new index.html immediately
AWS_PROFILE=instaserve AWS_REGION=ap-south-1 aws cloudfront create-invalidation \
  --distribution-id E1FBU5O1WALCVT --paths '/*' \
  --query 'Invalidation.Id' --output text
```

> **If the build fails complaining about a missing `.env.staging`:** run `npm run env:pull:staging` and try again. The env file is regenerable from AWS Secrets Manager — see Step 6 for the full source-of-truth model.

Expected duration: **2–3 minutes** total (build ~5s, sync ~30s, invalidation ~1–2 min to complete globally).

Check invalidation status (it starts as `InProgress`):

```bash
aws cloudfront get-invalidation \
  --distribution-id E1FBU5O1WALCVT \
  --id <invalidation-id> \
  --region ap-south-1 --profile instaserve \
  --query 'Invalidation.Status' --output text
```

Tell testers to hard-refresh (Cmd+Shift+R) — the HTML cache is gone but their browser may still hold the old bundle.

### C. Apply a new DB migration only

New SQL file in `server/migrations/` but no code changes? Just run the migration one-off task from **Step 5** — no redeploy needed. The running API picks up the new schema on next query.

Quick-dispatch version using the current staging values:

```bash
aws ecs run-task \
  --cluster InstaServe-staging-ClusterEB0386A7-MP8RbRt97BkO \
  --task-definition $(aws ecs describe-services \
    --cluster InstaServe-staging-ClusterEB0386A7-MP8RbRt97BkO \
    --services InstaServe-staging-ApiService199661B5-HKNHqQz2R6kO \
    --region ap-south-1 --profile instaserve \
    --query 'services[0].taskDefinition' --output text) \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-0679bbeeaa098429e,subnet-03ad380da24758d10],securityGroups=[sg-09aa8f858ca69b0fe],assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"web","command":["node","scripts/migrate.js"]}]}' \
  --region ap-south-1 --profile instaserve \
  --query 'tasks[0].taskArn' --output text
```

Then block on completion and check exit code:

```bash
TASK_ARN=<paste-from-above>
TASK_ID=$(echo $TASK_ARN | awk -F/ '{print $NF}')

aws ecs wait tasks-stopped \
  --cluster InstaServe-staging-ClusterEB0386A7-MP8RbRt97BkO \
  --tasks $TASK_ID \
  --region ap-south-1 --profile instaserve

aws ecs describe-tasks \
  --cluster InstaServe-staging-ClusterEB0386A7-MP8RbRt97BkO \
  --tasks $TASK_ID \
  --region ap-south-1 --profile instaserve \
  --query 'tasks[0].{stopCode:stopCode,reason:stoppedReason,exitCode:containers[0].exitCode}'
```

Want `exitCode: 0`. If non-zero, tail the logs:

```bash
aws logs get-log-events \
  --log-group-name /instaserve/staging/api \
  --log-stream-name api/web/$TASK_ID \
  --region ap-south-1 --profile instaserve \
  --query 'events[*].message' --output text
```

> Note: `scripts/migrate.js` is idempotent — it records applied migrations and skips them on rerun. Safe to run anytime.

### D. Full "something went sideways" redeploy

Occasionally the ECS service gets wedged (tasks failing health checks, secret changes not picked up, etc.). Force a fresh rollout without rebuilding:

```bash
aws ecs update-service \
  --cluster InstaServe-staging-ClusterEB0386A7-MP8RbRt97BkO \
  --service InstaServe-staging-ApiService199661B5-HKNHqQz2R6kO \
  --force-new-deployment \
  --region ap-south-1 --profile instaserve
```

This uses the **current** task def — good for picking up rotated secrets or simply restarting. It does **not** rebuild the image.

---

## Step 9 — Deploy Production

Once staging is working end-to-end:

```bash
cd infrastructure
npm run deploy:prod
```

Repeat Steps 4–7 for the `production` stage. **Important:** Remove the staging-only migration `20260416000000_verify_staging_providers.sql` before production — it auto-verifies all providers.

---

## Secrets Reference

| Secret path                     | Fields                                                                                     |
|---------------------------------|--------------------------------------------------------------------------------------------|
| `instaserve/<stage>/database`   | `username`, `password`, `host`, `port`, `dbname` (auto-populated by RDS)                   |
| `instaserve/<stage>/app`        | `JWT_SECRET`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `GEMINI_API_KEY` |

---

## Auto-prune of deploy artifacts

Every `npm run deploy:staging` (and `:prod`) automatically runs `scripts/prune-deploy-artifacts.sh <env>` via the `postdeploy:*` lifecycle hook. You don't need to run it manually.

What gets pruned on every deploy:

| Layer | Policy | Why |
|---|---|---|
| Local Docker `cdkasset-*` images | Keep 3 most recent | Each is ~309 MB; stale ones balloon the Docker VM disk. 3 covers current + emergency rollback. |
| Local Docker buildkit cache | `prune --filter until=24h` | Cache layers older than a day are very unlikely to be reused |
| Local `infrastructure/cdk.out` | Deleted | Synthesised templates regen in seconds; left over they accumulate to ~11 GB |
| ECS task definitions | Deregister INACTIVE revisions older than 7 days | Keeps the console + API responses clean. Active revision is never touched. |
| ECR images | **Lifecycle policy on the repo** keeps last 10 tagged | Set once, AWS auto-prunes daily. Run `aws ecr put-lifecycle-policy ...` once if you ever recreate the asset bucket. |

To run the prune manually (e.g. after a cancelled deploy that left junk):

```bash
./scripts/prune-deploy-artifacts.sh staging
```

To inspect current usage before/after:

```bash
docker system df                                                            # local
aws ecr list-images --repository-name <ecr-repo> --query 'length(imageIds)'  # AWS
aws ecs list-task-definitions --status INACTIVE --query 'length(taskDefinitionArns)'
```

**One-time setup the script does NOT do**: applying the ECR lifecycle policy. It's already applied to the staging repo, but if you ever recreate the bootstrap bucket you'll need to reapply:

```bash
aws ecr put-lifecycle-policy \
  --repository-name cdk-hnb659fds-container-assets-<account>-<region> \
  --lifecycle-policy-text '{"rules":[{"rulePriority":1,"description":"Keep last 10 tagged deploys","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}}]}'
```

---

## Useful Commands

```bash
# Tail API logs in real time
aws logs tail /instaserve/staging/api --follow --region ap-south-1

# List ECS tasks
aws ecs list-tasks --cluster <cluster-name> --region ap-south-1

# Check task exit code (for migration/one-off tasks)
aws ecs describe-tasks --cluster <cluster-name> --tasks <task-arn> \
  --region ap-south-1 \
  --query 'tasks[0].{status:lastStatus,exitCode:containers[0].exitCode}'

# View container logs for a specific task
aws logs get-log-events \
  --log-group-name /instaserve/staging/api \
  --log-stream-name api/web/<task-id> \
  --region ap-south-1 \
  --output json \
  --query 'events[*].message'

# Force ECS restart (after updating secrets)
aws ecs update-service \
  --cluster <cluster-name> \
  --service <service-name> \
  --force-new-deployment \
  --region ap-south-1

# Destroy staging (irreversible for non-RETAIN resources)
cd infrastructure
npx cdk destroy --context env=staging
```

---

## Cost Estimate (staging — ap-south-1)

| Service               | Approx/month (USD) |
|-----------------------|--------------------|
| RDS t4g.medium        | ~$60               |
| ElastiCache t4g.micro | ~$12               |
| ECS Fargate (1 task)  | ~$15               |
| NAT Gateway           | ~$35               |
| ALB                   | ~$18               |
| VPC Interface Endpoints (4 × 2 AZ) | ~$58  |
| CloudFront            | ~$1                |
| S3                    | ~$1                |
| **Total (staging)**   | **~$200/month (~$6.70/day)** |

Note: search runs on RDS via Postgres full-text (`tsvector`/`ILIKE`) — no separate search infra. If cost pressure increases, the next lever is removing the 4 VPC interface endpoints and routing their traffic through NAT (~$58/mo saved).

Production costs 3–5× staging due to larger instances and Multi-AZ.

> **Tip:** Destroy staging when not in use to save costs: `npx cdk destroy --context env=staging`
