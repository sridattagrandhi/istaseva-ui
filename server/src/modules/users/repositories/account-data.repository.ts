import type pg from 'pg';
import { dbQuery } from '../../../common/repositories/database.js';

/**
 * Data access for the DSAR export and account-deletion jobs (PRIV-002).
 *
 * EXPORT reads and ERASURE writes live together so the two lists stay in
 * sight of each other: anything exported should be either erased or
 * documented as retained below.
 *
 * Retention policy encoded here (defaults pending Legal/CFO sign-off — see
 * the account-lifecycle plan):
 * - RETAINED for statutory/financial reasons: bookings, payments, payouts,
 *   insurance_policies/claims, coupon_redemptions, admin_actions,
 *   consent_records (proof of consent). PII *columns* on retained rows are
 *   scrubbed; the opaque Firebase UID stays as the ledger key — once the
 *   profile, IdP user, and every linkable store are gone it no longer
 *   identifies a person.
 * - GST invoices/receipt snapshots on bookings are legally required to keep
 *   recipient details; they are NOT scrubbed.
 * - ERASED: everything else the user owns.
 */
export class AccountDataRepository {
  // ---------------------------------------------------------------- export

  /** Every table the export bundle includes, keyed by bundle section name. */
  exportQueries(userId: string): Array<{ section: string; sql: string; params: unknown[] }> {
    const u = [userId];
    return [
      { section: 'profile', sql: 'SELECT * FROM user_profiles WHERE user_id = $1', params: u },
      { section: 'provider_profile', sql: 'SELECT * FROM provider_profiles WHERE user_id = $1', params: u },
      { section: 'listings', sql: 'SELECT * FROM listings WHERE user_id = $1', params: u },
      { section: 'bookings', sql: 'SELECT * FROM bookings WHERE user_id = $1 OR created_by_user_id = $1', params: u },
      { section: 'payments', sql: 'SELECT * FROM payments WHERE user_id = $1', params: u },
      { section: 'reviews', sql: 'SELECT * FROM reviews WHERE user_id = $1', params: u },
      { section: 'messages', sql: 'SELECT * FROM messages WHERE sender_id = $1 OR receiver_id = $1', params: u },
      { section: 'notifications', sql: 'SELECT * FROM notifications WHERE user_id = $1', params: u },
      { section: 'wishlists', sql: 'SELECT * FROM user_wishlists WHERE user_id = $1', params: u },
      { section: 'assistant_memory', sql: 'SELECT * FROM user_assistant_memory WHERE user_id = $1', params: u },
      { section: 'transport_quotes', sql: 'SELECT * FROM transport_quotes WHERE user_id = $1', params: u },
      { section: 'safety_alerts', sql: 'SELECT * FROM safety_alerts WHERE user_id = $1', params: u },
      { section: 'consents', sql: 'SELECT * FROM consent_records WHERE user_id = $1', params: u },
      { section: 'verification_documents', sql: 'SELECT id, document_type, document_number, status, created_at FROM verification_documents WHERE user_id = $1', params: u },
      { section: 'payout_accounts', sql: 'SELECT * FROM payout_accounts WHERE user_id = $1', params: u },
      { section: 'payouts', sql: 'SELECT * FROM payouts WHERE provider_user_id = $1', params: u },
      { section: 'insurance_policies', sql: 'SELECT * FROM insurance_policies WHERE user_id = $1', params: u },
      { section: 'insurance_claims', sql: 'SELECT * FROM insurance_claims WHERE user_id = $1', params: u },
      { section: 'coupon_redemptions', sql: 'SELECT * FROM coupon_redemptions WHERE user_id = $1', params: u },
      { section: 'coupons_created', sql: 'SELECT * FROM coupons WHERE host_user_id = $1', params: u },
      { section: 'fcm_devices', sql: 'SELECT platform, device_hint, created_at FROM fcm_tokens WHERE user_id = $1', params: u },
      { section: 'analytics_profile', sql: 'SELECT * FROM analytics_customer_profiles WHERE user_id = $1', params: u },
      { section: 'analytics_devices', sql: 'SELECT * FROM analytics_device_links WHERE user_id = $1', params: u },
    ];
  }

