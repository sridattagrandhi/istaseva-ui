// Canonical India states/UTs + city/state derivation from free-text
// addresses. This is REFERENCE data used only to parse and validate what
// hosts type — the admin filter options themselves are still SELECT
// DISTINCTs over the listings table, never this list.
//
// Why it exists: listings.city / listings.state are free-text columns fed
// by several onboarding paths, and rows landed with the full address only
// in `location` (city/state NULL) or with a city name in the state column
// ("Hyderabad" as a state). deriveCityState() recovers both from the
// address text; the 20260708 migration applies the same rules to old rows.

export const INDIA_STATES: readonly string[] = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka',
  'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim',
  'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal',
  // Union territories
  'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir',
  'Ladakh', 'Lakshadweep', 'Puducherry',
];

const BY_LOWER = new Map(INDIA_STATES.map((s) => [s.toLowerCase(), s]));

/** Returns the canonical spelling if `value` is an Indian state/UT, else null. */
export function canonicalState(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return BY_LOWER.get(value.trim().toLowerCase()) ?? null;
}

// Longest names first so "Dadra and Nagar Haveli…" wins over any substring.
const STATES_BY_LENGTH = [...INDIA_STATES].sort((a, b) => b.length - a.length);

/** Finds an Indian state/UT mentioned in free text (whole-word match). */
export function findStateInText(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  for (const state of STATES_BY_LENGTH) {
    if (new RegExp(`\\b${state}\\b`, 'i').test(text)) return state;
  }
  return null;
}

/** The comma-separated segment immediately before the state mention, with
 *  PIN codes / stray digits stripped — usually the city. */
function cityBeforeState(text: string, state: string): string | null {
  const match = text.match(new RegExp(`([^,]+),\\s*${state}\\b`, 'i'));
  if (!match) return null;
  const city = match[1].replace(/\d{5,6}/g, '').replace(/\s+/g, ' ').trim();
  if (!city || canonicalState(city)) return null;
  return city;
}

export interface DerivedCityState {
  city: string | null;
  state: string | null;
}

/**
 * Best-effort city/state from a listing payload. Provided values win when
 * they're sane; otherwise the address text (`location` then `address`) is
 * parsed. A city value that is actually a state name is treated as absent.
 */
export function deriveCityState(payload: {
  city?: unknown; state?: unknown; location?: unknown; address?: unknown;
}): DerivedCityState {
  const texts = [payload.location, payload.address]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

  let state = canonicalState(payload.state);
  if (!state) {
    for (const text of texts) {
      state = findStateInText(text);
      if (state) break;
    }
  }

  let city = typeof payload.city === 'string' ? payload.city.trim() : '';
  if (!city || canonicalState(city)) {
    city = '';
    if (state) {
      for (const text of texts) {
        const parsed = cityBeforeState(text, state);
        if (parsed) { city = parsed; break; }
      }
    }
  }

  return { city: city || null, state };
}

/**
 * Mutates `payload` so city/state land clean in the DB:
 * - a state value that isn't a real Indian state/UT is replaced by one
 *   derived from the address text (when derivable);
 * - a missing city (or a city that is actually a state name) is filled
 *   from the address text.
 * Never throws, never blanks an existing value it can't improve.
 */
export function ensureCityState(payload: Record<string, unknown>): void {
  const derived = deriveCityState(payload);
  if (derived.state && !canonicalState(payload.state)) payload.state = derived.state;
  const cityIsUsable = typeof payload.city === 'string'
    && payload.city.trim().length > 0
    && !canonicalState(payload.city);
  if (derived.city && !cityIsUsable) payload.city = derived.city;
}
