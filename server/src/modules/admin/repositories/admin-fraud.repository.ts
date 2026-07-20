import { query } from '../../../common/db/postgres.js';

export interface FraudSignalRow {
  id: string;
  user_id: string;
  event_type: string;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  device_id: string | null;
  session_id: string | null;
  ip_address: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  user_name?: string | null;
  user_email?: string | null;
  user_suspended?: boolean | null;
  total_count?: string;
}

export interface FraudSignalFilters {
  userId?: string;
  riskLevel?: string;
  eventType?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

export const adminFraudRepository = {
  async listSignals(filters: FraudSignalFilters): Promise<{ rows: FraudSignalRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };

    if (filters.userId) add('f.user_id = ?', filters.userId);
    if (filters.riskLevel) add('f.risk_level = ?', filters.riskLevel);
    if (filters.eventType) add('f.event_type = ?', filters.eventType);
    if (filters.from) add('f.created_at >= ?::date', filters.from);
    // Inclusive end day — `<= '2026-07-06'` on timestamptz means midnight.
    if (filters.to) add(`f.created_at < (?::date + INTERVAL '1 day')`, filters.to);

    params.push(filters.limit, filters.offset);
    const result = await query<FraudSignalRow>(
      `
      SELECT f.*, u.display_name AS user_name, u.email AS user_email, u.is_suspended AS user_suspended,
             COUNT(*) OVER() AS total_count
      FROM fraud_signals f
      LEFT JOIN user_profiles u ON u.user_id = f.user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY f.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );
    return {
      rows: result.rows.map(({ total_count: _t, ...row }) => row as FraudSignalRow),
      total: result.rows.length ? Number(result.rows[0].total_count) : 0,
    };
  },

  /** Distinct event types seen (filter dropdown). */
  async listEventTypes(): Promise<string[]> {
    const result = await query<{ event_type: string }>(
      `SELECT DISTINCT event_type FROM fraud_signals ORDER BY event_type LIMIT 100`
    );
    return result.rows.map((r) => r.event_type);
  },

  async listSafetyAlerts(userId: string, limit = 20) {
    const result = await query(
      `SELECT id, user_id, booking_id, alert_type, description, status,
              emergency_contacts_notified, created_at
       FROM safety_alerts
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows;
  },

  async bookingStats(userId: string) {
    const result = await query<{ status: string; count: string }>(
      `SELECT status, COUNT(*) AS count FROM bookings WHERE user_id = $1 GROUP BY status`,
      [userId]
    );
    return Object.fromEntries(result.rows.map((r) => [r.status, Number(r.count)]));
  },
};
