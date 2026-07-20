/**
 * Frontend mirror of the server's onboarding field registry.
 *
 * ── SOURCE OF TRUTH ──────────────────────────────────────────────────────
 * Canonical definitions live on the server:
 *   server/src/modules/chat/agent/onboarding/registry/field-registry.ts
 *
 * This file is a HAND-MIRRORED PORT. The two registries must stay aligned
 * — when a field's required/applies-to/conditional rules change in the
 * server registry, mirror the change here too. The shared-name parity
 * test in this folder (`__tests__/field-registry.shared.test.ts`) checks
 * that the FE registry covers every load-bearing field name, but it
 * cannot detect a rule that drifted in semantics rather than shape.
 *
 * Why mirror instead of share: server and FE are separate packages with
 * no shared workspace today. Promoting the registry to a workspace
 * package is a bigger architectural change — tracked but deferred.
 *
 * ── SCOPE ────────────────────────────────────────────────────────────────
 * This registry encodes the SHARED subset of required-field rules — the
 * ones that match between the server's submit_listing tool and the
 * server's listing-readiness activation gate. FE-only rules (description
 * is also FE-only-counted as a length-bar, amenities >= 5 for single-
 * unit stays, checkInTime/checkOutTime, multi-room roomTypes editor
 * state, roomAmenities >= 3 per room) are NOT in this file — they live
 * in `onboarding-validation.ts` as an explicit wrapper layer on top of
 * the registry result. Keep them there; they're intentional product
 * divergence, not registry rules.
 *
 * Architecturally distinct from the server's:
 *   - No zod. The FE doesn't validate fields via zod; it consumes the
 *     profile shape from `useConversationEngine.ts` and checks
 *     presence. Plain TS predicates are enough here.
 *   - Listing-type inference includes the wider driver-* family
 *     (bus, tempo, scooter, motorcycle) that the FE legacy validator
 *     already recognized as transport. The server registry currently
 *     only handles driver-cab / driver-auto explicitly; that drift is
 *     a known issue separate from this work.
 */
import type { OnboardingProfile } from '@/hooks/useConversationEngine';

export type ListingType = 'stay' | 'service' | 'transport';
export type AppliesToAll = 'all';

/** Predicate: return true to mark a field required for this profile. */
export type RequirementPredicate = (profile: OnboardingProfile) => boolean;

export interface SharedFieldSpec {
  name: string;
  appliesTo: ListingType[] | AppliesToAll;
  requiredFor?: ListingType[];
  requiredWhen?: RequirementPredicate;
  /** "Filled" check. Defaults to "non-empty by JS truthiness/length". */
  isFilled?: (value: unknown, profile: OnboardingProfile) => boolean;
  /** Extra missing-field strings the registry shape can't express
   *  (e.g. duration must parse ≤ 24h). Returned strings are merged
   *  into the missing-set verbatim. */
  customGate?: (profile: OnboardingProfile) => string[];
}

// ── Listing-type inference (FE-aware: knows the wider driver-* family) ────
const STAY_CATEGORIES = new Set([
  'hotel', 'homestay', 'lodge', 'village-stay', 'farm-stay', 'heritage', 'sathram',
]);
const TRANSPORT_CATEGORIES = new Set([
  'driver-auto', 'driver-cab', 'driver-bus', 'driver-tempo',
  'driver-scooter', 'driver-motorcycle',
]);
const MULTI_ROOM_PROPERTY_TYPES = new Set(['hotel', 'lodge', 'heritage', 'sathram']);

export function inferListingType(profile: OnboardingProfile): ListingType | null {
  const cat = profile.category;
  if (!cat) return null;
  if (STAY_CATEGORIES.has(cat)) return 'stay';
  if (TRANSPORT_CATEGORIES.has(cat)) return 'transport';
  return 'service';
}

export function isMultiRoomStay(profile: OnboardingProfile): boolean {
  const pt = profile.propertyType || profile.category;
  return MULTI_ROOM_PROPERTY_TYPES.has(pt);
}

