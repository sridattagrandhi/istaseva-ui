// Small geo utilities for the marketplace "Near me" interactions.
// Kept dependency-free so the bundle doesn't pull in a full geo library
// just for a sort.

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance between two points, in kilometres. Returns Infinity
 *  if either point has invalid coords so callers can sort missing-location
 *  listings to the bottom without a special case. */
export function distanceKm(a: Partial<LatLng>, b: Partial<LatLng>): number {
  if (typeof a.lat !== "number" || typeof a.lng !== "number") return Infinity;
  if (typeof b.lat !== "number" || typeof b.lng !== "number") return Infinity;
  if (!Number.isFinite(a.lat) || !Number.isFinite(a.lng)) return Infinity;
  if (!Number.isFinite(b.lat) || !Number.isFinite(b.lng)) return Infinity;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Promise wrapper around the browser geolocation API. Rejects with a
 *  caller-friendly Error so the UI can show a single toast. */
export function getCurrentPosition(options?: PositionOptions): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("Your browser doesn't support location sharing."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(new Error("Location permission denied. Enable it in your browser to use Near me."));
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          reject(new Error("Couldn't determine your location right now. Try again in a moment."));
        } else if (err.code === err.TIMEOUT) {
          reject(new Error("Location request timed out. Try again."));
        } else {
          reject(new Error("Couldn't get your location."));
        }
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000, ...options },
    );
  });
}

/** Best-effort reverse geocode via OpenStreetMap Nominatim. Mirrors the
 *  pattern used in `src/contexts/LocationContext.tsx` so the booking flow
 *  doesn't need a backend round-trip (the server's `/api/geocode` is
 *  forward-only). Returns a human-readable single-line address, or null on
 *  failure. Caller is expected to fall back to lat/lng text. */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { display_name?: string; address?: Record<string, string> };
    if (data.display_name && data.display_name.trim()) return data.display_name.trim();
    const a = data.address || {};
    const parts = [a.road, a.suburb, a.neighbourhood, a.city || a.town || a.village, a.state, a.postcode]
      .filter((v) => typeof v === "string" && v.trim().length > 0);
    return parts.length > 0 ? parts.join(", ") : null;
  } catch {
    return null;
  }
}
