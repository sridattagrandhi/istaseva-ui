# Migration to AWS — Step-by-Step Playbook

> **Historical document — this migration is complete.** Kept as a record of the original cutover steps. Commands referencing `supabase/migrations/` no longer work; the schema lives in `server/migrations/` and is applied with `cd server && npm run db:migrate`. For current deployment procedure see `DEPLOYMENT.md`.

## Prerequisites

- AWS account with IAM user
- AWS CLI configured
- Node.js 18+ on your machine
- PostgreSQL client (`psql`)
- The exported InstaServe codebase

---

## Phase 1: Infrastructure Setup (Day 1-2)

### 1.1 Database — RDS PostgreSQL

```bash
aws rds create-db-instance \
  --db-instance-identifier instaserve-db \
  --db-instance-class db.t3.medium \
  --engine postgres \
  --engine-version 15 \
  --master-username instaserve_admin \
  --master-user-password <strong-password> \
  --allocated-storage 20 \
  --region ap-south-1
```

Apply the schema:
```bash
psql $RDS_CONNECTION_STRING < supabase/migrations/*.sql
```

### 1.2 Storage — S3

```bash
aws s3 mb s3://instaserve-uploads --region ap-south-1
aws s3 mb s3://instaserve-verification-docs --region ap-south-1
```

### 1.3 Auth — Cognito User Pool

```bash
aws cognito-idp create-user-pool \
  --pool-name InstaServe \
  --auto-verified-attributes email \
  --region ap-south-1
```

### 1.4 Cache — ElastiCache Redis

```bash
aws elasticache create-cache-cluster \
  --cache-cluster-id instaserve-cache \
  --cache-node-type cache.t3.micro \
  --engine redis \
  --num-cache-nodes 1 \
  --region ap-south-1
```

### 1.5 Search — OpenSearch

```bash
aws opensearch create-domain \
  --domain-name instaserve-search \
  --engine-version OpenSearch_2.11 \
  --cluster-config InstanceType=t3.small.search,InstanceCount=1 \
  --ebs-options EBSEnabled=true,VolumeType=gp3,VolumeSize=10 \
  --region ap-south-1
```

---

## Phase 2: Provider Swaps (Day 2-4)

### 2.1 Auth — Supabase → Cognito

Create `src/providers/auth/cognito-auth.provider.ts`:
```typescript
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { IAuthProvider } from './auth.interface';

export class CognitoAuthProvider implements IAuthProvider {
  private client: CognitoIdentityProviderClient;
  private clientId: string;

  constructor(region: string, clientId: string) {
    this.client = new CognitoIdentityProviderClient({ region });
    this.clientId = clientId;
  }

  async signIn(email: string, password: string) {
    const cmd = new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: this.clientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    });
    const result = await this.client.send(cmd);
    // Map to AuthSession...
  }

  // Implement remaining IAuthProvider methods...
}
```

Update `src/config/providers.ts`:
```typescript
import { CognitoAuthProvider } from '@/providers/auth/cognito-auth.provider';

export function getAuthProvider(): IAuthProvider {
  if (!authProvider) {
    authProvider = new CognitoAuthProvider(
      env.auth.cognitoRegion!,
      env.auth.cognitoClientId!
    );
  }
  return authProvider;
}
```

### 2.2 Database — Supabase → PostgreSQL

Create `src/providers/database/postgres-database.provider.ts`:
```typescript
import { Pool } from 'pg';
import type { IDatabaseProvider, QueryOptions } from './database.interface';

export class PostgresDatabaseProvider implements IDatabaseProvider {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async query<T>(table: string, options?: QueryOptions) {
    let sql = `SELECT * FROM ${table}`;
    const params: any[] = [];
    // Build WHERE, ORDER BY, LIMIT from options...
    const result = await this.pool.query(sql, params);
    return { data: result.rows as T[], count: result.rowCount, error: null };
  }

  async getById<T>(table: string, id: string) {
    const result = await this.pool.query(
      `SELECT * FROM ${table} WHERE id = $1`, [id]
    );
    return { data: (result.rows[0] as T) || null, error: null };
  }

  async insert<T>(table: string, data: Partial<T>) {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`);
    const result = await this.pool.query(
      `INSERT INTO ${table} (${keys.join(',')}) VALUES (${placeholders.join(',')}) RETURNING *`,
      values
    );
    return { data: result.rows[0] as T, error: null };
  }

  // Implement remaining IDatabaseProvider methods...
}
```

### 2.3 Storage — Supabase → S3

Create `src/providers/storage/s3-storage.provider.ts`:
```typescript
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { IStorageProvider } from './storage.interface';

