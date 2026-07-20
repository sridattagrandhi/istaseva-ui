import { NotFoundError, ValidationError } from '../../../common/errors/app-error.js';
import { bookingsService } from '../../bookings/index.js';
import { bookingsRepository } from '../../bookings/repositories/bookings.repository.js';
import {
  adminBookingsRepository,
  type AdminBookingFilters,
} from '../repositories/admin-bookings.repository.js';
import { adminActionsService } from './admin-actions.service.js';

export const adminBookingsService = {
  async search(filters: AdminBookingFilters) {
    return adminBookingsRepository.search(filters);
  },

  /** Full support dossier: booking + every payment attempt + cancel preview. */
  async detail(bookingId: string) {
    const result = await bookingsRepository.getBookingByIdForAdmin(bookingId);
    const booking = result.rows[0];
    if (!booking) throw new NotFoundError('Booking', bookingId);

    const [payments, cancelPreview] = await Promise.all([
      adminBookingsRepository.listPayments(bookingId),
      bookingsService.previewCancellationAsAdmin(bookingId).catch(() => null),
    ]);

    return { booking, payments, cancelPreview };
  },

  /**
   * Admin cancel. `refundMode: 'policy'` follows the standard cancellation
   * math (host semantics — guest-favorable); `'full'` refunds everything the
   * guest paid including the protect premium. The admin action is recorded
   * after the cancel commits — updateStatus owns its own transaction, and a
   * cancel that succeeded but failed to log must not be rolled back into
   * un-cancelled (the audit mirror in updateStatus already logged it).
   */
  async cancel(
    actorUserId: string,
    bookingId: string,
    opts: { refundMode: 'policy' | 'full'; reason: string }
  ) {
    if (!opts.reason?.trim()) {
      throw new ValidationError('A reason is required to cancel a booking as admin');
    }
    if (opts.refundMode !== 'policy' && opts.refundMode !== 'full') {
      throw new ValidationError("refundMode must be 'policy' or 'full'");
    }

    // Snapshot the guest + preview before mutating (for the action record).
    const before = await bookingsRepository.getBookingByIdForAdmin(bookingId);
    const booking = before.rows[0];
    if (!booking) throw new NotFoundError('Booking', bookingId);

    const result = await bookingsService.updateStatus(bookingId, 'cancelled', actorUserId, 'admin', {
      refundMode: opts.refundMode,
    });

    await adminBookingsRepository.setCancellationReason(bookingId, opts.reason.trim());

    await adminActionsService.record({
      actorUserId,
      action: 'admin.booking.cancel',
      targetType: 'booking',
      targetId: bookingId,
      reason: opts.reason.trim(),
      targetUserId: booking.user_id,
      bookingId,
      metadata: {
        refundMode: opts.refundMode,
        previousStatus: booking.status,
        listingId: booking.listing_id ?? null,
      },
    });

    return result;
  },
};
