import { randomUUID } from 'node:crypto';
import { getEventProvider } from '../../../common/providers/registry.js';
import { logger } from '../../../common/logging/logger.js';
import { RETENTION_DAYS } from '../../../common/config/retention.js';
import { EVENT_CONTRACT_VERSION, eventSpec, type EventName } from '../contract/events.js';

// Behavioural-event retention is centralized in common/config/retention.ts
// (PRIV-004; same value as the ingest controller by construction).
const ANALYTICS_EVENT_TTL_SECONDS = RETENTION_DAYS.analyticsEvents * 24 * 60 * 60;

/**
 * Server-side emitter for the same `analytics_events` envelope the clients POST
 * to /api/analytics/events. Used for events that must be reliable regardless of
 * the client (e.g. `booking_confirmed`, which drives the funnel's tail).
 * Fire-and-forget: never throws, never blocks the caller.
 */
export function trackServerEvent(eventType: EventName, opts: {
  userId?: string | null;
  listingId?: string | null;
  listingType?: 'stay' | 'service' | 'transport' | null;
  source?: string;
  props?: Record<string, unknown>;
} = {}): void {
  const nowMs = Date.now();
  const timestamp = new Date(nowMs).toISOString();
  const payload = {
    userId: opts.userId || 'system',
    eventId: randomUUID(),
    eventType,
    // PUX-014: stamp the contract + per-event version authoritatively.
    contractVersion: EVENT_CONTRACT_VERSION,
    eventVersion: eventSpec(eventType)?.version ?? 0,
    platform: 'server',
    listingId: opts.listingId ?? undefined,
    listingType: opts.listingType ?? undefined,
    source: opts.source ?? 'server',
    props: opts.props ?? {},
    timestamp,
    date: timestamp.slice(0, 10),
    expiresAt: Math.floor(nowMs / 1000) + ANALYTICS_EVENT_TTL_SECONDS,
  };
  void getEventProvider()
    .then((eventProvider) => eventProvider.putEvent('analytics_events', payload))
    .catch((error: Error) => logger.warn('Server analytics event write failed', { error: error.message, eventType }));
}
