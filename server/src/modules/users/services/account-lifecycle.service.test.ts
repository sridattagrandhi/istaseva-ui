// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../common/errors/app-error.js';

const requestsRepo = {
  findOpen: vi.fn(),
  findLatest: vi.fn(),
  getById: vi.fn(),
  insert: vi.fn(),
  cancelOpenDeletion: vi.fn(),
  claimForProcessing: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  findPendingForSweep: vi.fn(),
};

const sendNotificationEmailToUser = vi.fn(async () => undefined);

const dataRepo = {
  markProfileDeleted: vi.fn(),
  anonymizeUserProfile: vi.fn(),
  eraseStatements: vi.fn(() => []),
  scrubStatements: vi.fn(() => []),
  exportQueries: vi.fn(() => []),
  runStatement: vi.fn(),
  getOwnedListingIds: vi.fn(async () => []),
  deleteWishlistsForListings: vi.fn(),
  deleteListings: vi.fn(async () => 0),
};

const authProvider = {
  revokeSessions: vi.fn(),
  setUserDisabled: vi.fn(),
  deleteUser: vi.fn(),
};

vi.mock('../repositories/account-requests.repository.js', () => ({
  accountRequestsRepository: requestsRepo,
}));
vi.mock('../repositories/account-data.repository.js', () => ({
  accountDataRepository: dataRepo,
}));
vi.mock('../../../common/db/postgres.js', () => ({
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: vi.fn() })),
}));
vi.mock('../../../common/auth/account-deletion.js', () => ({
  setDeletedCache: vi.fn(),
}));
vi.mock('../../../common/auth/revocation.js', () => ({
  setRevokedNowCache: vi.fn(),
}));
vi.mock('../../../common/logging/audit-log.js', () => ({
  logAuditEvent: vi.fn(),
}));
vi.mock('../../notifications/services/email.service.js', () => ({
  sendNotificationEmailToUser: (params: unknown) => sendNotificationEmailToUser(params as never),
}));
vi.mock('../../../common/providers/registry.js', () => ({
  getAuthProvider: vi.fn(async () => authProvider),
  getEventProvider: vi.fn(async () => ({
    queryByUser: vi.fn(async () => []),
    deleteByUser: vi.fn(async () => 0),
  })),
  getStorageProvider: vi.fn(async () => ({
    listObjects: vi.fn(async () => ({ files: [], bucket: 'b' })),
    deleteObject: vi.fn(async () => ({ success: true })),
    putObject: vi.fn(async () => ({ bucket: 'b', key: 'k' })),
    presignDownload: vi.fn(async () => ({ downloadUrl: 'https://signed', bucket: 'b', key: 'k' })),
  })),
}));

const openRow = (over: Record<string, unknown> = {}) => ({
  id: 'req-1',
  user_id: 'u1',
  type: 'export',
  status: 'requested',
  error: null,
  export_key: null,
  export_expires_at: null,
  requested_at: new Date().toISOString(),
  started_at: null,
  completed_at: null,
  execute_after: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
  cancelled_at: null,
  ...over,
});

