/**
 * Listing geo privacy (audit item B1).
 *
 * Public listing reads used to expose the exact street address and lat/lng
 * of every listing — for homestays that is the host's HOME address, scrapeable
 * by anyone. Product decision (2026-07-13): all categories show an
 * APPROXIMATE location until the viewer has a real booking; exact geo is for
 * the owner, admins, and guests with a confirmed/in-progress/completed
 * booking.
 *
 * Approximation = coordinates rounded to 2 decimal places (~1.1 km cell), the
 * street `address` withheld, and the `location` display string REBUILT from
 * the derived `area`/`city`/`state` columns. `location` is UNTRUSTED free text —
 * Places autocomplete routinely fills it with the full formatted street
 * address ("Tank Bund Rd, opposite Hussain Sagar, ... 500080"), and `address`
 * is NULL on almost every row, so passing `location` through would leak the
 * exact address right next to the fuzzed map pin. Never fall back to the raw
 * string here. Rounding is deterministic (no jitter), so repeated fetches
 * can't be averaged to recover the point. `geo_exact` tells clients which
 * variant they got ("Exact location shared after booking").
 *
 * `area` (the neighbourhood, "Kukatpally") is included and does NOT widen the
 * disclosure: the 2dp cell we already publish is ~1.2 km², while a metro
 * neighbourhood is 5–10 km² — the pin is already the more precise signal, and
 * anyone can read the neighbourhood off it. The coordinate rounding above,
 * not the label, is what bounds location privacy here. `area` is also safe by
 * construction: it comes only from a structured geocode component that cannot
 * contain a road or door number (see areaFromGoogleComponents), never from
 * parsing `location`.
 */

const GEO_CELL_DECIMALS = 2;

const roundCoord = (value: unknown): unknown => {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const factor = 10 ** GEO_CELL_DECIMALS;
  return Math.round(n * factor) / factor;
};

const cleanPart = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s.length > 0 ? s : null;
};

/**
 * Safe public display string: "Area, City, State" from the derived columns
 * (populated by ensureArea / ensureCityState on every create/update — city and
 * state enforced there), degrading to whichever parts exist. Deliberately
 * NEVER the raw `location` text — that is where the street address leaks.
 *
 * `area` is usually null (the host only stated a city), in which case this
 * returns exactly the "City, State" it always did. Parts are deduped
 * case-insensitively, which absorbs the village case where the geocoder names
 * the settlement as both the area and the city ("Tirumala, Tirumala").
 */
export function publicLocationLabel(listing: Record<string, unknown>): string | null {
  const seen = new Set<string>();
  const parts = [cleanPart(listing.area), cleanPart(listing.city), cleanPart(listing.state)]
    .filter((part): part is string => part !== null)
    .filter((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * `metadata.visitAddress` is a FULL street address (onboarding pushes for
 * "building + street + pincode"), and `approximateListingGeo`'s top-level
 * rewrites never touched metadata — so it rode out next to the masked
 * `address`/`location` on every public read. Scrub it unless the host
 * explicitly opted in (`metadata.showAddressPublicly === true` — the
 * walk-in shop/salon/clinic case, set from onboarding/edit). Booked guests,
 * owners, and admins keep the raw row via markGeoExact, and the booking
 * itself snapshots the real address server-side (booking-intent.service).
 */
const scrubMetadataAddress = (metadata: unknown): unknown => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  const meta = metadata as Record<string, unknown>;
  if (typeof meta.visitAddress !== 'string' || meta.visitAddress.trim().length === 0) return metadata;
  if (meta.showAddressPublicly === true) return metadata;
  // Fresh object — masked rows must not share the metadata reference with
  // the raw row (listPublic caches rows; mutating in place would leak the
  // scrub into owner/booked reads, or the address into cached masked ones).
  return { ...meta, visitAddress: null };
};

/** Non-destructive: returns a copy with approximate geo + `geo_exact:false`. */
export function approximateListingGeo<T extends Record<string, unknown>>(listing: T): T {
  return {
    ...listing,
    lat: roundCoord(listing.lat),
    lng: roundCoord(listing.lng),
    address: null,
    location: publicLocationLabel(listing),
    metadata: scrubMetadataAddress(listing.metadata),
    geo_exact: false,
  };
}

/** Tag an untouched row so clients can rely on the flag's presence. */
export function markGeoExact<T extends Record<string, unknown>>(listing: T): T {
  return { ...listing, geo_exact: true };
}
