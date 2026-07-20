import { cacheGet, cacheSet } from '../../../common/cache/redis.js';
import { logger } from '../../../common/logging/logger.js';
import { analyticsIdentityRepository } from '../repositories/analytics-identity.repository.js';

/**
 * Stitches the anonymous analytics deviceId to the authenticated user when a
 * signup/login event flows through ingest, and persists the first-touch
 * acquisition channel on the user row at signup (set-once).
 *
 * Fire-and-forget from the ingest path: never throws, never blocks the 202.
 * A short-TTL Redis marker (same pattern as upsertUserEmail in
 * common/auth/require-auth.ts) keeps repeated logins from hammering Postgres.
 */
export class IdentityStitchService {
  async handleAuthEvent(input: {
    eventType: string;
    userId: string;
    deviceId?: string;
    channel?: string;
  }): Promise<void> {
    const { eventType, userId, deviceId, channel } = input;
    if (eventType !== 'signup' && eventType !== 'login') return;
    if (!userId || userId === 'anonymous' || !deviceId) return;

    const markerKey = `analytics:stitch:${userId}:${deviceId}`;
    try {
      // Signup must always write (the set-once channel attribution rides on
      // it); only repeat logins are throttled by the marker.
      if (eventType === 'login' && (await cacheGet<string>(markerKey))) return;
    } catch {
      // best-effort cache lookup
    }

    try {
      await analyticsIdentityRepository.upsertDeviceLink(deviceId, userId);
      if (eventType === 'signup' && channel) {
        await analyticsIdentityRepository.setAcquisitionChannelOnce(userId, channel);
      }
      try {
        await cacheSet(markerKey, '1', 3600);
      } catch {
        // cache write failure is non-fatal
      }
    } catch (err) {
      logger.debug('identity stitch skipped', { err: String(err) });
    }
  }
}

export const identityStitchService = new IdentityStitchService();
