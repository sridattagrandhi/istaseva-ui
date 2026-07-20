/**
 * Travel-time estimation. Today: enhanced haversine with vehicle-class +
 * time-of-day multipliers — no external dependency, no per-call cost.
 *
 * Tomorrow: swap to Google Distance Matrix (or any other provider) by
 * implementing the TravelTimeProvider interface and toggling TRAVEL_PROVIDER.
 * Built behind an interface so the rewrite is one-file.
 */

export type VehicleClass = 'walk' | 'scooter' | 'car' | 'van';

export interface TravelTimeProvider {
  /** Return travel time in MINUTES between two geo-points at a given hour-of-day (0–23). */
  travelMinutes(
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
    opts: { hourOfDay: number; vehicle?: VehicleClass; bufferMinutes?: number },
  ): Promise<number> | number;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Effective city speed by vehicle class, in km/h. These are conservative averages
// for Indian cities; they account for traffic, parking, and typical first/last-
// mile walk. Scooters routinely beat cars in dense traffic — that's intentional.
const VEHICLE_BASE_KMH: Record<VehicleClass, number> = {
  walk: 5,
  scooter: 22,
  car: 18,
  van: 14,
};

/**
 * Time-of-day multiplier on travel time. >1 means SLOWER (peak hour).
 * Hours are local (IST). We don't yet model day-of-week (Sunday traffic ≠
 * Tuesday) — add when we have data to justify it.
 */
function timeOfDayFactor(hour: number): number {
  if (hour >= 8 && hour < 11) return 1.5;   // morning peak
  if (hour >= 11 && hour < 16) return 1.0;  // midday lull
  if (hour >= 16 && hour < 20) return 1.6;  // evening peak
  return 0.8;                                // night / early morning
}

export class HaversineTravelTimeProvider implements TravelTimeProvider {
  travelMinutes(
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
    opts: { hourOfDay: number; vehicle?: VehicleClass; bufferMinutes?: number },
  ): number {
    const km = haversineKm(fromLat, fromLng, toLat, toLng);
    const baseKmh = VEHICLE_BASE_KMH[opts.vehicle ?? 'scooter'];
    const effectiveKmh = baseKmh / timeOfDayFactor(opts.hourOfDay);
    const minutes = Math.ceil((km / effectiveKmh) * 60);
    // Floor at 5 mins (parking, locating the door, etc.) even for adjacent points.
    return Math.max(5, minutes);
  }
}

let singleton: TravelTimeProvider | null = null;
export function getTravelTimeProvider(): TravelTimeProvider {
  if (!singleton) singleton = new HaversineTravelTimeProvider();
  return singleton;
}

export { haversineKm };
