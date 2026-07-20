import { distanceKm } from "@/lib/geo";

/**
 * Global location scope — the place picked in the navbar's "Search
 * everything" palette. All four marketplace surfaces (Discovery, Stays,
 * Services, Transport) narrow to it until the user clears it from the pill.
 *
 * Matching mirrors the stays picked-place filter: a listing belongs to the
 * scope when it sits within LOCATION_SCOPE_RADIUS_KM of the place OR any of
 * its admin/location text fields matches the place's locality/district/state.
 */
export interface LocationScope {
  lat: number;
  lng: number;
  locality: string | null;
  district: string | null;
  state: string | null;
  /** Short display name for the pill/chips (e.g. "Hyderabad"). */
  label: string;
}

/** Same radius the stays picked-place filter uses — generous enough to keep
 *  "Tirumala → Tirupati (~22 km)" visible while still narrowing meaningfully. */
export const LOCATION_SCOPE_RADIUS_KM = 50;

/** Case-insensitive bidirectional "either contains the other" — handles
 *  "Tirupati" matching "Tirupati district" or vice versa without picking
 *  up unrelated cities that share a prefix. */
function adminMatches(listingValue: string | null | undefined, scopeValue: string | null | undefined): boolean {
  if (!listingValue || !scopeValue) return false;
  const l = listingValue.trim().toLowerCase();
  const s = scopeValue.trim().toLowerCase();
  if (!l || !s) return false;
  return l.includes(s) || s.includes(l);
}

/** The geo/admin fields a marketplace row may carry. All optional — a row
 *  with neither coords nor a matching admin name simply falls outside the
 *  scope (identical to the stays picked-place behavior). */
export interface ScopeMatchable {
  lat?: number | null;
  lng?: number | null;
  /** Any location-ish text the vertical has: city, district, area,
   *  free-text location line, state. Order doesn't matter. */
  adminTexts?: Array<string | null | undefined>;
}

export function matchesLocationScope(scope: LocationScope | null, row: ScopeMatchable): boolean {
  if (!scope) return true;
  const hasCoords = typeof row.lat === "number" && typeof row.lng === "number";
  if (hasCoords) {
    const within = distanceKm(
      { lat: scope.lat, lng: scope.lng },
      { lat: row.lat as number, lng: row.lng as number },
    ) <= LOCATION_SCOPE_RADIUS_KM;
    if (within) return true;
  }
  const scopeNames = [scope.locality, scope.district, scope.state, scope.label];
  return (row.adminTexts ?? []).some((text) =>
    scopeNames.some((name) => adminMatches(text, name)),
  );
}

// ---- persistence (device-level browse context, like recent searches) ------

const STORAGE_KEY = "istaseva:location-scope:v1";

export function readStoredLocationScope(): LocationScope | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.lat === "number" &&
      typeof parsed.lng === "number" &&
      typeof parsed.label === "string" &&
      parsed.label
    ) {
      return {
        lat: parsed.lat,
        lng: parsed.lng,
        locality: typeof parsed.locality === "string" ? parsed.locality : null,
        district: typeof parsed.district === "string" ? parsed.district : null,
        state: typeof parsed.state === "string" ? parsed.state : null,
        label: parsed.label,
      };
    }
  } catch { /* corrupted / private mode — ignore */ }
  return null;
}

export function writeStoredLocationScope(scope: LocationScope | null) {
  try {
    if (scope) localStorage.setItem(STORAGE_KEY, JSON.stringify(scope));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* quota / private mode — ignore */ }
}
