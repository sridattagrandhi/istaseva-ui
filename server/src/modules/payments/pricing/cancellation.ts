/**
 * Cancellation refund computation.
 *
 * Current product rule: any paid booking cancellation gets a full refund.
 *
 * We keep the policy/timing inputs in the function signature because the
 * rest of the booking flow already passes them and because stricter policies
 * may come back later. For now, though, no cancellation fee is retained.
 */

export type CancellationPolicy = 'flexible' | 'moderate' | 'strict';
export type CancelledBy = 'guest' | 'host' | 'platform';

export interface PaymentBreakdown {
  /** ORIGINAL host portion (pre-discount). Display uses this. */
  subtotalPaise: number;
  platformFeePaise: number;
  taxesPaise: number;
  insurancePremiumPaise: number;
  /** Coupon discount in paise (0 when no coupon was applied). */
  discountPaise: number;
  /** Full charged amount = (subtotal − discount) + platformFee + taxes + insurance. */
  totalPaise: number;
}

export interface CancellationRefund {
  refundPaise: number;
  hostKeepsPaise: number;
  platformKeepsPaise: number;
  insuranceRefundedPaise: number;
  insuranceVoided: boolean;
  policy: CancellationPolicy;
  cancelledBy: CancelledBy;
  /** Human-readable reason — surfaced to the user on the cancel-preview card. */
  reason: string;
  /** Fraction (0..1) of the SUBTOTAL refunded. Useful for tests + audit. */
  subtotalRefundRate: number;
}

export function computeCancellationRefund(params: {
  breakdown: PaymentBreakdown;
  policy: CancellationPolicy;
  cancelledBy: CancelledBy;
  /** ISO timestamp for the booking's scheduled start (date + start_time). */
  scheduledStartIso: string;
  /** ISO timestamp of the cancellation request — usually `new Date().toISOString()`. */
  cancelledAtIso: string;
}): CancellationRefund {
  const { breakdown, policy, cancelledBy } = params;

  return {
    refundPaise: breakdown.totalPaise,
    hostKeepsPaise: 0,
    platformKeepsPaise: 0,
    insuranceRefundedPaise: breakdown.insurancePremiumPaise,
    insuranceVoided: false,
    policy,
    cancelledBy,
    reason: 'Full refund for cancellation.',
    subtotalRefundRate: 1,
  };
}
