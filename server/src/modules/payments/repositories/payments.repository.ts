import type pg from 'pg';
import { dbQuery } from '../../../common/repositories/database.js';
import type { PaymentStatus } from '../schemas/payment-status.js';

export class PaymentsRepository {
  getPendingBooking(bookingId: string, userId: string) {
    return dbQuery(
      'SELECT * FROM bookings WHERE id = $1 AND user_id = $2 AND status = $3 AND (hold_expires_at IS NULL OR hold_expires_at > NOW())',
      [bookingId, userId, 'pending']
    );
  }

  getPendingBookingWithAuthoritativePrice(bookingId: string, userId: string) {
    return dbQuery(
      `SELECT
         b.id,
         b.user_id,
         b.provider_id,
         b.service_category,
         b.status,
         b.hold_expires_at,
         b.agreed_price_paise,
         b.coupon_id,
         b.subtotal_paise,
         b.platform_fee_paise,
         b.taxes_paise,
         b.discount_paise,
         l.id AS listing_id,
         l.category AS listing_category,
         l.price_per_night,
         l.price
       FROM bookings b
       JOIN provider_profiles pp ON pp.id = b.provider_id
       LEFT JOIN LATERAL (
         SELECT l.id, l.category, l.price_per_night, l.price
         FROM listings l
         WHERE l.user_id = pp.user_id
           AND COALESCE(l.is_active, true) = true
         ORDER BY
           CASE WHEN l.category = b.service_category THEN 0 ELSE 1 END,
           l.updated_at DESC
         LIMIT 1
       ) l ON true
       WHERE b.id = $1
         AND b.user_id = $2
         AND b.status = 'pending'
         AND (b.hold_expires_at IS NULL OR b.hold_expires_at > NOW())
       LIMIT 1`,
      [bookingId, userId]
    );
  }

