// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const mockConfig = {
  app: { nodeEnv: 'test' },
  payment: {
    provider: 'razorpay' as 'razorpay' | 'mock' | 'stripe',
    razorpay: { keyId: 'rzp_test', keySecret: 'secret', webhookSecret: 'wh' },
  },
};

vi.mock('../config/index.js', () => ({ config: mockConfig }));

vi.mock('../../modules/payments/adapters/razorpay.adapter.js', () => ({
  razorpayAdapter: { __kind: 'razorpay' },
}));

vi.mock('./implementations/payment/mock-payment.provider.js', () => ({
  mockPaymentProvider: { __kind: 'mock' },
}));

describe('provider registry — payment wiring', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('returns the Razorpay adapter when PAYMENT_PROVIDER=razorpay', async () => {
    mockConfig.payment.provider = 'razorpay';
    const { getPaymentProvider } = await import('./registry.js');
    const provider = await getPaymentProvider();
    expect((provider as any).__kind).toBe('razorpay');
  });

  it('returns the mock provider when PAYMENT_PROVIDER=mock', async () => {
    mockConfig.payment.provider = 'mock';
    const { getPaymentProvider } = await import('./registry.js');
    const provider = await getPaymentProvider();
    expect((provider as any).__kind).toBe('mock');
  });

  it('throws loudly on unsupported payment providers', async () => {
    mockConfig.payment.provider = 'stripe';
    const { getPaymentProvider } = await import('./registry.js');
    await expect(getPaymentProvider()).rejects.toThrow(/Unsupported payment provider/);
  });
});
