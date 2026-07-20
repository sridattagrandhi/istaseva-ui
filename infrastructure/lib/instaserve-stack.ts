import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import { Construct } from 'constructs';

interface InstaServeStackProps extends cdk.StackProps {
  stage: string;
  /**
   * ARN of the CloudFront-scoped WAFv2 WebACL (created in us-east-1 by
   * WafStack). Optional so existing local synth/test paths still work
   * without a WAF; production/staging always pass it.
   */
  edgeWebAclArn?: string;
}

export class InstaServeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InstaServeStackProps) {
    super(scope, id, props);

    const { stage } = props;
    const isProd = stage === 'production';

    // ACM certificate for istaseva.com — issued in us-east-1 (required for CloudFront).
    // The cert ARN is the same for both staging and production since it covers *.istaseva.com.
    const CERT_ARN = 'arn:aws:acm:us-east-1:591446362332:certificate/3c5db6a0-a206-45df-ba41-84bd84fdca97';
    const certificate = acm.Certificate.fromCertificateArn(this, 'SiteCert', CERT_ARN);

    // SEC-004 (TLS origin leg): the CloudFront→ALB hop needs its own cert in
    // THIS region (the us-east-1 one above can only attach to CloudFront).
    // Same names, DNS-validated — the ACM validation CNAME for istaseva.com
    // already lives in Namecheap (region-independent), so this cert issues
    // without any new DNS records. The ALB is reached via a dedicated origin
    // subdomain because ACM cannot issue certs for *.elb.amazonaws.com.
    const originDomain = isProd ? 'origin.istaseva.com' : 'origin-staging.istaseva.com';
    const originCert = new acm.Certificate(this, 'OriginCert', {
      domainName: 'istaseva.com',
      subjectAlternativeNames: ['*.istaseva.com'],
      validation: acm.CertificateValidation.fromDns(),
    });

    // Domain aliases — staging uses a subdomain, production uses the apex
    const domainNames = isProd
      ? ['istaseva.com', 'www.istaseva.com']
      : ['staging.istaseva.com'];

    // Placeholder — CloudFront domain is added after the distribution is created
    const corsOriginsList: string[] = isProd
      ? ['https://istaseva.com', 'https://www.istaseva.com', 'http://localhost:8080']
      : ['https://staging.istaseva.com', 'http://localhost:8080'];
    const uploadCorsOrigins = cdk.Lazy.list({ produce: () => corsOriginsList });

    // ════════════════════════════════════════════
    // VPC
    // ════════════════════════════════════════════
    const vpc = new ec2.Vpc(this, 'VPC', {
      maxAzs: isProd ? 3 : 2,
      natGateways: isProd ? 2 : 1,
      subnetConfiguration: [
        { name: 'Public',   subnetType: ec2.SubnetType.PUBLIC,             cidrMask: 24 },
        { name: 'Private',  subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED,   cidrMask: 24 },
      ],
    });

    // ════════════════════════════════════════════
    // VPC Endpoints — keep traffic inside AWS network
    // Gateway endpoints are free; interface endpoints have hourly cost.
    // ════════════════════════════════════════════

