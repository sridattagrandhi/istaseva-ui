import type pg from 'pg';
import { dbQuery, runDbQuery } from '../../../common/repositories/database.js';

/**
 * Payouts bookkeeping — payable-booking discovery, the payouts ledger, and
 * partner payout accounts. Shared by the partner endpoints
 * (/api/providers/me/payouts, /me/payout-account) and the admin console
 * (/api/admin/payouts), so "what is payable" has exactly one definition.
 *
 * PAYABLE = effectively completed (mirrors the earnings predicate: the DB
 * never auto-flips confirmed→completed) + a captured payment + not FULLY
 * refunded + not already covered by a payout + the hold-time fee snapshot
 * exists (legacy rows without subtotal_paise are EXCLUDED, not guessed at).
 *
 * PARTIALLY refunded bookings stay payable, with the refunded amount netted
 * out of the host share (see NET_PAISE) — dropping the whole booking meant a
 * host whose completed booking got a small goodwill/partial refund never
 * received the rest of their money. Cancelled bookings remain excluded:
 * product policy is full-refund-on-cancel (computeCancellationRefund →
 * hostKeepsPaise 0), so a cancelled booking never carries a host share.
 *
 * NET per booking = subtotal − discount − commission − partial refunds
 * (hold-time snapshots; refunds attributed against the host share first, so
 * we can never overpay — GREATEST(0, …) floors it).
 */
const PAYABLE_WHERE = `
  b.payout_id IS NULL
  AND b.subtotal_paise IS NOT NULL
  AND (b.status = 'completed' OR (b.status IN ('confirmed','in_progress') AND b.scheduled_date < CURRENT_DATE))
  AND EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.status IN ('completed', 'partially_refunded'))
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.status = 'refunded')`;

const NET_PAISE = `GREATEST(0, b.subtotal_paise - COALESCE(b.discount_paise, 0) - COALESCE(b.commission_paise, 0)
  - COALESCE((SELECT SUM(COALESCE(p.refund_paise, 0)) FROM payments p WHERE p.booking_id = b.id AND p.status = 'partially_refunded'), 0))`;

export interface PayoutAccountRow {
  id: string;
  user_id: string;
  method: 'bank' | 'upi';
  account_holder: string | null;
  account_number: string | null;
  ifsc: string | null;
  upi_id: string | null;
  active: boolean;
  created_at: string;
}

export interface PayoutRow {
  id: string;
  provider_user_id: string;
  amount_paise: string | number;
  booking_count: number;
  method: string;
  account_snapshot: Record<string, unknown> | null;
  note: string | null;
  status: string;
  created_by: string | null;
  created_at: string;
}

export class PayoutsRepository {
  getActiveAccount(userId: string) {
    return dbQuery<PayoutAccountRow>(
      'SELECT * FROM payout_accounts WHERE user_id = $1 AND active',
      [userId]
    );
  }

