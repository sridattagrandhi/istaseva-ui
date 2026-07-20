import { dbQuery } from '../../../common/repositories/database.js';

export type AccountRequestType = 'export' | 'deletion';

export interface AccountRequestRow {
  id: string;
  user_id: string;
  type: AccountRequestType;
  status: 'requested' | 'processing' | 'completed' | 'failed' | 'cancelled';
  error: string | null;
  export_key: string | null;
  export_expires_at: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  execute_after: string;
  cancelled_at: string | null;
}

const COLUMNS = 'id, user_id, type, status, error, export_key, export_expires_at, requested_at, started_at, completed_at, execute_after, cancelled_at';

export class AccountRequestsRepository {
  /** The open (requested/processing) request for a user+type, if any. */
  findOpen(userId: string, type: AccountRequestType) {
    return dbQuery<AccountRequestRow>(
      `SELECT ${COLUMNS} FROM account_requests
       WHERE user_id = $1 AND type = $2 AND status IN ('requested', 'processing')
       LIMIT 1`,
      [userId, type],
    );
  }

  /** Most recent request of a type for the status endpoints. */
  findLatest(userId: string, type: AccountRequestType) {
    return dbQuery<AccountRequestRow>(
      `SELECT ${COLUMNS} FROM account_requests
       WHERE user_id = $1 AND type = $2
       ORDER BY requested_at DESC
       LIMIT 1`,
      [userId, type],
    );
  }

  getById(id: string) {
    return dbQuery<AccountRequestRow>(
      `SELECT ${COLUMNS} FROM account_requests WHERE id = $1 LIMIT 1`,
      [id],
    );
  }

  /**
   * Idempotent create: the partial unique index (one open row per user+type)
   * makes a concurrent duplicate a no-op; callers re-read the open row.
   */
  insert(userId: string, type: AccountRequestType, executeAfter?: Date) {
    return dbQuery<AccountRequestRow>(
      `INSERT INTO account_requests (user_id, type, execute_after)
       VALUES ($1, $2, COALESCE($3, NOW()))
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [userId, type, executeAfter ?? null],
    );
  }

  /**
   * Cancel an open deletion request during its grace window. Atomic against
   * claimForProcessing: whichever UPDATE moves the row out of 'requested'
   * first wins, so a cancel can never land on an in-flight erase.
   */
  cancelOpenDeletion(userId: string) {
    return dbQuery<AccountRequestRow>(
      `UPDATE account_requests
       SET status = 'cancelled', cancelled_at = NOW()
       WHERE user_id = $1 AND type = 'deletion' AND status = 'requested'
       RETURNING ${COLUMNS}`,
      [userId],
    );
  }

  /**
   * Claim a request for processing. Also re-claims rows stuck in
   * 'processing' longer than 15 minutes (a crashed run) so the recovery
   * sweeper can retry them. Returns no row when another worker holds it.
   */
  claimForProcessing(id: string) {
    return dbQuery<AccountRequestRow>(
      `UPDATE account_requests
       SET status = 'processing', started_at = NOW(), error = NULL
       WHERE id = $1
         AND execute_after <= NOW()
         AND (status = 'requested'
              OR (status = 'processing' AND started_at < NOW() - INTERVAL '15 minutes'))
       RETURNING ${COLUMNS}`,
      [id],
    );
  }

  markCompleted(id: string, exportKey?: string | null, exportExpiresAt?: Date | null) {
    return dbQuery<AccountRequestRow>(
      `UPDATE account_requests
       SET status = 'completed', completed_at = NOW(), export_key = $2, export_expires_at = $3
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [id, exportKey ?? null, exportExpiresAt ?? null],
    );
  }

  markFailed(id: string, error: string) {
    return dbQuery<AccountRequestRow>(
      `UPDATE account_requests
       SET status = 'failed', error = $2
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [id, error.slice(0, 2000)],
    );
  }

  /** Rows the recovery sweeper should (re)run: fresh requests and stale claims. */
  findPendingForSweep() {
    return dbQuery<AccountRequestRow>(
      `SELECT ${COLUMNS} FROM account_requests
       WHERE execute_after <= NOW()
         AND (status = 'requested'
              OR (status = 'processing' AND started_at < NOW() - INTERVAL '15 minutes'))
       ORDER BY requested_at
       LIMIT 20`,
      [],
    );
  }
}

export const accountRequestsRepository = new AccountRequestsRepository();
