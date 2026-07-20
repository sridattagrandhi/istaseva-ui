/**
 * Admin payouts ledger — who is owed what, and recording that a payout was
 * made. Recording is MANUAL for now (the admin moves the money by bank/UPI
 * themselves and records it here); when RazorpayX/Route lands, its executor
 * calls the same recordPayout so the ledger shape doesn't change.
 *
 * recordPayout is transactional and race-safe: the partner's payable
 * bookings are locked FOR UPDATE, summed, stamped with the new payout id,
 * and audited — two admins recording the same partner concurrently can't
 * double-pay a booking.
 */

import { transaction } from '../../../common/db/postgres.js';
import { NotFoundError, ValidationError } from '../../../common/errors/app-error.js';
import {
  payoutsRepository,
} from '../../providers/repositories/payouts.repository.js';
import { maskAccount } from '../../providers/services/payouts.service.js';
import { adminActionsService } from './admin-actions.service.js';

export const adminPayoutsService = {
  /** Every partner with payable (completed + paid + unrefunded + not yet
   *  paid-out) bookings, most-owed first. */
  async owedSummary() {
    const result = await payoutsRepository.owedByHost();
    return result.rows.map((r) => ({
      providerUserId: r.user_id,
      name: r.display_name || r.email || r.user_id,
      email: r.email,
      pendingPaise: Number(r.pending_paise),
      bookings: Number(r.booking_count),
      accountMethod: r.account_method, // null = partner hasn't added one
    }));
  },

  /** One partner's businesses (every listing they own), each with its share
   *  of the payable money — the informational drill-down behind a partner
   *  row. Recording stays per-partner; this changes nothing about payouts. */
  async partnerBusinesses(providerUserId: string) {
    const id = providerUserId?.trim();
    if (!id) throw new ValidationError('providerUserId is required');
    const result = await payoutsRepository.businessesByHost(id);
    return result.rows.map((r) => ({
      listingId: r.id,
      name: r.name,
      listingType: r.listing_type,
      category: r.category,
      city: r.city,
      state: r.state,
      // One coarse status for the popup: suspended/removed dominate inactive.
      status: r.archived_at ? 'removed' : r.banned_at ? 'suspended' : r.is_active ? 'live' : 'inactive',
      pendingPaise: Number(r.pending_paise),
      bookings: Number(r.booking_count),
    }));
  },

  async ledger(filters: { providerUserId?: string | null; limit?: number }) {
    const result = await payoutsRepository.listLedger(filters);
    return result.rows.map((r) => ({
      id: r.id,
      providerUserId: r.provider_user_id,
      name: r.display_name || r.email || r.provider_user_id,
      amountPaise: Number(r.amount_paise),
      bookings: r.booking_count,
      method: r.method,
      accountSnapshot: r.account_snapshot,
      note: r.note,
      status: r.status,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
  },

  async recordPayout(actorUserId: string, input: { providerUserId: string; note?: string | null }) {
    const providerUserId = input.providerUserId?.trim();
    if (!providerUserId) throw new ValidationError('providerUserId is required');

    // The destination must exist BEFORE money moves — the recorded ledger row
    // snapshots (masked) where it went.
    const accountRes = await payoutsRepository.getActiveAccount(providerUserId);
    const account = accountRes.rows[0];
    if (!account) {
      throw new ValidationError(
        'This partner has not added a payout account yet — ask them to add one from their dashboard’s Earnings tab.'
      );
    }

    return transaction(async (client) => {
      const payable = await payoutsRepository.lockPayableBookings(client, providerUserId);
      if (payable.rows.length === 0) {
        throw new NotFoundError('Payable bookings for partner', providerUserId);
      }
      const amountPaise = payable.rows.reduce((sum, r) => sum + Number(r.net_paise), 0);
      if (amountPaise <= 0) {
        throw new ValidationError('Payable amount is ₹0 — nothing to record');
      }

      const masked = maskAccount(account);
      const inserted = await payoutsRepository.insertPayout(client, {
        providerUserId,
        amountPaise,
        bookingCount: payable.rows.length,
        method: account.method,
        accountSnapshot: masked ? {
          method: masked.method,
          accountHolder: masked.accountHolder,
          accountNumberMasked: masked.accountNumberMasked,
          ifsc: masked.ifsc,
          upiIdMasked: masked.upiIdMasked,
        } : null,
        note: input.note?.trim() || null,
        createdBy: actorUserId,
      });
      const payout = inserted.rows[0];

      await payoutsRepository.stampBookings(client, payout.id, payable.rows.map((r) => r.id));

      await adminActionsService.record(
        {
          actorUserId,
          action: 'admin.payout.record',
          targetType: 'payout',
          targetId: payout.id,
          targetUserId: providerUserId,
          reason: input.note?.trim() || null,
          metadata: {
            providerUserId,
            amountPaise,
            bookingCount: payable.rows.length,
            method: account.method,
          },
        },
        client
      );

      return {
        id: payout.id,
        amountPaise,
        bookings: payable.rows.length,
        method: account.method,
        createdAt: payout.created_at,
      };
    });
  },
};