  getBookingForUser(bookingId: string, userId: string) {
    return dbQuery(
      `SELECT * FROM bookings
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [bookingId, userId]
    );
  }

  findByIdempotencyKey(userId: string, idempotencyKey: string) {
    return dbQuery(
      `SELECT * FROM payments
       WHERE user_id = $1 AND idempotency_key = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, idempotencyKey]
    );
  }

  insertPayment(params: {
    bookingId: string;
    userId: string;
    amountPaise: number;
    currency: string;
    orderId: string;
    metadata: Record<string, unknown>;
    idempotencyKey?: string;
    /** Fee breakdown — persisted so cancellation refunds and host payouts
     *  read from one source of truth, not from frontend rate constants.
     *  Optional for rare callers (room upgrades) that don't have the split. */
    subtotalPaise?: number | null;
    platformFeePaise?: number | null;
    taxesPaise?: number | null;
    insurancePremiumPaise?: number | null;
    /** Coupon discount applied to the total, in paise. NULL when no coupon. */
    discountPaise?: number | null;
  }, client?: pg.PoolClient) {
    // The payments table has both `amount` (NUMERIC, original) and `amount_paise` (INTEGER, added later).
    // Both are NOT NULL, so we must set both.
    //
    // `client` matters when the caller's transaction already holds a FOR
    // UPDATE lock on the booking row (payment_link.paid webhook): this
    // INSERT's FK check needs a KEY SHARE lock on that row, so running it on
    // a separate pool connection self-deadlocks until statement_timeout.
    const amountRupees = params.amountPaise / 100;
    const run = client
      ? client.query.bind(client)
      : dbQuery;
    return run(
      `INSERT INTO payments (
         booking_id, user_id, amount, amount_paise, currency, status, provider_ref, metadata, idempotency_key,
         subtotal_paise, platform_fee_paise, taxes_paise, insurance_premium_paise, discount_paise
       )
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        params.bookingId,
        params.userId,
        amountRupees,
        params.amountPaise,
        params.currency,
        params.orderId,
        JSON.stringify(params.metadata),
        params.idempotencyKey ?? null,
        params.subtotalPaise ?? null,
        params.platformFeePaise ?? null,
        params.taxesPaise ?? null,
        params.insurancePremiumPaise ?? null,
        params.discountPaise ?? null,
      ]
    );
  }

  insertInsurancePolicy(bookingId: string, userId: string, premiumAmount: number) {
    return dbQuery(
      `INSERT INTO insurance_policies (booking_id, user_id, premium_amount, coverage_amount, coverage_type, status)
       VALUES ($1, $2, $3, 500, 'standard', 'active')
       ON CONFLICT DO NOTHING`,
      [bookingId, userId, premiumAmount]
    );
  }

  getPaymentByBookingForUpdate(client: pg.PoolClient, bookingId: string) {
    return client.query(
      `SELECT * FROM payments
       WHERE booking_id = $1
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [bookingId]
    );
  }

  getPaymentByOrderForUpdate(client: pg.PoolClient, providerRef: string) {
    return client.query(
      `SELECT * FROM payments
       WHERE provider_ref = $1
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [providerRef]
    );
  }

  getPaymentByProviderPaymentIdForUpdate(client: pg.PoolClient, providerPaymentId: string) {
    return client.query(
      `SELECT * FROM payments
       WHERE provider_payment_id = $1
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [providerPaymentId]
    );
  }

  getLatestPaymentByBooking(bookingId: string) {
    return dbQuery(
      `SELECT * FROM payments
       WHERE booking_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [bookingId]
    );
  }

  getCompletedPaymentForBooking(bookingId: string) {
    return dbQuery(
      `SELECT * FROM payments
       WHERE booking_id = $1 AND status = 'completed'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [bookingId]
    );
  }

  updatePaymentStatus(client: pg.PoolClient, paymentId: string, status: PaymentStatus, params?: {
    providerPaymentId?: string | null;
    providerRef?: string | null;
    failedReason?: string | null;
  }) {
    return client.query(
      `UPDATE payments
       SET status = $1::text::public.payment_status,
           provider_payment_id = COALESCE($2, provider_payment_id),
           provider_ref = COALESCE($3, provider_ref),
           failed_reason = COALESCE($4, failed_reason),
           completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE completed_at END,
           refunded_at = CASE WHEN $1 = 'refunded' THEN NOW() ELSE refunded_at END,
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [
        status,
        params?.providerPaymentId ?? null,
        params?.providerRef ?? null,
        params?.failedReason ?? null,
        paymentId,
      ]
    );
  }

  async releaseBookingLock(client: pg.PoolClient, booking: any) {
    await client.query(
      `UPDATE slot_locks
       SET status = 'released', released_at = NOW()
       WHERE booking_id = $1 AND status = 'active'`,
      [booking.id]
    );
  }

  async insertGuarantee(client: pg.PoolClient, booking: any) {
    await client.query(
      `INSERT INTO service_guarantees
       (booking_id, user_id, provider_id, service_category, guarantee_months, guarantee_label, starts_at, expires_at)
       VALUES ($1, $2, $3, $4, 3, '3-month service guarantee', NOW(), NOW() + INTERVAL '3 months')
       ON CONFLICT DO NOTHING`,
      [booking.id, booking.user_id, booking.provider_id, booking.service_category]
    );
  }

  createRefundRecord(
    client: pg.PoolClient,
    paymentId: string,
    metadata?: Record<string, unknown>,
    refundPaise?: number | null,
    status: Extract<PaymentStatus, 'completed' | 'partially_refunded' | 'refunded'> = 'refunded',
  ) {
    return client.query(
      `UPDATE payments
       SET status = $4::text::public.payment_status,
           metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
           refund_paise = COALESCE($3, refund_paise),
           refunded_at = CASE
             WHEN $4 IN ('partially_refunded', 'refunded') THEN NOW()
             ELSE refunded_at
           END,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(metadata ?? { refundInitiated: true }), paymentId, refundPaise ?? null, status]
    );
  }

  voidInsurancePolicy(client: pg.PoolClient, bookingId: string) {
    return client.query(
      `UPDATE insurance_policies
       SET status = 'cancelled',
           updated_at = NOW()
       WHERE booking_id = $1 AND status = 'active'`,
      [bookingId]
    );
  }

  insertWebhookEventIfNew(client: pg.PoolClient, eventId: string, eventType: string) {
    return client.query(
      `INSERT INTO webhook_events (event_id, event_type)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING event_id`,
      [eventId, eventType]
    );
  }

  getWebhookEventById(eventId: string) {
    return dbQuery(
      `SELECT event_id
       FROM webhook_events
       WHERE event_id = $1
       LIMIT 1`,
      [eventId]
    );
  }

  updatePaymentStatusByProviderRef(providerRef: string, status: PaymentStatus) {
    return dbQuery(
      `UPDATE payments SET status = $1, updated_at = NOW()
       WHERE provider_ref = $2`,
      [status, providerRef]
    );
  }
}

export const paymentsRepository = new PaymentsRepository();
