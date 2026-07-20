import type pg from 'pg';
import { query } from '../../../common/db/postgres.js';

export interface AdminUserRow {
  user_id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  verification_status: string | null;
  is_suspended: boolean;
  suspended_at: string | null;
  suspension_reason: string | null;
  created_at: string;
}

const USER_COLS = `user_id, display_name, email, phone, verification_status,
  is_suspended, suspended_at, suspension_reason, created_at`;

export const adminUsersRepository = {
  /**
   * Upsert so a user who has never hit an authenticated endpoint (no profile
   * row yet) can still be suspended — the flag must exist before their first
   * request, not after.
   */
  async suspend(userId: string, reason: string, client: pg.PoolClient): Promise<AdminUserRow> {
    const result = await client.query<AdminUserRow>(
      `INSERT INTO user_profiles (user_id, is_suspended, suspended_at, suspension_reason)
       VALUES ($1, true, now(), $2)
       ON CONFLICT (user_id) DO UPDATE
         SET is_suspended = true, suspended_at = now(), suspension_reason = $2, updated_at = now()
       RETURNING ${USER_COLS}`,
      [userId, reason]
    );
    return result.rows[0];
  },

  async unsuspend(userId: string, client: pg.PoolClient): Promise<AdminUserRow | null> {
    const result = await client.query<AdminUserRow>(
      `UPDATE user_profiles
       SET is_suspended = false, suspended_at = NULL, suspension_reason = NULL, updated_at = now()
       WHERE user_id = $1
       RETURNING ${USER_COLS}`,
      [userId]
    );
    return result.rows[0] ?? null;
  },

  async getByUserId(userId: string): Promise<AdminUserRow | null> {
    const result = await query<AdminUserRow>(
      `SELECT ${USER_COLS} FROM user_profiles WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0] ?? null;
  },

  /** Lookup by exact uid, or fuzzy email/phone/name — the ops-console user finder. */
  async search(q: string, limit: number): Promise<AdminUserRow[]> {
    const result = await query<AdminUserRow>(
      `SELECT ${USER_COLS}
       FROM user_profiles
       WHERE user_id = $1
          OR email ILIKE '%' || $1 || '%'
          OR phone ILIKE '%' || $1 || '%'
          OR display_name ILIKE '%' || $1 || '%'
       ORDER BY (user_id = $1) DESC, created_at DESC
       LIMIT $2`,
      [q, limit]
    );
    return result.rows;
  },
};
