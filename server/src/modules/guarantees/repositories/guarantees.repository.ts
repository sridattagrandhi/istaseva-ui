import { dbQuery } from '../../../common/repositories/database.js';

export class GuaranteesRepository {
  create(userId: string, payload: {
    booking_id: string;
    provider_id: string;
    service_category: string;
    guarantee_months: number;
    guarantee_label: string;
    expires_at?: string;
  }) {
    return dbQuery(
      `INSERT INTO service_guarantees
       (booking_id, user_id, provider_id, service_category, guarantee_months, guarantee_label, starts_at, expires_at, claim_status)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), COALESCE($7::timestamptz, NOW() + ($5 || ' months')::interval), 'none')
       RETURNING *`,
      [
        payload.booking_id,
        userId,
        payload.provider_id,
        payload.service_category,
        payload.guarantee_months,
        payload.guarantee_label,
        payload.expires_at || null,
      ]
    );
  }

  getByBookingId(bookingId: string, userId: string) {
    return dbQuery(
      'SELECT * FROM service_guarantees WHERE booking_id = $1 AND user_id = $2 LIMIT 1',
      [bookingId, userId]
    );
  }

  fileClaim(guaranteeId: string, userId: string, description: string) {
    return dbQuery(
      `UPDATE service_guarantees
       SET claim_status = 'pending', claim_description = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [description, guaranteeId, userId]
    );
  }
}

export const guaranteesRepository = new GuaranteesRepository();
