import type pg from 'pg';
import { dbQuery, runDbQuery } from '../../../common/repositories/database.js';

export type CouponCategory = 'stay' | 'service' | 'transport';

export interface CouponRow {
  id: string;
  /** NULL for platform coupons (is_platform = true). */
  host_user_id: string | null;
  /** Admin-created, platform-wide coupon — skips the host-ownership check. */
  is_platform: boolean;
  /** Admin Firebase UID for platform coupons. */
  created_by: string | null;
  listing_id: string | null;
  /** Listing category the coupon is scoped to. NULL = legacy host-wide
   *  coupon (back-compat); set explicitly when created from the service
   *  or transport dashboards so a transport coupon can't apply to a stay
   *  booking on consume. */
  category: CouponCategory | null;
  code: string;
  discount_type: 'percent' | 'fixed';
  discount_value: string; // numeric is returned as string by pg
  max_uses: number | null;
  /** Per-user redemption cap. Default 1 (once per customer); NULL = unlimited
   *  per user. Enforced in consume() under the coupon-row lock. */
  max_uses_per_user: number | null;
  uses_count: number;
  valid_from: string | null;
  valid_until: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  /** SUM(coupon_redemptions.discount_paise) — projected by listForHost
   *  (::bigint → string) and the admin list (::int → number). */
  redeemed_paise?: string | number | null;
}

export class CouponsRepository {
  /**
   * Scoped per-dashboard list. When `category` is passed, returns only that
   * dashboard's coupons (host=stay, provider=service, transport=transport)
   * — a host shouldn't see their transport-side coupons mixed into the
   * stays dashboard, and vice versa. Legacy NULL-category coupons (created
   * before the category column landed) are included in EVERY scoped query
   * so they keep rendering somewhere instead of disappearing entirely.
   * When `category` is omitted, returns the unfiltered set (back-compat).
   */
  listForHost(hostUserId: string, category?: CouponCategory) {
    // The redemption ledger join gives the dashboards "₹X in discounts given"
    // next to uses_count — coupon_redemptions rows are written in the same
    // transaction as the booking hold, so the two never disagree.
    const redeemedJoin = `LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(cr.discount_paise), 0)::bigint AS redeemed_paise
        FROM coupon_redemptions cr WHERE cr.coupon_id = c.id
      ) r ON TRUE`;
    if (!category) {
      return dbQuery<CouponRow>(
        `SELECT c.*, r.redeemed_paise FROM coupons c
         ${redeemedJoin}
         WHERE c.host_user_id = $1
         ORDER BY c.created_at DESC`,
        [hostUserId],
      );
    }
    return dbQuery<CouponRow>(
      `SELECT c.*, r.redeemed_paise FROM coupons c
       ${redeemedJoin}
       WHERE c.host_user_id = $1
         AND (c.category = $2 OR c.category IS NULL)
       ORDER BY c.created_at DESC`,
      [hostUserId, category],
    );
  }

  getById(id: string) {
    return dbQuery<CouponRow>(`SELECT * FROM coupons WHERE id = $1`, [id]);
  }

  findByCode(code: string, client?: pg.PoolClient) {
    const sql = `SELECT * FROM coupons WHERE UPPER(code) = UPPER($1) LIMIT 1`;
    return client ? runDbQuery<CouponRow>(client, sql, [code]) : dbQuery<CouponRow>(sql, [code]);
  }

  insert(row: {
    hostUserId: string;
    listingId: string | null;
    /** Optional category scope. When the host (or provider / driver)
     *  selects "All your {kind}" in the dashboard the caller stamps a
     *  category here so the consume gate later rejects bookings of any
     *  other kind. NULL is preserved for legacy host-wide coupons. */
    category: CouponCategory | null;
    code: string;
    discountType: 'percent' | 'fixed';
    discountValue: number;
    maxUses: number | null;
    /** Per-user cap. 1 = once per customer (default); NULL = unlimited per user. */
    maxUsesPerUser: number | null;
    validFrom: string | null;
    validUntil: string | null;
  }) {
    return dbQuery<CouponRow>(
      `INSERT INTO coupons (host_user_id, listing_id, category, code, discount_type, discount_value,
                            max_uses, max_uses_per_user, valid_from, valid_until)
       VALUES ($1, $2, $3, UPPER($4), $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        row.hostUserId,
        row.listingId,
        row.category,
        row.code,
        row.discountType,
        row.discountValue,
        row.maxUses,
        row.maxUsesPerUser,
        row.validFrom,
        row.validUntil,
      ],
    );
  }

  deleteForHost(id: string, hostUserId: string) {
    return dbQuery<CouponRow>(
      `DELETE FROM coupons WHERE id = $1 AND host_user_id = $2 RETURNING *`,
      [id, hostUserId],
    );
  }

  setActive(id: string, hostUserId: string, isActive: boolean) {
    return dbQuery<CouponRow>(
      `UPDATE coupons SET is_active = $3, updated_at = NOW()
       WHERE id = $1 AND host_user_id = $2
       RETURNING *`,
      [id, hostUserId, isActive],
    );
  }

  /**
   * User targeting ("certain people"): one round trip answering both
   * "does this coupon target specific users at all?" and "is this user one
   * of them?". No target rows = open to everyone in the coupon's scope.
   */
  checkUserTargeting(couponId: string, userId: string, client?: pg.PoolClient) {
    const sql = `
      SELECT EXISTS(SELECT 1 FROM coupon_users WHERE coupon_id = $1) AS has_targets,
             EXISTS(SELECT 1 FROM coupon_users WHERE coupon_id = $1 AND user_id = $2) AS is_target
    `;
    return client
      ? runDbQuery<{ has_targets: boolean; is_target: boolean }>(client, sql, [couponId, userId])
      : dbQuery<{ has_targets: boolean; is_target: boolean }>(sql, [couponId, userId]);
  }

  /** Redemption ledger row — written in the SAME transaction as the booking hold. */
  insertRedemption(
    client: pg.PoolClient,
    row: { couponId: string; bookingId: string | null; userId: string; discountPaise: number },
  ) {
    return runDbQuery(
      client,
      `INSERT INTO coupon_redemptions (coupon_id, booking_id, user_id, discount_paise)
       VALUES ($1, $2, $3, $4)`,
      [row.couponId, row.bookingId, row.userId, row.discountPaise],
    );
  }

  /**
   * How many times this user has already redeemed this coupon. Called under the
   * coupon-row lock in consume(), so concurrent holds by the same guest see a
   * consistent count.
   */
  async countUserRedemptions(couponId: string, userId: string, client: pg.PoolClient): Promise<number> {
    const res = await runDbQuery<{ n: number }>(
      client,
      `SELECT COUNT(*)::int AS n FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2`,
      [couponId, userId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Atomically bump uses_count if this use wouldn't exceed max_uses. Returns updated row or null. */
  incrementUsesIfAllowed(id: string, client: pg.PoolClient) {
    return runDbQuery<CouponRow>(
      client,
      `UPDATE coupons
         SET uses_count = uses_count + 1, updated_at = NOW()
       WHERE id = $1
         AND (max_uses IS NULL OR uses_count < max_uses)
       RETURNING *`,
      [id],
    );
  }
}

export const couponsRepository = new CouponsRepository();
