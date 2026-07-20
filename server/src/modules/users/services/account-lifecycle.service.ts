import { transaction } from '../../../common/db/postgres.js';
import { AppError, NotFoundError } from '../../../common/errors/app-error.js';
import { logger } from '../../../common/logging/logger.js';
import { logAuditEvent } from '../../../common/logging/audit-log.js';
import { setDeletedCache } from '../../../common/auth/account-deletion.js';
import { getAuthProvider, getStorageProvider } from '../../../common/providers/registry.js';
import { setRevokedNowCache } from '../../../common/auth/revocation.js';
import {
  accountRequestsRepository,
  type AccountRequestRow,
  type AccountRequestType,
} from '../repositories/account-requests.repository.js';
import { accountDataRepository } from '../repositories/account-data.repository.js';
import { runAccountExport, EXPORT_BUCKET_NAME } from './account-export.job.js';
import { runAccountDeletion } from './account-deletion.job.js';
import { sendNotificationEmailToUser } from '../../notifications/services/email.service.js';

/**
 * Account lifecycle: DSAR export + account deletion (PRIV-002 / LEG-017).
 *
 * Jobs run IN-PROCESS: the request endpoint fires processRequest() without
 * awaiting it, and a periodic recovery sweeper (index.ts) re-runs any
 * 'requested' or stale-'processing' rows, so a crash mid-job self-heals.
 * If job volume ever warrants it, swap the fire-and-forget for an SQS
 * enqueue following the NotificationWorker pattern — the status model
 * already supports it.
 */

// Deletion demands a recent sign-in (Firebase `auth_time`), same policy the
// Firebase client SDK applies to its own delete(). Clients that see
// REAUTH_REQUIRED prompt the user to sign in again and retry.
const MAX_DELETION_AUTH_AGE_MS = 5 * 60 * 1000;

// Cooling-off window before erasure actually runs. The account stays usable
// during the window (otherwise the user could never reach the cancel
// endpoint); lockout + erase happen together when the job executes.
export const DELETION_GRACE_MS = 48 * 60 * 60 * 1000;

function toPublicRequest(row: AccountRequestRow) {
  const scheduledFor = row.type === 'deletion' ? row.execute_after : null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    requestedAt: row.requested_at,
    completedAt: row.completed_at,
    // Deletion-only grace metadata: when erasure runs, and whether the user
    // can still call cancel (i.e. the job hasn't claimed the row yet).
    scheduledFor,
    cancellable: row.type === 'deletion' && row.status === 'requested',
    error: row.status === 'failed' ? 'Request failed — support has been notified. You can retry.' : null,
  };
}

export class AccountLifecycleService {
  // ---------------------------------------------------------------- export

  /** Idempotent: an open export request is returned rather than duplicated. */
  async requestExport(userId: string) {
    const existing = await accountRequestsRepository.findOpen(userId, 'export');
    if (existing.rows[0]) return { data: toPublicRequest(existing.rows[0]) };

    const inserted = await accountRequestsRepository.insert(userId, 'export');
    // ON CONFLICT DO NOTHING → concurrent duplicate; re-read the winner.
    const row = inserted.rows[0] ?? (await accountRequestsRepository.findOpen(userId, 'export')).rows[0];
    if (!row) throw new AppError(500, 'Could not create export request');

    logAuditEvent({ event: 'account.export_requested', user_id: userId, metadata: { requestId: row.id } });
    this.kickOff(row);
    return { data: toPublicRequest(row) };
  }

  /** Latest export request; adds a fresh presigned URL while the bundle lives. */
  async getExportStatus(userId: string) {
    const result = await accountRequestsRepository.findLatest(userId, 'export');
    const row = result.rows[0];
    if (!row) return { data: null };

    let downloadUrl: string | null = null;
    if (
      row.status === 'completed'
      && row.export_key
      && row.export_expires_at
      && new Date(row.export_expires_at).getTime() > Date.now()
    ) {
      try {
        const storage = await getStorageProvider();
        downloadUrl = (await storage.presignDownload({ bucket: EXPORT_BUCKET_NAME, key: row.export_key })).downloadUrl;
      } catch (err) {
        logger.warn('Export presign failed', { userId, err: String(err) });
      }
    }

    return {
      data: {
        ...toPublicRequest(row),
        downloadUrl,
        downloadExpiresAt: row.export_expires_at,
      },
    };
  }

  // -------------------------------------------------------------- deletion

  /**
   * Schedule erasure after a 48h grace window. The account stays usable in
   * the window so the user can still cancel; the lockout (is_deleted flag +
   * session revoke + IdP disable) happens with the erase when the job runs.
   * A safeguard email goes out immediately so a hijacked-account deletion is
   * visible to the real owner in time to cancel.
   */
  async requestDeletion(userId: string, authTimeMs?: number) {
    // Recent-login gate. authTimeMs is absent only for IdPs that don't expose
    // auth_time (dev default provider) — fail-open there, like revocation.
    if (typeof authTimeMs === 'number' && Date.now() - authTimeMs > MAX_DELETION_AUTH_AGE_MS) {
      throw new AppError(401, 'Recent sign-in required to delete your account. Please sign in again and retry.', 'REAUTH_REQUIRED');
    }

    const existing = await accountRequestsRepository.findOpen(userId, 'deletion');
    if (existing.rows[0]) return { data: toPublicRequest(existing.rows[0]) };

    const executeAfter = new Date(Date.now() + DELETION_GRACE_MS);
    const inserted = await accountRequestsRepository.insert(userId, 'deletion', executeAfter);
    const row = inserted.rows[0] ?? (await accountRequestsRepository.findOpen(userId, 'deletion')).rows[0];
    if (!row) throw new AppError(500, 'Could not create deletion request');

    logAuditEvent({
      event: 'account.deletion_requested',
      user_id: userId,
      metadata: { requestId: row.id, executeAfter: row.execute_after },
    });
    // Best-effort safeguard notice (sendNotificationEmailToUser never throws).
    void sendNotificationEmailToUser({
      userId,
      type: 'account_deletion_scheduled',
      data: {
        title: 'Your IstaSeva account is scheduled for deletion',
        message: `We received a request to permanently delete your IstaSeva account. `
          + `Deletion will run after ${new Date(row.execute_after).toUTCString()}. `
          + `If you did not request this, sign in and cancel the request from Profile → Privacy before then.`,
      },
    });
    // No kickOff here: the sweeper picks the row up once execute_after passes.
    return { data: toPublicRequest(row) };
  }

