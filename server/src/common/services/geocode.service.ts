import { logger } from '../logging/logger.js';
import { config } from '../config/index.js';

/** formattedAddress: the provider's canonical rendering of the query — used by
 *  the assistant to echo back what the map understood ("Plot 12, Jubilee
 *  Hills, Hyderabad 500033 — right?"). Optional: older cache entries and some
 *  responses won't carry it; lat/lng remain the load-bearing fields.
 *
 *  area: the neighbourhood the geocoded query resolved to ("Kukatpally"), or
 *  null when the query wasn't precise enough to name one — geocoding
 *  "Hyderabad, Telangana" returns no sublocality at all. That null is
 *  load-bearing: `listings.area` is derived from it, and the public location
 *  label must never claim more precision than the host actually stated. */
export type GeocodeResult = {
  lat: number;
  lng: number;
  formattedAddress?: string;
  area?: string | null;
} | null;
/**
 * `regions` (default) — settlements/admin areas only; the stays search where
 * users type city/town names. `address` — no type restriction; booking
 * address & pickup fields where establishments ("Trident Hotel") must match.
 */
export type AutocompleteMode = 'regions' | 'address';
export type AddressSuggestion = {
  id: string;
  description: string;
  mainText: string;
  secondaryText: string;
};

/**
 * Resolved geo + admin hierarchy for a picked autocomplete suggestion.
 * The stays-marketplace search uses this to filter listings by distance
 * AND by district/state equivalence — so picking "Tirumala" surfaces
 * stays whose `district` is "Tirupati" (the parent municipality, ~22 km
 * away) instead of dropping them on a tight radius cut.
 */
export type PlaceDetailsResult = {
  lat: number;
  lng: number;
  /** Smallest settlement name ("Tirumala", "Tirupati"). */
  locality: string | null;
  /** Parent admin area, usually the district / municipality. */
  district: string | null;
  /** State (administrative_area_level_1). */
  state: string | null;
  /** Country name — should always be "India" given the country bias. */
  country: string | null;
};

/**
 * Geocoding service with two backends:
 *
 *  - `nominatim` (OpenStreetMap, free, no key) — default for local dev. 1 req/sec
 *    rate limit per OSM's usage policy. Coverage in tier-3 Indian towns is
 *    spotty.
 *  - `google` — Google Maps Geocoding API. Best India coverage. Requires
 *    GOOGLE_MAPS_API_KEY. Billed per request (~$5/1k).
 *
 * Switched by GEOCODING_PROVIDER env var. The in-process Map cache below is
 * shared across both backends — repeat lookups never hit upstream.
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const GOOGLE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const GOOGLE_AUTOCOMPLETE_URL = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';
const GOOGLE_PLACE_DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';
const NOMINATIM_USER_AGENT = 'InstaServe/1.0 (https://instaserve.in; support@instaserve.in)';

const cache = new Map<string, GeocodeResult>();
const suggestionCache = new Map<string, AddressSuggestion[]>();
let lastNominatimRequestAt = 0;

type GoogleAddressComponent = { long_name: string; short_name: string; types: string[] };

/**
 * The neighbourhood component of a Google geocode result, or null.
 *
 * `sublocality_level_1` ONLY, deliberately:
 *  - It is consistently the area a person would name — "Kukatpally",
 *    "Bandra West", "Khairtabad", "Tirumala".
 *  - It cannot carry a street address. Google classifies roads as `route` and
 *    door numbers as `street_number`, so this component is safe to publish on
 *    an unbooked read (see listing-geo-privacy.ts). "Tank Bund Rd, opposite
 *    Hussain Sagar, Hyderabad" resolves here to "Khairtabad", not the road.
 *  - `sublocality_level_2` is skipped: it's landmark-grade ("Hussain Sagar")
 *    — finer than we want to publish and not how people name an area.
 *
 * Match on the full `types` array, never `types[0]` — Google puts `political`
 * first on these ("Kukatpally" is `[political, sublocality, sublocality_level_1]`).
 */
export function areaFromGoogleComponents(
  components: GoogleAddressComponent[] | undefined,
): string | null {
  if (!Array.isArray(components)) return null;
  const hit = components.find((c) => Array.isArray(c?.types) && c.types.includes('sublocality_level_1'));
  const name = hit?.long_name?.trim();
  return name ? name : null;
}