  /** Replace-the-active-account pattern: deactivate + insert, so payout rows
   *  recorded against the old destination stay historically accurate. */
  async upsertAccount(input: {
    userId: string;
    method: 'bank' | 'upi';
    accountHolder: string | null;
    accountNumber: string | null;
    ifsc: string | null;
    upiId: string | null;
  }, client: pg.PoolClient) {
    await client.query(
      'UPDATE payout_accounts SET active = FALSE, updated_at = NOW() WHERE user_id = $1 AND active',
      [input.userId]
    );
    return client.query<PayoutAccountRow>(
      `INSERT INTO payout_accounts (user_id, method, account_holder, account_number, ifsc, upi_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.userId, input.method, input.accountHolder, input.accountNumber, input.ifsc, input.upiId]
    );
  }

  /** Pending (payable, not yet paid out) sum + count for one partner. */
  pendingForUser(userId: string) {
    return dbQuery<{ pending_paise: string; booking_count: string }>(
      `SELECT COALESCE(SUM(${NET_PAISE}), 0)::bigint AS pending_paise,
              COUNT(*)::bigint AS booking_count
       FROM bookings b
       JOIN provider_profiles pp ON pp.id = b.provider_id
       WHERE pp.user_id = $1 AND ${PAYABLE_WHERE}`,
      [userId]
    );
  }

  listPayoutsForUser(userId: string, limit = 50, offset = 0) {
    return dbQuery<PayoutRow>(
      `SELECT * FROM payouts WHERE provider_user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
  }

  countPayoutsForUser(userId: string) {
    return dbQuery<{ count: string }>(
      `SELECT COUNT(*)::bigint AS count FROM payouts WHERE provider_user_id = $1`,
      [userId]
    );
  }

  /** Admin: every partner with payable money, most-owed first. */
  owedByHost() {
    return dbQuery<{
      user_id: string;
      display_name: string | null;
      email: string | null;
      pending_paise: string;
      booking_count: string;
      account_method: string | null;
    }>(
      `SELECT pp.user_id,
              up.display_name,
              up.email,
              COALESCE(SUM(${NET_PAISE}), 0)::bigint AS pending_paise,
              COUNT(*)::bigint AS booking_count,
              pa.method AS account_method
       FROM bookings b
       JOIN provider_profiles pp ON pp.id = b.provider_id
       LEFT JOIN user_profiles up ON up.user_id = pp.user_id
       LEFT JOIN payout_accounts pa ON pa.user_id = pp.user_id AND pa.active
       WHERE ${PAYABLE_WHERE}
       GROUP BY pp.user_id, up.display_name, up.email, pa.method
       HAVING COALESCE(SUM(${NET_PAISE}), 0) > 0
       ORDER BY pending_paise DESC
       LIMIT 500`,
      []
    );
  }

  /** Admin drill-down: one partner's BUSINESSES — every listing they own,
   *  with this listing's share of the payable money (0 when none). Payable
   *  sums attach via bookings.listing_id, so a legacy booking without a
   *  listing_id counts toward the partner's owed total but not any listing
   *  row here — this view is informational, recording stays per-partner. */
  businessesByHost(userId: string) {
    return dbQuery<{
      id: string;
      name: string;
      listing_type: string;
      category: string | null;
      city: string | null;
      state: string | null;
      is_active: boolean;
      banned_at: string | null;
      archived_at: string | null;
      pending_paise: string;
      booking_count: string;
    }>(
      `SELECT l.id,
              COALESCE(NULLIF(btrim(l.name), ''), NULLIF(btrim(l.title), ''), 'Untitled') AS name,
              l.listing_type, l.category, l.city, l.state,
              l.is_active, l.banned_at, l.archived_at,
              COALESCE(pay.pending_paise, 0)::bigint AS pending_paise,
              COALESCE(pay.booking_count, 0)::bigint AS booking_count
       FROM listings l
       LEFT JOIN (
         SELECT b.listing_id,
                SUM(${NET_PAISE})::bigint AS pending_paise,
                COUNT(*)::bigint AS booking_count
         FROM bookings b
         WHERE ${PAYABLE_WHERE}
         GROUP BY b.listing_id
       ) pay ON pay.listing_id = l.id
       WHERE l.user_id = $1
       ORDER BY l.listing_type ASC, pending_paise DESC, lower(COALESCE(NULLIF(btrim(l.name), ''), l.title, '')) ASC
       LIMIT 500`,
      [userId]
    );
  }

  /** Lock this partner's payable bookings for the duration of the recording
   *  transaction — two admins clicking "Record payout" concurrently must not
   *  both cover the same bookings. */
  lockPayableBookings(client: pg.PoolClient, userId: string) {
    return client.query<{ id: string; net_paise: string }>(
      `SELECT b.id, ${NET_PAISE}::bigint AS net_paise
       FROM bookings b
       JOIN provider_profiles pp ON pp.id = b.provider_id
       WHERE pp.user_id = $1 AND ${PAYABLE_WHERE}
       FOR UPDATE OF b`,
      [userId]
    );
  }

  insertPayout(client: pg.PoolClient, input: {
    providerUserId: string;
    amountPaise: number;
    bookingCount: number;
    method: string;
    accountSnapshot: Record<string, unknown> | null;
    note: string | null;
    createdBy: string;
  }) {
    return client.query<PayoutRow>(
      `INSERT INTO payouts (provider_user_id, amount_paise, booking_count, method, account_snapshot, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.providerUserId,
        input.amountPaise,
        input.bookingCount,
        input.method,
        input.accountSnapshot ? JSON.stringify(input.accountSnapshot) : null,
        input.note,
        input.createdBy,
      ]
    );
  }

  stampBookings(client: pg.PoolClient, payoutId: string, bookingIds: string[]) {
    return client.query(
      'UPDATE bookings SET payout_id = $1 WHERE id = ANY($2::uuid[])',
      [payoutId, bookingIds]
    );
  }

  listLedger(filters: { providerUserId?: string | null; limit?: number }) {
    const params: unknown[] = [];
    let where = '';
    if (filters.providerUserId) {
      params.push(filters.providerUserId);
      where = `WHERE po.provider_user_id = $${params.length}`;
    }
    params.push(Math.min(Math.max(filters.limit ?? 100, 1), 500));
    return dbQuery<PayoutRow & { display_name: string | null; email: string | null }>(
      `SELECT po.*, up.display_name, up.email
       FROM payouts po
       LEFT JOIN user_profiles up ON up.user_id = po.provider_user_id
       ${where}
       ORDER BY po.created_at DESC
       LIMIT $${params.length}`,
      params
    );
  }
}

export const payoutsRepository = new PayoutsRepository();
