export interface PaymentOrderRequest {
  bookingId: string;
  userId: string;
  amountPaise: number;
  currency: 'INR' | 'USD';
  insurancePremium: number;
}

export interface PaymentOrderResponse {
  orderId: string;
  orderData: unknown;
  keyId: string;
}

export interface PaymentRefundRequest {
  paymentId: string;
  amountPaise: number;
  notes?: Record<string, string>;
}

export interface PaymentRefundResponse {
  refundId: string;
  refundData: unknown;
}

/** A refund already recorded at the gateway for a payment. Used as an
 *  idempotency pre-check before creating a new refund. */
export interface FetchedRefund {
  refundId: string;
  amountPaise: number;
  notes?: Record<string, string>;
  raw?: unknown;
}

/**
 * Future implementations:
 * - Razorpay
 * - Stripe
 * - Cashfree / custom gateway
 */
export interface FetchedPayment {
  id: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed' | string;
  raw?: unknown;
}

export interface PaymentCaptureRequest {
  paymentId: string;
  amountPaise: number;
  currency: string;
}

export interface PaymentLinkRequest {
  bookingId: string;
  amountPaise: number;
  currency: 'INR' | 'USD';
  description: string;
  customer: { name?: string | null; contact: string; email?: string | null };
  /** Where Razorpay redirects the guest after they pay. */
  callbackUrl?: string;
  /** Unix epoch (seconds) after which the link stops accepting payment.
   *  Should match the booking hold's expiry — a link that outlives the hold
   *  can collect money for a booking that no longer exists. */
  expireByEpochSec?: number;
}

export interface PaymentLinkResponse {
  /** Razorpay payment-link id (plink_...). Persisted on the booking. */
  id: string;
  /** Short public URL the guest opens to pay. Also the QR payload. */
  shortUrl: string;
  raw?: unknown;
}

export interface IPaymentProvider {
  createOrder(params: PaymentOrderRequest): Promise<PaymentOrderResponse>;
  verifySignature(orderId: string, paymentId: string, signature: string): boolean;
  refundPayment(params: PaymentRefundRequest): Promise<PaymentRefundResponse>;
  fetchPayment?(paymentId: string): Promise<FetchedPayment>;
  capturePayment?(params: PaymentCaptureRequest): Promise<FetchedPayment>;
  /** Create a shareable/QR payment link. Optional so gateways without link
   *  support (or older adapters) still satisfy the interface. */
  createPaymentLink?(params: PaymentLinkRequest): Promise<PaymentLinkResponse>;
  /** Stop an unpaid payment link from accepting money (host cancelled the
   *  pending booking). Best-effort; implementations should swallow
   *  already-paid/already-cancelled errors. */
  cancelPaymentLink?(linkId: string): Promise<void>;
  /** List refunds the gateway already holds for a payment — the idempotency
   *  pre-check for refundCompletedBooking. Implementations return [] on
   *  lookup failure (callers then proceed to create, same as before). */
  fetchRefundsForPayment?(paymentId: string): Promise<FetchedRefund[]>;
}
