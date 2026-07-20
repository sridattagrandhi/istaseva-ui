// design/api/geocode.ts — Google Places via the backend proxy (server holds the
// key; no native dependency). Powers the location-predictions dropdown in the
// search bar, onboarding, and booking, plus the catalog geo-filter.
//   • POST /api/geocode/autocomplete { input }   → { suggestions: PlacePrediction[] }
//   • POST /api/geocode/place-details { placeId } → { result: PlaceDetails | null }
import { api } from "@/lib/api";

export type PlacePrediction = { id: string; description: string; mainText: string; secondaryText: string };
// `state` is returned by the backend place-details endpoint; surfaced here so a
// recalled recent-search snapshot can label by locality/district/state parity
// with the web. Not used by the catalog geo-filter (locality/district only).
export type PlaceDetails = { lat: number; lng: number; locality: string | null; district: string | null; state: string | null };

/** Suggestion scope, mirrored from the backend proxy: "regions" (default)
 *  returns settlements only — right for the stays city/town search. "address"
 *  is unrestricted (includes establishments like hotels/stations) — use it
 *  for street-address fields (at-home service address, pickup point). */
export type AutocompleteMode = "regions" | "address";

/** Live place predictions for a typed query (>= 3 chars). Empty on error. */
export async function placePredictions(input: string, mode?: AutocompleteMode): Promise<PlacePrediction[]> {
  const q = (input || "").trim();
  if (q.length < 3) return [];
  try {
    const res = await api.post("/api/geocode/autocomplete", { input: q, ...(mode ? { mode } : {}) });
    const list = res.data?.suggestions ?? [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Forward-geocode a free-text address via the backend (POST /api/geocode →
 *  { result: {lat,lng} | null }). Null when unresolvable or on network error —
 *  callers treat that as "couldn't confirm this address". Mirrors the web's
 *  confirm-time gate in MarketplaceBookingModal. */
export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  const q = (address || "").trim();
  if (q.length < 3) return null;
  try {
    const res = await api.post("/api/geocode", { address: q });
    const r = res.data?.result;
    return r && typeof r.lat === "number" && typeof r.lng === "number" ? { lat: r.lat, lng: r.lng } : null;
  } catch {
    return null;
  }
}

/** Resolve a prediction's placeId → coordinates + admin hierarchy. */
export async function placeDetails(placeId: string): Promise<PlaceDetails | null> {
  if (!placeId) return null;
  try {
    const res = await api.post("/api/geocode/place-details", { placeId });
    return (res.data?.result ?? null) as PlaceDetails | null;
  } catch {
    return null;
  }
}

const EARTH_RADIUS_KM = 6371;
/** Great-circle distance (km). Infinity when either point lacks coords. */
export function distanceKm(a: { lat?: number; lng?: number }, b: { lat?: number; lng?: number }): number {
  if (a?.lat == null || a?.lng == null || b?.lat == null || b?.lng == null) return Infinity;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Bidirectional case-insensitive "either contains the other" — matches the web
 *  (handles "Tirupati" ↔ "Tirupati district" without prefix false-positives). */
export function adminMatches(a?: string | null, b?: string | null): boolean {
  const s = (a || "").trim().toLowerCase();
  const p = (b || "").trim().toLowerCase();
  if (!s || !p) return false;
  return s.includes(p) || p.includes(s);
}

/** Surface listings within this radius of a picked place (mirrors web's 50km). */
export const SEARCH_RADIUS_KM = 50;
