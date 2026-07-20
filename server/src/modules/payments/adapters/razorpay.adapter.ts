import crypto from 'crypto';
import { config } from '../../../common/config/index.js';
import type {
  IPaymentProvider,
  PaymentOrderRequest,
  PaymentRefundRequest,
  PaymentCaptureRequest,
  FetchedPayment,
  FetchedRefund,
  PaymentLinkRequest,
  PaymentLinkResponse,
} from '../../../common/providers/interfaces/payment-provider.interface.js';
import { ValidationError } from '../../../common/errors/app-error.js';
import { logger } from '../../../common/logging/logger.js';

/** Razorpay SDK errors are plain objects shaped as
 *  { statusCode, error: { code, description, ... } }, so
 *  `error instanceof Error` is false and `String(error)` yields
 *  "[object Object]". */
interface RazorpaySdkError {
  statusCode?: number;
  status?: number;
  error?: { code?: string; description?: string };
  description?: string;
  message?: string;
}

/** Pull the description (or any nested message) out of a Razorpay SDK error
 *  so logs and toasts show a useful reason. */
function razorpayErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  const e = error as RazorpaySdkError | null | undefined;
  return e?.error?.description || e?.description || e?.message || JSON.stringify(e);
}

/** The SDK's paymentLink typings don't line up with the conditional
 *  expire_by / callback_url params we send — keep a narrow structural view
 *  of the two calls we make instead of casting per call site. */
interface RazorpayPaymentLinkApi {
  paymentLink: {
    create(params: Record<string, unknown>): Promise<{ id: string; short_url: string } & Record<string, unknown>>;
    cancel(linkId: string): Promise<unknown>;
  };
}

/** Payment entity fields we read off fetch/capture responses. */
interface RazorpayPaymentEntity {
  id: string;
  order_id: string;
  amount: number | string;
  currency: string;
  status: string;
}

export class RazorpayAdapter implements IPaymentProvider {
  // Razorpay credentials are required for any environment that selects this
  // adapter (PAYMENT_PROVIDER=razorpay). Boot-time validation in
  // common/config/index.ts already enforces keyId/keySecret are present, but we
  // re-check here so a misconfigured deploy fails loudly at first call instead
  // of silently returning a mock. There is intentionally NO mock fallback —
  // local dev should keep PAYMENT_PROVIDER=mock.
  private requireCreds() {
    if (!config.payment.razorpay.keyId || !config.payment.razorpay.keySecret) {
      throw new ValidationError('Razorpay credentials are not configured');
    }
  }

