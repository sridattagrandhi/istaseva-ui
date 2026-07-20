import crypto from 'crypto';
import type pg from 'pg';
import { dbTransaction, dbQuery } from '../../../common/repositories/database.js';
import { ConflictError, ValidationError, NotFoundError, ForbiddenError } from '../../../common/errors/app-error.js';
import { logAuditEvent } from '../../../common/logging/audit-log.js';
import { logger } from '../../../common/logging/logger.js';
import { config } from '../../../common/config/index.js';
import { getCacheProvider, getPaymentProvider } from '../../../common/providers/registry.js';
import { bookingsService } from '../../bookings/index.js';
import { paymentsRepository } from '../repositories/payments.repository.js';
import { trackServerEvent } from '../../analytics/services/analytics-track.js';
import { deriveFeeBreakdown, insurancePremiumRupees } from '../pricing/fees.js';
import type { CreatePaymentInput } from '../schemas/payment.schema.js';

/** The fields we read off a Razorpay webhook entity (payment / refund /
 *  payment_link). Wire data — every value is cross-checked against our own
 *  rows before it drives a state change; the index signature keeps extra
 *  provider fields from tripping excess-property checks. */
interface RazorpayWebhookEntity {
  id: string;
  order_id: string;
  payment_id: string;
  amount?: number | string;
  currency?: string;
  status?: string | null;
  error_description?: string | null;
  error_code?: string | null;
  error_step?: string | null;
  error_source?: string | null;
  notes?: Record<string, string>;
  [key: string]: unknown;
}

/** Razorpay webhook envelope (see handleWebhook). */
interface RazorpayWebhookBody {
  event?: string;
  id?: string;
  payload?: {
    event?: string;
    payment?: { entity?: RazorpayWebhookEntity };
    refund?: { entity?: RazorpayWebhookEntity };
    payment_link?: { entity?: RazorpayWebhookEntity };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export class PaymentsService {
  private parseAuthoritativeAmount(row: Record<string, unknown> | undefined) {
    if (!row) return null;

    const pricePerNight = Number(row.price_per_night);
    if (Number.isFinite(pricePerNight) && pricePerNight > 0) {
      return pricePerNight;
    }

    let basePrice: number | null = null;
    const rawPrice = row.price;
    if (typeof rawPrice === 'number' && Number.isFinite(rawPrice) && rawPrice > 0) {
      basePrice = rawPrice;
    } else if (typeof rawPrice === 'string') {
      // Accept only well-formed decimal numbers — "1.2.3" or "12abc" must not
      // silently coerce. Strip a single currency symbol / whitespace, then
      // require a strict numeric match.
      const trimmed = rawPrice.trim().replace(/^[₹$€£]/, '').trim();
      if (/^\d+(\.\d+)?$/.test(trimmed)) {
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed) && parsed > 0) {
          basePrice = parsed;
        }
      }
    }

    return basePrice;
  }

  /**
   * Fallback amount check, only used when the booking has no agreed_price_paise.
   * The normal path is agreed-price-exact-match (see verifyPayment). This path
   * is deliberately strict — exact equality on paise — because the previous
   * heuristic accepted any 0.5x multiple of the base price, which allowed a
   * malicious client to under- or over-pay by half-units without the
   * agreed-price guard kicking in. If hourly/duration pricing is needed, it
   * should be reflected in agreed_price_paise at hold creation, not inferred here.
   */
  private isAmountValid(clientAmount: number, basePrice: number): boolean {
    const clientPaise = Math.round(clientAmount * 100);
    const basePaise = Math.round(basePrice * 100);
    return basePaise > 0 && clientPaise === basePaise;
  }