export function isOnlineOnlyService(profile: OnboardingProfile): boolean {
  if (inferListingType(profile) !== 'service') return false;
  const modes = profile.serviceModes ?? [];
  return modes.length > 0 && modes.every((m) => m === 'online');
}

// ── Helpers ──────────────────────────────────────────────────────────────
const nonEmptyString = (v: unknown): boolean =>
  typeof v === 'string' && v.trim().length > 0;
const positiveNumber = (v: unknown): boolean =>
  typeof v === 'number' && v > 0;

/** Mirror of the server-side parseDurationHours for the <=24h gate. */
export function parseDurationHours(text: string): number | null {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  if (t.includes('half day')) return 4;
  if (t.includes('full day')) return 8;
  const rangeDays = t.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(?:days?|d\b)/);
  if (rangeDays) return parseFloat(rangeDays[2]) * 24;
  const singleDays = t.match(/(\d+(?:\.\d+)?)\s*(?:days?|d\b)/);
  if (singleDays) return parseFloat(singleDays[1]) * 24;
  const rangeHours = t.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h\b)/);
  if (rangeHours) return parseFloat(rangeHours[2]);
  const rangeMins = t.match(/(\d+)\s*-\s*(\d+)\s*(?:mins?|minutes?|m\b)/);
  if (rangeMins) return parseInt(rangeMins[2], 10) / 60;
  const singleHours = t.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h\b)/);
  if (singleHours) return parseFloat(singleHours[1]);
  const singleMins = t.match(/(\d+)\s*(?:mins?|minutes?|m\b)/);
  if (singleMins) return parseInt(singleMins[1], 10) / 60;
  const bare = t.match(/^(\d+(?:\.\d+)?)$/);
  if (bare) return parseFloat(bare[1]);
  return null;
}

const hasAnyOpenDay = (wh: OnboardingProfile['workingHours'] | null | undefined): boolean => {
  if (!wh || typeof wh !== 'object') return false;
  return Object.values(wh).some((v) =>
    Array.isArray(v) && v.length === 2 && v[0] && v[1],
  );
};