describe('AccountLifecycleService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dataRepo.eraseStatements.mockReturnValue([]);
    dataRepo.scrubStatements.mockReturnValue([]);
    dataRepo.exportQueries.mockReturnValue([]);
    dataRepo.getOwnedListingIds.mockResolvedValue([]);
    dataRepo.deleteListings.mockResolvedValue(0);
  });

  it('requestExport is idempotent: returns the open request without inserting', async () => {
    const { accountLifecycleService } = await import('./account-lifecycle.service.js');
    requestsRepo.findOpen.mockResolvedValue({ rows: [openRow()] });
    const r = await accountLifecycleService.requestExport('u1');
    expect(r.data.id).toBe('req-1');
    expect(requestsRepo.insert).not.toHaveBeenCalled();
  });

  it('requestExport creates a request and kicks processing', async () => {
    const { accountLifecycleService } = await import('./account-lifecycle.service.js');
    requestsRepo.findOpen.mockResolvedValue({ rows: [] });
    requestsRepo.insert.mockResolvedValue({ rows: [openRow()] });
    requestsRepo.claimForProcessing.mockResolvedValue({ rows: [] }); // kickOff no-ops
    const r = await accountLifecycleService.requestExport('u1');
    expect(r.data.status).toBe('requested');
    expect(requestsRepo.insert).toHaveBeenCalledWith('u1', 'export');
  });

  it('requestDeletion rejects stale auth with REAUTH_REQUIRED', async () => {
    const { accountLifecycleService } = await import('./account-lifecycle.service.js');
    const staleAuth = Date.now() - 10 * 60 * 1000;
    await expect(accountLifecycleService.requestDeletion('u1', staleAuth)).rejects.toMatchObject({
      statusCode: 401,
      code: 'REAUTH_REQUIRED',
    });
    expect(requestsRepo.insert).not.toHaveBeenCalled();
  });

  it('requestDeletion schedules a 48h grace window and does NOT lock the account out yet', async () => {
    const { accountLifecycleService } = await import('./account-lifecycle.service.js');
    const { setDeletedCache } = await import('../../../common/auth/account-deletion.js');
    requestsRepo.findOpen.mockResolvedValue({ rows: [] });
    requestsRepo.insert.mockResolvedValue({ rows: [openRow({ type: 'deletion' })] });

    const before = Date.now();
    const r = await accountLifecycleService.requestDeletion('u1', Date.now());
    expect(r.data.type).toBe('deletion');
    expect(r.data.cancellable).toBe(true);
    expect(r.data.scheduledFor).toBeTruthy();

    // insert carries the grace deadline (~48h out).
    const executeAfter = requestsRepo.insert.mock.calls[0][2] as Date;
    expect(executeAfter.getTime()).toBeGreaterThanOrEqual(before + 47 * 60 * 60 * 1000);
    expect(executeAfter.getTime()).toBeLessThanOrEqual(before + 49 * 60 * 60 * 1000);

    // Account stays usable during grace: no lockout, no immediate job start.
    expect(dataRepo.markProfileDeleted).not.toHaveBeenCalled();
    expect(setDeletedCache).not.toHaveBeenCalled();
    expect(authProvider.setUserDisabled).not.toHaveBeenCalled();
    expect(requestsRepo.claimForProcessing).not.toHaveBeenCalled();

    // Safeguard email fired.
    expect(sendNotificationEmailToUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', type: 'account_deletion_scheduled' }),
    );
  });

  it('requestDeletion allows missing authTimeMs (fail-open like revocation)', async () => {
    const { accountLifecycleService } = await import('./account-lifecycle.service.js');
    requestsRepo.findOpen.mockResolvedValue({ rows: [] });
    requestsRepo.insert.mockResolvedValue({ rows: [openRow({ type: 'deletion' })] });
    const r = await accountLifecycleService.requestDeletion('u1', undefined);
    expect(r.data.type).toBe('deletion');
  });

  it('cancelDeletion cancels an open request and sends the cancellation email', async () => {
    const { accountLifecycleService } = await import('./account-lifecycle.service.js');
    requestsRepo.cancelOpenDeletion.mockResolvedValue({
      rows: [openRow({ type: 'deletion', status: 'cancelled', cancelled_at: new Date().toISOString() })],
    });
    const r = await accountLifecycleService.cancelDeletion('u1');
    expect(r.data.status).toBe('cancelled');
    expect(sendNotificationEmailToUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', type: 'account_deletion_cancelled' }),
    );
  });

  it('cancelDeletion returns 409 once the erase is already underway', async () => {
    const { accountLifecycleService } = await import('./account-lifecycle.service.js');
    requestsRepo.cancelOpenDeletion.mockResolvedValue({ rows: [] });
    requestsRepo.findLatest.mockResolvedValue({ rows: [openRow({ type: 'deletion', status: 'processing' })] });
    await expect(accountLifecycleService.cancelDeletion('u1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'DELETION_IN_PROGRESS',
    });
  });

  it('cancelDeletion 404s when there is nothing open', async () => {
    const { accountLifecycleService } = await import('./account-lifecycle.service.js');
    requestsRepo.cancelOpenDeletion.mockResolvedValue({ rows: [] });
    requestsRepo.findLatest.mockResolvedValue({ rows: [] });
    await expect(accountLifecycleService.cancelDeletion('u1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('processRequest completes an export and stores the bundle key', async () => {
    const { accountLifecycleService } = await import('./account-lifecycle.service.js');
    requestsRepo.claimForProcessing.mockResolvedValue({ rows: [openRow()] });
    requestsRepo.markCompleted.mockResolvedValue({ rows: [] });
    await accountLifecycleService.processRequest('req-1');
    expect(requestsRepo.markCompleted).toHaveBeenCalledWith(
      'req-1',
      expect.stringContaining('u1/exports/account-export-req-1.json'),
      expect.any(Date),
    );
  });

  it('processRequest locks the account out, runs the deletion orchestrator and deletes the IdP user', async () => {
    const { accountLifecycleService } = await import('./account-lifecycle.service.js');
    const { setDeletedCache } = await import('../../../common/auth/account-deletion.js');
    requestsRepo.claimForProcessing.mockResolvedValue({ rows: [openRow({ type: 'deletion' })] });
    requestsRepo.markCompleted.mockResolvedValue({ rows: [] });
    await accountLifecycleService.processRequest('req-1');
    // Lockout happens at execution time (post-grace), not at request time.
    expect(dataRepo.markProfileDeleted).toHaveBeenCalled();
    expect(setDeletedCache).toHaveBeenCalledWith('u1', true);
    expect(authProvider.revokeSessions).toHaveBeenCalledWith('u1');
    expect(authProvider.setUserDisabled).toHaveBeenCalledWith('u1', true);
    expect(authProvider.deleteUser).toHaveBeenCalledWith('u1');
    expect(dataRepo.anonymizeUserProfile).toHaveBeenCalledWith('u1');
    expect(requestsRepo.markCompleted).toHaveBeenCalledWith('req-1');
  });

  it('processRequest marks failed on job error (sweeper will retry)', async () => {
    const { accountLifecycleService } = await import('./account-lifecycle.service.js');
    requestsRepo.claimForProcessing.mockResolvedValue({ rows: [openRow({ type: 'deletion' })] });
    dataRepo.getOwnedListingIds.mockRejectedValue(new Error('db down'));
    requestsRepo.markFailed.mockResolvedValue({ rows: [] });
    await accountLifecycleService.processRequest('req-1');
    expect(requestsRepo.markFailed).toHaveBeenCalledWith('req-1', expect.stringContaining('db down'));
  });

  it('getExportStatus presigns a download for a live completed bundle', async () => {
    const { accountLifecycleService } = await import('./account-lifecycle.service.js');
    requestsRepo.findLatest.mockResolvedValue({
      rows: [openRow({
        status: 'completed',
        export_key: 'u1/exports/x.json',
        export_expires_at: new Date(Date.now() + 60_000).toISOString(),
      })],
    });
    const r = await accountLifecycleService.getExportStatus('u1');
    expect(r.data?.downloadUrl).toBe('https://signed');
  });

  it('getExportStatus omits the URL once the bundle expired', async () => {
    const { accountLifecycleService } = await import('./account-lifecycle.service.js');
    requestsRepo.findLatest.mockResolvedValue({
      rows: [openRow({
        status: 'completed',
        export_key: 'u1/exports/x.json',
        export_expires_at: new Date(Date.now() - 60_000).toISOString(),
      })],
    });
    const r = await accountLifecycleService.getExportStatus('u1');
    expect(r.data?.downloadUrl).toBeNull();
  });
});
