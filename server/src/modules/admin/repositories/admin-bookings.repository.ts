import { query } from '../../../common/db/postgres.js';

export interface AdminBookingFilters {
  bookingId?: string;
  /** Matches guest uid exactly, or guest email/phone/name fuzzily. */
  userQuery?: string;
  listingId?: string;
  status?: string;
  bookedOnBehalf?: boolean;
  from?: string; // scheduled_date >=
  to?: string;   // scheduled_date <=
  /** Multi-selects. States/cities match the LISTING's location (free-text
   *  columns, compared case-insensitively). Types match the listing's
   *  listing_type; categories match the booking's own service_category
   *  falling back to the listing's category. */
  states?: string[];
  cities?: string[];
  types?: string[];
  categories?: string[];
  providerIds?: string[];
  limit: number;
  offset: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normalize a multi-select's values for case-insensitive SQL comparison. */
export const lowerList = (values: string[]) =>
  values.map((v) => v.trim().toLowerCase()).filter(Boolean);

export const adminBookingsRepository = {
  async search(filters: AdminBookingFilters) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replaceAll('?', `$${params.length}`));
    };

    if (filters.bookingId && UUID_RE.test(filters.bookingId)) {
      add('b.id = ?::uuid', filters.bookingId);
    }
    if (filters.userQuery) {
      add(`(b.user_id = ? OR up.email ILIKE '%' || ? || '%'
            OR up.phone ILIKE '%' || ? || '%' OR up.display_name ILIKE '%' || ? || '%'
            OR b.guest_contact->>'phone' ILIKE '%' || ? || '%')`, filters.userQuery);
    }
    if (filters.listingId && UUID_RE.test(filters.listingId)) {
      add('b.listing_id = ?::uuid', filters.listingId);
    }
    if (filters.status) add('b.status = ?', filters.status);
    if (filters.bookedOnBehalf !== undefined) add('b.booked_on_behalf = ?', filters.bookedOnBehalf);
    if (filters.from) add('b.scheduled_date >= ?::date', filters.from);
    if (filters.to) add('b.scheduled_date <= ?::date', filters.to);
    if (filters.states?.length) add('lower(btrim(l.state)) = ANY(?)', lowerList(filters.states));
    if (filters.cities?.length) add('lower(btrim(l.city)) = ANY(?)', lowerList(filters.cities));
    if (filters.types?.length) add('lower(l.listing_type) = ANY(?)', lowerList(filters.types));
    if (filters.categories?.length) {
      add('lower(btrim(COALESCE(b.service_category, l.category))) = ANY(?)', lowerList(filters.categories));
    }
    if (filters.providerIds?.length) {
      // Non-UUID values match nothing (rather than throwing / being dropped):
      // the admin explicitly narrowed to providers, so never widen silently.
      add('b.provider_id = ANY(?::uuid[])', filters.providerIds.filter((id) => UUID_RE.test(id)));
    }

    params.push(filters.limit, filters.offset);
    const result = await query(
      `
      SELECT b.id, b.status, b.user_id, b.listing_id, b.provider_id,
             b.scheduled_date, b.end_date, b.start_time, b.end_time,
             b.service_category, b.agreed_price_paise, b.created_at,
             b.cancelled_at, b.cancellation_reason,
             b.booked_on_behalf, b.created_by_user_id, b.guest_contact, b.payment_link_url,
             l.name AS listing_name, l.listing_type,
             up.display_name AS guest_name, up.email AS guest_email, up.phone AS guest_phone,
             pp.display_name AS provider_name,
             p.amount_paise  AS payment_amount_paise,
             p.status        AS payment_status,
             p.refund_paise  AS payment_refund_paise,
             COUNT(*) OVER() AS total_count
      FROM bookings b
      LEFT JOIN listings l ON l.id = b.listing_id
      LEFT JOIN user_profiles up ON up.user_id = b.user_id
      LEFT JOIN provider_profiles pp ON pp.id = b.provider_id
      LEFT JOIN LATERAL (
        SELECT amount_paise, status, refund_paise
          FROM payments
         WHERE booking_id = b.id
         ORDER BY created_at DESC
         LIMIT 1
      ) p ON true
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY b.created_at DESC NULLS LAST, b.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );
    return {
      rows: result.rows.map(({ total_count: _t, ...row }) => row),
      total: result.rows.length ? Number(result.rows[0].total_count) : 0,
    };
  },

  /**
   * Stamp the admin's cancel reason onto the booking row so the detail
   * drawer's "Reason:" line renders. The shared updateStatus path never
   * writes cancellation_reason (for any actor), so this doesn't clobber
   * anything — admin_actions remains the authoritative audit record.
   */
  async setCancellationReason(bookingId: string, reason: string) {
    await query('UPDATE bookings SET cancellation_reason = $2 WHERE id = $1', [bookingId, reason]);
  },

  /** Every payment attempt for the booking, newest first (detail view). */
  async listPayments(bookingId: string) {
    const result = await query(
      `SELECT id, status, amount_paise, currency, provider_ref, provider_payment_id,
              subtotal_paise, platform_fee_paise, taxes_paise, insurance_premium_paise,
              discount_paise, refund_paise, completed_at, created_at
       FROM payments
       WHERE booking_id = $1
       ORDER BY created_at DESC`,
      [bookingId]
    );
    return result.rows;
  },
};
