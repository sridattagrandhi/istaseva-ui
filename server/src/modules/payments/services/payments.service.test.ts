// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbTransaction = vi.fn(async (fn: any) => fn({}));
const getPaymentProvider = vi.fn();
const getCacheProvider = vi.fn();
const getIdempotencyValue = vi.fn();
const setIdempotencyValue = vi.fn();
const createOrder = vi.fn();
const verifySignature = vi.fn();
const refundPayment = vi.fn();
const fetchPayment = vi.fn();
const capturePayment = vi.fn();
const getPendingBookingWithAuthoritativePrice = vi.fn();
const getBookingForUser = vi.fn();
const findByIdempotencyKey = vi.fn();
const insertPayment = vi.fn();
const insertInsurancePolicy = vi.fn();
const getPaymentByBookingForUpdate = vi.fn();
const updatePaymentStatus = vi.fn();
const releaseBookingLock = vi.fn();
const insertGuarantee = vi.fn();
const getPaymentByOrderForUpdate = vi.fn();
const getPaymentByProviderPaymentIdForUpdate = vi.fn();
const createRefundRecord = vi.fn();
const insertWebhookEventIfNew = vi.fn();
const getWebhookEventById = vi.fn();
const confirmBooking = vi.fn();
const getInternalBooking = vi.fn();

vi.mock('../../../common/repositories/database.js', () => ({
  dbTransaction,
}));

vi.mock('../../../common/providers/registry.js', () => ({
  getPaymentProvider,
  getCacheProvider,
  // The payment.failed webhook emits a payment_failed analytics event via
  // trackServerEvent — swallow the write in tests.
  getEventProvider: async () => ({ putEvent: async () => undefined }),
}));

vi.mock('../repositories/payments.repository.js', () => ({
  paymentsRepository: {
    getPendingBookingWithAuthoritativePrice,
    getBookingForUser,
    findByIdempotencyKey,
    insertPayment,
    insertInsurancePolicy,
    getPaymentByBookingForUpdate,
    updatePaymentStatus,
    releaseBookingLock,
    insertGuarantee,
    getPaymentByOrderForUpdate,
    getPaymentByProviderPaymentIdForUpdate,
    createRefundRecord,
    insertWebhookEventIfNew,
    getWebhookEventById,
  },
}));

vi.mock('../../bookings/index.js', () => ({
  bookingsService: {
    confirmBooking,
    getInternalBooking,
  },
}));

vi.mock('../../../common/logging/audit-log.js', () => ({
  logAuditEvent: vi.fn(),
}));