  async createOrder(input: CreatePaymentInput, userId: string) {
    const cache = await getCacheProvider();

    if (input.idempotencyKey) {
      const cacheKey = `payment:create:${userId}:${input.idempotencyKey}`;
      const cachedResponse = await cache.getIdempotencyValue<{
        orderId: string;
        amount: number;
        amountPaise: number;
        currency: string;
        keyId: string;
        bookingId: string;
        paymentId: string;
        status: string;
      }>(cacheKey);

      if (cachedResponse?.paymentId) {
        if (
          cachedResponse.bookingId !== input.bookingId
          || Math.round(cachedResponse.amountPaise) !== Math.round(input.amount * 100)
        ) {
          throw new ConflictError('This idempotency key is already in use for a different payment request.');
        }
        return cachedResponse;
      }

      const existing = await paymentsRepository.findByIdempotencyKey(userId, input.idempotencyKey);
      if (existing.rows[0]) {
        const amountPaise = Number(existing.rows[0].amount_paise ?? 0);
        if (
          existing.rows[0].booking_id !== input.bookingId
          || amountPaise !== Math.round(input.amount * 100)
        ) {
          throw new ConflictError('This idempotency key is already in use for a different payment request.');
        }
        const response = {
          orderId: existing.rows[0].provider_ref,
          amount: amountPaise / 100,
          amountPaise,
          currency: existing.rows[0].currency,
          keyId: config.payment.razorpay.keyId || 'rzp_test_mock',
          bookingId: existing.rows[0].booking_id,
          paymentId: existing.rows[0].id,
          status: existing.rows[0].status,
        };
        await cache.setIdempotencyValue(cacheKey, response, 600);
        return response;
      }
    }

    const booking = await paymentsRepository.getPendingBookingWithAuthoritativePrice(input.bookingId, userId);
    if (!booking.rows[0]) {
      const existingBooking = await paymentsRepository.getBookingForUser(input.bookingId, userId);
      if (!existingBooking.rows[0]) {
        throw new NotFoundError('Pending booking', input.bookingId);
      }

      if (existingBooking.rows[0].status !== 'pending') {
        throw new ValidationError('Booking is no longer available for payment');
      }

      throw new ValidationError('Booking hold has expired. Please create a new booking.');
    }

    // Use the agreed price stored in the booking (set during hold creation).
    // This accounts for dynamic pricing, duration-based pricing, etc.
    // Fall back to listing base price if agreed price wasn't stored.
    const bookingRow = booking.rows[0];
    const agreedPricePaise = bookingRow.agreed_price_paise ? Number(bookingRow.agreed_price_paise) : null;
    const agreedAmount = agreedPricePaise && Number.isFinite(agreedPricePaise) ? agreedPricePaise / 100 : null;
    const listingBasePrice = this.parseAuthoritativeAmount(bookingRow);
    const authoritativeAmount = agreedAmount ?? listingBasePrice;

    logger.info('Payment price validation', {
      bookingId: input.bookingId,
      clientAmount: input.amount,
      agreedPricePaise,
      agreedAmount,
      listingBasePrice,
      authoritativeAmount,
    });

    if (!authoritativeAmount) {
      logger.warn('No authoritative price found for booking', {
        bookingId: input.bookingId,
        bookingRow: { id: bookingRow.id, agreed_price_paise: bookingRow.agreed_price_paise, listing_id: bookingRow.listing_id },
      });
      throw new ValidationError('Unable to validate booking price. Please refresh and try again.');
    }

    // If we have an agreed price, validate exactly. Otherwise allow multiples for hourly pricing.
    const isValid = agreedAmount
      ? Math.round(agreedAmount * 100) === Math.round(input.amount * 100)
      : this.isAmountValid(input.amount, authoritativeAmount);

    if (!isValid) {
      logger.warn('Payment amount mismatch', {
        bookingId: input.bookingId,
        clientAmount: input.amount,
        clientPaise: Math.round(input.amount * 100),
        agreedAmount,
        agreedPaise: agreedPricePaise,
        authoritativeAmount,
        authoritativePaise: Math.round(authoritativeAmount * 100),
        usedAgreedPrice: !!agreedAmount,
      });
      throw new ValidationError('Booking amount no longer matches the current price. Please refresh and try again.');
    }

    const baseAmountPaise = Math.round(input.amount * 100);
    let insurancePremium = 0;
    let insurancePremiumPaise = 0;

    if (input.insuranceOptIn) {
      // Use the shared helper so the assistant's pricing preview and the
      // BookingModal preview can quote the same number we charge here.
      insurancePremium = insurancePremiumRupees(input.amount);
      insurancePremiumPaise = insurancePremium * 100;
    }

    const totalAmountPaise = baseAmountPaise + insurancePremiumPaise;
    const totalAmount = totalAmountPaise / 100;

    const paymentProvider = await getPaymentProvider();
    const order = await paymentProvider.createOrder({
      bookingId: input.bookingId,
      userId,
      amountPaise: totalAmountPaise,
      currency: input.currency,
      insurancePremium,
    });

    // Resolve a coupon discount, if one was applied at hold time. The booking
    // row carries `coupon_id` (nullable). We compute the discount in paise:
    //   - 'fixed'  → discount_value rupees (i.e. ×100)
    //   - 'percent'→ subtotal × value%, capped at subtotal
    // Use the forward breakdown that createHold persisted on the booking row.
    // This is the SAME math the customer saw on the booking modal — no inverse
    // derivation from total. createHold writes `subtotal/platform_fee/taxes/
    // discount` _paise to bookings; we copy them onto the payment row
    // verbatim, with insurance added on top.
    const subtotalFromBooking = bookingRow.subtotal_paise != null
      ? Number(bookingRow.subtotal_paise)
      : null;
    const platformFeeFromBooking = bookingRow.platform_fee_paise != null
      ? Number(bookingRow.platform_fee_paise)
      : null;
    const taxesFromBooking = bookingRow.taxes_paise != null
      ? Number(bookingRow.taxes_paise)
      : null;
    const discountFromBooking = bookingRow.discount_paise != null
      ? Number(bookingRow.discount_paise)
      : null;

    let subtotalPaise: number;
    let platformFeePaise: number;
    let taxesPaise: number;
    let discountPaise: number | null;
    let gstRateUsed: number | null = null;

    if (
      subtotalFromBooking != null && Number.isFinite(subtotalFromBooking)
      && platformFeeFromBooking != null && Number.isFinite(platformFeeFromBooking)
      && taxesFromBooking != null && Number.isFinite(taxesFromBooking)
    ) {
      // Hold was created post-migration — copy the breakdown straight through.
      subtotalPaise = subtotalFromBooking;
      platformFeePaise = platformFeeFromBooking;
      taxesPaise = taxesFromBooking;
      discountPaise = discountFromBooking;
    } else {
      // Legacy booking row (pre `20260516000000_booking_fee_breakdown.sql`):
      // recompute via the same forward helper using the listing's category /
      // nightly hint and coupon. We deliberately don't inverse-math from
      // total — that drifted from the modal numbers and made invoice rows
      // disagree with what was charged.
      let couponDiscountPaise = 0;
      try {
        if (bookingRow.coupon_id) {
          const r = await dbQuery<{ discount_type: string; discount_value: string | number }>(
            'SELECT discount_type, discount_value FROM coupons WHERE id = $1 LIMIT 1',
            [bookingRow.coupon_id],
          );
          const c = r.rows[0];
          if (c) {
            const value = Number(c.discount_value);
            const sub = totalAmountPaise - insurancePremiumPaise;
            couponDiscountPaise = c.discount_type === 'percent'
              ? Math.min(sub, Math.round((sub * value) / 100))
              : Math.min(sub, Math.round(value * 100));
            if (!Number.isFinite(couponDiscountPaise) || couponDiscountPaise <= 0) {
              couponDiscountPaise = 0;
            }
          }
        }
      } catch (err) {
        logger.warn('Coupon discount lookup failed; legacy fallback proceeds without discount line', {
          bookingId: input.bookingId,
          couponId: bookingRow.coupon_id,
          err: err instanceof Error ? err.message : String(err),
        });
      }

      const legacy = deriveFeeBreakdown({
        totalPaise: totalAmountPaise,
        insurancePremiumPaise,
        category: bookingRow.service_category ?? bookingRow.listing_category ?? null,
        nightlyPaise: bookingRow.price_per_night != null
          ? Math.round(Number(bookingRow.price_per_night) * 100)
          : null,
      });
      subtotalPaise = legacy.subtotalPaise;
      platformFeePaise = legacy.platformFeePaise;
      taxesPaise = legacy.taxesPaise;
      gstRateUsed = legacy.gstRate;
      discountPaise = couponDiscountPaise > 0 ? couponDiscountPaise : null;
    }

    const payment = await paymentsRepository.insertPayment({
      bookingId: input.bookingId,
      userId,
      amountPaise: totalAmountPaise,
      currency: input.currency,
      orderId: order.orderId,
      metadata: {
        insurancePremium,
        insurancePremiumPaise,
        insuranceOptIn: input.insuranceOptIn,
        razorpayOrder: order.orderData,
        feeBreakdown: {
          subtotalPaise,
          platformFeePaise,
          taxesPaise,
          insurancePremiumPaise,
          discountPaise,
          totalPaise: totalAmountPaise,
          gstRate: gstRateUsed,
          source: subtotalFromBooking != null ? 'booking-row' : 'legacy-derived',
        },
        discountPaise,
      },
      idempotencyKey: input.idempotencyKey,
      subtotalPaise,
      platformFeePaise,
      taxesPaise,
      insurancePremiumPaise,
      discountPaise,
    });

    if (input.insuranceOptIn) {
      await paymentsRepository.insertInsurancePolicy(input.bookingId, userId, insurancePremium);
    }

    logAuditEvent({
      event: 'payment.order_created',
      booking_id: input.bookingId,
      payment_id: payment.rows[0]?.id,
      user_id: userId,
      from_status: null,
      to_status: payment.rows[0]?.status,
    });

    const response = {
      orderId: order.orderId,
      amount: totalAmount,
      amountPaise: totalAmountPaise,
      currency: input.currency,
      keyId: order.keyId,
      bookingId: input.bookingId,
      paymentId: payment.rows[0]?.id,
      status: payment.rows[0]?.status,
    };

    if (input.idempotencyKey) {
      await cache.setIdempotencyValue(`payment:create:${userId}:${input.idempotencyKey}`, response, 600);
    }

    return response;
  }

