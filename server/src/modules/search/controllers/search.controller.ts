import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { searchService } from '../services/search.service.js';
import { getEventProvider } from '../../../common/providers/registry.js';
import { logger } from '../../../common/logging/logger.js';
import { RETENTION_DAYS } from '../../../common/config/retention.js';

// Query strings arrive as strings — use z.coerce for numerics so `?lat=12.9`
// parses cleanly. `q` is accepted as the conventional shorthand for `query`.
const searchSchema = z.object({
  query: z.string().min(1),
  category: z.string().optional(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  radiusKm: z.coerce.number().default(25),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  sortBy: z.enum(['relevance', 'distance', 'price', 'rating']).default('relevance'),
});

// Append-only log of a date-range selection on a marketplace listing page.
// `fromDate`/`toDate` are calendar days (YYYY-MM-DD); the frontend posts one
// event once the user has picked a complete check-in → check-out range.
const dateRangeEventSchema = z.object({
  listingType: z.enum(['stay', 'service', 'transport']).default('stay'),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fromDate must be YYYY-MM-DD'),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'toDate must be YYYY-MM-DD'),
  // Optional context so the same event row can carry whatever the search page
  // had active when the range was picked (location text, query, etc.).
  context: z.record(z.unknown()).optional(),
});

// Date-range search events are exploratory signal, not transactional state —
// retention is centralized in common/config/retention.ts (PRIV-004).
const SEARCH_EVENT_TTL_SECONDS = RETENTION_DAYS.searchEvents * 24 * 60 * 60;

export class SearchController {
  // POST /api/search/events/date-range — log a stay date-range selection to
  // the `search_events` DynamoDB table. Best-effort: a write failure never
  // fails the request, since this is analytics signal, not user-facing state.
  async logDateRangeEvent(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = dateRangeEventSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }

      // toDate must not precede fromDate (single-day same-date is allowed).
      if (parsed.data.toDate < parsed.data.fromDate) {
        return res.status(400).json({ error: 'toDate cannot be before fromDate' });
      }

      const timestamp = new Date().toISOString();
      const searchId = randomUUID();
      const payload = {
        userId: req.user?.id || 'anonymous',
        searchId,
        eventType: 'date_range_selected',
        listingType: parsed.data.listingType,
        fromDate: parsed.data.fromDate,
        toDate: parsed.data.toDate,
        metadata: parsed.data.context ?? {},
        timestamp,
        expiresAt: Math.floor(Date.now() / 1000) + SEARCH_EVENT_TTL_SECONDS,
      };

      // Fire-and-forget: respond 202 immediately and let the DynamoDB write
      // settle in the background. The client doesn't need the result.
      void getEventProvider()
        .then((eventProvider) => eventProvider.putEvent('search_events', payload))
        .catch((error: Error) => {
          logger.warn('Search date-range event write failed', { error: error.message, searchId });
        });

      return res.status(202).json({ success: true, searchId });
    } catch (err) {
      next(err);
    }
  }

  async search(req: Request, res: Response, next: NextFunction) {
    try {
      // Accept `q` as an alias for `query` (standard search-URL convention).
      // Strip NUL bytes first: Postgres text/tsquery reject a raw NUL byte with
      // `invalid byte sequence for encoding "UTF8": 0x00`, which would surface
      // as a 500. A pure-NUL query collapses to '' and fails the min(1) check
      // below as a clean 400.
      // eslint-disable-next-line no-control-regex -- deliberately matches NUL to strip it before Postgres rejects the byte
      const stripNul = (v: unknown) => (typeof v === 'string' ? v.replace(/\u0000/g, '') : v);
      const raw = {
        ...req.query,
        query: stripNul(req.query.query ?? req.query.q),
        category: stripNul(req.query.category),
      };
      const parsed = searchSchema.safeParse(raw);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }

      const response = await searchService.search({
        searchQuery: parsed.data.query,
        category: parsed.data.category,
        lat: parsed.data.lat,
        lng: parsed.data.lng,
        radiusKm: parsed.data.radiusKm,
        page: parsed.data.page,
        limit: parsed.data.limit,
        sortBy: parsed.data.sortBy,
      });

      res.json(response);
    } catch (err) {
      next(err);
    }
  }
}

export const searchController = new SearchController();
