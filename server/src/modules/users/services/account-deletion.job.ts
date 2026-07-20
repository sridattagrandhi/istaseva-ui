import { getAuthProvider, getEventProvider, getStorageProvider } from '../../../common/providers/registry.js';
import { logger } from '../../../common/logging/logger.js';
import { logAuditEvent } from '../../../common/logging/audit-log.js';
import { accountDataRepository } from '../repositories/account-data.repository.js';
import { requestMixpanelDeletion } from '../adapters/mixpanel-deletion.adapter.js';
import { userStoragePrefixes } from './account-export.job.js';
import type { EventTableName } from '../../../common/providers/interfaces/event-provider.interface.js';

/**
 * Account-deletion orchestrator (PRIV-002 / LEG-017).
 *
 * Runs AFTER the 48h grace window has passed and the lifecycle service has
 * locked the account out (is_deleted flag — enforced by require-auth —
 * revoked sessions, disabled IdP user). Every stage is idempotent, so the
 * recovery sweeper can safely re-run a partial failure.
 *
 * Stage order: Postgres erase → PII scrub on retained rows → listings →
 * S3 sweep → DynamoDB sweep → IdP delete → profile anonymize. The IdP user
 * is deleted only after the data is gone; the profile row is anonymized LAST
 * so its is_deleted flag keeps blocking any still-valid token throughout.
 */

const SWEEP_BUCKETS = ['uploads', 'listings', 'verification', 'chat', 'claims'];

const EVENT_TABLES: EventTableName[] = [
  'audit_events',
  'fraud_signals',
  'search_events',
  'analytics_events',
  'communication_logs',
  'recommendation_signals',
];

export async function runAccountDeletion(userId: string): Promise<void> {
  // 1. Hard-delete the non-retained Postgres rows.
  for (const statement of accountDataRepository.eraseStatements(userId)) {
    await accountDataRepository.runStatement(statement);
  }

  // 2. Scrub PII columns on statutorily retained rows (bookings, guarantees,
  //    provider profile). Receipt/invoice snapshots stay — GST retention.
  for (const statement of accountDataRepository.scrubStatements(userId)) {
    await accountDataRepository.runStatement(statement);
  }

  // 3. Listings: clear other users' wishlist pointers, then hard-delete
  //    (room types, overrides, listing coupons, fee-rule scopes cascade).
  const listingIds = await accountDataRepository.getOwnedListingIds(userId);
  await accountDataRepository.deleteWishlistsForListings(listingIds);
  const deletedListings = await accountDataRepository.deleteListings(userId);

  // 4. S3 sweep: every object under the user's key prefixes, including any
  //    export bundles produced earlier (they live under <userId>/exports/).
  //    Prefer the version-aware purge: prod buckets are versioned, where a
  //    plain delete only writes a delete marker and the bytes survive as
  //    noncurrent versions. Fall back to list+delete for providers without
  //    versioning (local dev).
  let deletedObjects = 0;
  const storage = await getStorageProvider();
  for (const bucket of SWEEP_BUCKETS) {
    for (const prefix of userStoragePrefixes(userId)) {
      if (storage.purgeObjectVersions) {
        deletedObjects += (await storage.purgeObjectVersions({ bucket, prefix })).deleted;
      } else {
        const listed = await storage.listObjects({ bucket, prefix });
        for (const key of listed.files) {
          await storage.deleteObject({ bucket, key });
          deletedObjects++;
        }
      }
    }
  }

  // 5. DynamoDB event trails. The final account.deletion_completed audit
  //    event below is written AFTER this sweep and is keyed to the (now
  //    unlinkable) UID — that single tombstone is the deletion evidence.
  const eventProvider = await getEventProvider();
  let deletedEvents = 0;
  for (const table of EVENT_TABLES) {
    deletedEvents += await eventProvider.deleteByUser(table, userId);
  }

  // 6. Vendor erasure (PRIV-002): ask third-party processors holding personal
  //    data keyed to this user to delete it. No-ops when the vendor isn't
  //    configured; throws (→ sweeper retry) when configured but failing.
  //    Razorpay records are statutorily retained (payments/GST) — documented
  //    in the retention schedule, not deleted.
  const mixpanel = await requestMixpanelDeletion(userId);

  // 7. Delete the IdP user (idempotent; optional capability).
  const authProvider = await getAuthProvider();
  if (authProvider.deleteUser) {
    await authProvider.deleteUser(userId);
  }

  // 8. Anonymize the master profile row (kept for the is_deleted flag).
  await accountDataRepository.anonymizeUserProfile(userId);

  logger.info('Account deletion completed', { userId, deletedListings, deletedObjects, deletedEvents });
  logAuditEvent({
    event: 'account.deletion_completed',
    user_id: userId,
    metadata: {
      deletedListings,
      deletedObjects,
      deletedEvents,
      vendorErasure: { mixpanel: mixpanel.requested ? (mixpanel.taskId ?? 'requested') : mixpanel.reason },
    },
  });
}
