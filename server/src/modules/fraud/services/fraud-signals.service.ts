import { dbQuery } from '../../../common/repositories/database.js';
import { getEventProvider } from '../../../common/providers/registry.js';
import { logger } from '../../../common/logging/logger.js';
import { trackServerEvent } from '../../analytics/services/analytics-track.js';
import type { FraudSignalInput } from '../schemas/fraud-signal.schema.js';
import { RETENTION_DAYS } from '../../../common/config/retention.js';

const FRAUD_SIGNAL_TTL_SECONDS = RETENTION_DAYS.fraudSignals * 24 * 60 * 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class FraudSignalsService {
  async createSignal(userId: string, payload: FraudSignalInput) {
    const event = {
      userId,
      eventType: payload.eventType,
      riskLevel: payload.riskLevel,
      deviceId: payload.deviceId,
      sessionId: payload.sessionId,
      ipAddress: payload.ipAddress,
      metadata: payload.metadata ?? {},
      timestamp: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + FRAUD_SIGNAL_TTL_SECONDS,
    };

    await getEventProvider().then((eventProvider) => eventProvider.putEvent('fraud_signals', event));

    // Postgres mirror powers the admin ops console (cross-user filters by
    // risk/type/date — DynamoDB's userId partitioning can't answer those).
    // Best-effort: a mirror failure must never block signal ingestion.
    try {
      await dbQuery(
        `INSERT INTO fraud_signals (user_id, event_type, risk_level, device_id, session_id, ip_address, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          userId,
          payload.eventType,
          payload.riskLevel,
          payload.deviceId ?? null,
          payload.sessionId ?? null,
          payload.ipAddress ?? null,
          JSON.stringify(payload.metadata ?? {}),
        ]
      );
    } catch (err) {
      logger.warn('Fraud signal Postgres mirror write failed', {
        userId,
        eventType: payload.eventType,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    // Also surface in the analytics pipeline so the admin dashboard can show
    // fraud-signal volume + severity alongside the other metrics.
    trackServerEvent('fraud_signal', {
      userId,
      source: 'fraud',
      props: { riskLevel: payload.riskLevel, kind: payload.eventType },
    });

    if (payload.riskLevel === 'critical') {
      // metadata.bookingId is client-supplied free-form metadata; only attach
      // it when it's a real booking id (safety_alerts.booking_id is now
      // FK-backed — SEC-006). The alert itself is always recorded.
      const rawBookingId = payload.metadata?.bookingId;
      const bookingId =
        typeof rawBookingId === 'string' && UUID_RE.test(rawBookingId) ? rawBookingId : null;
      await dbQuery(
        `INSERT INTO safety_alerts
         (user_id, booking_id, alert_type, description, status, emergency_contacts_notified)
         VALUES ($1, (SELECT id FROM public.bookings WHERE id = $2::uuid), $3, $4, 'open', false)
         RETURNING id`,
        [
          userId,
          bookingId,
          'fraud_signal',
          payload.metadata?.description ?? `Critical fraud signal: ${payload.eventType}`,
        ]
      );
    }

    logger.info('Fraud signal recorded', {
      userId,
      eventType: payload.eventType,
      riskLevel: payload.riskLevel,
    });

    return { data: { recorded: true } };
  }
}

export const fraudSignalsService = new FraudSignalsService();
