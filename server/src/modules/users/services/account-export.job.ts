import { getEventProvider, getStorageProvider } from '../../../common/providers/registry.js';
import { logger } from '../../../common/logging/logger.js';
import { accountDataRepository } from '../repositories/account-data.repository.js';
import type { EventTableName } from '../../../common/providers/interfaces/event-provider.interface.js';

/** DSAR export bundle (PRIV-002): everything we hold about one user, as JSON. */

const EXPORT_BUCKET = 'uploads';
export const EXPORT_TTL_HOURS = 72;

// Every user-partitioned DynamoDB event table. api_request_logs cannot be
// queried by user and is excluded (short-TTL operational logs).
const EVENT_TABLES: EventTableName[] = [
  'audit_events',
  'fraud_signals',
  'search_events',
  'analytics_events',
  'communication_logs',
  'recommendation_signals',
];

// The two key shapes assertKeyOwnedByUser accepts — the same convention the
// deletion sweep relies on.
const STORAGE_BUCKETS = ['uploads', 'listings', 'verification', 'chat', 'claims'];
export function userStoragePrefixes(userId: string): string[] {
  return [`${userId}/`, `properties/${userId}/`];
}

export async function runAccountExport(userId: string, requestId: string): Promise<{
  exportKey: string;
  exportExpiresAt: Date;
}> {
  const bundle: Record<string, unknown> = {
    _readme:
      'IstaSeva personal-data export (DSAR). Sections mirror our internal stores. '
      + 'Financial records (bookings, payments, payouts) are retained after account '
      + 'deletion as required by Indian tax law; everything else is erased on deletion.',
    generatedAt: new Date().toISOString(),
    userId,
    requestId,
  };

  // Postgres sections. A missing/failed section is recorded rather than
  // failing the whole bundle — the user still gets everything else.
  for (const query of accountDataRepository.exportQueries(userId)) {
    try {
      bundle[query.section] = await accountDataRepository.runStatement(query);
    } catch (err) {
      logger.warn('Export section failed', { userId, section: query.section, err: String(err) });
      bundle[query.section] = { error: 'section unavailable' };
    }
  }

  // DynamoDB event trails.
  const events: Record<string, unknown> = {};
  try {
    const eventProvider = await getEventProvider();
    for (const table of EVENT_TABLES) {
      try {
        events[table] = await eventProvider.queryByUser(table, userId);
      } catch (err) {
        logger.warn('Export events failed', { userId, table, err: String(err) });
        events[table] = { error: 'table unavailable' };
      }
    }
  } catch (err) {
    logger.warn('Export event provider unavailable', { userId, err: String(err) });
  }
  bundle.events = events;

  // Stored files: keys only (KYC documents, chat media, photos). The bytes
  // stay behind authenticated presigned downloads.
  const files: Record<string, string[]> = {};
  try {
    const storage = await getStorageProvider();
    for (const bucket of STORAGE_BUCKETS) {
      const keys: string[] = [];
      for (const prefix of userStoragePrefixes(userId)) {
        try {
          const listed = await storage.listObjects({ bucket, prefix });
          keys.push(...listed.files);
        } catch (err) {
          logger.warn('Export storage list failed', { userId, bucket, prefix, err: String(err) });
        }
      }
      if (keys.length > 0) files[bucket] = keys;
    }
  } catch (err) {
    logger.warn('Export storage provider unavailable', { userId, err: String(err) });
  }
  bundle.stored_files = files;

  // Persist under the user's own prefix so the standard storage ownership
  // check lets them (and only them) download it.
  const exportKey = `${userId}/exports/account-export-${requestId}.json`;
  const storage = await getStorageProvider();
  await storage.putObject({
    bucket: EXPORT_BUCKET,
    key: exportKey,
    body: JSON.stringify(bundle, null, 2),
    contentType: 'application/json',
  });

  return {
    exportKey,
    exportExpiresAt: new Date(Date.now() + EXPORT_TTL_HOURS * 60 * 60 * 1000),
  };
}

export const EXPORT_BUCKET_NAME = EXPORT_BUCKET;
