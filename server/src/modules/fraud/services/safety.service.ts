import { dbQuery } from '../../../common/repositories/database.js';
import { logAuditEvent } from '../../../common/logging/audit-log.js';
import { ForbiddenError, NotFoundError } from '../../../common/errors/app-error.js';
import type { CreateSafetyAlertInput, CreateSafetyCheckInput } from '../schemas/safety.schema.js';

export class SafetyService {
  // SEC-006: safety records may only reference bookings the caller is a party
  // to — the booking's customer or the owning provider's user. Anything else
  // would let any account attach false emergency/safety records to arbitrary
  // bookings.
  private async assertBookingParty(bookingId: string, userId: string): Promise<void> {
    const result = await dbQuery<{ user_id: string; provider_user_id: string | null }>(
      `SELECT b.user_id, pp.user_id AS provider_user_id
       FROM bookings b
       LEFT JOIN provider_profiles pp ON pp.id = b.provider_id
       WHERE b.id = $1`,
      [bookingId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Booking', bookingId);
    if (row.user_id !== userId && row.provider_user_id !== userId) {
      throw new ForbiddenError('You are not a party to this booking');
    }
  }

  async createAlert(userId: string, input: CreateSafetyAlertInput) {
    if (input.booking_id) await this.assertBookingParty(input.booking_id, userId);

    // status and emergency_contacts_notified are server-owned (SEC-006):
    // alerts always open as 'open', and contacts are only marked notified by
    // the server-side path that actually notifies them.
    const result = await dbQuery(
      `INSERT INTO safety_alerts
       (user_id, booking_id, alert_type, description, location_lat, location_lng, status, emergency_contacts_notified)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', false)
       RETURNING *`,
      [
        userId,
        input.booking_id ?? null,
        input.alert_type,
        input.description ?? null,
        input.location_lat ?? null,
        input.location_lng ?? null,
      ]
    );
    const alert = result.rows[0];

    logAuditEvent({
      event: 'safety.alert_created',
      user_id: userId,
      metadata: {
        alertId: alert?.id,
        alertType: alert?.alert_type,
        bookingId: alert?.booking_id,
      },
    });

    return { data: alert };
  }

  async listAlerts(userId: string) {
    const result = await dbQuery(
      'SELECT * FROM safety_alerts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25',
      [userId]
    );
    return { data: result.rows };
  }

  async createCheck(userId: string, input: CreateSafetyCheckInput) {
    await this.assertBookingParty(input.booking_id, userId);

    // initiated_by is the authenticated caller's user id, never a client
    // claim (SEC-006 actor forgery). The caller's role on the booking is
    // derivable by joining bookings/provider_profiles.
    const result = await dbQuery(
      `INSERT INTO safety_checks
       (booking_id, check_type, initiated_by, response, is_resolved, severity)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.booking_id,
        input.check_type,
        userId,
        input.response,
        input.is_resolved ?? true,
        input.severity,
      ]
    );
    return { data: result.rows[0] };
  }
}

export const safetyService = new SafetyService();
