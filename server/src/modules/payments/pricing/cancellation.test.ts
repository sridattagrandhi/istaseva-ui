// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { computeCancellationRefund, type PaymentBreakdown } from './cancellation.js';

const breakdown: PaymentBreakdown = {
  subtotalPaise: 100_000,    // ₹1000 host portion
  platformFeePaise: 10_000,  // ₹100 IstaSeva 10%
  taxesPaise: 13_200,        // ~12% on 110000
  insurancePremiumPaise: 2_000,
  discountPaise: 0,
  totalPaise: 125_200,
};

const start = '2026-06-01T18:00:00Z';

describe('computeCancellationRefund', () => {
  it('refunds 100% for guest cancellations regardless of policy or timing', () => {
    const r = computeCancellationRefund({
      breakdown,
      policy: 'strict',
      cancelledBy: 'guest',
      scheduledStartIso: start,
      cancelledAtIso: '2026-06-01T17:00:00Z', // 1h before start
    });
    expect(r.refundPaise).toBe(125_200);
    expect(r.subtotalRefundRate).toBe(1);
    expect(r.insuranceVoided).toBe(false);
    expect(r.insuranceRefundedPaise).toBe(2_000);
    expect(r.platformKeepsPaise).toBe(0);
    expect(r.hostKeepsPaise).toBe(0);
  });

  it('refunds 100% for guest cancellations after the scheduled start', () => {
    const r = computeCancellationRefund({
      breakdown,
      policy: 'moderate',
      cancelledBy: 'guest',
      scheduledStartIso: start,
      cancelledAtIso: '2026-06-02T18:00:00Z', // 24h after
    });
    expect(r.refundPaise).toBe(125_200);
    expect(r.platformKeepsPaise).toBe(0);
    expect(r.insuranceVoided).toBe(false);
    expect(r.insuranceRefundedPaise).toBe(2_000);
  });

  it('refunds 100% for host cancellations', () => {
    const r = computeCancellationRefund({
      breakdown,
      policy: 'strict',
      cancelledBy: 'host',
      scheduledStartIso: start,
      cancelledAtIso: '2026-06-01T17:30:00Z',
    });
    expect(r.refundPaise).toBe(125_200);
    expect(r.platformKeepsPaise).toBe(0);
    expect(r.insuranceVoided).toBe(false);
  });

  it('refunds 100% for platform cancellations', () => {
    const r = computeCancellationRefund({
      breakdown,
      policy: 'strict',
      cancelledBy: 'platform',
      scheduledStartIso: start,
      cancelledAtIso: '2026-06-01T17:30:00Z',
    });
    expect(r.refundPaise).toBe(125_200);
    expect(r.platformKeepsPaise).toBe(0);
    expect(r.insuranceVoided).toBe(false);
  });

  it('refunds exactly the charged total when a coupon was applied', () => {
    const r = computeCancellationRefund({
      breakdown: {
        ...breakdown,
        subtotalPaise: 100_000,
        discountPaise: 20_000,
        platformFeePaise: 8_000,
        taxesPaise: 10_560,
        insurancePremiumPaise: 0,
        totalPaise: 98_560,
      },
      policy: 'flexible',
      cancelledBy: 'guest',
      scheduledStartIso: start,
      cancelledAtIso: '2026-06-01T17:00:00Z',
    });
    expect(r.refundPaise).toBe(98_560);
    expect(r.hostKeepsPaise).toBe(0);
    expect(r.platformKeepsPaise).toBe(0);
  });
});