vi.mock('../../../common/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('PaymentsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPaymentProvider.mockResolvedValue({
      createOrder,
      verifySignature,
      refundPayment,
      fetchPayment,
      capturePayment,
    });
    fetchPayment.mockResolvedValue({
      id: 'pay-1',
      orderId: 'order-1',
      amountPaise: 50000,
      currency: 'INR',
      status: 'captured',
    });
    capturePayment.mockResolvedValue({
      id: 'pay-1',
      orderId: 'order-1',
      amountPaise: 50000,
      currency: 'INR',
      status: 'captured',
    });
    getCacheProvider.mockResolvedValue({
      getIdempotencyValue,
      setIdempotencyValue,
    });
    getIdempotencyValue.mockResolvedValue(null);
    setIdempotencyValue.mockResolvedValue(undefined);
    verifySignature.mockReturnValue(true);
    getPendingBookingWithAuthoritativePrice.mockResolvedValue({
      rows: [{ id: 'booking-1', status: 'pending', user_id: 'user-1', price_per_night: 500 }],
    });
    getBookingForUser.mockResolvedValue({
      rows: [{ id: 'booking-1', status: 'pending', user_id: 'user-1' }],
    });
    findByIdempotencyKey.mockResolvedValue({ rows: [] });
    createOrder.mockResolvedValue({
      orderId: 'order-1',
      orderData: { id: 'order-1' },
      keyId: 'rzp_test',
    });
    insertPayment.mockResolvedValue({
      rows: [{ id: 'payment-1', booking_id: 'booking-1', status: 'pending', provider_ref: 'order-1' }],
    });
    getPaymentByBookingForUpdate.mockResolvedValue({
      rows: [{ id: 'payment-1', booking_id: 'booking-1', user_id: 'user-1', status: 'pending', provider_ref: 'order-1', amount_paise: 50000, currency: 'INR', provider_payment_id: 'pay-1' }],
    });
    updatePaymentStatus.mockResolvedValue({
      rows: [{ id: 'payment-1', booking_id: 'booking-1', user_id: 'user-1', status: 'completed', amount_paise: 50000, provider_payment_id: 'pay-1' }],
    });
    confirmBooking.mockResolvedValue({
      id: 'booking-1',
      user_id: 'user-1',
      status: 'confirmed',
    });
    getInternalBooking.mockResolvedValue({
      id: 'booking-1',
      user_id: 'user-1',
      status: 'pending',
    });
    getPaymentByOrderForUpdate.mockResolvedValue({
      rows: [{ id: 'payment-1', booking_id: 'booking-1', user_id: 'user-1', status: 'pending', provider_ref: 'order-1', amount_paise: 50000, currency: 'INR', provider_payment_id: 'pay-1' }],
    });
    getPaymentByProviderPaymentIdForUpdate.mockResolvedValue({
      rows: [{ id: 'payment-1', booking_id: 'booking-1', user_id: 'user-1', status: 'completed', provider_ref: 'order-1', provider_payment_id: 'pay-1' }],
    });
    refundPayment.mockResolvedValue({
      refundId: 'refund-1',
      refundData: { id: 'refund-1' },
    });
    createRefundRecord.mockResolvedValue({
      rows: [{ id: 'payment-1', booking_id: 'booking-1', user_id: 'user-1', status: 'refunded' }],
    });
    insertWebhookEventIfNew.mockResolvedValue({ rows: [{ event_id: 'evt-1' }], rowCount: 1 });
    getWebhookEventById.mockResolvedValue({ rows: [] });
  });

  it('creates a payment order for a pending booking', async () => {
    const { paymentsService } = await import('./payments.service.js');

    const result = await paymentsService.createOrder(
      {
        bookingId: 'booking-1',
        amount: 500,
        currency: 'INR',
        insuranceOptIn: true,
        idempotencyKey: 'payment-create-1',
      },
      'user-1'
    );

    expect(createOrder).toHaveBeenCalled();
    expect(insertPayment).toHaveBeenCalled();
    expect(insertInsurancePolicy).toHaveBeenCalled();
    expect(result.bookingId).toBe('booking-1');
    // ₹500 base + ₹2 flat insurance premium = ₹502 = 50,200 paise.
    // The insurance premium is a FLAT ₹2 added after tax (CLAUDE.md
    // "Insurance / trip protection is a flat ₹2"), not a percentage —
    // the prior expected value of 51,000 paise was stale from before
    // that formula change. The pricing chain here only confirms the
    // pre-agreed amount + adds insurance; fees/GST are already baked
    // into agreed_price_paise during the booking-creation flow, so
    // they don't recompute on createOrder.
    expect(result.amountPaise).toBe(50200);
  });

  it('rejects createOrder when the client-supplied amount disagrees with the booking agreed price', async () => {
    // Backend stores agreed_price_paise = 50000 (₹500). Client claims they're
    // paying ₹450 — server must reject with ValidationError so a tampered
    // total can never be persisted.
    getPendingBookingWithAuthoritativePrice.mockResolvedValue({
      rows: [{
        id: 'booking-1',
        status: 'pending',
        user_id: 'user-1',
        price_per_night: 500,
        agreed_price_paise: 50000,
      }],
    });
    const { paymentsService } = await import('./payments.service.js');

    await expect(
      paymentsService.createOrder(
        {
          bookingId: 'booking-1',
          amount: 450,
          currency: 'INR',
          insuranceOptIn: false,
        },
        'user-1',
      ),
    ).rejects.toThrow(/no longer matches/);

    expect(createOrder).not.toHaveBeenCalled();
    expect(insertPayment).not.toHaveBeenCalled();
  });

  it('returns the existing order when createOrder is retried with the same idempotency key', async () => {
    findByIdempotencyKey.mockResolvedValue({
      rows: [{ id: 'payment-1', booking_id: 'booking-1', provider_ref: 'order-existing', amount_paise: 50000, currency: 'INR', status: 'pending' }],
    });
    const { paymentsService } = await import('./payments.service.js');

    const result = await paymentsService.createOrder(
      {
        bookingId: 'booking-1',
        amount: 500,
        currency: 'INR',
        insuranceOptIn: false,
        idempotencyKey: 'payment-create-1',
      },
      'user-1'
    );

    expect(insertPayment).not.toHaveBeenCalled();
    expect(result.orderId).toBe('order-existing');
  });

  it('verifies payment, updates payment status, and confirms the booking', async () => {
    const { paymentsService } = await import('./payments.service.js');

    const result = await paymentsService.verifyPayment({
      bookingId: 'booking-1',
      userId: 'user-1',
      razorpay_order_id: 'order-1',
      razorpay_payment_id: 'pay-1',
      razorpay_signature: 'sig',
    });

    expect(verifySignature).toHaveBeenCalledWith('order-1', 'pay-1', 'sig');
    expect(updatePaymentStatus).toHaveBeenCalled();
    expect(confirmBooking).toHaveBeenCalledWith(
      'booking-1',
      expect.objectContaining({
        paymentId: 'payment-1',
      })
    );
    expect(result.success).toBe(true);
  });

  it('returns early on duplicate verify when payment is already completed', async () => {
    getPaymentByBookingForUpdate.mockResolvedValue({
      rows: [{ id: 'payment-1', booking_id: 'booking-1', user_id: 'user-1', status: 'completed', provider_ref: 'order-1' }],
    });
    const { paymentsService } = await import('./payments.service.js');

    const result = await paymentsService.verifyPayment({
      bookingId: 'booking-1',
      userId: 'user-1',
      razorpay_order_id: 'order-1',
      razorpay_payment_id: 'pay-1',
      razorpay_signature: 'sig',
    });

    expect(updatePaymentStatus).not.toHaveBeenCalled();
    expect(confirmBooking).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('rejects verify when the client-supplied order id does not match the stored provider_ref', async () => {
    const { paymentsService } = await import('./payments.service.js');

    await expect(
      paymentsService.verifyPayment({
        bookingId: 'booking-1',
        userId: 'user-1',
        razorpay_order_id: 'order-EVIL',
        razorpay_payment_id: 'pay-1',
        razorpay_signature: 'sig',
      }),
    ).rejects.toThrow(/Order id mismatch/);

    expect(verifySignature).not.toHaveBeenCalled();
    expect(updatePaymentStatus).not.toHaveBeenCalled();
    expect(confirmBooking).not.toHaveBeenCalled();
  });

  it('rejects verify when the caller is not the booking owner', async () => {
    const { paymentsService } = await import('./payments.service.js');

    await expect(
      paymentsService.verifyPayment({
        bookingId: 'booking-1',
        userId: 'attacker-user',
        razorpay_order_id: 'order-1',
        razorpay_payment_id: 'pay-1',
        razorpay_signature: 'sig',
      }),
    ).rejects.toThrow(/Not authorized/);

    expect(updatePaymentStatus).not.toHaveBeenCalled();
    expect(confirmBooking).not.toHaveBeenCalled();
  });

  it('does not confirm the booking unless the fetched payment is captured', async () => {
    fetchPayment.mockResolvedValue({
      id: 'pay-1',
      orderId: 'order-1',
      amountPaise: 50000,
      currency: 'INR',
      status: 'created',
    });
    const { paymentsService } = await import('./payments.service.js');

    const result = await paymentsService.verifyPayment({
      bookingId: 'booking-1',
      userId: 'user-1',
      razorpay_order_id: 'order-1',
      razorpay_payment_id: 'pay-1',
      razorpay_signature: 'sig',
    });

    expect(result).toMatchObject({ success: true, pending: true });
    expect(updatePaymentStatus).not.toHaveBeenCalled();
    expect(confirmBooking).not.toHaveBeenCalled();
  });

  it('captures an authorized payment for the stored amount before confirming', async () => {
    fetchPayment.mockResolvedValue({
      id: 'pay-1',
      orderId: 'order-1',
      amountPaise: 50000,
      currency: 'INR',
      status: 'authorized',
    });
    const { paymentsService } = await import('./payments.service.js');

    await paymentsService.verifyPayment({
      bookingId: 'booking-1',
      userId: 'user-1',
      razorpay_order_id: 'order-1',
      razorpay_payment_id: 'pay-1',
      razorpay_signature: 'sig',
    });

    expect(capturePayment).toHaveBeenCalledWith({
      paymentId: 'pay-1',
      amountPaise: 50000,
      currency: 'INR',
    });
    expect(updatePaymentStatus).toHaveBeenCalled();
    expect(confirmBooking).toHaveBeenCalled();
  });

  it('does not overwrite provider_ref with a client-supplied order id', async () => {
    const { paymentsService } = await import('./payments.service.js');

    await paymentsService.verifyPayment({
      bookingId: 'booking-1',
      userId: 'user-1',
      razorpay_order_id: 'order-1',
      razorpay_payment_id: 'pay-1',
      razorpay_signature: 'sig',
    });

    expect(updatePaymentStatus).toHaveBeenCalledWith(
      expect.anything(),
      'payment-1',
      'completed',
      expect.objectContaining({ providerRef: 'order-1' }),
    );
  });

  it('marks webhook payment failures without confirming the booking', async () => {
    updatePaymentStatus.mockResolvedValue({
      rows: [{ id: 'payment-1', booking_id: 'booking-1', user_id: 'user-1', status: 'failed' }],
    });
    const { paymentsService } = await import('./payments.service.js');

    await paymentsService.handleWebhook({
      id: 'evt-1',
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: 'pay-1',
            order_id: 'order-1',
            error_description: 'Declined',
          },
        },
      },
    });

    expect(updatePaymentStatus).toHaveBeenCalledWith(
      expect.anything(),
      'payment-1',
      'failed',
      expect.objectContaining({ failedReason: 'Declined' })
    );
    expect(confirmBooking).not.toHaveBeenCalled();
  });

  it('returns early when the webhook event was already processed', async () => {
    getWebhookEventById.mockResolvedValue({ rows: [{ event_id: 'evt-1' }] });
    const { paymentsService } = await import('./payments.service.js');

    const result = await paymentsService.handleWebhook({
      id: 'evt-1',
      event: 'payment.failed',
      payload: {},
    });

    expect(result).toEqual({ success: true, message: 'duplicate' });
    expect(updatePaymentStatus).not.toHaveBeenCalled();
  });

  it('dedupes webhooks by x-razorpay-event-id header in preference to body id', async () => {
    getWebhookEventById.mockResolvedValue({ rows: [{ event_id: 'header-evt-9' }] });
    const { paymentsService } = await import('./payments.service.js');

    const result = await paymentsService.handleWebhook(
      {
        // Body has a different id; the header should win for dedupe.
        id: 'body-evt-other',
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay-1', order_id: 'order-1' } } },
      },
      { eventIdFromHeader: 'header-evt-9' },
    );

    expect(getWebhookEventById).toHaveBeenCalledWith('header-evt-9');
    expect(result).toEqual({ success: true, message: 'duplicate' });
    expect(updatePaymentStatus).not.toHaveBeenCalled();
  });

  it('auto-refunds captured payments when the booking is already expired', async () => {
    getInternalBooking.mockResolvedValue({
      id: 'booking-1',
      user_id: 'user-1',
      status: 'expired',
    });
    getPaymentByBookingForUpdate.mockResolvedValue({
      rows: [{ id: 'payment-1', booking_id: 'booking-1', user_id: 'user-1', status: 'completed', provider_ref: 'order-1', amount_paise: 50000, provider_payment_id: 'pay-1' }],
    });
    const { paymentsService } = await import('./payments.service.js');

    await paymentsService.handleWebhook({
      id: 'evt-2',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay-1',
            order_id: 'order-1',
            amount: 50000,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });

    expect(refundPayment).toHaveBeenCalled();
    expect(createRefundRecord).toHaveBeenCalled();
    expect(confirmBooking).not.toHaveBeenCalled();
  });

  it('records partial cancellation refunds as partially_refunded', async () => {
    getPaymentByBookingForUpdate.mockResolvedValue({
      rows: [{
        id: 'payment-1',
        booking_id: 'booking-1',
        user_id: 'user-1',
        status: 'completed',
        provider_ref: 'order-1',
        provider_payment_id: 'pay-1',
        amount_paise: 50000,
      }],
    });
    const { paymentsService } = await import('./payments.service.js');

    await paymentsService.refundCompletedBooking({
      bookingId: 'booking-1',
      paymentId: 'payment-1',
      userId: 'user-1',
      refundPaise: 25000,
    });

    expect(refundPayment).toHaveBeenCalledWith(expect.objectContaining({
      paymentId: 'pay-1',
      amountPaise: 25000,
    }));
    expect(createRefundRecord).toHaveBeenCalledWith(
      expect.anything(),
      'payment-1',
      expect.objectContaining({ refundedPaise: 25000, refundStatus: 'partially_refunded' }),
      25000,
      'partially_refunded',
    );
  });

  it('keeps zero-refund cancellations completed instead of marking them refunded', async () => {
    getPaymentByBookingForUpdate.mockResolvedValue({
      rows: [{
        id: 'payment-1',
        booking_id: 'booking-1',
        user_id: 'user-1',
        status: 'completed',
        provider_ref: 'order-1',
        provider_payment_id: 'pay-1',
        amount_paise: 50000,
      }],
    });
    const { paymentsService } = await import('./payments.service.js');

    await paymentsService.refundCompletedBooking({
      bookingId: 'booking-1',
      paymentId: 'payment-1',
      userId: 'user-1',
      refundPaise: 0,
    });

    expect(refundPayment).not.toHaveBeenCalled();
    expect(createRefundRecord).toHaveBeenCalledWith(
      expect.anything(),
      'payment-1',
      expect.objectContaining({ refundedPaise: 0, refundStatus: 'completed' }),
      0,
      'completed',
    );
  });

  it('marks refund.processed webhook as partially_refunded for partial Razorpay refunds', async () => {
    getPaymentByProviderPaymentIdForUpdate.mockResolvedValue({
      rows: [{
        id: 'payment-1',
        booking_id: 'booking-1',
        user_id: 'user-1',
        status: 'partially_refunded',
        provider_ref: 'order-1',
        provider_payment_id: 'pay-1',
        amount_paise: 50000,
        refund_paise: 25000,
      }],
    });
    const { paymentsService } = await import('./payments.service.js');

    await paymentsService.handleWebhook({
      id: 'evt-refund-partial',
      event: 'refund.processed',
      payload: {
        refund: {
          entity: {
            id: 'rfnd-1',
            payment_id: 'pay-1',
            amount: 25000,
          },
        },
      },
    });

    expect(updatePaymentStatus).toHaveBeenCalledWith(
      expect.anything(),
      'payment-1',
      'partially_refunded',
      expect.objectContaining({ providerPaymentId: 'pay-1', providerRef: 'order-1' }),
    );
  });

  it('does not complete the booking when payment.captured webhook amount disagrees with the stored payment', async () => {
    getPaymentByOrderForUpdate.mockResolvedValue({
      rows: [{
        id: 'payment-1',
        booking_id: 'booking-1',
        user_id: 'user-1',
        status: 'pending',
        provider_ref: 'order-1',
        amount_paise: 50000,
        currency: 'INR',
        provider_payment_id: null,
      }],
    });
    const { paymentsService } = await import('./payments.service.js');

    await paymentsService.handleWebhook({
      id: 'evt-amount-mismatch',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay-1',
            order_id: 'order-1',
            amount: 1, // attacker tries to capture for 1 paise
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });

    expect(updatePaymentStatus).not.toHaveBeenCalled();
    expect(confirmBooking).not.toHaveBeenCalled();
  });

  it('does not complete the booking when payment.captured webhook currency disagrees with the stored payment', async () => {
    getPaymentByOrderForUpdate.mockResolvedValue({
      rows: [{
        id: 'payment-1',
        booking_id: 'booking-1',
        user_id: 'user-1',
        status: 'pending',
        provider_ref: 'order-1',
        amount_paise: 50000,
        currency: 'INR',
        provider_payment_id: null,
      }],
    });
    const { paymentsService } = await import('./payments.service.js');

    await paymentsService.handleWebhook({
      id: 'evt-currency-mismatch',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay-1',
            order_id: 'order-1',
            amount: 50000,
            currency: 'USD',
            status: 'captured',
          },
        },
      },
    });

    expect(updatePaymentStatus).not.toHaveBeenCalled();
    expect(confirmBooking).not.toHaveBeenCalled();
  });

  it('settles an on-behalf booking on payment_link.paid: inserts a completed payment and confirms', async () => {
    // Host-books-on-behalf has no pre-created payment row, so the webhook must
    // insert one before confirming (the DB trigger requires a completed payment).
    getInternalBooking.mockResolvedValue({
      id: 'booking-1',
      user_id: 'host-1',
      status: 'pending',
      booked_on_behalf: true,
      agreed_price_paise: 50000,
      currency: 'INR',
      subtotal_paise: 42000,
      platform_fee_paise: 3000,
      taxes_paise: 5000,
      discount_paise: null,
    });
    // No prior payment row for this booking.
    getPaymentByBookingForUpdate.mockResolvedValue({ rows: [] });
    const { paymentsService } = await import('./payments.service.js');

    await paymentsService.handleWebhook({
      id: 'evt-plink-1',
      event: 'payment_link.paid',
      payload: {
        payment_link: {
          entity: { id: 'plink-1', amount: 50000, currency: 'INR', status: 'paid', notes: { bookingId: 'booking-1' } },
        },
        payment: {
          entity: { id: 'pay-1', order_id: 'order-plink-1', amount: 50000, currency: 'INR', status: 'captured' },
        },
      },
    });

    expect(insertPayment).toHaveBeenCalled();
    expect(updatePaymentStatus).toHaveBeenCalledWith(expect.anything(), 'payment-1', 'completed', expect.anything());
    expect(confirmBooking).toHaveBeenCalledWith('booking-1', expect.objectContaining({ skipCompletedPaymentCheck: true }));
  });

  it('ignores payment_link.paid when the paid amount disagrees with the booking total', async () => {
    getInternalBooking.mockResolvedValue({
      id: 'booking-1',
      user_id: 'host-1',
      status: 'pending',
      booked_on_behalf: true,
      agreed_price_paise: 50000,
      currency: 'INR',
    });
    getPaymentByBookingForUpdate.mockResolvedValue({ rows: [] });
    const { paymentsService } = await import('./payments.service.js');

    await paymentsService.handleWebhook({
      id: 'evt-plink-mismatch',
      event: 'payment_link.paid',
      payload: {
        payment_link: {
          entity: { id: 'plink-2', amount: 1, currency: 'INR', status: 'paid', notes: { bookingId: 'booking-1' } },
        },
        payment: {
          entity: { id: 'pay-2', order_id: 'order-plink-2', amount: 1, currency: 'INR', status: 'captured' },
        },
      },
    });

    expect(insertPayment).not.toHaveBeenCalled();
    expect(confirmBooking).not.toHaveBeenCalled();
  });

  // Use the actual mockPaymentProvider (no fetchPayment / capturePayment) to
  // prove the local mock flow still works end-to-end after we stripped the
  // mock fetch/capture stubs.
  it('verifies and confirms when running against the real mockPaymentProvider', async () => {
    const { mockPaymentProvider } = await import('../../../common/providers/implementations/payment/mock-payment.provider.js');
    getPaymentProvider.mockResolvedValue(mockPaymentProvider);

    const order = await mockPaymentProvider.createOrder({
      bookingId: 'booking-1',
      userId: 'user-1',
      amountPaise: 50000,
      currency: 'INR',
      insurancePremium: 0,
    });

    getPaymentByBookingForUpdate.mockResolvedValue({
      rows: [{
        id: 'payment-1',
        booking_id: 'booking-1',
        user_id: 'user-1',
        status: 'pending',
        provider_ref: order.orderId,
        amount_paise: 50000,
        currency: 'INR',
        provider_payment_id: null,
      }],
    });

    const { paymentsService } = await import('./payments.service.js');

    const result = await paymentsService.verifyPayment({
      bookingId: 'booking-1',
      userId: 'user-1',
      razorpay_order_id: order.orderId,
      razorpay_payment_id: 'pay_mock_1',
      razorpay_signature: 'mock-sig',
    });

    expect(result).toEqual({ success: true, message: 'Payment verified, booking confirmed', paymentId: 'payment-1' });
    expect(updatePaymentStatus).toHaveBeenCalledWith(
      expect.anything(),
      'payment-1',
      'completed',
      expect.objectContaining({ providerRef: order.orderId, providerPaymentId: 'pay_mock_1' }),
    );
    expect(confirmBooking).toHaveBeenCalled();
  });
});
