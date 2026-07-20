import { NotFoundError } from '../../../common/errors/app-error.js';
import {
  adminFraudRepository,
  type FraudSignalFilters,
} from '../repositories/admin-fraud.repository.js';
import { adminBookingsRepository } from '../repositories/admin-bookings.repository.js';
import { adminListingsRepository } from '../repositories/admin-listings.repository.js';
import { adminUsersRepository } from '../repositories/admin-users.repository.js';

export const adminFraudService = {
  async listSignals(filters: FraudSignalFilters) {
    return adminFraudRepository.listSignals(filters);
  },

  async listEventTypes() {
    return adminFraudRepository.listEventTypes();
  },

  /**
   * Investigation dossier for one user: profile + suspension state, their
   * fraud signals, safety alerts, booking counts + recent bookings, and the
   * listings they host. Everything the fraud screen needs to decide between
   * "suspend user" and "ban listing".
   */
  async userDossier(userId: string) {
    const profile = await adminUsersRepository.getByUserId(userId);
    // A user can have signals without a profile row (e.g. deleted profile) —
    // only 404 when we know nothing about them at all.
    const [signals, alerts, bookingStats, recentBookings, listings] = await Promise.all([
      adminFraudRepository.listSignals({ userId, limit: 50, offset: 0 }),
      adminFraudRepository.listSafetyAlerts(userId),
      adminFraudRepository.bookingStats(userId),
      adminBookingsRepository.search({ userQuery: userId, limit: 10, offset: 0 }),
      adminListingsRepository.search({ userId, limit: 20, offset: 0 }),
    ]);

    if (!profile && signals.total === 0 && Object.keys(bookingStats).length === 0) {
      throw new NotFoundError('User', userId);
    }

    return {
      profile,
      signals: signals.rows,
      signalsTotal: signals.total,
      safetyAlerts: alerts,
      bookingStats,
      recentBookings: recentBookings.rows,
      listings: listings.rows,
    };
  },
};