async function geocodeViaNominatim(query: string): Promise<GeocodeResult> {
  // Respect Nominatim's 1 req/sec policy
  const now = Date.now();
  const elapsed = now - lastNominatimRequestAt;
  if (elapsed < 1100) {
    await new Promise((resolve) => setTimeout(resolve, 1100 - elapsed));
  }
  lastNominatimRequestAt = Date.now();

  // addressdetails=1 adds the structured `address` object — the Nominatim
  // equivalent of Google's address_components, and the only way to get an
  // area out of this backend without parsing display_name.
  const url = `${NOMINATIM_URL}?format=json&limit=1&addressdetails=1&countrycodes=in&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': NOMINATIM_USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(7000),
  });

  if (!response.ok) {
    logger.warn('Geocoding (nominatim) request failed', { status: response.status, query });
    return null;
  }

  const data = (await response.json()) as Array<{
    lat: string;
    lon: string;
    display_name?: string;
    address?: Record<string, string>;
  }>;
  if (!Array.isArray(data) || data.length === 0) return null;

  const lat = parseFloat(data[0].lat);
  const lng = parseFloat(data[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // OSM's closest analogues to Google's sublocality_level_1. Same rule as
  // areaFromGoogleComponents: a named area only, never the road (`road`) or
  // house number (`house_number`).
  const osm = data[0].address ?? {};
  const area = (osm.suburb || osm.neighbourhood || '').trim() || null;
  return {
    lat,
    lng,
    ...(data[0].display_name ? { formattedAddress: data[0].display_name } : {}),
    area,
  };
}

async function geocodeViaGoogle(query: string): Promise<GeocodeResult> {
  const apiKey = config.geocoding.googleMapsApiKey;
  if (!apiKey) {
    logger.warn('Geocoding (google) called without GOOGLE_MAPS_API_KEY — falling back to nominatim');
    return geocodeViaNominatim(query);
  }

  // Bias toward India by default; Google handles formatted addresses well so
  // we don't need to append country manually.
  const url = `${GOOGLE_URL}?address=${encodeURIComponent(query)}&region=in&key=${apiKey}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(7000),
  });

  if (!response.ok) {
    logger.warn('Geocoding (google) request failed', { status: response.status, query });
    return null;
  }

  const data = (await response.json()) as {
    status: string;
    error_message?: string;
    results: Array<{
      geometry: { location: { lat: number; lng: number } };
      formatted_address?: string;
      // Already in every response — the API returns these by default and we
      // simply discarded them before `area` existed. No extra call, no cost.
      address_components?: GoogleAddressComponent[];
    }>;
  };

  // ZERO_RESULTS is a normal "no hit", not an error. Anything else (REQUEST_DENIED,
  // OVER_QUERY_LIMIT, INVALID_REQUEST) is worth logging — most often it means a
  // misconfigured API restriction or billing problem, both of which we should see.
  if (data.status !== 'OK') {
    if (data.status === 'ZERO_RESULTS') return null;
    logger.warn('Geocoding (google) returned non-OK', { status: data.status, error: data.error_message, query });
    return null;
  }

  const first = data.results[0]?.geometry?.location;
  if (!first || !Number.isFinite(first.lat) || !Number.isFinite(first.lng)) return null;
  const formatted = data.results[0]?.formatted_address;
  return {
    lat: first.lat,
    lng: first.lng,
    ...(formatted ? { formattedAddress: formatted } : {}),
    area: areaFromGoogleComponents(data.results[0]?.address_components),
  };
}

/**
 * Geocode a free-form address. Returns null on failure (network, no result,
 * upstream error). Caller is expected to handle the null case gracefully —
 * geocoding must never block a booking or listing creation.
 */
