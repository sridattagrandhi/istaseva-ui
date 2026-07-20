#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { InstaServeStack } from '../lib/instaserve-stack';
import { WafStack } from '../lib/waf-stack';

const app = new cdk.App();

const env = app.node.tryGetContext('env') || 'staging';
const region = app.node.tryGetContext('region') || 'ap-south-1';

// Hard-pin accounts per stage so a misconfigured AWS_PROFILE can't
// silently deploy to the wrong AWS account. Override via context if you
// ever need to bootstrap a new environment: `cdk deploy -c account=...`.
const ACCOUNTS: Record<string, string> = {
  staging: '591446362332',
  // production: '...', // add when prod account is provisioned
};

const account = app.node.tryGetContext('account') || ACCOUNTS[env];
if (!account) {
  throw new Error(`No AWS account pinned for env="${env}". Add it to bin/app.ts or pass -c account=...`);
}

const callerAccount = process.env.CDK_DEFAULT_ACCOUNT;
if (callerAccount && callerAccount !== account) {
  throw new Error(
    `Refusing to deploy: env="${env}" targets account ${account}, but the current AWS credentials are for ${callerAccount}. ` +
    `Export AWS_PROFILE=instaserve (or the correct profile) and retry.`
  );
}

// CloudFront-scoped WAF must live in us-east-1. We expose its ARN to the
// main stack via cross-region references (CDK will synthesize the SSM glue).
// First deploy any new env in COUNT mode (`-c wafCount=true`) so we can
// observe metrics for ~1 week before flipping to BLOCK.
const countMode = app.node.tryGetContext('wafCount') === 'true' || env !== 'production';
const wafStack = new WafStack(app, `InstaServe-${env}-Waf`, {
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true,
  stage: env,
  countMode,
});

const mainStack = new InstaServeStack(app, `InstaServe-${env}`, {
  env: { account, region },
  crossRegionReferences: true,
  stage: env,
  edgeWebAclArn: wafStack.webAclArn,
});
mainStack.addDependency(wafStack);
