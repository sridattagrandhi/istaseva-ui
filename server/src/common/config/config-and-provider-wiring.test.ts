// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('configuration and provider wiring', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  it('loads validated config for local development defaults', async () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'test-secret';
    process.env.DATABASE_URL = 'postgres://instaserve:instaserve_dev@localhost:5432/instaserve';
    process.env.S3_BUCKET_UPLOADS = 'uploads';
    process.env.S3_BUCKET_VERIFICATION = 'verification';
    process.env.S3_BUCKET_FRONTEND = 'frontend';
    process.env.S3_BUCKET_CLAIMS = 'claims';
    process.env.S3_BUCKET_CHAT = 'chat';
    process.env.S3_BUCKET_LISTINGS = 'listings';
    process.env.S3_PREFIX_LISTINGS = 'listings/';
    process.env.S3_PREFIX_CLAIMS = 'claims/';
    process.env.S3_PREFIX_CHAT = 'chat/';
    process.env.S3_PREFIX_VERIFICATION = 'verification/';
    process.env.S3_PRESIGNED_UPLOAD_EXPIRY_SECONDS = '300';
    process.env.S3_PRESIGNED_DOWNLOAD_EXPIRY_SECONDS = '300';

    const { config } = await import('./index.js');

    expect(config.app.nodeEnv).toBe('development');
    expect(config.auth.jwt.secret).toBe('test-secret');
    expect(config.storage.bucketUploads).toBe('uploads');
    expect(config.storage.bucketClaims).toBe('claims');
    expect(config.storage.prefixListings).toBe('listings/');
  });

  it('blocks mock providers in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_PROVIDER = 'mock';
    process.env.JWT_SECRET = 'prod-secret';
    process.env.DATABASE_URL = 'postgres://instaserve:instaserve_dev@localhost:5432/instaserve';
    process.env.S3_BUCKET_UPLOADS = 'uploads';
    process.env.S3_BUCKET_VERIFICATION = 'verification';
    process.env.S3_BUCKET_FRONTEND = 'frontend';
    process.env.S3_BUCKET_CLAIMS = 'claims';
    process.env.S3_BUCKET_CHAT = 'chat';
    process.env.S3_BUCKET_LISTINGS = 'listings';
    process.env.S3_PREFIX_LISTINGS = 'listings/';
    process.env.S3_PREFIX_CLAIMS = 'claims/';
    process.env.S3_PREFIX_CHAT = 'chat/';
    process.env.S3_PREFIX_VERIFICATION = 'verification/';
    process.env.S3_PRESIGNED_UPLOAD_EXPIRY_SECONDS = '300';
    process.env.S3_PRESIGNED_DOWNLOAD_EXPIRY_SECONDS = '300';

    await expect(import('./index.js')).rejects.toThrow(/Mock providers are blocked in production/);
  });

  it('wires the payment provider through the registry', async () => {
    // Use test mode so the webhook-secret requirement (deployed-env-only) is
    // skipped — this test is about the provider switch, not webhook config.
    process.env.NODE_ENV = 'test';
    process.env.PAYMENT_PROVIDER = 'razorpay';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_123';
    process.env.RAZORPAY_KEY_SECRET = 'secret';
    process.env.JWT_SECRET = 'test-secret';
    process.env.DATABASE_URL = 'postgres://instaserve:instaserve_dev@localhost:5432/instaserve';
    process.env.S3_BUCKET_UPLOADS = 'uploads';
    process.env.S3_BUCKET_VERIFICATION = 'verification';
    process.env.S3_BUCKET_FRONTEND = 'frontend';
    process.env.S3_BUCKET_CLAIMS = 'claims';
    process.env.S3_BUCKET_CHAT = 'chat';
    process.env.S3_BUCKET_LISTINGS = 'listings';
    process.env.S3_PREFIX_LISTINGS = 'listings/';
    process.env.S3_PREFIX_CLAIMS = 'claims/';
    process.env.S3_PREFIX_CHAT = 'chat/';
    process.env.S3_PREFIX_VERIFICATION = 'verification/';
    process.env.S3_PRESIGNED_UPLOAD_EXPIRY_SECONDS = '300';
    process.env.S3_PRESIGNED_DOWNLOAD_EXPIRY_SECONDS = '300';

    const { getPaymentProvider } = await import('../providers/registry.js');
    const provider = await getPaymentProvider();

    expect(typeof provider.createOrder).toBe('function');
    expect(typeof provider.verifySignature).toBe('function');
  });
});
