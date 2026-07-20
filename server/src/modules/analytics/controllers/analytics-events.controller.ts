import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getEventProvider } from '../../../common/providers/registry.js';
import { logger } from '../../../common/logging/logger.js';
import { RETENTION_DAYS } from '../../../common/config/retention.js';
import { identityStitchService } from '../services/identity-stitch.service.js';
import { EVENT_CONTRACT_VERSION, eventSpec } from '../contract/events.js';

// Canonical behavioural-event envelope. Kept deliberately flat and typed so the
// same rows are queryable now (nightly rollups) and ML-ready later without a
// re-plumb. The server stamps the authoritative `userId`/`timestamp`; the
// client only supplies the event shape.
//
// PRIVACY (DPDP): `props` must never carry PII — no names, emails, or phone
// numbers — and never any caste/community data. Location is coarse city/state
// strings only, never lat/lng. It is exploratory signal, expired after 1 year.
const eventTypeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_.]+$/, 'eventType must be snake_case (a-z, 0-9, _, .)');

const analyticsEventSchema = z.object({
  eventType: eventTypeSchema,
  // Client platform the event fired from (web / mobile). Server-emitted events
  // set this to 'server' via trackServerEvent.
  platform: z.enum(['web', 'mobile', 'server']).optional(),
  // First-touch acquisition channel (utm_source / referrer host / "direct" / "app").
  channel: z.string().max(40).optional(),
  // Stable per-device id (localStorage/AsyncStorage) so anonymous, pre-login
  // browsing still forms a coherent series.
  deviceId: z.string().min(1).max(128).optional(),
  sessionId: z.string().min(1).max(128).optional(),
  listingId: z.string().max(128).optional(),
  listingType: z.enum(['stay', 'service', 'transport']).optional(),
  category: z.string().max(64).optional(),
  // Screen/route the event fired from.
  source: z.string().max(128).optional(),
  // Optional client-reported time (server time remains authoritative).
  clientTs: z.string().datetime().optional(),
  // Active UI language (i18n code, e.g. "te") — drives the language-mix rollup.
  language: z.string().max(16).optional(),
  // Coarse customer origin, sent only after the user grants geolocation and a
  // reverse geocode resolves. City/state strings only — never coordinates.
  originCity: z.string().max(80).optional(),
  originState: z.string().max(80).optional(),
  props: z.record(z.unknown()).optional(),
});

// Clients batch events to avoid a request per interaction.
const ingestSchema = z.object({
  events: z.array(analyticsEventSchema).min(1).max(50),
});

// Behavioural events are analytics signal, not transactional state —
// retention is centralized in common/config/retention.ts (PRIV-004).
const ANALYTICS_EVENT_TTL_SECONDS = RETENTION_DAYS.analyticsEvents * 24 * 60 * 60;

export class AnalyticsEventsController {
  // POST /api/analytics/events — append a batch of behavioural events to the
  // `analytics_events` DynamoDB table. Best-effort: a write failure never fails
  // the request, since this is signal, not user-facing state. optionalAuth so
  // the userId is captured when signed in but anonymous browsing still logs.
  async ingest(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = ingestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }

      const userId = req.user?.id || 'anonymous';
      const nowMs = Date.now();
      const expiresAt = Math.floor(nowMs / 1000) + ANALYTICS_EVENT_TTL_SECONDS;

      // Stamp the contract version (PUX-014) authoritatively from the server's
      // registry — never trust a client-sent version. Unknown event names are
      // still stored (analytics is best-effort) but flagged as unregistered so
      // drift/typos surface in logs instead of silently corrupting rollups.
      let unregistered = 0;
      const propMismatches: string[] = [];
      const payloads = parsed.data.events.map((event) => {
        const timestamp = new Date(nowMs).toISOString();
        const spec = eventSpec(event.eventType);
        if (!spec) {
          unregistered += 1;
        } else if (event.props && !spec.props.safeParse(event.props).success) {
          // Lenient: a props-shape mismatch (e.g. revenuePaise sent as a string)
          // is flagged so it can be fixed, but the row is still stored.
          propMismatches.push(event.eventType);
        }
        return {
          userId,
          eventId: randomUUID(),
          eventType: event.eventType,
          contractVersion: EVENT_CONTRACT_VERSION,
          eventVersion: spec?.version ?? 0,
          platform: event.platform ?? 'web',
          channel: event.channel,
          deviceId: event.deviceId,
          sessionId: event.sessionId,
          listingId: event.listingId,
          listingType: event.listingType,
          category: event.category,
          source: event.source,
          clientTs: event.clientTs,
          language: event.language,
          originCity: event.originCity,
          originState: event.originState,
          props: event.props ?? {},
          timestamp,
          date: timestamp.slice(0, 10),
          expiresAt,
        };
      });

      if (unregistered > 0) {
        // Not an error — the row is stored — but it means a client fired an event
        // name that isn't in the canonical contract (a typo or an un-added event).
        logger.warn('Unregistered analytics event(s) ingested', {
          unregistered,
          total: payloads.length,
          names: [...new Set(parsed.data.events.map((e) => e.eventType).filter((n) => !eventSpec(n)))].slice(0, 10),
        });
      }
      if (propMismatches.length > 0) {
        // Registered event whose props don't match the contract's shape — stored,
        // but flagged so the offending client can be corrected (PUX-014).
        logger.warn('Analytics event props did not match the contract', {
          count: propMismatches.length,
          names: [...new Set(propMismatches)].slice(0, 10),
        });
      }

      // Identity stitch: signup/login events already carry the deviceId and
      // first-touch channel, and userId is authoritative here — link them in
      // Postgres (device↔user + set-once acquisition channel). Fire-and-forget,
      // outside the DynamoDB write path; the service never throws.
      if (userId !== 'anonymous') {
        for (const event of parsed.data.events) {
          if ((event.eventType === 'signup' || event.eventType === 'login') && event.deviceId) {
            void identityStitchService.handleAuthEvent({
              eventType: event.eventType,
              userId,
              deviceId: event.deviceId,
              channel: event.channel,
            });
          }
        }
      }

      // Fire-and-forget: respond 202 immediately and let the DynamoDB writes
      // settle in the background. The client doesn't need the result.
      void getEventProvider()
        .then(async (eventProvider) => {
          const results = await Promise.allSettled(
            payloads.map((payload) => eventProvider.putEvent('analytics_events', payload)),
          );
          const failed = results.filter((r) => r.status === 'rejected').length;
          if (failed > 0) {
            logger.warn('Analytics event write partially failed', { failed, total: payloads.length });
          }
        })
        .catch((error: Error) => {
          logger.warn('Analytics event write failed', { error: error.message });
        });

      return res.status(202).json({ success: true, accepted: payloads.length });
    } catch (err) {
      next(err);
    }
  }
}

export const analyticsEventsController = new AnalyticsEventsController();
