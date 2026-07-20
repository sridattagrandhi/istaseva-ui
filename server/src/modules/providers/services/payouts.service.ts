/**
 * Partner payout accounts + payout status. The admin console records the
 * payouts (admin-payouts.service.ts); this service is the PARTNER side:
 * where they want their money, and where their money is.
 *
 * Full account numbers go in once and never come back out — every read path
 * returns masked values (last 4). No verification flow yet (penny-drop etc.
 * arrives with the RazorpayX integration); accounts save as unverified-
 * but-usable, which matches the manual-payout reality.
 */

import { transaction } from '../../../common/db/postgres.js';
import { ValidationError } from '../../../common/errors/app-error.js';
import {
  payoutsRepository,
  type PayoutAccountRow,
} from '../repositories/payouts.repository.js';

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI_RE = /^[\w.-]{2,}@[a-zA-Z]{2,}$/;
const ACCOUNT_RE = /^\d{9,18}$/;

export function maskAccount(row: PayoutAccountRow | null | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    method: row.method,
    accountHolder: row.account_holder,
    /** "•••• 1234" — never the full number. */
    accountNumberMasked: row.account_number ? `•••• ${row.account_number.slice(-4)}` : null,
    ifsc: row.ifsc,
    /** UPI ids are semi-public handles; mask the user part anyway. */
    upiIdMasked: row.upi_id
      ? `${row.upi_id.slice(0, 2)}•••${row.upi_id.slice(row.upi_id.indexOf('@'))}`
      : null,
    updatedAt: row.created_at,
  };
}

export const providerPayoutsService = {
  async getMyAccount(userId: string) {
    const result = await payoutsRepository.getActiveAccount(userId);
    return { account: maskAccount(result.rows[0]) };
  },

  async saveMyAccount(userId: string, input: {
    method: 'bank' | 'upi';
    accountHolder?: string | null;
    accountNumber?: string | null;
    ifsc?: string | null;
    upiId?: string | null;
  }) {
    let accountHolder: string | null = null;
    let accountNumber: string | null = null;
    let ifsc: string | null = null;
    let upiId: string | null = null;

    if (input.method === 'bank') {
      accountHolder = input.accountHolder?.trim() || null;
      accountNumber = input.accountNumber?.replace(/\s+/g, '') || null;
      ifsc = input.ifsc?.trim().toUpperCase() || null;
      if (!accountHolder) throw new ValidationError('Account holder name is required');
      if (!accountNumber || !ACCOUNT_RE.test(accountNumber)) {
        throw new ValidationError('Account number must be 9–18 digits');
      }
      if (!ifsc || !IFSC_RE.test(ifsc)) {
        throw new ValidationError('That IFSC code doesn’t look right (e.g. HDFC0001234)');
      }
    } else if (input.method === 'upi') {
      upiId = input.upiId?.trim().toLowerCase() || null;
      if (!upiId || !UPI_RE.test(upiId)) {
        throw new ValidationError('That UPI ID doesn’t look right (e.g. name@okhdfcbank)');
      }
    } else {
      throw new ValidationError('method must be bank or upi');
    }

    const saved = await transaction((client) =>
      payoutsRepository.upsertAccount(
        { userId, method: input.method, accountHolder, accountNumber, ifsc, upiId },
        client
      )
    );
    return { account: maskAccount(saved.rows[0]) };
  },

  /** Pending amount (payable, awaiting payout) + recorded payout history,
   *  paginated most-recent-first (50 per page; `page` is 1-based). */
  async getMyPayouts(userId: string, pageRaw?: number) {
    const pageSize = 50;
    const page = Math.max(1, Math.floor(pageRaw || 1));
    const [pending, history, count, account] = await Promise.all([
      payoutsRepository.pendingForUser(userId),
      payoutsRepository.listPayoutsForUser(userId, pageSize, (page - 1) * pageSize),
      payoutsRepository.countPayoutsForUser(userId),
      payoutsRepository.getActiveAccount(userId),
    ]);
    const p = pending.rows[0];
    return {
      pending: {
        amountPaise: Number(p?.pending_paise ?? 0),
        bookings: Number(p?.booking_count ?? 0),
      },
      hasAccount: !!account.rows[0],
      page,
      pageSize,
      total: Number(count.rows[0]?.count ?? 0),
      payouts: history.rows.map((r) => ({
        id: r.id,
        amountPaise: Number(r.amount_paise),
        bookings: r.booking_count,
        method: r.method,
        note: r.note,
        status: r.status,
        createdAt: r.created_at,
        // Masked destination snapshotted at payout time (admin-payouts writes
        // maskAccount() into payouts.account_snapshot) — lets the partner see
        // WHERE each payout went ("Sent to A/C •••• 1234" / UPI). Masked
        // server-side; never contains full numbers.
        destination: r.account_snapshot
          ? {
              method: (r.account_snapshot as Record<string, unknown>).method ?? null,
              accountNumberMasked: (r.account_snapshot as Record<string, unknown>).accountNumberMasked ?? null,
              upiIdMasked: (r.account_snapshot as Record<string, unknown>).upiIdMasked ?? null,
            }
          : null,
      })),
    };
  },
};
