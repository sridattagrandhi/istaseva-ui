# Scaling Path: MVP → 1 Million Users

**Current state: Phase 2 is complete.** The app runs on a dedicated Express API with RDS PostgreSQL, ElastiCache Redis, and ECS Fargate. Phase 1 below is kept as history; Phase 3 onward is the forward-looking plan.

## Phase 1: MVP (0-1K users) — completed, no longer the architecture

- **Architecture**: Client-side React + Supabase (managed PostgreSQL + edge functions)
- **Suitable for**: Validating product-market fit, early users, iterating fast
- **Bottleneck**: Supabase connection limits, edge function cold starts — the reasons for moving to Phase 2

## Phase 2: Dedicated Backend (1K-10K users) — completed

### What changed
- Exported the codebase from Lovable
- Built the Express API server (`server/`)
- Reduced the frontend provider registry to auth/realtime/analytics; everything else moved behind the API
- Moved the edge functions to API routes (`/api/smart-schedule`, `/api/onboarding-chat`, `/api/supply-optimization`)
- Added Redis for caching (availability slots, pricing configs)
- Added job queue for async work (notifications, KYC verification)

### Infrastructure
```
React SPA → API Gateway → Express Server → PostgreSQL (RDS)
                                         → Redis (ElastiCache)
                                         → S3 (file storage)
```

## Phase 3: Service Separation (10K-100K users)

### Extract these first (highest traffic/latency sensitivity)
1. **Chat Service** → Dedicated WebSocket server (Socket.io / AWS AppSync)
2. **Search Service** → OpenSearch cluster with listing/provider indices
3. **Notification Service** → SQS + Lambda workers for email/SMS/push

### Keep together (transactional consistency)
- Auth + Users + Profiles
- Bookings + Payments + Guarantees
- Listings + Availability

### Infrastructure
```
React SPA → CloudFront CDN
           → ALB → API Server (ECS Fargate)
                    → PostgreSQL (RDS Multi-AZ)
                    → Redis Cluster
           → WebSocket Server (for chat)
           → OpenSearch (for discovery)
           → SQS → Lambda (notifications)
           → S3 (storage)
```

## Phase 4: Full Scale (100K-1M users)

### Database
- Read replicas for search/listing queries
- Connection pooling (PgBouncer)
- Table partitioning for bookings/messages (by date)
- Consider DynamoDB for high-write tables (audit logs, fraud events)

### Compute
- Auto-scaling ECS/EKS clusters
- Regional deployment (Mumbai primary, Chennai/Hyderabad secondary)
- API rate limiting and throttling

### Caching
- Redis cluster with read replicas
- CDN caching for listing images and static assets
- Application-level caching for pricing configs

### Search & Discovery
- OpenSearch with dedicated data/master nodes
- Geo-distance queries for "near me" features
- ML-powered ranking (personalization, demand-supply matching)

### AI/ML Pipeline
- Fraud scoring model (SageMaker)
- Dynamic pricing optimization
- Provider recommendation engine
- Demand forecasting for supply optimization

### Observability
- Distributed tracing (X-Ray / Jaeger)
- Centralized logging (CloudWatch / ELK)
- Real-time dashboards (Grafana)
- Alerting (PagerDuty)

## Cost Estimates (India region, ap-south-1)

| Phase | Monthly Est. |
|-------|-------------|
| Phase 1 (MVP, Supabase-era) | $25-50 |
| Phase 2 (Basic AWS) | $200-500 |
| Phase 3 (Multi-service) | $1,000-3,000 |
| Phase 4 (Full scale) | $5,000-15,000 |