  async verifyPayment(params: {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
    bookingId: string;
    userId: string;
  }) {
    const paymentProvider = await getPaymentProvider();

    type VerifyResult =
      | { kind: 'completed'; payment: pg.QueryResultRow; alreadyCompleted: boolean }
      | { kind: 'pending'; payment: pg.QueryResultRow; status: string };

    const result: VerifyResult = await dbTransaction(async (client) => {
      const locked = await paymentsRepository.getPaymentByBookingForUpdate(client, params.bookingId);
      const currentPayment = locked.rows[0];

      if (!currentPayment) {
        throw new NotFoundError('Payment', params.bookingId);
      }

      // Authorization: the payment must belong to the caller.
      if (currentPayment.user_id !== params.userId) {
        throw new ForbiddenError('Not authorized to verify this payment');
      }

      if (currentPayment.status === 'completed') {
        return { kind: 'completed', payment: currentPayment, alreadyCompleted: true };
      }

      // Canonical order id: the value we stored when creating the order.
      // Reject if the client-supplied order id does not match — we will NEVER
      // verify a signature against a client-supplied order id.
      const canonicalOrderId: string | null = currentPayment.provider_ref ?? null;
      if (!canonicalOrderId) {
        throw new ValidationError('Payment has no order reference; cannot verify');
      }
      if (params.razorpay_order_id && params.razorpay_order_id !== canonicalOrderId) {
        throw new ValidationError('Order id mismatch — refusing to verify');
      }

      // HMAC is computed against the SERVER-stored order id, never the client's.
      if (
        !paymentProvider.verifySignature(
          canonicalOrderId,
          params.razorpay_payment_id,
          params.razorpay_signature,
        )
      ) {
        throw new ValidationError('Payment verification failed — invalid signature');
      }

      // Confirm with Razorpay that the payment exists, belongs to this order,
      // and is captured. If only authorized, capture it for the exact stored
      // amount/currency before confirming the booking.
      const expectedAmountPaise = Number(currentPayment.amount_paise ?? 0);
      const expectedCurrency = String(currentPayment.currency || 'INR');

      let fetched: Awaited<ReturnType<NonNullable<typeof paymentProvider.fetchPayment>>> | null = null;
      if (paymentProvider.fetchPayment) {
        fetched = await paymentProvider.fetchPayment(params.razorpay_payment_id);
        if (fetched.orderId !== canonicalOrderId) {
          throw new ValidationError('Fetched payment order id does not match');
        }
        if (Number(fetched.amountPaise) !== expectedAmountPaise) {
          throw new ValidationError('Fetched payment amount does not match');
        }
        if (fetched.currency !== expectedCurrency) {
          throw new ValidationError('Fetched payment currency does not match');
        }

        if (fetched.status === 'authorized' && paymentProvider.capturePayment) {
          fetched = await paymentProvider.capturePayment({
            paymentId: params.razorpay_payment_id,
            amountPaise: expectedAmountPaise,
            currency: expectedCurrency,
          });
        }

        if (fetched.status !== 'captured') {
          // Not captured yet — leave payment pending and let the webhook
          // (payment.captured) finish the job.
          return { kind: 'pending', payment: currentPayment, status: fetched.status };
        }
      }

      // Mark payment as completed FIRST — the DB trigger
      // enforce_booking_state_transition_trigger requires a completed payment
      // before allowing a booking to transition to 'confirmed'.
      // Always write the canonical (server-stored) order id back — never a
      // client-supplied value.
      const updatedPayment = (
        await paymentsRepository.updatePaymentStatus(client, currentPayment.id, 'completed', {
          providerPaymentId: params.razorpay_payment_id,
          providerRef: canonicalOrderId,
        })
      ).rows[0];

      const confirmedBooking = await bookingsService.confirmBooking(params.bookingId, {
        client,
        paymentId: currentPayment.id,
        userId: currentPayment.user_id,
        skipCompletedPaymentCheck: true,
      });

      if (confirmedBooking) {
        await paymentsRepository.releaseBookingLock(client, confirmedBooking);
        await paymentsRepository.insertGuarantee(client, confirmedBooking);
      }

      return { kind: 'completed', payment: updatedPayment, alreadyCompleted: false };
    });

    if (result.kind === 'pending') {
      logger.info('Payment not yet captured — waiting for webhook', {
        bookingId: params.bookingId,
        paymentId: result.payment.id,
        status: result.status,
      });
      return {
        success: true,
        pending: true,
        message: 'Payment is not yet captured. We will confirm once capture completes.',
        paymentId: result.payment.id,
      };
    }

    if (!result.alreadyCompleted) {
      logAuditEvent({
        event: 'payment.completed',
        booking_id: params.bookingId,
        payment_id: result.payment.id,
        user_id: result.payment.user_id,
        from_status: 'pending',
        to_status: result.payment.status,
      });
      logger.info('Payment verified and booking confirmed', {
        bookingId: params.bookingId,
        paymentId: result.payment.id,
      });
    }

    return { success: true, message: 'Payment verified, booking confirmed', paymentId: result.payment.id };
  }

