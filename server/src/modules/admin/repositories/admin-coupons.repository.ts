import type pg from 'pg';
import { query } from '../../../common/db/postgres.js';
import type { CouponRow } from '../../coupons/repositories/coupons.repository.js';

export interface AdminCouponRow extends CouponRow {
  redemption_count: number;
  redeemed_paise: number;
  target_user_count: number;
  listing_name: string | null;
  creator_name: string | null;
  total_count?: string;
}

export interface AdminCouponFilters {
  q?: string;               // code substring
  scope?: 'platform' | 'host';
  active?: boolean;
  limit: number;
  offset: number;
}

const COUPON_SELECT = `
  SELECT c.*,
         COALESCE(r.redemption_count, 0)::int AS redemption_count,
         COALESCE(r.redeemed_paise, 0)::int   AS redeemed_paise,
         COALESCE(t.target_user_count, 0)::int AS target_user_count,
         COALESCE(l.name, l.title)            AS listing_name,
         u.display_name                       AS creator_name
  FROM coupons c
  LEFT JOIN listings l ON l.id = c.listing_id
  LEFT JOIN user_profiles u ON u.user_id = COALESCE(c.created_by, c.host_user_id)
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS redemption_count, SUM(discount_paise) AS redeemed_paise
    FROM coupon_redemptions cr WHERE cr.coupon_id = c.id
  ) r ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS target_user_count FROM coupon_users cu WHERE cu.coupon_id = c.id
  ) t ON true
`;

export const adminCouponsRepository = {
  async list(filters: AdminCouponFilters): Promise<{ rows: AdminCouponRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };

    if (filters.q) add(`c.code ILIKE '%' || ? || '%'`, filters.q);
    if (filters.scope === 'platform') where.push('c.is_platform = true');
    else if (filters.scope === 'host') where.push('c.is_platform = false');
    if (filters.active !== undefined) add('c.is_active = ?', filters.active);

    params.push(filters.limit, filters.offset);
    const result = await query<AdminCouponRow & { total_count: string }>(
      `${COUPON_SELECT.replace('SELECT c.*,', 'SELECT c.*, COUNT(*) OVER() AS total_count,')}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY c.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return {
      rows: result.rows.map(({ total_count: _t, ...row }) => row as AdminCouponRow),
      total: result.rows.length ? Number(result.rows[0].total_count) : 0,
    };
  },

  async getById(couponId: string): Promise<AdminCouponRow | null> {
    const result = await query<AdminCouponRow>(`${COUPON_SELECT} WHERE c.id = $1`, [couponId]);
    return result.rows[0] ?? null;
  },

  insertPlatformCoupon(
    client: pg.PoolClient,
    row: {
      createdBy: string;
      listingId: string | null;
      category: string | null;
      code: string;
      discountType: 'percent' | 'fixed';
      discountValue: number;
      maxUses: number | null;
      validFrom: string | null;
      validUntil: string | null;
    }
  ) {
    return client.query<CouponRow>(
      `INSERT INTO coupons (host_user_id, is_platform, created_by, listing_id, category, code,
                            discount_type, discount_value, max_uses, valid_from, valid_until)
       VALUES (NULL, true, $1, $2, $3, UPPER($4), $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        row.createdBy,
        row.listingId,
        row.category,
        row.code,
        row.discountType,
        row.discountValue,
        row.maxUses,
        row.validFrom,
        row.validUntil,
      ]
    );
  },

  async insertTargetUsers(client: pg.PoolClient, couponId: string, userIds: string[]) {
    if (!userIds.length) return;
    await client.query(
      `INSERT INTO coupon_users (coupon_id, user_id)
       SELECT $1, unnest($2::text[])
       ON CONFLICT DO NOTHING`,
      [couponId, userIds]
    );
  },

  async listTargetUsers(couponId: string) {
    const result = await query(
      `SELECT cu.user_id, u.display_name, u.email
       FROM coupon_users cu
       LEFT JOIN user_profiles u ON u.user_id = cu.user_id
       WHERE cu.coupon_id = $1
       ORDER BY u.display_name NULLS LAST`,
      [couponId]
    );
    return result.rows;
  },

  async listRedemptions(couponId: string, limit = 100) {
    const result = await query(
      `SELECT cr.id, cr.booking_id, cr.user_id, cr.discount_paise, cr.created_at,
              u.display_name AS user_name, u.email AS user_email,
              b.status AS booking_status
       FROM coupon_redemptions cr
       LEFT JOIN user_profiles u ON u.user_id = cr.user_id
       LEFT JOIN bookings b ON b.id = cr.booking_id
       WHERE cr.coupon_id = $1
       ORDER BY cr.created_at DESC
       LIMIT $2`,
      [couponId, limit]
    );
    return result.rows;
  },

  /** Admin moderation: activate/deactivate ANY coupon (host or platform). */
  setActive(client: pg.PoolClient, couponId: string, isActive: boolean) {
    return client.query<CouponRow>(
      `UPDATE coupons SET is_active = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [couponId, isActive]
    );
  },
};