  /** Execute one export/erase/scrub statement; returns rows (for exports). */
  async runStatement(query: { sql: string; params: unknown[] }) {
    const result = await dbQuery(query.sql, query.params);
    return result.rows;
  }

  // --------------------------------------------------------------- erasure

  /** The listing ids a user owns — needed for pre-delete cleanups. */
  async getOwnedListingIds(userId: string): Promise<string[]> {
    const result = await dbQuery<{ id: string }>('SELECT id FROM listings WHERE user_id = $1', [userId]);
    return result.rows.map((r) => r.id);
  }

  /**
   * Hard-delete every personal-data row that is NOT statutorily retained.
   * Each statement is independently idempotent; the job re-runs the whole
   * list on retry. Order matters only where noted.
   */
  eraseStatements(userId: string): Array<{ label: string; sql: string; params: unknown[] }> {
    const u = [userId];
    return [
      { label: 'assistant_memory', sql: 'DELETE FROM user_assistant_memory WHERE user_id = $1', params: u },
      { label: 'wishlists', sql: 'DELETE FROM user_wishlists WHERE user_id = $1', params: u },
      { label: 'notifications', sql: 'DELETE FROM notifications WHERE user_id = $1', params: u },
      { label: 'fcm_tokens', sql: 'DELETE FROM fcm_tokens WHERE user_id = $1', params: u },
      // Two-sided rows: erasing one side removes the thread for both — a chat
      // with a deleted account disappears rather than showing orphan halves.
      { label: 'messages', sql: 'DELETE FROM messages WHERE sender_id = $1 OR receiver_id = $1', params: u },
      { label: 'conversations', sql: 'DELETE FROM conversations WHERE user_id = $1 OR other_user_id = $1', params: u },
      // Votes cascade with reviews; this handles the user's votes on others'.
      { label: 'review_helpful_votes', sql: 'DELETE FROM review_helpful_votes WHERE user_id = $1', params: u },
      // trg_refresh_listing_rating keeps listing rating denorms consistent.
      { label: 'reviews', sql: 'DELETE FROM reviews WHERE user_id = $1', params: u },
      // locked_by was converted to TEXT in 20260411100000.
      { label: 'slot_locks', sql: 'DELETE FROM slot_locks WHERE locked_by = $1', params: u },
      { label: 'transport_quotes', sql: 'DELETE FROM transport_quotes WHERE user_id = $1', params: u },
      { label: 'safety_alerts', sql: 'DELETE FROM safety_alerts WHERE user_id = $1', params: u },
      // Booking-scoped safety evidence is kept; only the identity is unlinked.
      { label: 'safety_checks', sql: 'UPDATE safety_checks SET initiated_by = NULL WHERE initiated_by = $1', params: u },
      // KYC rows go; the S3 objects go in the storage sweep (LEG-013).
      { label: 'verification_documents', sql: 'DELETE FROM verification_documents WHERE user_id = $1', params: u },
      { label: 'coupon_users', sql: 'DELETE FROM coupon_users WHERE user_id = $1', params: u },
      // Redemption ledger rows are retained (financial); the host's coupon
      // definitions are deactivated (not deleted) so redemption history keeps
      // its FK target. host_user_id STAYS: the coupons_owner_or_platform
      // CHECK requires an owner on non-platform coupons, and the opaque UID
      // is the same retained ledger key the bookings/payments rows keep.
      { label: 'coupons_deactivate', sql: 'UPDATE coupons SET is_active = FALSE WHERE host_user_id = $1', params: u },
      // Payout bank/UPI details: purged — the payouts ledger already carries
      // a masked account_snapshot, which is the retained financial record.
      { label: 'payout_accounts', sql: 'DELETE FROM payout_accounts WHERE user_id = $1', params: u },
      // Analytics identity: both the RFM profile and device stitching go.
      { label: 'analytics_customer_profiles', sql: 'DELETE FROM analytics_customer_profiles WHERE user_id = $1', params: u },
      { label: 'analytics_device_links', sql: 'DELETE FROM analytics_device_links WHERE user_id = $1', params: u },
      { label: 'fraud_signals', sql: 'DELETE FROM fraud_signals WHERE user_id = $1', params: u },
      // Moderation labels stay (ML/audit corpus per the table's comment) but
      // are de-linked from the person. storage_key is NOT NULL and the object
      // itself is deleted by the storage sweep, so the key becomes inert.
      { label: 'image_moderation_labels', sql: 'UPDATE image_moderation_labels SET user_id = NULL WHERE user_id = $1', params: u },
    ];
  }