  async refundCompletedBooking(params: {
    bookingId: string;
    paymentId: string;
    userId: string;
    client?: pg.PoolClient;
    /**
     * Why we're refunding. Drives the user-facing notification copy.
     * - 'cancelled': user (or provider) cancelled a confirmed booking — default
     * - 'expired':   payment captured after the slot-hold TTL elapsed, so we
     *                auto-refund. User didn't cancel; saying "cancelled" is
     *                misleading.
     */
    reason?: 'cancelled' | 'expired';
    /**
     * Explicit refund amount in paise — partial refunds for guest-initiated
     * cancellations under moderate / strict policies. Omit (or pass null /
     * the full amount_paise) to refund the entire payment.
     */
    refundPaise?: number | null;
    /** Cancellation policy that produced refundPaise — included in audit metadata. */
    refundReasonDetail?: string;
    /** If true, mark insurance_policies for this booking as cancelled. */
    voidInsurance?: boolean;
  }) {
    const reason = params.reason ?? 'cancelled';
    const paymentProvider = await getPaymentProvider();

    const execute = async (client: pg.PoolClient) => {
      const paymentLock = await paymentsRepository.getPaymentByBookingForUpdate(client, params.bookingId);
      const payment = paymentLock.rows[0];
      if (!payment || payment.id !== params.paymentId || payment.status !== 'completed') {
        return payment ?? null;
      }

      const providerRefundReason = reason === 'expired' ? 'booking_expired' : 'booking_cancelled';
      const fullAmountPaise = Number(payment.amount_paise ?? 0);
      // Caller's explicit amount wins; cap at the full amount (defense in depth)
      // and never go below zero. Null/undefined → full refund (legacy behavior).
      const refundAmountPaise = params.refundPaise == null
        ? fullAmountPaise
        : Math.max(0, Math.min(fullAmountPaise, Math.round(params.refundPaise)));
      const refundStatus = refundAmountPaise <= 0
        ? 'completed'
        : refundAmountPaise >= fullAmountPaise
          ? 'refunded'
          : 'partially_refunded';

      // Zero-refund is not expected from normal booking cancellation right now
      // because product policy is full refund, but keep the branch defensive
      // for explicit admin/internal callers that pass refundPaise: 0.
      //
      // IDEMPOTENCY: this gateway call runs inside the caller's DB txn. If a
      // prior attempt refunded at Razorpay but the txn rolled back before
      // createRefundRecord committed, the payment row still reads
      // 'completed' and a retry would refund the guest TWICE. The status
      // guard above means this method issues at most one refund per payment,
      // so any refund the gateway already holds tagged with this payment's
      // id belongs to that lost attempt — record it instead of re-refunding.
      let refund: { refundId: string; refundData: unknown } | null = null;
      if (refundAmountPaise > 0 && payment.provider_payment_id) {
        const existingRefunds = paymentProvider.fetchRefundsForPayment
          ? await paymentProvider.fetchRefundsForPayment(payment.provider_payment_id)
          : [];
        const prior = existingRefunds.find((r) => r.notes?.paymentId === payment.id);
        if (prior) {
          logger.warn('payments: found existing gateway refund for payment — reusing instead of re-refunding', {
            bookingId: params.bookingId,
            paymentId: payment.id,
            refundId: prior.refundId,
          });
          refund = { refundId: prior.refundId, refundData: prior.raw ?? prior };
        } else {
          refund = await paymentProvider.refundPayment({
            paymentId: payment.provider_payment_id,
            amountPaise: refundAmountPaise,
            notes: {
              bookingId: params.bookingId,
              paymentId: payment.id,
              reason: providerRefundReason,
            },
          });
        }
      }

      if (params.voidInsurance) {
        await paymentsRepository.voidInsurancePolicy(client, params.bookingId);
      }

      const refunded = (await paymentsRepository.createRefundRecord(
        client,
        payment.id,
        {
          refundReason: providerRefundReason,
          refundId: refund?.refundId ?? null,
          refundResponse: refund?.refundData ?? null,
          refundPolicyDetail: params.refundReasonDetail ?? null,
          refundedPaise: refundAmountPaise,
          refundStatus,
        },
        refundAmountPaise,
        refundStatus,
      )).rows[0];

      logAuditEvent({
        event: 'payment.refunded',
        booking_id: params.bookingId,
        payment_id: refunded.id,
        user_id: params.userId,
        from_status: payment.status,
        to_status: refunded.status,
      });

      // Tell the guest the refund is on its way. Best-effort — never blocks
      // the refund itself. Lazy import avoids a circular dep on bookings.
      try {
        const amount = refundAmountPaise / 100;
        const amountLabel = amount > 0 ? `₹${amount.toLocaleString('en-IN')}` : 'no refund';
        const policyDetail = params.refundReasonDetail ? ` ${params.refundReasonDetail}` : '';
        const refundMessage = refundAmountPaise <= 0
          ? `Your booking has been cancelled. No refund was issued for this internal adjustment.${policyDetail}`
          : reason === 'expired'
            ? `${amountLabel} has been refunded — the booking slot expired before payment completed. It usually lands in 5–7 business days.`
            : `${amountLabel} has been refunded for your cancelled booking.${policyDetail} It usually lands in 5–7 business days.`;
        const title = refundAmountPaise <= 0 ? 'Booking Cancelled' : 'Refund Issued 💸';
        const { notificationsService } = await import('../../notifications/services/notifications.service.js');
        notificationsService.send({
          userId: payment.user_id ?? params.userId,
          type: 'payment',
          title,
          message: refundMessage,
          link: `/bookings?booking=${params.bookingId}`,
          channels: ['push', 'in_app', 'email'],
          metadata: {
            bookingId: params.bookingId,
            paymentId: refunded.id,
            refundedPaise: refundAmountPaise,
            chargedPaise: payment.amount_paise,
          },
        }).catch(() => { /* best-effort */ });
      } catch { /* notifications module unavailable */ }

      return refunded;
    };

    return params.client ? execute(params.client) : dbTransaction(execute);
  }

