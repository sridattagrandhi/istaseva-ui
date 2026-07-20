import { z } from 'zod';

/**
 * Geocoding provider config.
 *
 *  - `nominatim` — OpenStreetMap, free, no key. Hard 1 req/sec rate limit per
 *    OSM's usage policy. Fine for local dev; not safe at scale.
 *  - `google`    — Google Maps Geocoding API. Best India coverage. Requires
 *    GOOGLE_MAPS_API_KEY. Billed per request, but the $200/mo Google credit
 *    covers ~40k geocodes free.
 */
export const geocodingSchema = z.object({
  provider: z.enum(['nominatim', 'google']).default('nominatim'),
  googleMapsApiKey: z.string().optional(),
});
