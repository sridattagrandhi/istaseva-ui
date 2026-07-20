import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

interface WafStackProps extends cdk.StackProps {
  stage: string;
  /**
   * If true, rate-based rules are deployed in COUNT mode — they tag matching
   * requests in CloudWatch metrics but do not block. Use this for the first
   * ~1 week in any new environment so we can pick thresholds from real
   * traffic data instead of guessing. Flip to false (BLOCK) once the metrics
   * look right.
   */
  countMode?: boolean;
}

/**
 * Edge WAF for the public CloudFront distribution. Lives in us-east-1 because
 * AWS requires CLOUDFRONT-scoped WebACLs in that region. The stack is wired
 * to InstaServeStack via cross-region references; the consumer attaches the
 * ARN to its `cloudfront.Distribution` via `webAclId`.
 *
 * Layered defense:
 *   1. AWSManagedRulesCommonRuleSet  — generic OWASP-style protections
 *   2. AWSManagedRulesKnownBadInputsRuleSet — blocks known exploit patterns
 *   3. AWSManagedRulesAmazonIpReputationList — blocks AWS-flagged abusive IPs
 *   4. RateBasedStatement on /api/auth/*       — credential-stuffing brake
 *   5. RateBasedStatement on the rest of /api/* — volumetric abuse brake
 *
 * App-layer per-user limits live in server/src/app/create-app.ts and run on
 * top of these. WAF cannot read our JWTs, so it can only key on IP.
 */
export class WafStack extends cdk.Stack {
  readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: WafStackProps) {
    super(scope, id, props);

    const { stage, countMode = false } = props;
    const action: wafv2.CfnWebACL.RuleActionProperty = countMode
      ? { count: {} }
      : { block: {} };

    const webAcl = new wafv2.CfnWebACL(this, 'EdgeWebAcl', {
      name: `instaserve-edge-${stage}`,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `instaserve-edge-${stage}`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWSManagedCommonRuleSet',
          priority: 0,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              // Exclude file-upload endpoints from CRS body inspection.
              // CRS's SizeRestrictions_BODY rule blocks any body > 8KB and
              // CrossSiteScripting_BODY / GenericRFI_BODY scan binary bytes,
              // both of which reject legitimate PNG/PDF uploads via
              // /api/storage/upload (verification docs, listing photos,
              // chat attachments). Other paths still get full CRS coverage.
              scopeDownStatement: {
                notStatement: {
                  statement: {
                    orStatement: {
                      statements: [
                        {
                          byteMatchStatement: {
                            fieldToMatch: { uriPath: {} },
                            positionalConstraint: 'STARTS_WITH',
                            searchString: '/api/storage/upload',
                            textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                          },
                        },
                        {
                          byteMatchStatement: {
                            fieldToMatch: { uriPath: {} },
                            positionalConstraint: 'STARTS_WITH',
                            searchString: '/api/storage/local-upload/',
                            textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedCommonRuleSet',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedKnownBadInputs',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedKnownBadInputs',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedAmazonIpReputation',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAmazonIpReputationList',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedAmazonIpReputation',
            sampledRequestsEnabled: true,
          },
        },
        // Auth path — much stricter, IP-keyed. WAF rate windows are fixed at
        // 5 minutes, so 50 = 10 attempts/min sustained from one IP.
        {
          name: 'AuthRateLimit',
          priority: 10,
          action,
          statement: {
            rateBasedStatement: {
              limit: 50,
              aggregateKeyType: 'IP',
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'STARTS_WITH',
                  searchString: '/api/auth/',
                  textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AuthRateLimit',
            sampledRequestsEnabled: true,
          },
        },
        // General API path — 2000 req / 5min ≈ 6.6 rps sustained per IP.
        // Real users behind CGNAT can share an IP, so this is intentionally
        // generous. Tighten only after watching CloudWatch for false
        // positives.
        {
          name: 'ApiRateLimit',
          priority: 11,
          action,
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'STARTS_WITH',
                  searchString: '/api/',
                  textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'ApiRateLimit',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    this.webAclArn = webAcl.attrArn;

    // ── WAF logging (LEG-004 / CERT-In) ───────────────────────────────────
    // CLOUDFRONT-scoped WebACLs log from us-east-1, and the destination
    // bucket must live in this region and be named `aws-waf-logs-*`.
    // Retention mirrors the main access-logs bucket (400d >= 180d floor).
    const wafLogsBucket = new s3.Bucket(this, 'WafLogsBucket', {
      bucketName: `aws-waf-logs-instaserve-${stage}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(400) }],
      removalPolicy: stage === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: stage !== 'production',
    });

    const loggingConfig = new wafv2.CfnLoggingConfiguration(this, 'EdgeWafLogging', {
      resourceArn: webAcl.attrArn,
      logDestinationConfigs: [wafLogsBucket.bucketArn],
      // Never log credential-bearing headers.
      redactedFields: [
        { singleHeader: { Name: 'authorization' } },
        { singleHeader: { Name: 'cookie' } },
      ],
    });
    loggingConfig.node.addDependency(wafLogsBucket);

    new cdk.CfnOutput(this, 'WebAclArn', {
      value: this.webAclArn,
      exportName: `instaserve-edge-${stage}-waf-arn`,
    });
  }
}