  /**
   * Cancel an open deletion request inside its grace window. 409 when the
   * erase has already started (or finished); 404 when there is nothing open.
   */
  async cancelDeletion(userId: string) {
    const cancelled = await accountRequestsRepository.cancelOpenDeletion(userId);
    const row = cancelled.rows[0];
    if (!row) {
      const latest = await accountRequestsRepository.findLatest(userId, 'deletion');
      const last = latest.rows[0];
      if (last && (last.status === 'processing' || last.status === 'completed')) {
        throw new AppError(409, 'Deletion is already underway and can no longer be cancelled.', 'DELETION_IN_PROGRESS');
      }
      throw new NotFoundError('Deletion request', userId);
    }

    logAuditEvent({ event: 'account.deletion_cancelled', user_id: userId, metadata: { requestId: row.id } });
    void sendNotificationEmailToUser({
      userId,
      type: 'account_deletion_cancelled',
      data: {
        title: 'Your IstaSeva account deletion was cancelled',
        message: 'The scheduled deletion of your IstaSeva account has been cancelled. Your account remains active. '
          + 'If you did not cancel this yourself, please reset your password immediately.',
      },
    });
    return { data: toPublicRequest(row) };
  }

  /** Deletion status; during the grace window the account can still authenticate. */
  async getDeletionStatus(userId: string) {
    const result = await accountRequestsRepository.findLatest(userId, 'deletion');
    return { data: result.rows[0] ? toPublicRequest(result.rows[0]) : null };
  }

  // ------------------------------------------------------------ processing

  /** Enforce the deletion lockout at execution time. Idempotent, best-effort IdP. */
  private async lockOutAccount(userId: string): Promise<void> {
    await transaction(async (client) => {
      await accountDataRepository.markProfileDeleted(client, userId);
    });
    await setDeletedCache(userId, true);
    try {
      const provider = await getAuthProvider();
      if (provider.revokeSessions) {
        await provider.revokeSessions(userId);
        await setRevokedNowCache(userId);
      }
      if (provider.setUserDisabled) await provider.setUserDisabled(userId, true);
    } catch (err) {
      logger.warn('IdP disable during deletion execution failed (job will retry delete)', { userId, err: String(err) });
    }
  }

  /** Fire-and-forget job start; failures are retried by the sweeper. */
  private kickOff(row: AccountRequestRow): void {
    void this.processRequest(row.id).catch((err) => {
      logger.error('Account request processing failed', { requestId: row.id, err: String(err) });
    });
  }

  /** Claim + run one request. Safe to call concurrently and repeatedly. */
  async processRequest(requestId: string): Promise<void> {
    const claimed = await accountRequestsRepository.claimForProcessing(requestId);
    const row = claimed.rows[0];
    if (!row) return; // someone else holds it, or it's terminal

    try {
      if (row.type === 'export') {
        const { exportKey, exportExpiresAt } = await runAccountExport(row.user_id, row.id);
        await accountRequestsRepository.markCompleted(row.id, exportKey, exportExpiresAt);
        logAuditEvent({ event: 'account.export_completed', user_id: row.user_id, metadata: { requestId: row.id } });
      } else {
        // Grace window is over — lock the account out NOW (flag + cache +
        // session revoke + IdP disable), then erase. All idempotent, so a
        // sweeper retry after partial failure is safe.
        await this.lockOutAccount(row.user_id);
        await runAccountDeletion(row.user_id);
        await accountRequestsRepository.markCompleted(row.id);
        // account.deletion_completed audit event is emitted by the job itself.
      }
    } catch (err) {
      logger.error('Account request failed', { requestId: row.id, type: row.type, err: String(err) });
      await accountRequestsRepository.markFailed(row.id, String(err));
    }
  }

  /** Recovery sweeper body — called from the index.ts interval. */
  async processPending(): Promise<void> {
    const pending = await accountRequestsRepository.findPendingForSweep();
    for (const row of pending.rows) {
      await this.processRequest(row.id).catch((err) => {
        logger.error('Sweeper processing failed', { requestId: row.id, err: String(err) });
      });
    }
  }

  /** Used by tests/support tooling. */
  async getRequest(requestId: string) {
    const result = await accountRequestsRepository.getById(requestId);
    if (!result.rows[0]) throw new NotFoundError('Account request', requestId);
    return result.rows[0];
  }

  get requestTypes(): AccountRequestType[] {
    return ['export', 'deletion'];
  }
}

export const accountLifecycleService = new AccountLifecycleService();