    // Gateway endpoints (free — route-table-based, no SG needed). Kept on both
    // stages: no per-hour charge, and they cover S3 + DynamoDB, the two highest
    // -volume AWS services this app talks to.
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    vpc.addGatewayEndpoint('DynamoDBEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // Interface endpoints (used by ECS tasks running in private subnets).
    // PRODUCTION ONLY — each endpoint bills per-hour per-AZ (~$0.011/hr × ENIs),
    // so with 4 endpoints across 2 AZs staging was paying ~$58/mo to keep
    // Secrets Manager / ECR / CloudWatch Logs traffic on the AWS backbone.
    // Staging already has a NAT gateway (natGateways: 1), so those calls reach
    // the same AWS public endpoints through NAT instead — a bit of NAT data
    // processing in exchange for dropping the hourly endpoint fees. Prod keeps
    // the endpoints (backbone traffic + higher volume justify the cost).
    if (isProd) {
      // Shared SG for all interface endpoints: allow HTTPS from private subnets
      const vpcEndpointSg = new ec2.SecurityGroup(this, 'VpcEndpointSG', {
        vpc,
        description: 'Allow HTTPS from private subnets to VPC interface endpoints',
      });
      vpc.privateSubnets.forEach((subnet) => {
        vpcEndpointSg.addIngressRule(
          ec2.Peer.ipv4(subnet.ipv4CidrBlock),
          ec2.Port.tcp(443),
          'HTTPS from private subnet',
        );
      });

      const privateSubnets = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };

      vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        securityGroups: [vpcEndpointSg],
        subnets: privateSubnets,
      });
      vpc.addInterfaceEndpoint('EcrApiEndpoint', {
        service: ec2.InterfaceVpcEndpointAwsService.ECR,
        securityGroups: [vpcEndpointSg],
        subnets: privateSubnets,
      });
      vpc.addInterfaceEndpoint('EcrDkrEndpoint', {
        service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
        securityGroups: [vpcEndpointSg],
        subnets: privateSubnets,
      });
      vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
        service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
        securityGroups: [vpcEndpointSg],
        subnets: privateSubnets,
      });
    }

    // ════════════════════════════════════════════
    // Security Groups
    // ════════════════════════════════════════════
    // apiSg is attached to the ECS tasks. CDK's ApplicationLoadBalancedFargateService
    // creates its own ALB security group internally and auto-wires ALB → task ingress
    // on the container port, so we don't need to add that rule manually.
    const apiSg    = new ec2.SecurityGroup(this, 'ApiSG',      { vpc, description: 'API server (ECS tasks)' });
    const dbSg     = new ec2.SecurityGroup(this, 'DatabaseSG', { vpc, description: 'PostgreSQL' });
    const redisSg  = new ec2.SecurityGroup(this, 'RedisSG',    { vpc, description: 'Redis' });

    dbSg.addIngressRule(apiSg,    ec2.Port.tcp(5432), 'API to PostgreSQL');
    redisSg.addIngressRule(apiSg, ec2.Port.tcp(6379), 'API to Redis');

    // ════════════════════════════════════════════
    // Secrets Manager — all credentials live here
    // ════════════════════════════════════════════

    // Database credentials (auto-rotatable RDS secret)
    // CDK populates: username, password, engine, host, port, dbname
    const dbSecret = new secretsmanager.Secret(this, 'DBSecret', {
      secretName: `instaserve/${stage}/database`,
      description: 'RDS PostgreSQL credentials (auto-managed)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'instaserve_admin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    // Application secrets — populate these in the AWS console before first deploy.
    // See DEPLOYMENT.md for the full list of required keys.
    const appSecret = new secretsmanager.Secret(this, 'AppSecret', {
      secretName: `instaserve/${stage}/app`,
      description: 'Application secrets: JWT, Razorpay, LLM API keys, etc. Populate before deploy.',
      secretObjectValue: {
        JWT_SECRET:                    cdk.SecretValue.unsafePlainText('REPLACE_ME_WITH_32_CHAR_MIN_SECRET'),
        FIREBASE_SERVICE_ACCOUNT_JSON: cdk.SecretValue.unsafePlainText('REPLACE_ME_WITH_FIREBASE_SA_JSON'),
        RAZORPAY_KEY_ID:               cdk.SecretValue.unsafePlainText('REPLACE_ME'),
        RAZORPAY_KEY_SECRET:           cdk.SecretValue.unsafePlainText('REPLACE_ME'),
        RAZORPAY_WEBHOOK_SECRET:       cdk.SecretValue.unsafePlainText('REPLACE_ME'),
        OPENAI_API_KEY:                cdk.SecretValue.unsafePlainText('REPLACE_ME'),
        ANTHROPIC_API_KEY:             cdk.SecretValue.unsafePlainText('REPLACE_ME'),
        // Gemini (text + Live voice) and Google TTS all auth via
        // GEMINI_VERTEX_SA_JSON — no per-service API keys. Rotate once,
        // rotate everywhere.
      },
    });

    // ════════════════════════════════════════════
    // Database — RDS PostgreSQL
    // ════════════════════════════════════════════
    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_15 }),
      instanceType: isProd
        ? ec2.InstanceType.of(ec2.InstanceClass.R6G, ec2.InstanceSize.LARGE)
        // Staging holds a tiny dataset (~tens of MB) and serves a single task,
        // so 2 GB RAM (t4g.small) is ample — t4g.medium's 4 GB was idle spend.
        : ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      // Use our pre-created secret so we control its name/path
      credentials: rds.Credentials.fromSecret(dbSecret),
      databaseName: 'instaserve',
      allocatedStorage: isProd ? 100 : 20,
      maxAllocatedStorage: isProd ? 500 : 50,
      multiAz: isProd,
      backupRetention: cdk.Duration.days(isProd ? 30 : 7),
      deletionProtection: isProd,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      storageEncrypted: true,
      monitoringInterval: isProd ? cdk.Duration.seconds(60) : undefined,
    });

    // Read replica for production
    if (isProd) {
      new rds.DatabaseInstanceReadReplica(this, 'DatabaseReadReplica', {
        sourceDatabaseInstance: database,
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.R6G, ec2.InstanceSize.LARGE),
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [dbSg],
      });
    }

    // ════════════════════════════════════════════
    // RDS Proxy — connection pooler in front of Postgres (production only)
    // ════════════════════════════════════════════
    // Fargate tasks each hold their own pg pool. Without a pooler, every
    // scale-out multiplies the connection count and will saturate RDS long
    // before we hit CPU/memory limits. The proxy multiplexes thousands of
    // client connections onto a small pool of backend connections.
    //
    // Staging runs a single task (desiredCount 1) that never autoscales, so
    // there's only ever one pg pool — nothing to multiplex — and the proxy
    // earns nothing while billing ~$22/mo. So it's prod-only: staging connects
    // straight to the instance (the apiSg → dbSg:5432 ingress rule above
    // already permits that path). `dbHost` captures whichever endpoint the app
    // should point DB_HOST at.
    //
    // Auth: uses the same dbSecret. The proxy's IAM role is granted
    // GetSecretValue on that secret. App-side, we just point DB_HOST at the
    // resolved endpoint — same username/password flow otherwise.
    let dbHost: string;
    if (isProd) {
      const dbProxySg = new ec2.SecurityGroup(this, 'DatabaseProxySG', {
        vpc,
        description: 'RDS Proxy - accepts connections from API tasks, forwards to RDS',
      });
      // Tasks → proxy
      dbProxySg.addIngressRule(apiSg, ec2.Port.tcp(5432), 'API to RDS Proxy');
      // Proxy → DB
      dbSg.addIngressRule(dbProxySg, ec2.Port.tcp(5432), 'RDS Proxy to PostgreSQL');

      const dbProxy = new rds.DatabaseProxy(this, 'DatabaseProxy', {
        proxyTarget: rds.ProxyTarget.fromInstance(database),
        secrets: [dbSecret],
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [dbProxySg],
        // TLS between app ↔ proxy. App already sets ssl.rejectUnauthorized=false.
        requireTLS: true,
        // Transaction-level pinning — safe default for pg + transactions.
        idleClientTimeout: cdk.Duration.minutes(30),
        // Large backend pool for the autoscaling production fleet.
        maxConnectionsPercent: 90,
        maxIdleConnectionsPercent: 50,
        debugLogging: false,
      });
      dbHost = dbProxy.endpoint;
    } else {
      // Staging: no proxy — the app talks to the RDS instance directly.
      dbHost = database.instanceEndpoint.hostname;
    }

    // ════════════════════════════════════════════
    // Cache — ElastiCache Redis
    // ════════════════════════════════════════════
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Redis subnet group',
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });

    // AUTH token (ENG-007/SEC-009). ElastiCache constraints: 16-128 chars,
    // no '@', '"' or '/'. excludePunctuation keeps it alphanumeric-only.
    // Injected into the task as an ECS secret (REDIS_AUTH_TOKEN), never a
    // plain env var; the CFN template only carries a dynamic reference.
    const redisAuthSecret = new secretsmanager.Secret(this, 'RedisAuthSecret', {
      secretName: `instaserve/${stage}/redis`,
      description: 'ElastiCache Redis AUTH token',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'authToken',
        excludePunctuation: true,
        passwordLength: 64,
      },
    });

    // ENG-007/SEC-009: replication group (not CfnCacheCluster) so we get
    // TLS in transit, encryption at rest, AUTH, snapshots, and — in prod —
    // a replica with automatic Multi-AZ failover. Staging stays single-node
    // for cost but keeps the full encryption/auth posture so the app config
    // is identical across environments.
    //
    // NOTE: swapping the resource type replaces the cache (data loss is fine
    // — everything in Redis is a TTL'd cache/lock/ticket) and changes the
    // endpoint, which flows to the task env automatically on deploy.
    // The construct id must NOT be 'Redis' — CloudFormation refuses to change
    // a resource's type under an existing logical id, so the replication
    // group needs a fresh id (old CacheCluster gets deleted in the same update).
    const redisReplicationGroupId = `instaserve-${stage}-redis`;
    const redis = new elasticache.CfnReplicationGroup(this, 'RedisRg', {
      replicationGroupId: redisReplicationGroupId,
      replicationGroupDescription: 'IstaSeva cache / locks / rate limits / WS fanout',
      engine: 'redis',
      engineVersion: '7.1',
      cacheNodeType: isProd ? 'cache.r6g.large' : 'cache.t4g.micro',
      // Prod: primary + 1 replica, automatic failover across AZs.
      // Staging: single member (failover needs >= 2, so both flags stay off).
      numCacheClusters: isProd ? 2 : 1,
      automaticFailoverEnabled: isProd,
      multiAzEnabled: isProd,
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true,
      authToken: redisAuthSecret.secretValueFromJson('authToken').unsafeUnwrap(),
      snapshotRetentionLimit: isProd ? 7 : 1,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      securityGroupIds: [redisSg.securityGroupId],
      port: 6379,
    });
    // Member clusters are `<replicationGroupId>-001[, -002]` — the CloudWatch
    // alarms/dashboard below key on the -001 member (always exists; after a
    // prod failover the roles swap but both members keep reporting).
    const redisPrimaryMemberId = `${redisReplicationGroupId}-001`;

    // ════════════════════════════════════════════
    // Event Store — DynamoDB (6 tables, on-demand billing)
    // ════════════════════════════════════════════
    const retainPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    const auditEventsTable = new dynamodb.Table(this, 'AuditEventsTable', {
      tableName: `instaserve-${stage}-audit-events`,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'userId',  type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'sortKey', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: retainPolicy,
    });
    auditEventsTable.addGlobalSecondaryIndex({
      indexName: 'resource-index',
      partitionKey: { name: 'resourceKey', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'timestamp',   type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const fraudSignalsTable = new dynamodb.Table(this, 'FraudSignalsTable', {
      tableName: `instaserve-${stage}-fraud-signals`,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'userId',  type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'sortKey', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: retainPolicy,
    });
    fraudSignalsTable.addGlobalSecondaryIndex({
      indexName: 'risk-level-index',
      partitionKey: { name: 'riskLevel', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const apiRequestLogsTable = new dynamodb.Table(this, 'ApiRequestLogsTable', {
      tableName: `instaserve-${stage}-api-request-logs`,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'date',    type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'sortKey', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: retainPolicy,
    });

    const searchEventsTable = new dynamodb.Table(this, 'SearchEventsTable', {
      tableName: `instaserve-${stage}-search-events`,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'userId',  type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'sortKey', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: retainPolicy,
    });

    // Append-only behavioural analytics events (listing views, clicks, funnel
    // steps, logins). Partitioned by userId/deviceId for per-user reads; the
    // `date-index` GSI lets the nightly rollup scan one calendar day at a time.
    const analyticsEventsTable = new dynamodb.Table(this, 'AnalyticsEventsTable', {
      tableName: `instaserve-${stage}-analytics-events`,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'userId',  type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'sortKey', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: retainPolicy,
    });
    analyticsEventsTable.addGlobalSecondaryIndex({
      indexName: 'date-index',
      partitionKey: { name: 'date',    type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'sortKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const communicationLogsTable = new dynamodb.Table(this, 'CommunicationLogsTable', {
      tableName: `instaserve-${stage}-communication-logs`,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'userId',  type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'sortKey', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: retainPolicy,
    });

    const recommendationSignalsTable = new dynamodb.Table(this, 'RecommendationSignalsTable', {
      tableName: `instaserve-${stage}-recommendation-signals`,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'userId',  type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'sortKey', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: retainPolicy,
    });
    recommendationSignalsTable.addGlobalSecondaryIndex({
      indexName: 'signal-type-index',
      partitionKey: { name: 'signalType', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'timestamp',  type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ════════════════════════════════════════════
    // Storage — S3 Buckets
    // ════════════════════════════════════════════

    // ── CERT-In log store (LEG-004 / LEG-007 / PRIV-004) ──────────────────
    // The CERT-In Directions (28 Apr 2022) require ICT system logs to be
    // retained for a rolling 180 days within Indian jurisdiction. This bucket
    // (in the stack region, ap-south-1) receives VPC flow logs, ALB access
    // logs, CloudFront access logs and CloudTrail, with a 400-day lifecycle
    // (comfortably above the 180-day floor). Object ACLs stay enabled
    // (BUCKET_OWNER_PREFERRED) because CloudFront/ALB legacy log delivery
    // writes with ACLs.
    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      bucketName: `instaserve-access-logs-${stage}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      enforceSSL: true,
      lifecycleRules: [{
        expiration: cdk.Duration.days(400), // >= 180-day CERT-In floor + ops buffer
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
      }],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    // VPC flow logs — network telemetry for incident forensics (CERT-In).
    vpc.addFlowLog('VpcFlowLogs', {
      destination: ec2.FlowLogDestination.toS3(accessLogsBucket, 'vpc-flow-logs/'),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // CloudTrail — API/management audit trail, multi-region, integrity-validated.
    new cloudtrail.Trail(this, 'AuditTrail', {
      bucket: accessLogsBucket,
      s3KeyPrefix: 'cloudtrail',
      isMultiRegionTrail: true,
      enableFileValidation: true,
    });

    const uploadsBucket = new s3.Bucket(this, 'UploadsBucket', {
      bucketName: `instaserve-uploads-${stage}`,
      cors: [{
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
        allowedOrigins: uploadCorsOrigins,
        allowedHeaders: ['*'],
        maxAge: 3600,
      }],
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: isProd,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      // Retention (PRIV-004): current objects live with the account (account
      // deletion purges them); noncurrent versions must not linger — without
      // this rule, "deleted" bytes survive forever on the versioned prod
      // bucket. See docs/DATA-RETENTION.md.
      lifecycleRules: [{
        noncurrentVersionExpiration: cdk.Duration.days(30),
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
      }],
    });

    const verificationBucket = new s3.Bucket(this, 'VerificationBucket', {
      bucketName: `instaserve-verification-${stage}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: isProd,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      // KYC documents: 365-day cap on current objects AND 30-day cleanup of
      // noncurrent versions — previously old versions outlived the 365-day
      // rule indefinitely on the versioned prod bucket (LEG-013).
      lifecycleRules: [{
        expiration: cdk.Duration.days(365),
        noncurrentVersionExpiration: cdk.Duration.days(30),
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
      }],
    });

    // Listings images/videos — presigned URLs, same CORS as uploads
    const listingsBucket = new s3.Bucket(this, 'ListingsBucket', {
      bucketName: `instaserve-listings-${stage}`,
      cors: [{
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
        allowedOrigins: uploadCorsOrigins,
        allowedHeaders: ['*'],
        maxAge: 3600,
      }],
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: isProd,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      // Listing media lives with the listing; only reap stale versions.
      lifecycleRules: [{
        noncurrentVersionExpiration: cdk.Duration.days(30),
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
      }],
    });

    // Chat media attachments
    const chatMediaBucket = new s3.Bucket(this, 'ChatMediaBucket', {
      bucketName: `instaserve-chat-media-${stage}`,
      cors: [{
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
        allowedOrigins: uploadCorsOrigins,
        allowedHeaders: ['*'],
        maxAge: 3600,
      }],
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: cdk.Duration.days(7) }],
    });

    // Generated reports and exports
    const reportsBucket = new s3.Bucket(this, 'ReportsBucket', {
      bucketName: `instaserve-reports-${stage}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }], // auto-expire old reports
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    // DB backups and data exports
    const backupsBucket = new s3.Bucket(this, 'BackupsBucket', {
      bucketName: `instaserve-backups-${stage}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true, // always keep backup versions
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      // Backups previously accumulated forever (PRIV-004): cap at 180 days,
      // reap noncurrent versions after 30. RDS point-in-time recovery covers
      // the short-term restore window independently of this bucket.
      lifecycleRules: [{
        expiration: cdk.Duration.days(180),
        noncurrentVersionExpiration: cdk.Duration.days(30),
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
      }],
    });

    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `instaserve-frontend-${stage}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // ════════════════════════════════════════════
    // Media CDN — CloudFront in front of listings + uploads + chat buckets
    // URL format: https://<mediaCdn>/<s3-key>  (no bucket name in path)
    // The CDN URL is stored directly — no path rewriting needed.
    // Default origin covers listings (properties/*, listings/*).
    // Uploads bucket is a secondary origin served via /uploads/* prefix.
    // ════════════════════════════════════════════
    const mediaCdn = new cloudfront.Distribution(this, 'MediaCDN', {
      defaultBehavior: {
        // Covers listing photos (keys like properties/... and listings/...)
        origin: origins.S3BucketOrigin.withOriginAccessControl(listingsBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        // User uploads (avatars, general uploads) — stored under uploads/ prefix
        '/uploads/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(uploadsBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        // Chat attachments — stored under chat/ prefix
        '/chat/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(chatMediaBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
      },
      // CERT-In access logging (LEG-004): media request logs → 400-day store.
      logBucket: accessLogsBucket,
      logFilePrefix: 'cloudfront/media/',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    });

    // ════════════════════════════════════════════
    // CDN — CloudFront with Origin Access Control
    // ════════════════════════════════════════════
    // SPA routing via a CloudFront Function on the S3 (frontend) behavior ONLY.
    // This replaces the distribution-wide 403/404 → index.html error responses,
    // which were global and therefore also rewrote /api/* error statuses to
    // 200 + index.html — masking real API errors (404/403) from API clients.
    // Attached only to the default (S3) behavior; /api/* and /ws/* have their
    // own behaviors, so their responses now pass through untouched. Uses
    // indexOf (not includes/startsWith) for portability across CF-Function runtimes.
    const spaRoutingFunction = new cloudfront.Function(this, 'SpaRouting', {
      comment: 'SPA fallback: rewrite extensionless client routes to /index.html',
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var request = event.request;',
          '  var uri = request.uri;',
          "  if (uri.indexOf('.') !== -1 || uri.indexOf('/api/') === 0 || uri.indexOf('/ws/') === 0) {",
          '    return request;',
          '  }',
          "  request.uri = '/index.html';",
          '  return request;',
          '}',
        ].join('\n'),
      ),
    });

    // ── Security response headers (SEC-010) ─────────────────────────────────
    // The SPA document is served from S3 via CloudFront's DEFAULT behavior,
    // bypassing Express/helmet entirely — so the pages a browser actually loads
    // had none of these headers. Attach a ResponseHeadersPolicy to that
    // behavior (the /api, /health, /ws* behaviors below keep helmet's headers
    // from the origin, so this is intentionally scoped to the frontend).
    //
    // HSTS / frame / referrer / content-type are enforced immediately (safe).
    // CSP ships REPORT-ONLY first: a wrong enforcing policy would break Razorpay
    // checkout, Firebase auth, and Google Maps. Review violation reports from
    // staging, tighten, then promote to an enforcing `Content-Security-Policy`
    // (move it into securityHeadersBehavior.contentSecurityPolicy).
    const cspReportOnly = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' https://fonts.gstatic.com data:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "script-src 'self' https://checkout.razorpay.com https://*.razorpay.com https://apis.google.com https://www.gstatic.com https://www.google.com https://maps.googleapis.com",
      // cartocdn: apex serves the MapLibre style.json, tiles.<sub> serves
      // tiles/sprites/fonts — CSP wildcards don't match the bare apex, so
      // BOTH are required.
      "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.razorpay.com https://api.mixpanel.com https://maps.googleapis.com https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com https://nominatim.openstreetmap.org https://*.cloudfront.net wss://*.istaseva.com wss://*.cloudfront.net",
      "frame-src 'self' https://razorpay.com https://*.razorpay.com https://checkout.razorpay.com https://*.firebaseapp.com https://*.google.com",
      "worker-src 'self' blob:",
      "form-action 'self'",
      "upgrade-insecure-requests",
    ].join('; ');

    const frontendSecurityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'FrontendSecurityHeaders', {
      responseHeadersPolicyName: `instaserve-${stage}-frontend-security`,
      comment: 'SEC-010: HSTS/frame/referrer/content-type/permissions enforced; CSP report-only',
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          // preload deliberately OFF — submitting to the HSTS preload list is a
          // hard-to-reverse commitment; enable once the domain is prod-stable.
          preload: false,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          // Not covered by securityHeadersBehavior. Allow the capabilities the
          // app actually uses (mic = voice assistant, geolocation = "near me")
          // and DELEGATE payment to the Razorpay checkout iframe — `payment=(self)`
          // alone denies the cross-origin Razorpay frame the Payment Request API
          // (GPay/Apple Pay tokenization), which a real checkout surfaced. Razorpay's
          // accelerometer/device-motion fraud sensors are deliberately left blocked
          // (they only feed its risk engine; not delegating powerful motion sensors
          // to a third party is the safer default). Deny everything else.
          {
            header: 'Permissions-Policy',
            value: 'camera=(), microphone=(self), geolocation=(self), payment=(self "https://checkout.razorpay.com"), usb=(), fullscreen=(self)',
            override: true,
          },
          { header: 'Content-Security-Policy-Report-Only', value: cspReportOnly, override: true },
        ],
      },
    });

    const distribution = new cloudfront.Distribution(this, 'CDN', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: frontendSecurityHeaders,
        functionAssociations: [
          {
            function: spaRoutingFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      defaultRootObject: 'index.html',
      // Edge WAF — managed rule sets + IP-keyed rate limits. ARN comes from
      // the us-east-1 WafStack via cross-region references.
      webAclId: props.edgeWebAclArn,
      // CERT-In access logging (LEG-004): edge request logs → 400-day store.
      logBucket: accessLogsBucket,
      logFilePrefix: 'cloudfront/frontend/',
      // Custom domain + SSL cert
      domainNames,
      certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    });

    // Add CloudFront domain to S3 CORS origins (resolved via cdk.Lazy above)
    corsOriginsList.push(`https://${distribution.distributionDomainName}`);

    // ════════════════════════════════════════════
    // Search — Postgres full-text search (no separate infrastructure).
    // Search queries hit the RDS Postgres instance via the `postgres` search
    // provider (see server/src/common/providers/implementations/search/
    // postgres-search.provider.ts). If volume grows, add pg_trgm + a tsvector
    // GIN index, then consider Meilisearch/Typesense or Algolia.
    // ════════════════════════════════════════════

    // ════════════════════════════════════════════
    // Messaging — SQS + SNS
    // ════════════════════════════════════════════
    const notificationDLQ = new sqs.Queue(this, 'NotificationDLQ', {
      queueName: `instaserve-notifications-dlq-${stage}`,
      retentionPeriod: cdk.Duration.days(14),
    });

    const notificationQueue = new sqs.Queue(this, 'NotificationQueue', {
      queueName: `instaserve-notifications-${stage}`,
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(7),
      deadLetterQueue: {
        queue: notificationDLQ,
        maxReceiveCount: 3,
      },
    });

    // (Removed) bookingEventsTopic — was an SNS topic intended to fan out
    // booking lifecycle events, but no code ever published to it and
    // nothing subscribed. Notifications are delivered via the in-process
    // notificationsService → SQS worker path instead (see
    // bookings.service.ts and notification-worker.service.ts). If we ever
    // need true pub/sub fan-out to external subscribers (analytics, audit
    // log, third-party webhooks), add it back here with at least one real
    // publisher and subscriber.

    // ════════════════════════════════════════════
    // Compute — ECS Fargate (API Server)
    // ════════════════════════════════════════════
    const apiLogGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: `/instaserve/${stage}/api`,
      // CERT-In (LEG-004): app logs must be retained >= 180 days on prod.
      // Staging gets a month — enough to debug, cheap to keep.
      retention: isProd ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: isProd
        ? ecs.ContainerInsights.ENABLED
        : ecs.ContainerInsights.DISABLED,
    });

    const apiService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'ApiService', {
      cluster,
      securityGroups: [apiSg],
      loadBalancerName: `instaserve-${stage}`,
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset('../server', {
          platform: ecr_assets.Platform.LINUX_AMD64,
        }),
        containerPort: 3001,
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: 'api',
          logGroup: apiLogGroup,
        }),
        // ── Non-sensitive configuration as plain env vars ─────────────────
        environment: {
          NODE_ENV:                            isProd ? 'production' : 'development',
          APP_ENV:                             stage, // staging | production — used for logging/config context
          PORT:                                '3001',
          FRONTEND_URL:                        isProd ? 'https://istaseva.com' : 'https://staging.istaseva.com',
          API_URL:                             isProd ? 'https://istaseva.com' : 'https://staging.istaseva.com',
          AWS_REGION:                          this.region,

          // DB host: the RDS Proxy endpoint in prod, the raw RDS instance
          // endpoint in staging (no proxy there). The pg pool uses the same
          // dbSecret credentials (username/password) either way, so only the
          // host differs. See the RDS Proxy block above for the rationale.
          DB_HOST:                             dbHost,

          // Provider selection
          AUTH_PROVIDER:                       'firebase',
          DATABASE_PROVIDER:                   'postgres',
          CACHE_PROVIDER:                      'redis',
          STORAGE_PROVIDER:                    's3',
          // CDK context override: deploy with `--context paymentProvider=mock`
          // to short-circuit Razorpay for end-to-end booking tests. Defaults
          // to razorpay so production / normal deploys are unaffected.
          PAYMENT_PROVIDER:                    (this.node.tryGetContext('paymentProvider') as string) || 'razorpay',
          // Backend config gate (see server/src/common/config/index.ts):
          // mock payments on staging require this explicit opt-in. We pass
          // it through only when the operator also set `paymentProvider=mock`
          // so leaving the flag set won't auto-degrade a razorpay deploy.
          PAYMENT_ALLOW_MOCK_IN_DEPLOY:        this.node.tryGetContext('paymentProvider') === 'mock' ? 'true' : 'false',
          NOTIFICATION_PROVIDER:               'default',
          // Postgres full-text search (tsvector + ILIKE fallback) lives on
          // the RDS instance — see postgres-search.provider.ts.
          SEARCH_PROVIDER:                     'postgres',
          KYC_PROVIDER:                        'mock',
          // Geocoding: Google Maps Geocoding API. Best India coverage. Browser
          // never sees the key — the frontend calls /api/geocode which proxies
          // through here. Falls back to Nominatim if GOOGLE_MAPS_API_KEY is
          // unset (handy for local dev without a key).
          GEOCODING_PROVIDER:                  'google',
          LLM_PROVIDER:                        'gemini',
          // gemini-2.0-flash was retired ("no longer available to new users")
          // on the generativelanguage endpoint. Back to 2.5-flash — tone is
          // shaped by the banned-phrase rules in the assistant system prompt
          // rather than the model alone.
          LLM_MODEL:                           'gemini-2.5-flash',
          TTS_PROVIDER:                        'google',
          GOOGLE_TTS_VOICE_MODEL:              'Neural2',
          EVENT_PROVIDER:                      'dynamodb',

          // Auth — Firebase project ID (non-sensitive)
          FIREBASE_PROJECT_ID:                 'istasewa-93903',

          // Cache — Redis host/port (URL constructed by server from DB_* vars, see config/index.ts)
          REDIS_HOST:                          redis.attrPrimaryEndPointAddress,
          REDIS_PORT:                          redis.attrPrimaryEndPointPort,
          REDIS_TLS:                           'true',
          REDIS_KEY_PREFIX:                    `instaserve-${stage}`,

          // Storage — S3
          S3_BUCKET_UPLOADS:                   uploadsBucket.bucketName,
          S3_BUCKET_VERIFICATION:              verificationBucket.bucketName,
          S3_BUCKET_LISTINGS:                  listingsBucket.bucketName,
          S3_BUCKET_CHAT:                      chatMediaBucket.bucketName,
          S3_BUCKET_REPORTS:                   reportsBucket.bucketName,
          S3_BUCKET_BACKUPS:                   backupsBucket.bucketName,
          S3_PREFIX_LISTINGS:                  'listings/',
          S3_PREFIX_CLAIMS:                    'claims/',
          S3_PREFIX_CHAT:                      'chat/',
          S3_PREFIX_VERIFICATION:              'verification/',

          // Notifications
          SES_FROM_EMAIL:                      'noreply@istaseva.com',
          // SMTP — when SMTP_HOST is set the notifications module routes
          // through nodemailer instead of the SES SDK. Used in staging
          // while SES is in sandbox; remove once SES production access
          // is granted and prod is happy on the SES path.
          SMTP_HOST:                           'smtp.gmail.com',
          SMTP_PORT:                           '465',
          SMTP_SECURE:                         'true',
          SMTP_USER:                           'istasewa@gmail.com',
          SMTP_FROM_EMAIL:                     'istasewa@gmail.com',
          SNS_SMS_SENDER_ID:                   'InstaServe',
          SQS_NOTIFICATION_QUEUE_URL:          notificationQueue.queueUrl,

          // Events — DynamoDB tables
          DYNAMODB_AUDIT_EVENTS_TABLE:         auditEventsTable.tableName,
          DYNAMODB_FRAUD_SIGNALS_TABLE:        fraudSignalsTable.tableName,
          DYNAMODB_API_REQUEST_LOGS_TABLE:     apiRequestLogsTable.tableName,
          DYNAMODB_SEARCH_EVENTS_TABLE:        searchEventsTable.tableName,
          DYNAMODB_ANALYTICS_EVENTS_TABLE:     analyticsEventsTable.tableName,
          DYNAMODB_COMMUNICATION_LOGS_TABLE:   communicationLogsTable.tableName,
          DYNAMODB_RECOMMENDATION_SIGNALS_TABLE: recommendationSignalsTable.tableName,

          LOG_LEVEL: isProd ? 'info' : 'debug',

          // Image moderation (NSFW gate for listing photos). Staging runs the
          // model as a sidecar in this task (added below), so the API reaches
          // it on localhost. Prod leaves this unset → gate is a no-op there
          // until we deploy the sidecar to prod too. Fail-open by default
          // (IMAGE_MODERATION_FAIL_CLOSED unset); see image-moderation.service.ts.
          ...(isProd ? {} : { IMAGE_MODERATION_URL: 'http://localhost:8501' }),

          // ─── AI agent feature flags ───
          // All default to '0' in code so an unconfigured environment
          // boots into the legacy single-shot chat path. Staging gets
          // the full agent stack turned on; production rollout follows
          // once staging proves stable.
          //
          // Keep these aligned with server/src/common/config/schemas/
          // llm.schema.ts — adding a new flag there means adding it here
          // too, otherwise the staging task will run with the default.
          ASSISTANT_TOOL_LOOP:       '1',
          ASSISTANT_MAX_TOOL_TURNS:  '6',
          ONBOARDING_AGENT:          '1',
          ASSISTANT_MEMORY:          '1',
          ASSISTANT_GROUNDING:       '1',
          ASSISTANT_SPECULATIVE:     '1',
          ASSISTANT_CHIPS:           '1',
          // Gemini Live model — native-audio dialog is the only one with
          // good Indian-language voice quality; the default in code is
          // a half-cascade GA model which sounds robotic. Pinning the
          // preview model here keeps voice quality consistent across
          // deploys until Live API ships its GA replacement.
          GEMINI_LIVE_MODEL:         'gemini-live-2.5-flash-native-audio',
        },
        // ── Sensitive values pulled from Secrets Manager at task startup ──
        secrets: {
          // DB connection — RDS populates port/dbname/username/password into dbSecret.
          // DB_HOST is set in `environment` above (RDS Proxy in prod, raw
          // instance in staging); port/name/creds come from the secret here.
          DB_PORT:     ecs.Secret.fromSecretsManager(dbSecret, 'port'),
          DB_NAME:     ecs.Secret.fromSecretsManager(dbSecret, 'dbname'),
          DB_USER:     ecs.Secret.fromSecretsManager(dbSecret, 'username'),
          DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),

          // Redis AUTH (ENG-007/SEC-009) — paired with REDIS_TLS=true above.
          REDIS_AUTH_TOKEN: ecs.Secret.fromSecretsManager(redisAuthSecret, 'authToken'),

          // App secrets
          JWT_SECRET:                    ecs.Secret.fromSecretsManager(appSecret, 'JWT_SECRET'),
          FIREBASE_SERVICE_ACCOUNT_JSON: ecs.Secret.fromSecretsManager(appSecret, 'FIREBASE_SERVICE_ACCOUNT_JSON'),
          RAZORPAY_KEY_ID:               ecs.Secret.fromSecretsManager(appSecret, 'RAZORPAY_KEY_ID'),
          RAZORPAY_KEY_SECRET:           ecs.Secret.fromSecretsManager(appSecret, 'RAZORPAY_KEY_SECRET'),
          RAZORPAY_WEBHOOK_SECRET:       ecs.Secret.fromSecretsManager(appSecret, 'RAZORPAY_WEBHOOK_SECRET'),
          // Vertex AI — SA + project + region. Used for ALL Gemini calls
          // (text chat, Live voice) AND Google Cloud TTS. Single credential
          // for every Google API the app talks to. Keeping the JSON in
          // Secrets Manager (not as a file mount) so rotations are a
          // one-line put-secret-value, no redeploy needed beyond the normal
          // ECS task recycle for env refresh.
          GEMINI_VERTEX_SA_JSON:         ecs.Secret.fromSecretsManager(appSecret, 'GEMINI_VERTEX_SA_JSON'),
          GEMINI_VERTEX_PROJECT:         ecs.Secret.fromSecretsManager(appSecret, 'GEMINI_VERTEX_PROJECT'),
          GEMINI_VERTEX_LOCATION:        ecs.Secret.fromSecretsManager(appSecret, 'GEMINI_VERTEX_LOCATION'),
          // Google Maps Geocoding API key. Restrict by IP (ECS NAT egress)
          // in Google Cloud Console once the key is rotated to a backend-only
          // key — see DEPLOYMENT.md.
          GOOGLE_MAPS_API_KEY:           ecs.Secret.fromSecretsManager(appSecret, 'GOOGLE_MAPS_API_KEY'),
          // IstaSeva's own GSTIN — printed on every tax invoice. Mock value
          // in staging until we register the entity for real.
          PLATFORM_GSTIN:                ecs.Secret.fromSecretsManager(appSecret, 'PLATFORM_GSTIN'),
          // Gmail App Password for the SMTP transport above. Populated
          // manually in the instaserve/<stage>/app secret — see DEPLOYMENT.md.
          SMTP_PASS:                     ecs.Secret.fromSecretsManager(appSecret, 'SMTP_PASS'),
        },
      },
      // Staging bumped from 256/512 to 512/2048 to fit the image-moderation
      // sidecar (NudeNet + ONNX runtime needs ~1GB). Prod unchanged — it has
      // no sidecar yet. 512 CPU permits 1024-4096 MB memory in Fargate.
      cpu:              isProd ? 1024 : 512,
      memoryLimitMiB:   isProd ? 2048 : 2048,
      desiredCount:     isProd ? 2 : 1,
      // Zero-downtime rollouts on BOTH tiers: keep the current task serving
      // (minHealthy 100) and allow a temporary extra task (maxHealthy 200) so
      // the new revision must pass health checks before the old one drains.
      // Previously staging used minHealthy 0 → the old task drained before the
      // new one was healthy, so a bad image caused a full outage.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // Auto-roll-back a deploy whose new tasks never reach a steady state,
      // instead of draining capacity and hanging until a manual cancel.
      circuitBreaker: { rollback: true },
      publicLoadBalancer: true,
      // SEC-004: don't auto-open the listener to 0.0.0.0/0 — ingress is
      // granted explicitly below, restricted to CloudFront's origin-facing
      // prefix list, so the ALB can't be reached directly from the internet.
      openListener: false,
      assignPublicIp: false,
      // Give the container time to start before health checks begin
      healthCheckGracePeriod: cdk.Duration.seconds(120),
    });

    // ALB target-group health check — must match the server's /health route
    apiService.targetGroup.configureHealthCheck({
      path: '/health',
      healthyHttpCodes: '200',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });

    // ── Image-moderation sidecar (staging only) ──
    // NSFW gate for listing photos. Runs inside the API task, so the server
    // reaches it at http://localhost:8501 — containers in one Fargate task
    // share a network namespace, so no service discovery, ALB target, or SG
    // rule is needed (8501 is never exposed outside the task). Marked
    // non-essential: if it OOMs/crashes, the API task stays up and the gate
    // fails open (see image-moderation.service.ts). NudeNet weights are baked
    // into the image at build time, so it needs no runtime internet egress.
    // Not on prod yet — enabling there is a separate sizing/cost decision
    // (bump the prod task memory and drop the `!isProd` guards).
    if (!isProd) {
      const moderationLogGroup = new logs.LogGroup(this, 'ModerationLogGroup', {
        logGroupName: `/instaserve/${stage}/image-moderation`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      apiService.taskDefinition.addContainer('image-moderation', {
        image: ecs.ContainerImage.fromAsset('../services/image-moderation', {
          platform: ecr_assets.Platform.LINUX_AMD64,
        }),
        essential: false,
        portMappings: [{ containerPort: 8501 }],
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: 'image-moderation',
          logGroup: moderationLogGroup,
        }),
        healthCheck: {
          command: [
            'CMD-SHELL',
            "python -c \"import urllib.request; urllib.request.urlopen('http://localhost:8501/health')\" || exit 1",
          ],
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          retries: 3,
          startPeriod: cdk.Duration.seconds(40),
        },
      });
    }

    // ════════════════════════════════════════════
    // SEC-004: lock the origin to CloudFront so the ALB can't be hit
    // directly (which would bypass the WAF, edge rate limits and TLS).
    // Two independent layers:
    //   1. Network — ALB security group only admits CloudFront's
    //      origin-facing IP ranges (AWS-managed prefix list, auto-updated).
    //   2. Request — CloudFront injects a secret x-origin-verify header;
    //      the listener forwards ONLY when it matches and answers 403
    //      otherwise. This also blocks requests routed through an
    //      attacker-owned CloudFront distribution (which layer 1 admits).
    // ════════════════════════════════════════════

    // Layer 1 — SG ingress from CloudFront's origin-facing prefix list only.
    // (openListener: false above stopped the construct opening 0.0.0.0/0.)
    //
    // Only :443 is opened: CloudFront reaches the origin over HTTPS_ONLY (see
    // albOrigin below), so the HTTP:80 listener needs no inbound path and is
    // left unreachable. This ALSO respects the per-SG rule quota — a managed
    // prefix-list reference counts as the list's max-entries (~55) against the
    // 60-rule limit, so a SECOND prefix-list rule (:80) would blow the quota
    // (ServiceLimitExceeded). One rule = one path = within limits.
    const cloudFrontOriginFacing = ec2.PrefixList.fromLookup(this, 'CloudFrontOriginFacing', {
      prefixListName: 'com.amazonaws.global.cloudfront.origin-facing',
    });
    apiService.loadBalancer.connections.allowFrom(
      ec2.Peer.prefixList(cloudFrontOriginFacing.prefixListId),
      ec2.Port.tcp(443),
      'CloudFront origin-facing ranges only, TLS (SEC-004)',
    );

    // CERT-In access logging (LEG-004): ALB request logs → 400-day store.
    apiService.loadBalancer.logAccessLogs(accessLogsBucket, 'alb');

    // Layer 2 — shared secret between CloudFront and the ALB listener.
    // Generated by Secrets Manager; referenced via CloudFormation dynamic
    // references so the value never lands in the template or in Git. To
    // rotate: put a new secret value, then redeploy (both sides re-resolve).
    const originVerifySecret = new secretsmanager.Secret(this, 'OriginVerifySecret', {
      secretName: `instaserve/${stage}/origin-verify`,
      description: 'Shared secret CloudFront presents to the ALB (x-origin-verify)',
      // Alphanumeric only: ALB header-condition values treat * and ? as
      // wildcards, so keep the secret free of metacharacters.
      generateSecretString: { excludePunctuation: true, includeSpace: false, passwordLength: 48 },
    });

    // Default action: 403 for anything that reaches the listener without the
    // header (i.e. not via our CloudFront distribution).
    const cfnListener = apiService.listener.node.defaultChild as elbv2.CfnListener;
    cfnListener.defaultActions = [{
      type: 'fixed-response',
      fixedResponseConfig: { statusCode: '403', contentType: 'text/plain', messageBody: 'Forbidden' },
    }];
    // Matching header → forward to the API target group. Applies to normal
    // requests AND WebSocket upgrades (/ws, /ws/voice) — CloudFront adds
    // origin custom headers to upgrade requests too.
    apiService.listener.addAction('AllowCloudFrontOnly', {
      priority: 1,
      conditions: [
        elbv2.ListenerCondition.httpHeader('x-origin-verify', [
          originVerifySecret.secretValue.unsafeUnwrap(),
        ]),
      ],
      action: elbv2.ListenerAction.forward([apiService.targetGroup]),
    });

    // TLS origin leg (SEC-004): HTTPS listener CloudFront actually talks to,
    // presenting the regional cert for the origin subdomain. Same gating as
    // the HTTP listener: 403 by default, forward only with the secret header.
    // The HTTP:80 listener above still exists (construct default, gated to 403)
    // but has NO security-group ingress — it's effectively dead. Kept only to
    // avoid a listener-replacement churn on the construct's default listener.
    const httpsListener = apiService.loadBalancer.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [originCert],
      // Don't auto-open 0.0.0.0/0 — the prefix-list ingress above covers :443.
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: 'text/plain',
        messageBody: 'Forbidden',
      }),
    });
    httpsListener.addAction('AllowCloudFrontOnlyTls', {
      priority: 1,
      conditions: [
        elbv2.ListenerCondition.httpHeader('x-origin-verify', [
          originVerifySecret.secretValue.unsafeUnwrap(),
        ]),
      ],
      action: elbv2.ListenerAction.forward([apiService.targetGroup]),
    });

    // ── Route /api/* and /health through CloudFront to the ALB ──
    // This ensures the frontend (HTTPS) can reach the API without mixed-content errors.
    // NOTE: /api/*, /health and /ws* behaviors all share this one origin
    // object, so the x-origin-verify header rides on every ALB-bound path.
    //
    // The origin is the custom subdomain (NOT the raw ALB DNS) over HTTPS —
    // ACM can't issue certs for *.elb.amazonaws.com, so TLS to the origin
    // requires our own hostname. ⚠ DEPLOY ORDER: the Namecheap CNAME
    // (<origin subdomain> → ALB DNS, see OriginDnsRecord output) must resolve
    // BEFORE this origin change deploys, or CloudFront can't reach the API.
    const albOrigin = new origins.HttpOrigin(
      originDomain,
      {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        customHeaders: {
          'x-origin-verify': originVerifySecret.secretValue.unsafeUnwrap(),
        },
      },
    );
    distribution.addBehavior('/api/*', albOrigin, {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
    });
    distribution.addBehavior('/health', albOrigin, {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
    });
    // WebSocket endpoint — the API server upgrades WS connections for
    // realtime messages, notifications, AND Gemini Live voice (which the
    // assistant + onboarding agents use). Pattern is `/ws*` (not bare
    // `/ws`) so it matches BOTH `/ws` (legacy realtime) AND `/ws/voice`
    // (Live voice). Bare `/ws` is a literal match in CloudFront and would
    // fall through to the default S3 origin for the voice subpath — which
    // means the server never sees the upgrade and the client just sees
    // "connection error" on the live-voice pill.
    distribution.addBehavior('/ws*', albOrigin, {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
    });

    // ════════════════════════════════════════════
    // Migration task — runs `node scripts/migrate.js` against the same RDS,
    // using the SAME image as the API container. Invoked post-deploy by CI
    // via `aws ecs run-task` against the outputs below. Idempotent — re-runs
    // are a no-op when no new SQL files are pending.
    // ════════════════════════════════════════════
    const migrationLogGroup = new logs.LogGroup(this, 'MigrationLogs', {
      logGroupName: `/ecs/instaserve-${stage}-migrate`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const migrationTaskDef = new ecs.FargateTaskDefinition(this, 'MigrationTaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
    });
    migrationTaskDef.addContainer('migrate', {
      image: ecs.ContainerImage.fromAsset('../server', {
        platform: ecr_assets.Platform.LINUX_AMD64,
      }),
      command: ['node', 'scripts/migrate.js'],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'migrate',
        logGroup: migrationLogGroup,
      }),
      environment: {
        NODE_ENV: isProd ? 'production' : 'development',
        APP_ENV:  stage,
        AWS_REGION: this.region,
        // Same endpoint the API uses: RDS Proxy in prod, raw instance in
        // staging. CI runs this task with apiSg, which reaches both.
        DB_HOST: dbHost,
      },
      secrets: {
        DB_USER:     ecs.Secret.fromSecretsManager(dbSecret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
        DB_PORT:     ecs.Secret.fromSecretsManager(dbSecret, 'port'),
        DB_NAME:     ecs.Secret.fromSecretsManager(dbSecret, 'dbname'),
        // JWT_SECRET is loaded by server/src/common/config/index.ts during
        // boot — the migrate script imports config indirectly, so we must
        // satisfy the schema even though migrations don't sign tokens.
        JWT_SECRET:  ecs.Secret.fromSecretsManager(appSecret, 'JWT_SECRET'),
      },
    });
    dbSecret.grantRead(migrationTaskDef.taskRole);
    appSecret.grantRead(migrationTaskDef.taskRole);

    new cdk.CfnOutput(this, 'MigrationTaskDefArn', {
      value: migrationTaskDef.taskDefinitionArn,
      description: 'ECS task definition for DB migrations — invoke with aws ecs run-task',
    });
    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: cluster.clusterName,
      description: 'ECS cluster running API + migration tasks',
    });
    new cdk.CfnOutput(this, 'MigrationSubnetIds', {
      value: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(','),
      description: 'Private subnets for the migration task ENI',
    });
    new cdk.CfnOutput(this, 'MigrationSecurityGroupId', {
      value: apiSg.securityGroupId,
      description: 'SG that has DB ingress — reused by the migration task',
    });

    // Auto-scaling
    const scaling = apiService.service.autoScaleTaskCount({
      minCapacity: isProd ? 2 : 1,
      maxCapacity: isProd ? 10 : 2,
    });
    scaling.scaleOnCpuUtilization('CpuScaling',    { targetUtilizationPercent: 70 });
    scaling.scaleOnMemoryUtilization('MemScaling', { targetUtilizationPercent: 80 });

    // ════════════════════════════════════════════
    // IAM — least-privilege grants to ECS task role
    // ════════════════════════════════════════════
    const taskRole = apiService.taskDefinition.taskRole;

    // S3
    uploadsBucket.grantReadWrite(taskRole);
    verificationBucket.grantReadWrite(taskRole);
    listingsBucket.grantReadWrite(taskRole);
    chatMediaBucket.grantReadWrite(taskRole);
    reportsBucket.grantReadWrite(taskRole);
    backupsBucket.grantReadWrite(taskRole);

    // DynamoDB
    auditEventsTable.grantReadWriteData(taskRole);
    fraudSignalsTable.grantReadWriteData(taskRole);
    apiRequestLogsTable.grantReadWriteData(taskRole);
    searchEventsTable.grantReadWriteData(taskRole);
    analyticsEventsTable.grantReadWriteData(taskRole);
    communicationLogsTable.grantReadWriteData(taskRole);
    recommendationSignalsTable.grantReadWriteData(taskRole);

    // SQS / SNS
    notificationQueue.grantSendMessages(taskRole);
    notificationQueue.grantConsumeMessages(taskRole); // worker needs ReceiveMessage + DeleteMessage
    notificationDLQ.grantConsumeMessages(taskRole);   // allow inspecting DLQ

    // Secrets Manager — only the three secrets this service needs
    dbSecret.grantRead(taskRole);
    appSecret.grantRead(taskRole);

    // SES domain identity — verifies istaseva.com for sending.
    // After deploy, add the three DKIM CNAME records shown in SesDkimRecords output to Namecheap.
    const sesIdentity = new ses.EmailIdentity(this, 'SesIdentity', {
      identity: ses.Identity.domain('istaseva.com'),
    });

    // SES — scoped to verified identities only
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'SESTransactional',
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      // SES authorizes SendEmail against BOTH the source (from) identity and
      // each recipient identity. In sandbox mode every recipient email is its
      // own verified identity, so we must allow identity/* here. Post-sandbox,
      // recipients no longer need per-identity authorization — this will still
      // work, and SES will enforce verified-sender checks via the identity
      // policy attached directly to istaseva.com.
      resources: [
        `arn:aws:ses:${this.region}:${this.account}:identity/*`,
      ],
      conditions: {
        StringLike: {
          'ses:FromAddress': ['noreply@istaseva.com', '*@istaseva.com'],
        },
      },
    }));

    // SNS SMS — allows Publish to topics and direct phone numbers
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'SNSSms',
      actions: ['sns:Publish'],
      resources: [
        `arn:aws:sns:${this.region}:${this.account}:*`,
        '*', // required for direct-to-phone-number SMS (no topic ARN)
      ],
    }));

    // Firebase auth runs on Google infrastructure — no AWS IAM policy needed here.

    // ════════════════════════════════════════════
    // Monitoring — CloudWatch Alarms → SNS → Email
    // ════════════════════════════════════════════

    // Alert topic — subscribe your email after first deploy:
    //   aws sns subscribe --topic-arn <AlarmTopicArn output> \
    //     --protocol email --notification-endpoint you@example.com \
    //     --region ap-south-1
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `instaserve-alarms-${stage}`,
      displayName: `InstaServe ${stage} Alarms`,
    });
    const alarmAction = new cw_actions.SnsAction(alarmTopic);

    // ── ECS: running task count drops to 0 ───────────────────────────────────
    new cloudwatch.Alarm(this, 'EcsNoRunningTasks', {
      alarmName: `instaserve-${stage}-ecs-no-running-tasks`,
      alarmDescription: 'ECS service has no running tasks — API is down',
      metric: new cloudwatch.Metric({
        namespace: 'ECS/ContainerInsights',
        metricName: 'RunningTaskCount',
        dimensionsMap: {
          ClusterName: cluster.clusterName,
          ServiceName: apiService.service.serviceName,
        },
        statistic: 'Minimum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }).addAlarmAction(alarmAction);

    // ── ECS: CPU > 85% for 5 min ─────────────────────────────────────────────
    new cloudwatch.Alarm(this, 'EcsHighCpu', {
      alarmName: `instaserve-${stage}-ecs-high-cpu`,
      alarmDescription: 'ECS CPU utilisation > 85% — may need scaling',
      metric: apiService.service.metricCpuUtilization({
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 85,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // ── ECS: Memory > 90% ────────────────────────────────────────────────────
    new cloudwatch.Alarm(this, 'EcsHighMemory', {
      alarmName: `instaserve-${stage}-ecs-high-memory`,
      alarmDescription: 'ECS memory utilisation > 90% — risk of OOM kill',
      metric: apiService.service.metricMemoryUtilization({
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 90,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // ── ALB: 5xx error rate > 5% for 5 min ──────────────────────────────────
    const alb5xxAlarm = new cloudwatch.Alarm(this, 'Alb5xxRate', {
      alarmName: `instaserve-${stage}-alb-5xx-rate`,
      alarmDescription: 'ALB 5xx error rate exceeds 5% — investigate API errors',
      metric: new cloudwatch.MathExpression({
        expression: '100 * errors / MAX([errors, requests])',
        usingMetrics: {
          errors: new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HTTPCode_Target_5XX_Count',
            dimensionsMap: { LoadBalancer: apiService.loadBalancer.loadBalancerFullName },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
          requests: new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'RequestCount',
            dimensionsMap: { LoadBalancer: apiService.loadBalancer.loadBalancerFullName },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
        },
      }),
      threshold: 5,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alb5xxAlarm.addAlarmAction(alarmAction);

    // ── ALB: P99 response latency > 3s ───────────────────────────────────────
    new cloudwatch.Alarm(this, 'AlbHighLatency', {
      alarmName: `instaserve-${stage}-alb-high-latency`,
      alarmDescription: 'ALB P99 response time > 3 s — API is slow',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'TargetResponseTime',
        dimensionsMap: { LoadBalancer: apiService.loadBalancer.loadBalancerFullName },
        statistic: 'p99',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 3,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // ── RDS: CPU > 80% ───────────────────────────────────────────────────────
    new cloudwatch.Alarm(this, 'RdsCpu', {
      alarmName: `instaserve-${stage}-rds-cpu`,
      alarmDescription: 'RDS CPU > 80%',
      metric: database.metricCPUUtilization({
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // ── RDS: Free storage < 2 GB ─────────────────────────────────────────────
    new cloudwatch.Alarm(this, 'RdsLowStorage', {
      alarmName: `instaserve-${stage}-rds-low-storage`,
      alarmDescription: 'RDS free storage < 2 GB — disk is filling up',
      metric: database.metricFreeStorageSpace({
        statistic: 'Minimum',
        period: cdk.Duration.minutes(15),
      }),
      threshold: 2 * 1024 * 1024 * 1024, // 2 GB in bytes
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // ── RDS: DB connections > 80 ─────────────────────────────────────────────
    new cloudwatch.Alarm(this, 'RdsHighConnections', {
      alarmName: `instaserve-${stage}-rds-high-connections`,
      alarmDescription: 'RDS connection count > 80 — connection pool may be exhausted',
      metric: database.metricDatabaseConnections({
        statistic: 'Maximum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // ── Redis: engine CPU > 80% ──────────────────────────────────────────────
    new cloudwatch.Alarm(this, 'RedisHighCpu', {
      alarmName: `instaserve-${stage}-redis-high-cpu`,
      alarmDescription: 'Redis EngineCPUUtilization > 80%',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ElastiCache',
        metricName: 'EngineCPUUtilization',
        dimensionsMap: { CacheClusterId: redisPrimaryMemberId },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // ── Redis: freeable memory < 50 MB ───────────────────────────────────────
    new cloudwatch.Alarm(this, 'RedisLowMemory', {
      alarmName: `instaserve-${stage}-redis-low-memory`,
      alarmDescription: 'Redis freeable memory < 50 MB — consider upgrading instance',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ElastiCache',
        metricName: 'FreeableMemory',
        dimensionsMap: { CacheClusterId: redisPrimaryMemberId },
        statistic: 'Minimum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 50 * 1024 * 1024, // 50 MB in bytes
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // ── SQS: DLQ has messages (failed notifications) ─────────────────────────
    new cloudwatch.Alarm(this, 'NotificationDlqMessages', {
      alarmName: `instaserve-${stage}-notification-dlq-messages`,
      alarmDescription: 'Notification DLQ has messages — some notifications failed permanently',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SQS',
        metricName: 'ApproximateNumberOfMessagesVisible',
        dimensionsMap: { QueueName: notificationDLQ.queueName },
        statistic: 'Maximum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // ── SQS: main queue backlog > 1000 for 10 min (worker falling behind) ────
    new cloudwatch.Alarm(this, 'NotificationQueueBacklog', {
      alarmName: `instaserve-${stage}-notification-queue-backlog`,
      alarmDescription: 'Notification queue depth > 1000 — worker is not keeping up',
      metric: notificationQueue.metricApproximateNumberOfMessagesVisible({
        statistic: 'Maximum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1000,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // ── SQS: oldest message age > 10 min (stuck processing) ─────────────────
    new cloudwatch.Alarm(this, 'NotificationQueueStale', {
      alarmName: `instaserve-${stage}-notification-queue-stale`,
      alarmDescription: 'Notification queue oldest message > 10 min — delivery is delayed',
      metric: notificationQueue.metricApproximateAgeOfOldestMessage({
        statistic: 'Maximum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 600, // seconds
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // ── ALB: unhealthy host count > 0 for 3 min ──────────────────────────────
    // A single unhealthy task for 3 consecutive minutes means we're serving
    // with reduced capacity. Doesn't self-heal without attention.
    new cloudwatch.Alarm(this, 'AlbUnhealthyHosts', {
      alarmName: `instaserve-${stage}-alb-unhealthy-hosts`,
      alarmDescription: 'ALB has unhealthy targets — ECS task failing health checks',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'UnHealthyHostCount',
        dimensionsMap: {
          LoadBalancer: apiService.loadBalancer.loadBalancerFullName,
          TargetGroup: apiService.targetGroup.targetGroupFullName,
        },
        statistic: 'Maximum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // ════════════════════════════════════════════
    // CloudWatch Dashboard — single pane for live ops
    // ════════════════════════════════════════════
    // Consolidates the metrics that alarm above, plus raw request/error
    // counts. The dashboard is named per stage so dev/staging/prod each
    // get their own and don't clobber each other.
    const dashboard = new cloudwatch.Dashboard(this, 'OpsDashboard', {
      dashboardName: `instaserve-${stage}-ops`,
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ALB — Requests & 5xx',
        width: 12,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'RequestCount',
            dimensionsMap: { LoadBalancer: apiService.loadBalancer.loadBalancerFullName },
            statistic: 'Sum',
            period: cdk.Duration.minutes(1),
            label: 'Requests',
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HTTPCode_Target_5XX_Count',
            dimensionsMap: { LoadBalancer: apiService.loadBalancer.loadBalancerFullName },
            statistic: 'Sum',
            period: cdk.Duration.minutes(1),
            label: 'Target 5xx',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HTTPCode_ELB_5XX_Count',
            dimensionsMap: { LoadBalancer: apiService.loadBalancer.loadBalancerFullName },
            statistic: 'Sum',
            period: cdk.Duration.minutes(1),
            label: 'ELB 5xx',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'ALB — Latency (p50/p95/p99)',
        width: 12,
        left: ['p50', 'p95', 'p99'].map(
          (stat) =>
            new cloudwatch.Metric({
              namespace: 'AWS/ApplicationELB',
              metricName: 'TargetResponseTime',
              dimensionsMap: { LoadBalancer: apiService.loadBalancer.loadBalancerFullName },
              statistic: stat,
              period: cdk.Duration.minutes(1),
              label: stat,
            })
        ),
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ECS — CPU & Memory',
        width: 12,
        left: [
          apiService.service.metricCpuUtilization({ period: cdk.Duration.minutes(1), label: 'CPU %' }),
          apiService.service.metricMemoryUtilization({ period: cdk.Duration.minutes(1), label: 'Mem %' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'ECS — Running task count',
        width: 12,
        left: [
          new cloudwatch.Metric({
            namespace: 'ECS/ContainerInsights',
            metricName: 'RunningTaskCount',
            dimensionsMap: {
              ClusterName: cluster.clusterName,
              ServiceName: apiService.service.serviceName,
            },
            statistic: 'Maximum',
            period: cdk.Duration.minutes(1),
          }),
        ],
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'RDS — CPU & Connections',
        width: 12,
        left: [database.metricCPUUtilization({ period: cdk.Duration.minutes(1), label: 'CPU %' })],
        right: [database.metricDatabaseConnections({ period: cdk.Duration.minutes(1), label: 'Connections' })],
      }),
      new cloudwatch.GraphWidget({
        title: 'Redis — CPU & Memory',
        width: 12,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ElastiCache',
            metricName: 'EngineCPUUtilization',
            dimensionsMap: { CacheClusterId: redisPrimaryMemberId },
            statistic: 'Average',
            period: cdk.Duration.minutes(1),
            label: 'CPU %',
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'AWS/ElastiCache',
            metricName: 'FreeableMemory',
            dimensionsMap: { CacheClusterId: redisPrimaryMemberId },
            statistic: 'Minimum',
            period: cdk.Duration.minutes(1),
            label: 'Freeable bytes',
          }),
        ],
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'SQS — Notification queue',
        width: 24,
        left: [
          notificationQueue.metricApproximateNumberOfMessagesVisible({
            period: cdk.Duration.minutes(1),
            label: 'Visible',
          }),
          notificationDLQ.metricApproximateNumberOfMessagesVisible({
            period: cdk.Duration.minutes(1),
            label: 'DLQ visible',
          }),
        ],
        right: [
          notificationQueue.metricApproximateAgeOfOldestMessage({
            period: cdk.Duration.minutes(1),
            label: 'Oldest age (s)',
          }),
        ],
      }),
    );

    // ════════════════════════════════════════════
    // Outputs
    // ════════════════════════════════════════════
    new cdk.CfnOutput(this, 'FrontendURL', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront distribution URL (paste into VITE_APP_URL)',
    });
    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.distributionDomainName,
      description: 'Raw CloudFront domain — add as CNAME target in Namecheap (staging → this value)',
    });
    new cdk.CfnOutput(this, 'MediaCdnUrl', {
      value: `https://${mediaCdn.distributionDomainName}`,
      description: 'Media CDN base URL — set as S3_PUBLIC_BASE_URL in app secrets so listing images load via CDN',
    });
    new cdk.CfnOutput(this, 'ApiURL', {
      value: `http://${apiService.loadBalancer.loadBalancerDnsName}`,
      description: 'ALB DNS (origin only — direct requests get 403 since SEC-004; use the CloudFront domain for VITE_API_URL and all clients/webhooks)',
    });
    new cdk.CfnOutput(this, 'OriginDnsRecord', {
      value: `CNAME ${originDomain.replace('.istaseva.com', '')} -> ${apiService.loadBalancer.loadBalancerDnsName}`,
      description: 'Namecheap record required BEFORE deploying the HTTPS origin (Host = name without .istaseva.com)',
    });
    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: database.instanceEndpoint.hostname,
      description: 'RDS endpoint (run migrations from a bastion or CI/CD)',
    });
    // Proxy exists in prod only; in staging the API/migrations use the raw
    // DatabaseEndpoint above, so there's no proxy endpoint to emit.
    if (isProd) {
      new cdk.CfnOutput(this, 'DatabaseProxyEndpoint', {
        value: dbHost, // in prod, dbHost === the RDS Proxy endpoint
        description: 'RDS Proxy endpoint — the API tasks connect here (pooled)',
      });
    }
    new cdk.CfnOutput(this, 'RedisEndpoint', {
      value: redis.attrPrimaryEndPointAddress,
      description: 'ElastiCache Redis primary endpoint (TLS + AUTH required)',
    });
    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: alarmTopic.topicArn,
      description: 'SNS alarm topic — subscribe your email: aws sns subscribe --topic-arn <arn> --protocol email --notification-endpoint you@example.com --region ap-south-1',
    });
    new cdk.CfnOutput(this, 'AppSecretName', {
      value: `instaserve/${stage}/app`,
      description: 'Secrets Manager secret name — populate FIREBASE_SERVICE_ACCOUNT_JSON here',
    });
    new cdk.CfnOutput(this, 'UploadsBucketName',      { value: uploadsBucket.bucketName,      description: 'S3 uploads bucket' });
    new cdk.CfnOutput(this, 'ListingsBucketName',     { value: listingsBucket.bucketName,     description: 'S3 listings bucket' });
    new cdk.CfnOutput(this, 'ChatMediaBucketName',    { value: chatMediaBucket.bucketName,    description: 'S3 chat media bucket' });
    new cdk.CfnOutput(this, 'ReportsBucketName',      { value: reportsBucket.bucketName,      description: 'S3 reports bucket' });
    new cdk.CfnOutput(this, 'BackupsBucketName',      { value: backupsBucket.bucketName,      description: 'S3 backups bucket' });
    new cdk.CfnOutput(this, 'FrontendBucketName',     { value: frontendBucket.bucketName,     description: 'S3 frontend bucket — deploy Vite build here' });
    new cdk.CfnOutput(this, 'DBSecretArn', {
      value: dbSecret.secretArn,
      description: 'Secrets Manager ARN for RDS credentials',
    });
    new cdk.CfnOutput(this, 'AppSecretArn', {
      value: appSecret.secretArn,
      description: 'Secrets Manager ARN for app secrets (JWT, Razorpay, LLM keys)',
    });
    new cdk.CfnOutput(this, 'NotificationQueueUrl', {
      value: notificationQueue.queueUrl,
      description: 'SQS notification queue URL',
    });

    // SES DKIM records — add all three as CNAME records in Namecheap after deploy.
    // Format: Host = <name> (without .istaseva.com), Value = <value>
    new cdk.CfnOutput(this, 'SesDkimRecord1', {
      value: sesIdentity.dkimRecords[0].name,
      description: 'SES DKIM CNAME Host 1 — add to Namecheap DNS',
    });
    new cdk.CfnOutput(this, 'SesDkimValue1', {
      value: sesIdentity.dkimRecords[0].value,
      description: 'SES DKIM CNAME Value 1',
    });
    new cdk.CfnOutput(this, 'SesDkimRecord2', {
      value: sesIdentity.dkimRecords[1].name,
      description: 'SES DKIM CNAME Host 2 — add to Namecheap DNS',
    });
    new cdk.CfnOutput(this, 'SesDkimValue2', {
      value: sesIdentity.dkimRecords[1].value,
      description: 'SES DKIM CNAME Value 2',
    });
    new cdk.CfnOutput(this, 'SesDkimRecord3', {
      value: sesIdentity.dkimRecords[2].name,
      description: 'SES DKIM CNAME Host 3 — add to Namecheap DNS',
    });
    new cdk.CfnOutput(this, 'SesDkimValue3', {
      value: sesIdentity.dkimRecords[2].value,
      description: 'SES DKIM CNAME Value 3',
    });
  }
}