  /**
   * PII scrubs on RETAINED rows. Receipt/invoice snapshots on bookings are
   * deliberately untouched — GST invoices must keep recipient details.
   */
  scrubStatements(userId: string): Array<{ label: string; sql: string; params: unknown[] }> {
    const u = [userId];
    return [
      {
        label: 'bookings_pii',
        sql: `UPDATE bookings
              SET address = NULL, notes = NULL, lat = NULL, lng = NULL,
                  cancellation_reason = NULL, guest_contact = NULL
              WHERE user_id = $1`,
        params: u,
      },
      {
        label: 'service_guarantees_claim_text',
        sql: 'UPDATE service_guarantees SET claim_description = NULL WHERE user_id = $1',
        params: u,
      },
      {
        // Provider profile cannot be hard-deleted: bookings.provider_id has a
        // non-cascading FK. Scrub the PII and take it off the marketplace.
        label: 'provider_profile_anonymize',
        sql: `UPDATE provider_profiles
              SET display_name = 'Deleted user', bio = NULL, lat = NULL, lng = NULL, is_available = FALSE
              WHERE user_id = $1`,
        params: u,
      },
      {
        label: 'provider_availability',
        sql: 'DELETE FROM provider_availability WHERE provider_id IN (SELECT id FROM provider_profiles WHERE user_id = $1)',
        params: u,
      },
      {
        label: 'provider_blackout_dates',
        sql: 'DELETE FROM provider_blackout_dates WHERE provider_id IN (SELECT id FROM provider_profiles WHERE user_id = $1)',
        params: u,
      },
    ];
  }

  /** Remove other users' wishlist rows pointing at soon-deleted listings. */
  async deleteWishlistsForListings(listingIds: string[]): Promise<void> {
    if (listingIds.length === 0) return;
    await dbQuery('DELETE FROM user_wishlists WHERE listing_id = ANY($1::uuid[])', [listingIds]);
  }

  /** Hard-delete the user's listings (room types etc. cascade). */
  async deleteListings(userId: string): Promise<number> {
    const result = await dbQuery('DELETE FROM listings WHERE user_id = $1', [userId]);
    return result.rowCount ?? 0;
  }

  /**
   * Final step: anonymize the master profile row. The row itself is KEPT so
   * the is_deleted flag keeps rejecting any still-valid tokens.
   */
  async anonymizeUserProfile(userId: string): Promise<void> {
    await dbQuery(
      `UPDATE user_profiles
       SET display_name = 'Deleted user', avatar_url = NULL, bio = NULL, phone = NULL,
           location = NULL, email = NULL, anonymized_at = NOW()
       WHERE user_id = $1`,
      [userId],
    );
  }

  /** Flag the account as deleted inside the request transaction. */
  async markProfileDeleted(client: pg.PoolClient, userId: string): Promise<void> {
    await client.query(
      `INSERT INTO user_profiles (user_id, display_name, is_deleted, deletion_requested_at)
       VALUES ($1, 'Deleted user', TRUE, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET is_deleted = TRUE, deletion_requested_at = NOW(), updated_at = NOW()`,
      [userId],
    );
  }
}

export const accountDataRepository = new AccountDataRepository();
