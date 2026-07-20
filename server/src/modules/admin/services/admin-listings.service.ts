import { transaction } from '../../../common/db/postgres.js';
import { NotFoundError, ValidationError } from '../../../common/errors/app-error.js';
import { logger } from '../../../common/logging/logger.js';
import { listingsService } from '../../listings/services/listings.service.js';
import { roomTypesService } from '../../listings/services/room-types.service.js';
import { notificationsService } from '../../notifications/services/notifications.service.js';
import {
  adminListingsRepository,
  type AdminListingFilters,
} from '../repositories/admin-listings.repository.js';
import { adminUsersRepository } from '../repositories/admin-users.repository.js';
import { adminActionsService } from './admin-actions.service.js';

export const adminListingsService = {
  async search(filters: AdminListingFilters) {
    return adminListingsRepository.search(filters);
  },

  /**
   * Read-only inspection view: the full decorated listing (room types,
   * rewritten image URLs — same shape the public detail page consumes) plus
   * the host's contact card. No mutation surface here by design.
   */
  async detail(listingId: string) {
    const result = await listingsService.getById(listingId);
    const listing = result.data;
    const host = listing.user_id
      ? await adminUsersRepository.getByUserId(String(listing.user_id))
      : null;
    return { listing, host };
  },

  /**
   * Assisted onboarding: an admin creates a listing ON the target user's
   * account (ops signs up a low-tech host over the phone / in person).
   *
   * Guards are server-enforced here — the target must be a real account,
   * KYC-verified, and not suspended. Everything after the guards delegates
   * to the SAME listingsService.create the self-serve paths use, so the
   * content guardrails (legal/safe/viable + India-only), forced-inactive
   * draft, provider-profile auto-create, and availability slots all apply
   * identically. Publishing stays with the owner: they get a notification
   * and activate from their own dashboard (readiness validator unchanged).
   */
  async createForUser(
    actorUserId: string,
    targetUserId: string,
    payload: Record<string, unknown>,
    rooms: Array<Record<string, unknown>> = [],
  ) {
    const target = await adminUsersRepository.getByUserId(targetUserId);
    if (!target) throw new NotFoundError('User', targetUserId);
    if (target.verification_status !== 'verified') {
      throw new ValidationError('This user must complete KYC verification before a listing can be created on their account.');
    }
    if (target.is_suspended) {
      throw new ValidationError('This account is suspended — unsuspend it before creating listings on it.');
    }

    const created = await listingsService.create(targetUserId, payload);
    const listing = created.data as Record<string, unknown>;
    const listingId = String(listing.id);
    const listingName = String(listing.name ?? listing.title ?? 'your listing');

    // Multi-room stays: room types are created HERE (as the target owner)
    // because the /room-types route is ownership-checked and would reject
    // the admin. Non-fatal per room, mirroring the self-serve flow — the
    // host can finish up from their dashboard.
    for (let i = 0; i < rooms.length; i++) {
      try {
        await roomTypesService.create(listingId, targetUserId, { sort_order: i, ...rooms[i] });
      } catch (err) {
        logger.warn('create-for-user: room type creation failed (listing kept)', {
          listingId,
          roomIndex: i,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await adminActionsService.record({
      actorUserId,
      action: 'admin.listing.create_for_user',
      targetType: 'listing',
      targetId: listingId,
      targetUserId,
      metadata: {
        listingName,
        listingType: listing.listing_type ?? null,
        category: listing.category ?? null,
      },
    });

    // Consent trail made visible: the owner learns immediately that support
    // created a draft on their account, and publishing remains THEIR action.
    notificationsService.send({
      userId: targetUserId,
      type: 'listing_created_by_support',
      title: 'A draft listing was created for you',
      message: `IstaSeva support created “${listingName}” on your account. Review it and publish it from your dashboard when you're ready.`,
      link: '/dashboard/host',
      channels: ['in_app', 'push'],
      metadata: { listingId },
    }).catch((err) => {
      logger.warn('create-for-user notification failed (listing unaffected)', {
        listingId,
        targetUserId,
        err: String(err),
      });
    });

    return created;
  },

  /**
   * Ban is a separate state from is_active/is_published (host-controlled):
   * banned_* columns are outside the listings PATCH allowlist, so only these
   * endpoints touch them. Excluded from listPublic + text search; bookings
   * are rejected in createHold AND by the DB trigger
   * trg_reject_booking_on_banned_listing.
   */
  async ban(actorUserId: string, listingId: string, reason: string) {
    if (!reason?.trim()) {
      throw new ValidationError('A reason is required to ban a listing');
    }

    return transaction(async (client) => {
      const row = await adminListingsRepository.ban(listingId, actorUserId, reason.trim(), client);
      if (!row) throw new NotFoundError('Listing', listingId);
      await adminActionsService.record(
        {
          actorUserId,
          action: 'admin.listing.ban',
          targetType: 'listing',
          targetId: listingId,
          reason: reason.trim(),
          targetUserId: row.user_id,
          metadata: { listingName: row.name ?? row.title, listingType: row.listing_type },
        },
        client
      );
      return row;
    });
  },

  async unban(actorUserId: string, listingId: string, reason?: string) {
    return transaction(async (client) => {
      const row = await adminListingsRepository.unban(listingId, client);
      if (!row) throw new NotFoundError('Listing', listingId);
      await adminActionsService.record(
        {
          actorUserId,
          action: 'admin.listing.unban',
          targetType: 'listing',
          targetId: listingId,
          reason: reason?.trim() || null,
          targetUserId: row.user_id,
          metadata: { listingName: row.name ?? row.title, listingType: row.listing_type },
        },
        client
      );
      return row;
    });
  },

  /**
   * Admin takedown ("delete") — a SOFT archive, never a row deletion:
   * bookings/payments reference listings for invoices, disputes and GST
   * retention, and a hard DELETE would cascade room types / availability /
   * listing coupons / fee rules. Self-serve deletion is gone entirely; this
   * is the only removal path and it is reversible via restore.
   */
  async archive(actorUserId: string, listingId: string, reason: string) {
    if (!reason?.trim()) {
      throw new ValidationError('A reason is required to delete a listing');
    }

    return transaction(async (client) => {
      const row = await adminListingsRepository.archive(listingId, actorUserId, reason.trim(), client);
      if (!row) throw new NotFoundError('Listing', listingId);
      await adminActionsService.record(
        {
          actorUserId,
          action: 'admin.listing.archive',
          targetType: 'listing',
          targetId: listingId,
          reason: reason.trim(),
          targetUserId: row.user_id,
          metadata: { listingName: row.name ?? row.title, listingType: row.listing_type },
        },
        client
      );
      return row;
    });
  },

  async unarchive(actorUserId: string, listingId: string, reason?: string) {
    return transaction(async (client) => {
      const row = await adminListingsRepository.unarchive(listingId, client);
      if (!row) throw new NotFoundError('Listing', listingId);
      await adminActionsService.record(
        {
          actorUserId,
          action: 'admin.listing.unarchive',
          targetType: 'listing',
          targetId: listingId,
          reason: reason?.trim() || null,
          targetUserId: row.user_id,
          metadata: { listingName: row.name ?? row.title, listingType: row.listing_type },
        },
        client
      );
      return row;
    });
  },
};