export async function geocodeAddress(address: string): Promise<GeocodeResult> {
  const query = address?.trim();
  if (!query) return null;

  // Effective provider: Google whenever a key is configured, regardless
  // of GEOCODING_PROVIDER. Coverage on noisy Indian addresses (business
  // name + landmark + colony + area + city) is dramatically better than
  // Nominatim, and Place Autocomplete + no rate-limit are bonus wins.
  // Local dev without a key stays on Nominatim automatically.
  const effectiveProvider: 'google' | 'nominatim' =
    config.geocoding.googleMapsApiKey ? 'google' : 'nominatim';
  const cacheKey = `${effectiveProvider}:${query.toLowerCase()}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  const runOnce = async (q: string): Promise<GeocodeResult> => {
    return effectiveProvider === 'google'
      ? geocodeViaGoogle(q)
      : geocodeViaNominatim(q);
  };

  try {
    let result = await runOnce(query);

    // Fallback: real Indian street addresses are routinely written
    // "<business>, <landmark>, <colony>, <area>, <city>, <state>" — that
    // full string trips Nominatim into ZERO_RESULTS even though
    // "<area>, <city>, <state>" geocodes fine. Retry once with the tail
    // (last 3 comma segments) so a legitimate Hyderabad pickup isn't
    // rejected just because the user included the shop name + landmark.
    // Skipped when there's nothing to trim or when the first attempt
    // already succeeded.
    if (!result) {
      const parts = query.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 4) {
        const trimmedQuery = parts.slice(-3).join(', ');
        if (trimmedQuery.toLowerCase() !== query.toLowerCase()) {
          logger.debug('Geocoding: retrying with trimmed tail', { query, trimmedQuery });
          result = await runOnce(trimmedQuery);
        }
      }
    }

    cache.set(cacheKey, result);
    return result;
  } catch (error) {
    logger.warn('Geocoding threw an error', { provider: config.geocoding.provider, err: String(error), query });
    cache.set(cacheKey, null);
    return null;
  }
}

async function autocompleteViaGoogle(query: string, mode: AutocompleteMode): Promise<AddressSuggestion[]> {
  const apiKey = config.geocoding.googleMapsApiKey;
  if (!apiKey) {
    logger.warn('Places autocomplete called without GOOGLE_MAPS_API_KEY');
    return [];
  }

  const params = new URLSearchParams({
    input: query,
    components: 'country:in',
    region: 'in',
    key: apiKey,
  });
  if (mode === 'regions') {
    // Restrict to settlement / administrative area types so the dropdown
    // surfaces real places ("Tirumala", "Tirupati") and NOT business
    // matches like "Tirumala Shopping Centre, Andheri West, Mumbai" that
    // happen to contain the typed substring. `(regions)` covers
    // locality, sublocality, postal_code, country, neighborhood, and
    // administrative_area_level_1…5 — the right granularity for stays
    // where users type city/town/village names, never a shop name.
    //
    // `address` mode omits `types` entirely: booking address / pickup-point
    // fields need establishments too ("Trident Hotel", "Secunderabad
    // Railway Station"), which `(regions)` filters out.
    params.set('types', '(regions)');
  }
  const response = await fetch(`${GOOGLE_AUTOCOMPLETE_URL}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    logger.warn('Places autocomplete request failed', { status: response.status, query });
    return [];
  }

  const data = (await response.json()) as {
    status: string;
    error_message?: string;
    predictions?: Array<{
      place_id: string;
      description: string;
      structured_formatting?: {
        main_text?: string;
        secondary_text?: string;
      };
    }>;
  };

  if (data.status !== 'OK') {
    if (data.status !== 'ZERO_RESULTS') {
      logger.warn('Places autocomplete returned non-OK', { status: data.status, error: data.error_message, query });
    }
    return [];
  }

  return (data.predictions ?? []).slice(0, 5).map((prediction) => ({
    id: prediction.place_id,
    description: prediction.description,
    mainText: prediction.structured_formatting?.main_text || prediction.description,
    secondaryText: prediction.structured_formatting?.secondary_text || '',
  }));
}

/**
 * Return Google Places address suggestions without exposing the Maps key to
 * the browser. Empty array means "no suggestions" or "provider unavailable";
 * callers should leave the input behaving like a normal text field.
 */
const placeDetailsCache = new Map<string, PlaceDetailsResult | null>();

/**
 * Resolve a Google Place Autocomplete `place_id` into coordinates +
 * admin hierarchy. Returns null when the upstream call fails (network,
 * unauthorized, ZERO_RESULTS). Caller treats null as "couldn't resolve"
 * and falls back to pure text search.
 *
 * Admin extraction strategy:
 *  - locality          → first of address_components matching `locality`,
 *                        `sublocality_level_1`, `administrative_area_level_3`
 *  - district          → first of `administrative_area_level_2`,
 *                        `administrative_area_level_3`, `locality`
 *  - state             → `administrative_area_level_1`
 *  - country           → `country`
 *
 * Some Indian villages fill only `sublocality_level_1` or
 * `administrative_area_level_3`; the cascade above covers each variant.
 */
