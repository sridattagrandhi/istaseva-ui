import { getEventProvider } from '../providers/registry.js';
import { RETENTION_DAYS, ttlEpochSeconds } from '../config/retention.js';
import { logger } from './logger.js';

interface AuditEvent {
  event: string;
  booking_id?: string | null;
  payment_id?: string | null;
  user_id?: string | null;
  from_status?: string | null;
  to_status?: string | null;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export function logAuditEvent(event: AuditEvent) {
  const timestamp = event.timestamp || new Date().toISOString();
  const action = event.event;
  const [resource = 'system'] = action.split('.');
  const resourceId =
    (resource === 'booking' ? event.booking_id : null)
    ?? (resource === 'payment' ? event.payment_id : null)
    ?? event.booking_id
    ?? event.payment_id
    ?? 'unknown';

  const payload = {
    userId: event.user_id || 'system',
    action,
    resource,
    resourceId,
    bookingId: event.booking_id ?? null,
    paymentId: event.payment_id ?? null,
    fromStatus: event.from_status ?? null,
    toStatus: event.to_status ?? null,
    metadata: event.metadata ?? {},
    timestamp,
    expiresAt: ttlEpochSeconds(RETENTION_DAYS.auditEvents),
  };

  logger.info('Audit event', payload);

  void getEventProvider()
    .then((eventProvider) => eventProvider.putEvent('audit_events', payload))
    .catch((error: Error) => {
      logger.warn('Audit write failed', { error: error.message, action, resourceId });
    });
}