  async createOrder(params: PaymentOrderRequest) {
    this.requireCreds();
    try {
      const Razorpay = (await import('razorpay')).default;
      const razorpay = new Razorpay({
        key_id: config.payment.razorpay.keyId!,
        key_secret: config.payment.razorpay.keySecret!,
      });

      const order = await razorpay.orders.create({
        amount: params.amountPaise,
        currency: params.currency,
        receipt: params.bookingId,
        notes: {
          bookingId: params.bookingId,
          userId: params.userId,
          insurancePremium: String(params.insurancePremium),
        },
      });

      return {
        orderId: order.id,
        orderData: order,
        keyId: config.payment.razorpay.keyId!,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      const statusCode = (error as RazorpaySdkError | null | undefined)?.statusCode
        ?? (error as RazorpaySdkError | null | undefined)?.status;

      logger.error('Razorpay order creation failed', {
        error: msg,
        statusCode,
        amountPaise: params.amountPaise,
        currency: params.currency,
        bookingId: params.bookingId,
        keyIdPrefix: config.payment.razorpay.keyId?.slice(0, 12) + '...',
      });

      if (statusCode === 401) {
        throw new ValidationError(
          'Razorpay API key is invalid or expired. Please update your Razorpay credentials.'
        );
      }

      throw new ValidationError(
        `Payment gateway error: ${msg}. Please try again or contact support.`
      );
    }
  }

  async createPaymentLink(params: PaymentLinkRequest): Promise<PaymentLinkResponse> {
    this.requireCreds();
    try {
      const Razorpay = (await import('razorpay')).default;
      const razorpay = new Razorpay({
        key_id: config.payment.razorpay.keyId!,
        key_secret: config.payment.razorpay.keySecret!,
      });

      const hasEmail = !!(params.customer.email && params.customer.email.trim());
      // notify.sms/email make Razorpay deliver the short_url to the guest for
      // us — the app's own SMS channel is a stub, so we lean on this. reminder_enable
      // nudges unpaid links. notes.bookingId is how the payment_link.paid webhook
      // maps the payment back to our booking (payment links mint their own order id).
      const link = await (razorpay as unknown as RazorpayPaymentLinkApi).paymentLink.create({
        amount: params.amountPaise,
        currency: params.currency,
        description: params.description,
        customer: {
          name: params.customer.name ?? undefined,
          contact: params.customer.contact,
          email: hasEmail ? params.customer.email : undefined,
        },
        notify: { sms: true, email: hasEmail },
        reminder_enable: true,
        notes: { bookingId: params.bookingId },
        // Without expire_by Razorpay keeps links payable for ~6 months while
        // our booking hold dies in hours — a guest could pay a dead booking.
        // Razorpay requires expire_by ≥ 15 minutes out; clamp defensively.
        ...(params.expireByEpochSec
          ? { expire_by: Math.max(params.expireByEpochSec, Math.floor(Date.now() / 1000) + 16 * 60) }
          : {}),
        ...(params.callbackUrl
          ? { callback_url: params.callbackUrl, callback_method: 'get' }
          : {}),
      });

      return { id: link.id, shortUrl: link.short_url, raw: link };
    } catch (error: unknown) {
      const msg = razorpayErrorMessage(error);
      logger.error('Razorpay payment link creation failed', {
        error: msg,
        amountPaise: params.amountPaise,
        bookingId: params.bookingId,
      });
      throw new ValidationError(`Payment link error: ${msg}. Please try again.`);
    }
  }

  verifySignature(razorpayOrderId: string, razorpayPaymentId: string, razorpaySignature: string) {
    // Never silently accept signatures — staging/production both need a real
    // secret. Boot-time config validation guarantees this, but defend in depth.
    this.requireCreds();

    const body = `${razorpayOrderId}|${razorpayPaymentId}`;
    const expectedSignature = crypto
      .createHmac('sha256', config.payment.razorpay.keySecret!)
      .update(body)
      .digest('hex');

    return expectedSignature === razorpaySignature;
  }

  async refundPayment(params: PaymentRefundRequest) {
    this.requireCreds();
    try {
      const Razorpay = (await import('razorpay')).default;
      const razorpay = new Razorpay({
        key_id: config.payment.razorpay.keyId!,
        key_secret: config.payment.razorpay.keySecret!,
      });

      const refund = await razorpay.payments.refund(params.paymentId, {
        amount: params.amountPaise,
        notes: params.notes,
      });

      return {
        refundId: refund.id,
        refundData: refund,
      };
    } catch (error: unknown) {
      const msg = razorpayErrorMessage(error);
      logger.error('Razorpay refund failed', {
        error: msg,
        paymentId: params.paymentId,
        amountPaise: params.amountPaise,
      });
      throw new ValidationError(`Refund failed: ${msg}`);
    }
  }

  private requireClient() {
    this.requireCreds();
    return import('razorpay').then(({ default: Razorpay }) => new Razorpay({
      key_id: config.payment.razorpay.keyId!,
      key_secret: config.payment.razorpay.keySecret!,
    }));
  }

  async cancelPaymentLink(linkId: string): Promise<void> {
    const razorpay = await this.requireClient();
    try {
      await (razorpay as unknown as RazorpayPaymentLinkApi).paymentLink.cancel(linkId);
    } catch (error: unknown) {
      const msg = razorpayErrorMessage(error);
      // Already-paid / already-cancelled / already-expired links can't be
      // cancelled — that's fine, the link can no longer take money either
      // way. Log-and-continue keeps booking cancellation unblocked.
      logger.warn('Razorpay payment link cancel failed (continuing)', { error: msg, linkId });
    }
  }

  async fetchRefundsForPayment(paymentId: string): Promise<FetchedRefund[]> {
    const razorpay = await this.requireClient();
    try {
      // fetchMultipleRefund isn't on the SDK's payments typings — narrow
      // structural cast, same shape the runtime call has always used.
      const res = await (razorpay.payments as unknown as {
        fetchMultipleRefund(paymentId: string, params: Record<string, unknown>): Promise<{ items?: unknown }>;
      }).fetchMultipleRefund(paymentId, {});
      const items = Array.isArray(res?.items) ? res.items : [];
      return items.map((r) => ({
        refundId: String(r.id),
        amountPaise: Number(r.amount) || 0,
        notes: r.notes && typeof r.notes === 'object' ? r.notes : undefined,
        raw: r,
      }));
    } catch (error: unknown) {
      const msg = razorpayErrorMessage(error);
      // Pre-check is best-effort: on lookup failure return [] so the caller
      // proceeds to create the refund exactly as it did before this method
      // existed.
      logger.warn('Razorpay refund lookup failed (treating as none)', { error: msg, paymentId });
      return [];
    }
  }

  async fetchPayment(paymentId: string): Promise<FetchedPayment> {
    const razorpay = await this.requireClient();
    try {
      const p = await razorpay.payments.fetch(paymentId) as unknown as RazorpayPaymentEntity;
      return {
        id: p.id,
        orderId: p.order_id,
        amountPaise: Number(p.amount),
        currency: p.currency,
        status: p.status,
        raw: p,
      };
    } catch (error: unknown) {
      const msg = razorpayErrorMessage(error);
      logger.error('Razorpay fetchPayment failed', { error: msg, paymentId });
      throw new ValidationError(`Failed to fetch payment: ${msg}`);
    }
  }

  async capturePayment(params: PaymentCaptureRequest): Promise<FetchedPayment> {
    const razorpay = await this.requireClient();
    try {
      const captured = await razorpay.payments.capture(
        params.paymentId,
        params.amountPaise,
        params.currency,
      ) as unknown as RazorpayPaymentEntity;
      return {
        id: captured.id,
        orderId: captured.order_id,
        amountPaise: Number(captured.amount),
        currency: captured.currency,
        status: captured.status,
        raw: captured,
      };
    } catch (error: unknown) {
      const msg = razorpayErrorMessage(error);
      logger.error('Razorpay capturePayment failed', {
        error: msg,
        paymentId: params.paymentId,
        amountPaise: params.amountPaise,
      });
      throw new ValidationError(`Payment capture failed: ${msg}`);
    }
  }
}

export const razorpayAdapter = new RazorpayAdapter();