// ── THE FE REGISTRY ──────────────────────────────────────────────────────
// Field order is preserved in the missing-fields output for stability.
export const FE_FIELD_REGISTRY: SharedFieldSpec[] = [
  // Core — required for everyone
  { name: 'category', appliesTo: 'all', requiredFor: ['stay', 'service', 'transport'], isFilled: nonEmptyString },
  { name: 'name',     appliesTo: 'all', requiredFor: ['stay', 'service', 'transport'], isFilled: nonEmptyString },
  // location required for everyone EXCEPT online-only services
  { name: 'location', appliesTo: 'all',
    requiredWhen: (p) => !isOnlineOnlyService(p),
    isFilled: nonEmptyString },
  // description required everywhere (closes drift with listing-readiness:190)
  { name: 'description', appliesTo: 'all', requiredFor: ['stay', 'service', 'transport'], isFilled: nonEmptyString },

  // Single-unit stays only
  { name: 'price', appliesTo: ['stay', 'service'],
    requiredWhen: (p) => inferListingType(p) === 'stay' && !isMultiRoomStay(p),
    isFilled: (v) => Number(v) > 0 },
  { name: 'bedrooms', appliesTo: ['stay'],
    requiredWhen: (p) => inferListingType(p) === 'stay' && !isMultiRoomStay(p),
    isFilled: positiveNumber },
  { name: 'maxGuests', appliesTo: ['stay'],
    requiredWhen: (p) => inferListingType(p) === 'stay' && !isMultiRoomStay(p),
    isFilled: positiveNumber },

  // Services
  { name: 'experience', appliesTo: ['service', 'transport'],
    requiredFor: ['service', 'transport'], isFilled: nonEmptyString },
  { name: 'duration', appliesTo: ['service'], requiredFor: ['service'],
    isFilled: nonEmptyString,
    // duration must parse to >0 and <=24 hours
    customGate: (p) => {
      if (!nonEmptyString(p.duration)) return [];
      const hours = parseDurationHours(p.duration);
      if (hours == null || !(hours > 0) || hours > 24) return ['duration'];
      return [];
    } },
  { name: 'pricingUnit', appliesTo: ['service'], requiredFor: ['service'],
    isFilled: nonEmptyString },
  { name: 'serviceModes', appliesTo: ['service'], requiredFor: ['service'],
    isFilled: (v) => Array.isArray(v) && v.length > 0 },
  { name: 'languages', appliesTo: ['service', 'transport'], requiredFor: ['service', 'transport'],
    isFilled: (v) => Array.isArray(v) && v.length > 0 },
  // serviceRadius required when (service + at-home) OR transport
  { name: 'serviceRadius', appliesTo: ['service', 'transport'],
    requiredWhen: (p) => {
      const t = inferListingType(p);
      if (t === 'transport') return true;
      if (t === 'service') return (p.serviceModes ?? []).includes('at-home');
      return false;
    },
    isFilled: positiveNumber },
  { name: 'visitAddress', appliesTo: ['service'],
    requiredWhen: (p) => (p.serviceModes ?? []).includes('visit-provider'),
    isFilled: nonEmptyString },
  { name: 'meetingDetails', appliesTo: ['service'],
    requiredWhen: (p) => (p.serviceModes ?? []).includes('online'),
    isFilled: nonEmptyString },
  // servicesCatalog: at least one group with name + basePrice > 0.
  // Legacy grace: a populated top-level `price` stands in.
  { name: 'servicesCatalog', appliesTo: ['service'], requiredFor: ['service'],
    isFilled: (v, p) => {
      const cat = Array.isArray(v) ? v : [];
      const hasValid = cat.some((g) =>
        g && typeof g === 'object'
        && typeof (g as { name?: unknown }).name === 'string'
        && ((g as { name: string }).name).trim().length > 0
        && Number((g as { basePrice?: unknown }).basePrice) > 0);
      if (hasValid) return true;
      return Number(p.price) > 0;
    } },

  // Transport
  { name: 'transportMode', appliesTo: ['transport'], requiredFor: ['transport'],
    isFilled: (v) => v === 'hourly' || v === 'day' || v === 'package',
    // Multi-mode select: transportModes[0] also satisfies legacy single-mode reads.
    customGate: (p) => {
      const modes = (p.transportModes && p.transportModes.length > 0)
        ? p.transportModes
        : (p.transportMode ? [p.transportMode] : []);
      const bookable = modes.filter((m) => m === 'hourly' || m === 'day' || m === 'package');
      return bookable.length === 0 ? [] : []; // base requirement already covered
    } },
  { name: 'pricePerHour', appliesTo: ['transport'],
    requiredWhen: (p) => {
      const modes = (p.transportModes && p.transportModes.length > 0)
        ? p.transportModes
        : (p.transportMode ? [p.transportMode] : []);
      return modes.includes('hourly');
    },
    isFilled: (v) => Number(v) > 0 },
  { name: 'pricePerDay', appliesTo: ['transport'],
    requiredWhen: (p) => {
      const modes = (p.transportModes && p.transportModes.length > 0)
        ? p.transportModes
        : (p.transportMode ? [p.transportMode] : []);
      return modes.includes('day');
    },
    isFilled: (v) => Number(v) > 0 },
  { name: 'packageOptions', appliesTo: ['transport'],
    requiredWhen: (p) => {
      const modes = (p.transportModes && p.transportModes.length > 0)
        ? p.transportModes
        : (p.transportMode ? [p.transportMode] : []);
      return modes.includes('package');
    },
    // Each non-empty package row must carry: label, price > 0, at least one
    // named stop, and a valid distance range (min > 0, max >= min). Hours
    // can be 0 here because the duration-vs-working-hours rule lives in the
    // editor; the registry enforces shape so half-filled rows don't slip
    // through publish. Completely blank rows (no label, no price) are
    // skipped — the submit mapper drops them, so they shouldn't block.
    isFilled: (v) => {
      if (!Array.isArray(v) || v.length === 0) return false;
      let validCount = 0;
      for (const row of v) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        const label = typeof r.label === 'string' ? r.label.trim() : '';
        const priceN = Number(r.price);
        const isBlank = !label && !(priceN > 0);
        if (isBlank) continue; // empty filler row, dropped on save
        if (!label) return false;
        if (!(priceN > 0)) return false;
        const stops = Array.isArray(r.stops) ? r.stops : [];
        const hasStop = stops.some((s) => {
          if (typeof s === 'string') return s.trim().length > 0;
          if (s && typeof s === 'object') {
            const place = (s as Record<string, unknown>).place;
            return typeof place === 'string' && place.trim().length > 0;
          }
          return false;
        });
        if (!hasStop) return false;
        const minKm = Number(r.distanceKmMin);
        const maxKm = Number(r.distanceKmMax);
        if (!Number.isFinite(minKm) || minKm <= 0) return false;
        if (!Number.isFinite(maxKm) || maxKm < minKm) return false;
        validCount += 1;
      }
      return validCount > 0;
    } },
  // Transport vehicle identity — the FE form requires these explicitly
  // even though the server's submit_listing prefers transportationTypes[].
  { name: 'vehicleType', appliesTo: ['transport'], requiredFor: ['transport'], isFilled: nonEmptyString },
  { name: 'vehicleName', appliesTo: ['transport'], requiredFor: ['transport'], isFilled: nonEmptyString },
  // Colour + number plate — shown to riders in the booking summary so they
  // can spot the exact car. Required to publish; mirrors the server registry.
  { name: 'vehicleColor', appliesTo: ['transport'], requiredFor: ['transport'], isFilled: nonEmptyString },
  { name: 'licensePlate', appliesTo: ['transport'], requiredFor: ['transport'], isFilled: nonEmptyString },
  { name: 'seatingCapacity', appliesTo: ['transport'], requiredFor: ['transport'],
    isFilled: (v) => nonEmptyString(v) && Number(v) > 0 },
  // transportationTypes: at least one entry — server registry uses a
  // customGate that runs catalog per-row validation; FE just needs the
  // array to be non-empty so publish won't fail at the activation gate.
  { name: 'transportationTypes', appliesTo: ['transport'], requiredFor: ['transport'],
    isFilled: (v) => Array.isArray(v) && v.length > 0 },

  // Working hours — required for service + transport (closes drift with listing-readiness:350,466)
  { name: 'workingHours', appliesTo: ['service', 'transport'],
    requiredFor: ['service', 'transport'],
    isFilled: hasAnyOpenDay },
];

