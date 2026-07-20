import { transaction } from '../../../common/db/postgres.js';
import { setSuspensionCache } from '../../../common/auth/suspension.js';
import { getAuthProvider } from '../../../common/providers/registry.js';
import { NotFoundError, ValidationError } from '../../../common/errors/app-error.js';
import { logger } from '../../../common/logging/logger.js';
import { adminUsersRepository, type AdminUserRow } from '../repositories/admin-users.repository.js';
import { adminActionsService } from './admin-actions.service.js';
import { accountLifecycleService } from '../../users/services/account-lifecycle.service.js';

/**
 * Suspension side-effect order matters:
 * 1. Postgres flag + admin_actions row commit atomically (source of truth).
 * 2. Redis cache overwrite makes require-auth reject the user immediately.
 * 3. IdP disable (Firebase) blocks new sign-ins; best-effort — if the IdP
 *    call fails, layers 1–2 still enforce, so we log and continue.
 */
async function setIdpDisabled(userId: string, disabled: boolean): Promise<void> {
  try {
    const provider = await getAuthProvider();
    if (provider.setUserDisabled) {
      await provider.setUserDisabled(userId, disabled);
    }
  } catch (err) {
    logger.warn('IdP disable/enable failed; DB+cache suspension still enforced', {
      userId,
      disabled,
      err: String(err),
    });
  }
}

export const adminUsersService = {
  async suspend(actorUserId: string, targetUserId: string, reason: string): Promise<AdminUserRow> {
    if (!reason?.trim()) {
      throw new ValidationError('A reason is required to suspend a user');
    }
    if (actorUserId === targetUserId) {
      throw new ValidationError('You cannot suspend your own account');
    }

    const row = await transaction(async (client) => {
      const updated = await adminUsersRepository.suspend(targetUserId, reason.trim(), client);
      await adminActionsService.record(
        {
          actorUserId,
          action: 'admin.user.suspend',
          targetType: 'user',
          targetId: targetUserId,
          reason: reason.trim(),
          targetUserId,
        },
        client
      );
      return updated;
    });

    await setSuspensionCache(targetUserId, true);
    await setIdpDisabled(targetUserId, true);
    return row;
  },

  async unsuspend(actorUserId: string, targetUserId: string, reason?: string): Promise<AdminUserRow> {
    const row = await transaction(async (client) => {
      const updated = await adminUsersRepository.unsuspend(targetUserId, client);
      if (!updated) {
        throw new NotFoundError('User', targetUserId);
      }
      await adminActionsService.record(
        {
          actorUserId,
          action: 'admin.user.unsuspend',
          targetType: 'user',
          targetId: targetUserId,
          reason: reason?.trim() || null,
          targetUserId,
        },
        client
      );
      return updated;
    });

    await setSuspensionCache(targetUserId, false);
    await setIdpDisabled(targetUserId, false);
    return row;
  },

  /**
   * Admin-initiated account takedown (LEG-003 and similar discoveries, e.g. a
   * user found to be under 18). Suspends the account immediately — blocking
   * further use during the grace window — and files the SAME deletion request
   * the user-initiated flow uses, so the existing sweeper erases the account
   * (profile, uploads, event tables, analytics identity) after the 48h grace.
   * The lifecycle safeguard email still goes out; the user can't sign in to
   * cancel while suspended, so disputes go through the grievance process.
   */
  async requestDeletion(actorUserId: string, targetUserId: string, reason: string) {
    // suspend() validates the reason, forbids self-targeting, and writes its
    // own admin_actions row; this method adds the deletion-request action.
    await this.suspend(actorUserId, targetUserId, reason);
    const { data } = await accountLifecycleService.requestDeletion(targetUserId);
    await adminActionsService.record({
      actorUserId,
      action: 'admin.user.request_deletion',
      targetType: 'user',
      targetId: targetUserId,
      reason: reason.trim(),
      targetUserId,
    });
    return { data };
  },

  async search(q: string, limit = 20): Promise<AdminUserRow[]> {
    if (!q?.trim()) return [];
    return adminUsersRepository.search(q.trim(), Math.min(Math.max(limit, 1), 50));
  },

  async get(userId: string): Promise<AdminUserRow> {
    const row = await adminUsersRepository.getByUserId(userId);
    if (!row) throw new NotFoundError('User', userId);
    return row;
  },
};
