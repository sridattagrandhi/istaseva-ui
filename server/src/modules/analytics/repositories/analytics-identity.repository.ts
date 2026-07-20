import { dbQuery } from '../../../common/repositories/database.js';

/**
 * Identity stitching + acquisition attribution writes, driven by the analytics
 * ingest path (signup/login events already carry deviceId + channel, and the
 * server stamps the authoritative userId — no extra client calls needed).
 */
export class AnalyticsIdentityRepository {
  /** Link an analytics deviceId to a user. Idempotent; refreshes last_seen_at. */
  upsertDeviceLink(deviceId: string, userId: string) {
    return dbQuery(
      `INSERT INTO analytics_device_links (device_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (device_id, user_id) DO UPDATE SET last_seen_at = NOW()`,
      [deviceId, userId],
    );
  }

  /**
   * Persist the first-touch acquisition channel captured at signup. Set-once:
   * a user acquired via "instagram" stays attributed to instagram even if a
   * later session arrives via a different channel. Durable in Postgres because
   * raw analytics events expire after 1 year.
   */
  setAcquisitionChannelOnce(userId: string, channel: string) {
    return dbQuery(
      `UPDATE user_profiles
       SET acquisition_channel = $2, acquired_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND acquisition_channel IS NULL`,
      [userId, channel.slice(0, 40)],
    );
  }
}

export const analyticsIdentityRepository = new AnalyticsIdentityRepository();