export class S3StorageProvider implements IStorageProvider {
  private client: S3Client;

  constructor(region: string) {
    this.client = new S3Client({ region });
  }

  async upload(bucket: string, path: string, file: File) {
    await this.client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: path,
      Body: Buffer.from(await file.arrayBuffer()),
      ContentType: file.type,
    }));
    return { success: true, data: { url: this.getPublicUrl(bucket, path) } };
  }

  getPublicUrl(bucket: string, path: string): string {
    return `https://${bucket}.s3.amazonaws.com/${path}`;
  }

  // Implement remaining IStorageProvider methods...
}
```

### 2.4 Payments — Mock → Stripe

Create `src/providers/payment/stripe-payment.provider.ts`:
```typescript
import type { IPaymentProvider, PaymentIntent } from './payment.interface';

export class StripePaymentProvider implements IPaymentProvider {
  async createPaymentIntent(params) {
    // Call your backend which uses Stripe SDK
    const response = await fetch('/api/payments/create-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return await response.json();
  }
  // Implement remaining methods...
}
```

### 2.5 Notifications — Mock → SNS + SES

```typescript
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import type { INotificationProvider, NotificationPayload } from './notification.interface';

export class AWSNotificationProvider implements INotificationProvider {
  async send(payload: NotificationPayload) {
    for (const channel of payload.channels) {
      switch (channel) {
        case 'email': await this.sendEmail(payload); break;
        case 'sms': await this.sendSMS(payload); break;
        case 'push': await this.sendPush(payload); break;
      }
    }
    return { success: true };
  }
}
```

---

## Phase 3: Edge Functions → API Server (Day 4-5)

### 3.1 Create Express Server

```bash
mkdir -p server/src/routes
```

Convert each edge function to an Express route:

```typescript
// server/src/routes/onboarding-chat.ts
import { Router } from 'express';
import OpenAI from 'openai';

const router = Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

router.post('/api/onboarding-chat', async (req, res) => {
  const { messages, profile, displayLang } = req.body;
  // Same logic as supabase/functions/onboarding-chat/index.ts
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [...],
  });
  res.json(response);
});

export default router;
```

### 3.2 Update Frontend API Calls

Update `src/config/environment.ts`:
```typescript
apiBaseUrl: process.env.VITE_API_URL || 'http://localhost:3001',
```

The LLM provider now calls your own API instead of Supabase functions.

---

## Phase 4: Deploy (Day 5-7)

### Frontend — S3 + CloudFront
```bash
npm run build
aws s3 sync dist/ s3://instaserve-frontend --delete
aws cloudfront create-invalidation --distribution-id $DIST_ID --paths "/*"
```

### Backend — ECS Fargate
```bash
docker build -t instaserve-api .
aws ecr get-login-password | docker login --username AWS --password-stdin $ECR_URL
docker push $ECR_URL/instaserve-api:latest
# Deploy via ECS task definition
```

---

## Environment Variables (Production)

```bash
# .env.production
DATABASE_URL=postgres://user:pass@rds-endpoint:5432/instaserve
REDIS_URL=redis://elasticache-endpoint:6379
S3_BUCKET=instaserve-uploads
COGNITO_POOL_ID=ap-south-1_xxxxxx
COGNITO_CLIENT_ID=xxxxxxxxxx
STRIPE_SECRET_KEY=sk_live_xxxxxx
OPENAI_API_KEY=sk-xxxxxx
OPENSEARCH_ENDPOINT=https://search-instaserve.ap-south-1.es.amazonaws.com
```

---

## Checklist

- [ ] RDS PostgreSQL provisioned and schema applied
- [ ] S3 buckets created with CORS configured
- [ ] Cognito User Pool created with app client
- [ ] ElastiCache Redis cluster running
- [ ] OpenSearch domain created and indices mapped
- [ ] Auth provider swapped in `providers.ts`
- [ ] Database provider swapped in `providers.ts`
- [ ] Storage provider swapped in `providers.ts`
- [ ] Payment provider swapped (Stripe connected)
- [ ] Notification provider swapped (SES/SNS)
- [ ] Edge functions converted to Express routes
- [ ] Frontend deployed to S3 + CloudFront
- [ ] Backend deployed to ECS Fargate
- [ ] DNS configured
- [ ] SSL certificates provisioned
- [ ] Health checks and monitoring configured