// ── Derivation ───────────────────────────────────────────────────────────
const defaultIsFilled = (v: unknown): boolean => {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return !!v;
};

function fieldAppliesTo(
  appliesTo: SharedFieldSpec['appliesTo'],
  listingType: ListingType,
): boolean {
  if (appliesTo === 'all') return true;
  return appliesTo.includes(listingType);
}

/**
 * Apply the FE registry to a profile and return the set of missing
 * required-field names. Returns a Set (mutable copy expected to be
 * unioned with FE-only rules in `onboarding-validation.ts`).
 */
export function getRegistryMissingFields(profile: OnboardingProfile): Set<string> {
  const missing = new Set<string>();
  const listingType = inferListingType(profile);

  for (const spec of FE_FIELD_REGISTRY) {
    if (listingType && spec.appliesTo !== 'all'
        && !fieldAppliesTo(spec.appliesTo, listingType)) continue;
    if (!listingType && spec.appliesTo !== 'all') continue;

    let required = false;
    if (spec.requiredFor) {
      if (listingType && spec.requiredFor.includes(listingType)) {
        required = true;
      } else if (!listingType
        && spec.appliesTo === 'all'
        && spec.requiredFor.length === 3) {
        required = true;
      }
    }
    if (!required && spec.requiredWhen?.(profile)) required = true;

    if (required) {
      const isFilled = spec.isFilled ?? defaultIsFilled;
      const value = (profile as unknown as Record<string, unknown>)[spec.name];
      if (!isFilled(value, profile)) missing.add(spec.name);
    }

    if (spec.customGate) {
      for (const m of spec.customGate(profile)) missing.add(m);
    }
  }
  return missing;
}