export async function placeDetailsForId(placeId: string): Promise<PlaceDetailsResult | null> {
  const trimmed = placeId?.trim();
  if (!trimmed) return null;
  if (placeDetailsCache.has(trimmed)) return placeDetailsCache.get(trimmed)!;

  const apiKey = config.geocoding.googleMapsApiKey;
  if (!apiKey) {
    logger.warn('Place details called without GOOGLE_MAPS_API_KEY');
    return null;
  }

  try {
    const params = new URLSearchParams({
      place_id: trimmed,
      // Trim the response payload to the fields we need — keeps the
      // Places "Details" SKU on the cheap Basic Data tier.
      fields: 'geometry/location,address_components',
      key: apiKey,
    });
    const response = await fetch(`${GOOGLE_PLACE_DETAILS_URL}?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      logger.warn('Place details request failed', { status: response.status, placeId: trimmed });
      placeDetailsCache.set(trimmed, null);
      return null;
    }
    const data = (await response.json()) as {
      status: string;
      error_message?: string;
      result?: {
        geometry?: { location?: { lat: number; lng: number } };
        address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
      };
    };
    if (data.status !== 'OK' || !data.result?.geometry?.location) {
      if (data.status !== 'ZERO_RESULTS') {
        logger.warn('Place details non-OK', { status: data.status, error: data.error_message, placeId: trimmed });
      }
      placeDetailsCache.set(trimmed, null);
      return null;
    }
    const components = data.result.address_components ?? [];
    const pick = (types: string[]): string | null => {
      for (const t of types) {
        const hit = components.find((c) => c.types.includes(t));
        if (hit) return hit.long_name;
      }
      return null;
    };
    const result: PlaceDetailsResult = {
      lat: data.result.geometry.location.lat,
      lng: data.result.geometry.location.lng,
      locality: pick(['locality', 'sublocality_level_1', 'administrative_area_level_3']),
      district: pick(['administrative_area_level_2', 'administrative_area_level_3', 'locality']),
      state: pick(['administrative_area_level_1']),
      country: pick(['country']),
    };
    placeDetailsCache.set(trimmed, result);
    return result;
  } catch (error) {
    logger.warn('Place details threw an error', { err: String(error), placeId: trimmed });
    placeDetailsCache.set(trimmed, null);
    return null;
  }
}

export async function autocompleteAddress(input: string, mode: AutocompleteMode = 'regions'): Promise<AddressSuggestion[]> {
  const query = input?.trim();
  if (query.length < 3) return [];

  const cacheKey = `google:${mode}:${query.toLowerCase()}`;
  if (suggestionCache.has(cacheKey)) return suggestionCache.get(cacheKey)!;

  try {
    const result = await autocompleteViaGoogle(query, mode);
    suggestionCache.set(cacheKey, result);
    return result;
  } catch (error) {
    logger.warn('Places autocomplete threw an error', { err: String(error), query });
    suggestionCache.set(cacheKey, []);
    return [];
  }
}

/**
 * Outcome of verifying that a free-text address resolves to a real place
 * inside India. Onboarding (AI + manual) requires `ok === true` before a
 * location is accepted — see the `location` field guardrail and the
 * listings create gate.
 */
export type IndiaLocationVerification = {
  /** resolved AND inside India — the only state onboarding accepts. */
  ok: boolean;
  /** The geocoder found a real place for this text at all. */
  resolved: boolean;
  /** The resolved place is in India. */
  inIndia: boolean;
  lat: number | null;
  lng: number | null;
  /** Country name as returned by the geocoder ("India", "United States", …). */
  country: string | null;
};

// Generous lat/lng box around India (incl. island territories). Used only
// as the in-India signal for the keyless Nominatim path and as a Google
// fallback when address_components omit a country. Tight enough to exclude
// the US/EU, loose enough not to clip Andaman & Nicobar / Lakshadweep.
const INDIA_BOUNDS = { latMin: 6.0, latMax: 37.6, lngMin: 67.0, lngMax: 97.5 };
function withinIndiaBounds(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= INDIA_BOUNDS.latMin && lat <= INDIA_BOUNDS.latMax
    && lng >= INDIA_BOUNDS.lngMin && lng <= INDIA_BOUNDS.lngMax
  );
}

const indiaVerifyCache = new Map<string, IndiaLocationVerification>();
const NOT_RESOLVED: IndiaLocationVerification = {
  ok: false, resolved: false, inIndia: false, lat: null, lng: null, country: null,
};

/**
 * Geocode a free-text address and confirm it is a real place in India.
 *
 * Why this exists separately from `geocodeAddress`: that helper returns
 * only `{lat,lng}` and the Google path uses `region=in` as a BIAS, not a
 * restriction — "New York" still resolves. To reject non-India locations
 * we must read the country out of Google's `address_components`. The
 * keyless Nominatim path is already `countrycodes=in`-restricted, so any
 * hit there is in-India by construction (confirmed with a bounds check).
 *
 * Never throws — a network/timeout failure returns `resolved:false`,
 * which the caller treats as "couldn't confirm, ask again" rather than a
 * hard error.
 */
export async function verifyIndiaLocation(address: string): Promise<IndiaLocationVerification> {
  const query = address?.trim();
  if (!query) return NOT_RESOLVED;

  const apiKey = config.geocoding.googleMapsApiKey;
  const cacheKey = `${apiKey ? 'google' : 'nominatim'}:${query.toLowerCase()}`;
  const cached = indiaVerifyCache.get(cacheKey);
  if (cached) return cached;

  let result: IndiaLocationVerification = NOT_RESOLVED;
  try {
    if (apiKey) {
      result = await verifyViaGoogle(query, apiKey);
    } else {
      // Keyless dev: Nominatim is country-restricted to India already, and
      // geocodeAddress() carries the comma-trim fallback for noisy
      // addresses. A non-null hit is therefore an in-India resolution.
      const geo = await geocodeAddress(query);
      result = geo
        ? { ok: true, resolved: true, inIndia: true, lat: geo.lat, lng: geo.lng, country: 'India' }
        : NOT_RESOLVED;
    }
  } catch (error) {
    logger.warn('verifyIndiaLocation threw', { err: String(error), query });
    result = NOT_RESOLVED;
  }

  indiaVerifyCache.set(cacheKey, result);
  return result;
}

async function verifyViaGoogle(query: string, apiKey: string): Promise<IndiaLocationVerification> {
  const runOnce = async (q: string): Promise<IndiaLocationVerification | null> => {
    const url = `${GOOGLE_URL}?address=${encodeURIComponent(q)}&region=in&key=${apiKey}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(7000) });
    if (!response.ok) {
      logger.warn('verifyIndiaLocation (google) request failed', { status: response.status, query: q });
      return null;
    }
    const data = (await response.json()) as {
      status: string;
      error_message?: string;
      results: Array<{
        geometry?: { location?: { lat: number; lng: number } };
        address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
      }>;
    };
    if (data.status !== 'OK') {
      if (data.status !== 'ZERO_RESULTS') {
        logger.warn('verifyIndiaLocation (google) non-OK', { status: data.status, error: data.error_message, query: q });
      }
      return null;
    }
    const first = data.results[0];
    const loc = first?.geometry?.location;
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null;
    const countryComp = (first.address_components ?? []).find((c) => c.types.includes('country'));
    const country = countryComp?.long_name ?? null;
    const inIndia =
      countryComp?.short_name === 'IN'
      || country === 'India'
      // Country component occasionally absent on a coarse match — trust the box.
      || (countryComp == null && withinIndiaBounds(loc.lat, loc.lng));
    return { ok: inIndia, resolved: true, inIndia, lat: loc.lat, lng: loc.lng, country };
  };

  let res = await runOnce(query);
  // Same comma-trim tail retry geocodeAddress uses for noisy Indian
  // addresses ("<shop>, <landmark>, <colony>, <area>, <city>").
  if (!res) {
    const parts = query.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 4) {
      const trimmed = parts.slice(-3).join(', ');
      if (trimmed.toLowerCase() !== query.toLowerCase()) res = await runOnce(trimmed);
    }
  }
  return res ?? NOT_RESOLVED;
}

/**
 * Build the best available address string from listing fields.
 */
export function buildAddressString(payload: Record<string, unknown>): string {
  const parts = [
    payload.address,
    payload.location,
    payload.city,
    payload.state,
    payload.country || 'India',
  ]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
  // Dedupe in order (case-insensitive)
  const seen = new Set<string>();
  return parts
    .filter((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(', ');
}