  async handleWebhook(rawBody: unknown, opts: { eventIdFromHeader?: string } = {}) {
    // Signature-verified but otherwise untyped wire data — narrow to the
    // envelope shape we actually read.
    const body = rawBody as RazorpayWebhookBody | null | undefined;
    const event = body?.event;
    const payload: NonNullable<RazorpayWebhookBody['payload']> = body?.payload ?? {};
    // Prefer the x-razorpay-event-id header (the canonical delivery id Razorpay
    // assigns per webhook). Fall back to the body id, then any entity id, only
    // when the header is missing — e.g. older test fixtures.
    const eventId = opts.eventIdFromHeader
      ?? body?.id
      ?? payload?.event
      ?? payload?.payment?.entity?.id
      ?? payload?.refund?.entity?.id;

    if (!event || !eventId) {
      throw new ValidationError('Invalid webhook payload');
    }

    // Fast-path dedupe: cheap SELECT outside the txn. Not authoritative on its
    // own because Razorpay retries aggressively — two concurrent deliveries of
    // the same event would both pass this check and race on the row below.
    // Each txn branch therefore re-checks atomically via the ON CONFLICT insert
    // and bails if another in-flight txn already claimed the event.
    const existingWebhookEvent = await paymentsRepository.getWebhookEventById(eventId);
    if (existingWebhookEvent.rows[0]) {
      return { success: true, message: 'duplicate' };
    }

    // Duplicate-detection token: insert into webhook_events with ON CONFLICT
    // DO NOTHING; rowCount 0 means a concurrent delivery already claimed it.
    const claimEvent = async (client: pg.PoolClient) => {
      const claimed = await paymentsRepository.insertWebhookEventIfNew(client, eventId, event);
      return claimed.rowCount! > 0;
    };

    let duplicate = false;

    switch (event) {
      case 'payment.captured': {
        // Same as the untyped code: a captured event without payload.payment
        // is malformed and throws before any state change.
        const paymentEntity = payload.payment!.entity!;
        await dbTransaction(async (client) => {
          if (!(await claimEvent(client))) { duplicate = true; return; }

          const locked = await paymentsRepository.getPaymentByOrderForUpdate(client, paymentEntity.order_id);
          const payment = locked.rows[0];
          if (!payment) {
            return;
          }

          if (payment.status === 'completed') {
            return;
          }

          // Defense-in-depth: even though we looked up the payment by order_id,
          // refuse to confirm anything if the entity disagrees with the row we
          // stored at order creation. Razorpay sometimes sends entities with
          // unexpected status (e.g. 'authorized' on an event mislabelled as
          // captured) — only the captured status should mark the payment done.
          const expectedAmountPaise = Number(payment.amount_paise ?? 0);
          const expectedCurrency = String(payment.currency || 'INR');
          const entityAmount = Number(paymentEntity.amount);
          const entityCurrency = String(paymentEntity.currency || '');
          const entityStatus = paymentEntity.status ? String(paymentEntity.status) : null;

          if (paymentEntity.order_id !== payment.provider_ref) {
            logger.warn('payment.captured webhook: order_id mismatch — ignoring', {
              bookingId: payment.booking_id,
              paymentId: payment.id,
              entityOrderId: paymentEntity.order_id,
              storedProviderRef: payment.provider_ref,
            });
            return;
          }
          if (!Number.isFinite(entityAmount) || entityAmount !== expectedAmountPaise) {
            logger.warn('payment.captured webhook: amount mismatch — ignoring', {
              bookingId: payment.booking_id,
              paymentId: payment.id,
              entityAmount,
              expectedAmountPaise,
            });
            return;
          }
          if (entityCurrency !== expectedCurrency) {
            logger.warn('payment.captured webhook: currency mismatch — ignoring', {
              bookingId: payment.booking_id,
              paymentId: payment.id,
              entityCurrency,
              expectedCurrency,
            });
            return;
          }
          if (entityStatus && entityStatus !== 'captured') {
            logger.warn('payment.captured webhook: entity status is not captured — ignoring', {
              bookingId: payment.booking_id,
              paymentId: payment.id,
              entityStatus,
            });
            return;
          }

          const booking = await bookingsService.getInternalBooking(payment.booking_id, client);

          if (booking.status === 'expired') {
            const updated = (
              await paymentsRepository.updatePaymentStatus(client, payment.id, 'completed', {
                providerPaymentId: paymentEntity.id,
                providerRef: payment.provider_ref,
              })
            ).rows[0];

            logger.warn('Auto-refund: payment captured for expired booking', {
              bookingId: payment.booking_id,
              paymentId: updated.id,
            });

            await this.refundCompletedBooking({
              bookingId: payment.booking_id,
              paymentId: updated.id,
              userId: payment.user_id,
              client,
              reason: 'expired',
            });
            return;
          }

          // Mark payment completed FIRST (DB trigger requires it before booking confirmation).
          // Always write back the canonical (server-stored) order id, never the
          // webhook-supplied value.
          const updated = (
            await paymentsRepository.updatePaymentStatus(client, payment.id, 'completed', {
              providerPaymentId: paymentEntity.id,
              providerRef: payment.provider_ref,
            })
          ).rows[0];

          const confirmedBooking = await bookingsService.confirmBooking(payment.booking_id, {
            client,
            paymentId: payment.id,
            userId: payment.user_id,
            skipCompletedPaymentCheck: true,
          });

          if (confirmedBooking) {
            await paymentsRepository.releaseBookingLock(client, confirmedBooking);
            await paymentsRepository.insertGuarantee(client, confirmedBooking);
          }
        });
        break;
      }
      case 'payment_link.paid': {
        // Host-books-on-behalf: the guest paid a Razorpay Payment Link. Unlike
        // the self-service flow there is NO pre-created payment row (the link
        // mints its own order at pay-time), so we insert a completed payment
        // here — the DB trigger requires one before the booking can confirm —
        // then run the same confirmation path as payment.captured.
        const linkEntity = payload.payment_link?.entity ?? ({} as RazorpayWebhookEntity);
        const paymentEntity = payload.payment?.entity ?? ({} as RazorpayWebhookEntity);
        const bookingId: string | undefined = linkEntity?.notes?.bookingId;

        await dbTransaction(async (client) => {
          if (!(await claimEvent(client))) { duplicate = true; return; }
          if (!bookingId) {
            logger.warn('payment_link.paid webhook: missing notes.bookingId — ignoring', {
              paymentLinkId: linkEntity?.id,
            });
            return;
          }

          const booking = await bookingsService.getInternalBooking(bookingId, client);
          if (!booking) {
            logger.warn('payment_link.paid webhook: booking not found — ignoring', { bookingId });
            return;
          }

          // Only settle unpaid on-behalf holds. A non-on-behalf or already
          // non-pending booking arriving here is unexpected; ignore rather than
          // double-charge/confirm.
          if (!booking.booked_on_behalf || booking.status !== 'pending') {
            // A guest can still pay a DEAD on-behalf booking: legacy links
            // without expire_by, Razorpay's ≥15-min expiry floor, or a host
            // cancellation racing a guest mid-checkout. The money was
            // captured either way — record the payment and AUTO-REFUND it,
            // mirroring payment.captured's expired-booking path. (This used
            // to log "needs manual refund" and drop the event: guest charged,
            // slot gone, nothing recorded.)
            const deadOnBehalf = booking.booked_on_behalf
              && (booking.status === 'expired' || booking.status === 'cancelled');
            const capturedPaise = Number(paymentEntity.amount ?? linkEntity.amount);
            if (deadOnBehalf && Number.isFinite(capturedPaise) && capturedPaise > 0) {
              const existingDead = await paymentsRepository.getPaymentByBookingForUpdate(client, bookingId);
              if (existingDead.rows[0]) {
                logger.warn('payment_link.paid webhook: dead booking already has a payment row — ignoring duplicate', {
                  bookingId, paymentLinkId: linkEntity?.id,
                });
                return;
              }
              logger.warn('payment_link.paid webhook: link paid after booking died — auto-refunding', {
                bookingId, bookingStatus: booking.status, paymentLinkId: linkEntity?.id,
              });
              const deadProviderRef = String(paymentEntity.order_id || linkEntity.id);
              const insertedDead = (await paymentsRepository.insertPayment({
                bookingId,
                userId: booking.user_id,
                amountPaise: capturedPaise,
                currency: String(paymentEntity.currency || linkEntity.currency || 'INR'),
                orderId: deadProviderRef,
                metadata: {
                  source: 'payment_link',
                  paymentLinkId: linkEntity?.id,
                  paidAfterBookingDead: true,
                },
              }, client)).rows[0];
              const updatedDead = (await paymentsRepository.updatePaymentStatus(client, insertedDead.id, 'completed', {
                providerPaymentId: String(paymentEntity.id || linkEntity.id),
                providerRef: deadProviderRef,
              })).rows[0];
              await this.refundCompletedBooking({
                bookingId,
                paymentId: updatedDead.id,
                userId: booking.user_id,
                client,
                reason: booking.status === 'expired' ? 'expired' : 'cancelled',
              });
              return;
            }
            return;
          }

          // Amount/currency must match the server-authoritative booking total.
          const expectedPaise = Number(booking.agreed_price_paise ?? 0);
          const entityAmount = Number(paymentEntity.amount ?? linkEntity.amount);
          const entityCurrency = String(paymentEntity.currency || linkEntity.currency || 'INR');
          if (!Number.isFinite(entityAmount) || entityAmount !== expectedPaise) {
            logger.warn('payment_link.paid webhook: amount mismatch — ignoring', {
              bookingId, entityAmount, expectedPaise,
            });
            return;
          }
          if (entityCurrency !== String(booking.currency || 'INR')) {
            logger.warn('payment_link.paid webhook: currency mismatch — ignoring', {
              bookingId, entityCurrency,
            });
            return;
          }

          // Guard against a duplicate settle if a payment row somehow exists.
          const existing = await paymentsRepository.getPaymentByBookingForUpdate(client, bookingId);
          if (existing.rows[0]?.status === 'completed') return;

          // Copy the forward fee breakdown off the booking row (same source the
          // self-service invoice reads) so the receipt reconciles. No insurance
          // on host-created bookings.
          const providerRef = String(paymentEntity.order_id || linkEntity.id);
          const inserted = (await paymentsRepository.insertPayment({
            bookingId,
            userId: booking.user_id,
            amountPaise: expectedPaise,
            currency: entityCurrency,
            orderId: providerRef,
            metadata: {
              source: 'payment_link',
              paymentLinkId: linkEntity?.id,
              feeBreakdown: {
                subtotalPaise: booking.subtotal_paise ?? null,
                platformFeePaise: booking.platform_fee_paise ?? null,
                taxesPaise: booking.taxes_paise ?? null,
                insurancePremiumPaise: 0,
                discountPaise: booking.discount_paise ?? null,
                totalPaise: expectedPaise,
              },
            },
            subtotalPaise: booking.subtotal_paise ?? null,
            platformFeePaise: booking.platform_fee_paise ?? null,
            taxesPaise: booking.taxes_paise ?? null,
            insurancePremiumPaise: 0,
            discountPaise: booking.discount_paise ?? null,
            // Same txn client — getInternalBooking holds FOR UPDATE on the
            // booking row; a pool-connection insert would self-deadlock on the
            // FK's KEY SHARE lock (see insertPayment).
          }, client)).rows[0];

          await paymentsRepository.updatePaymentStatus(client, inserted.id, 'completed', {
            providerPaymentId: String(paymentEntity.id || linkEntity.id),
            providerRef,
          });

          const confirmedBooking = await bookingsService.confirmBooking(bookingId, {
            client,
            paymentId: inserted.id,
            userId: booking.user_id,
            skipCompletedPaymentCheck: true,
          });

          if (confirmedBooking) {
            await paymentsRepository.releaseBookingLock(client, confirmedBooking);
            await paymentsRepository.insertGuarantee(client, confirmedBooking);
          }
        });
        break;
      }
      case 'payment.failed': {
        const paymentEntity = payload.payment!.entity!;
        let notifyUserId: string | null = null;
        let notifyBookingId: string | null = null;
        let notifyReason: string | null = null;
        let failureHandled = false;
        await dbTransaction(async (client) => {
          if (!(await claimEvent(client))) { duplicate = true; return; }

          const locked = await paymentsRepository.getPaymentByOrderForUpdate(client, paymentEntity.order_id);
          const payment = locked.rows[0];
          if (!payment) {
            return;
          }

          if (payment.status === 'completed' || payment.status === 'refunded') {
            return;
          }

          const failedReason = paymentEntity.error_description || 'provider_reported_failure';
          const updated = (
            await paymentsRepository.updatePaymentStatus(client, payment.id, 'failed', {
              providerPaymentId: paymentEntity.id,
              providerRef: paymentEntity.order_id,
              failedReason,
            })
          ).rows[0];

          // Release the slot hold immediately so the user (or anyone else) can
          // try again on the same date/time. Without this the lock sits for
          // the rest of its 5-min TTL after a payment we already know failed.
          await paymentsRepository.releaseBookingLock(client, { id: payment.booking_id });

          logAuditEvent({
            event: 'payment.failed',
            booking_id: payment.booking_id,
            payment_id: updated.id,
            user_id: payment.user_id,
            from_status: payment.status,
            to_status: updated.status,
          });

          notifyUserId = payment.user_id ?? null;
          notifyBookingId = payment.booking_id ?? null;
          notifyReason = failedReason;
          failureHandled = true;
        });

        // Authoritative payment_failed analytics event — the rollup counts
        // these (plus client user_dismissed, which never reaches the webhook)
        // so client and server reports can't double-count. Emitted AFTER the
        // txn commits, same reasoning as the notification below. Categorical
        // fields only — error_description is free text and stays out (DPDP).
        if (failureHandled) {
          trackServerEvent('payment_failed', {
            userId: notifyUserId,
            source: 'razorpay_webhook',
            props: {
              reasonCode: String(paymentEntity.error_code || 'provider_reported_failure'),
              ...(paymentEntity.error_step ? { step: String(paymentEntity.error_step) } : {}),
              ...(paymentEntity.error_source ? { src: String(paymentEntity.error_source) } : {}),
              ...(notifyBookingId ? { bookingId: notifyBookingId } : {}),
            },
          });
        }

        // Fire the user-facing "payment didn't go through" notification AFTER
        // the txn commits. Inside the txn it could fire even on rollback,
        // and the notifications service does its own DB write that doesn't
        // belong in the payment-state transaction.
        if (notifyUserId && notifyBookingId) {
          try {
            const { notificationsService } = await import('../../notifications/services/notifications.service.js');
            const detail = notifyReason && notifyReason !== 'provider_reported_failure'
              ? ` (${notifyReason})`
              : '';
            await notificationsService.send({
              userId: notifyUserId,
              type: 'payment',
              title: 'Payment didn\'t go through',
              message: `Your payment didn't complete${detail}. The slot's been released — try again or pick another option.`,
              link: `/bookings?booking=${notifyBookingId}`,
              channels: ['push', 'in_app', 'email'],
              metadata: { bookingId: notifyBookingId },
            });
          } catch (err) {
            logger.warn('payment.failed: user notification failed', { err: String(err), bookingId: notifyBookingId });
          }
        }
        break;
      }
      case 'refund.processed': {
        const refundEntity = payload.refund!.entity!;
        await dbTransaction(async (client) => {
          if (!(await claimEvent(client))) { duplicate = true; return; }

          const locked = await paymentsRepository.getPaymentByProviderPaymentIdForUpdate(client, refundEntity.payment_id);
          const payment = locked.rows[0];
          if (!payment) {
            return;
          }

          if (payment.status === 'refunded') {
            return;
          }

          const refundedPaise = Number(refundEntity.amount ?? payment.refund_paise ?? 0);
          const chargedPaise = Number(payment.amount_paise ?? 0);
          const nextStatus = Number.isFinite(refundedPaise)
            && Number.isFinite(chargedPaise)
            && chargedPaise > 0
            && refundedPaise < chargedPaise
            ? 'partially_refunded'
            : 'refunded';

          await paymentsRepository.updatePaymentStatus(client, payment.id, nextStatus, {
            providerPaymentId: payment.provider_payment_id,
            providerRef: payment.provider_ref,
          });
        });
        break;
      }
      case 'payment_link.expired': {
        // On-behalf links carry expire_by matched to the hold (clamped to
        // Razorpay's ≥15-min floor), so Razorpay fires this when the guest
        // never paid. The hold sweeper
        // owns the booking transition (pending → expired); we just claim the
        // event and leave an observability trail tying link to booking.
        const expiredLink = payload.payment_link?.entity ?? ({} as RazorpayWebhookEntity);
        await dbTransaction(async (client) => {
          if (!(await claimEvent(client))) { duplicate = true; return; }
          logger.info('payment_link.expired webhook: link lapsed unpaid', {
            paymentLinkId: expiredLink?.id,
            bookingId: expiredLink?.notes?.bookingId,
          });
        });
        break;
      }
      default:
        await dbTransaction(async (client) => {
          if (!(await claimEvent(client))) { duplicate = true; return; }
        });
        break;
    }

    return { success: true, message: duplicate ? 'duplicate' : 'processed' };
  }

  /**
   * Verify a Razorpay webhook HMAC-SHA256 signature.
   *
   * `rawBody` MUST be the exact request bytes — Razorpay signs those bytes, and
   * re-serializing a parsed JSON object will not reproduce them. The webhook route
   * mounts express.raw() so req.body arrives here as a Buffer.
   *
   * Secret is required in every environment except the test runner, so staging
   * boxes (which are internet-reachable) can't be tricked into accepting forged
   * webhooks.
   */
  verifyWebhookSignature(signature: string | undefined, rawBody: Buffer) {
    if (!config.payment.razorpay.webhookSecret) {
      if (config.app.nodeEnv !== 'test') {
        throw new ValidationError('Razorpay webhook secret is required');
      }
      return true;
    }
    if (!signature) return false;

    const expected = crypto
      .createHmac('sha256', config.payment.razorpay.webhookSecret)
      .update(rawBody)
      .digest('hex');

    // Timing-safe comparison; Buffer.from on a non-hex string throws, hence the try.
    try {
      const a = Buffer.from(signature, 'hex');
      const b = Buffer.from(expected, 'hex');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}

export const paymentsService = new PaymentsService();
