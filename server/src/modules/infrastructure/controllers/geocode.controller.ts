import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../../common/errors/app-error.js';
import { autocompleteAddress, geocodeAddress, placeDetailsForId } from '../../../common/services/geocode.service.js';
import { cacheGet, cacheSet } from '../../../common/cache/redis.js';

const geocodeSchema = z.object({
  address: z.string().min(3).max(500),
});

const autocompleteSchema = z.object({
  input: z.string().min(3).max(200),
  // 'regions' (default): settlements only, for the stays city/town search.
  // 'address': unrestricted (incl. establishments), for booking address and
  // pickup-point fields. See AutocompleteMode in geocode.service.
  mode: z.enum(['regions', 'address']).optional(),
});

const placeDetailsSchema = z.object({
  placeId: z.string().min(3).max(255),
});

/**
 * Thin proxy in front of the geocoding provider so the browser never sees the
 * Google Maps API key. Adds a Redis cache layer (24h) on top of the in-process
 * cache inside `geocode.service` — this one survives container restarts and
 * is shared across tasks.
 */
export class GeocodeController {
  async geocode(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = geocodeSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      const normalized = parsed.data.address.trim().toLowerCase();
      const cacheKey = `geocode:${normalized}`;

      const cached = await cacheGet<{ lat: number; lng: number } | null>(cacheKey);
      if (cached !== null) {
        res.json({ result: cached, cached: true });
        return;
      }

      const result = await geocodeAddress(parsed.data.address);
      // Cache positives for 24h, negatives for 5m (so a typo or unresolved
      // address gets a chance to retry sooner without flooding upstream).
      await cacheSet(cacheKey, result, result ? 86400 : 300);
      res.json({ result, cached: false });
    } catch (err) {
      next(err);
    }
  }

  async autocomplete(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = autocompleteSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      const mode = parsed.data.mode ?? 'regions';
      const normalized = parsed.data.input.trim().toLowerCase();
      const cacheKey = `places:autocomplete:${mode}:${normalized}`;

      const cached = await cacheGet<Awaited<ReturnType<typeof autocompleteAddress>>>(cacheKey);
      if (cached !== null) {
        res.json({ suggestions: cached, cached: true });
        return;
      }

      const suggestions = await autocompleteAddress(parsed.data.input, mode);
      await cacheSet(cacheKey, suggestions, suggestions.length > 0 ? 86400 : 300);
      res.json({ suggestions, cached: false });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Resolve a Google Place Autocomplete `place_id` into coordinates +
   * admin hierarchy. Powers the stays-marketplace location filter: the
   * frontend picks a suggestion, calls this to get lat/lng + locality
   * + district, then filters stays by distance OR district equivalence.
   *
   * Result cached 24h on hits, 5m on misses — place_id is stable so
   * a long TTL is safe.
   */
  async placeDetails(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = placeDetailsSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      const cacheKey = `places:details:${parsed.data.placeId}`;
      const cached = await cacheGet<Awaited<ReturnType<typeof placeDetailsForId>>>(cacheKey);
      if (cached !== null) {
        res.json({ result: cached, cached: true });
        return;
      }

      const result = await placeDetailsForId(parsed.data.placeId);
      await cacheSet(cacheKey, result, result ? 86400 : 300);
      res.json({ result, cached: false });
    } catch (err) {
      next(err);
    }
  }
}

export const geocodeController = new GeocodeController();
