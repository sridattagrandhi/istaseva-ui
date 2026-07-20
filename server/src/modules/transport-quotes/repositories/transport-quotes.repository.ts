import { dbQuery } from '../../../common/repositories/database.js';

export class TransportQuotesRepository {
  create(input: {
    userId: string;
    providerId: string;
    listingId: string;
    pickupAddress: string;
    dropAddress: string;
    stops: unknown;
    scheduledDate: string;
    scheduledTime?: string | null;
    estimatedKm?: number | null;
    estimatedDurationMinutes?: number | null;
    customerNotes?: string | null;
  }) {
    return dbQuery(
      `INSERT INTO transport_quotes (
         user_id, provider_id, listing_id,
         pickup_address, drop_address, stops,
         scheduled_date, scheduled_time, estimated_km,
         estimated_duration_minutes, customer_notes, status
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,'pending')
       RETURNING *`,
      [
        input.userId,
        input.providerId,
        input.listingId,
        input.pickupAddress,
        input.dropAddress,
        JSON.stringify(input.stops ?? []),
        input.scheduledDate,
        input.scheduledTime ?? null,
        input.estimatedKm ?? null,
        input.estimatedDurationMinutes ?? null,
        input.customerNotes ?? null,
      ],
    );
  }

  getById(id: string) {
    return dbQuery(`SELECT * FROM transport_quotes WHERE id = $1 LIMIT 1`, [id]);
  }

  listForUser(userId: string, limit: number, offset: number) {
    return dbQuery(
      `SELECT q.*, l.name AS listing_name, l.vehicle_name, l.category AS listing_category
         FROM transport_quotes q
         LEFT JOIN listings l ON l.id = q.listing_id
        WHERE q.user_id = $1
        ORDER BY q.created_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
  }

  listForProvider(providerId: string, status: string | null, limit: number, offset: number) {
    return dbQuery(
      `SELECT q.*, l.name AS listing_name, l.vehicle_name, l.category AS listing_category,
              up.display_name AS customer_name
         FROM transport_quotes q
         LEFT JOIN listings l ON l.id = q.listing_id
         LEFT JOIN user_profiles up ON up.user_id = q.user_id
        WHERE q.provider_id = $1
          AND ($2::text IS NULL OR q.status = $2)
        ORDER BY q.created_at DESC
        LIMIT $3 OFFSET $4`,
      [providerId, status, limit, offset],
    );
  }

  submitProviderQuote(id: string, amountPaise: number, message?: string | null) {
    return dbQuery(
      `UPDATE transport_quotes
          SET status = 'quoted',
              provider_quote_paise = $2,
              provider_message = $3,
              quoted_at = NOW()
        WHERE id = $1
          AND status IN ('pending', 'quoted')
        RETURNING *`,
      [id, amountPaise, message ?? null],
    );
  }

  markAccepted(id: string) {
    return dbQuery(
      `UPDATE transport_quotes
          SET status = 'accepted',
              accepted_at = NOW()
        WHERE id = $1 AND status = 'quoted'
        RETURNING *`,
      [id],
    );
  }

  markBooked(id: string, bookingId: string) {
    return dbQuery(
      `UPDATE transport_quotes
          SET status = 'booked',
              booking_id = $2
        WHERE id = $1
        RETURNING *`,
      [id, bookingId],
    );
  }

  /**
   * Mark stale `pending`/`quoted` requests as expired.
   *
   * Pending → expires 7 days after creation (driver never replied).
   * Quoted  → expires 48h after the driver's quote (customer never decided).
   *
   * Idempotent + cheap; we call it lazily from list endpoints so a stale
   * dashboard view auto-cleans the rows it's about to display. A dedicated
   * cron would also work but the lazy sweep keeps the schema self-healing
   * without standing infrastructure.
   */
  sweepExpired() {
    return dbQuery(
      `UPDATE transport_quotes
          SET status = 'expired'
        WHERE status IN ('pending', 'quoted')
          AND (
            (status = 'pending' AND created_at < NOW() - INTERVAL '7 days')
            OR (status = 'quoted' AND quoted_at IS NOT NULL AND quoted_at < NOW() - INTERVAL '48 hours')
          )`,
    );
  }

  setStatus(id: string, status: 'rejected' | 'cancelled' | 'expired') {
    return dbQuery(
      `UPDATE transport_quotes
          SET status = $2
        WHERE id = $1
          AND status NOT IN ('booked', 'cancelled', 'rejected', 'expired')
        RETURNING *`,
      [id, status],
    );
  }
}

export const transportQuotesRepository = new TransportQuotesRepository();
