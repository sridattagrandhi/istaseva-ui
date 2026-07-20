/**
 * The onboarding field registry — single source of truth for every
 * extractable field on the onboarding profile.
 *
 * See field-registry.types.ts for the FieldSpec contract and design
 * notes. Three derivers consume this:
 *   - derive-zod.ts            → ProfilePatch zod schema
 *   - derive-json-schema.ts    → parametersJsonSchema for Gemini
 *   - derive-submit-gate.ts    → submit-readiness check
 *
 * Phase A status: this file exists but is NOT yet wired into the live
 * tools (extract_fields and submit_listing still own their hand-rolled
 * schemas). The invariants test guards against shape drift; Phase B
 * does the cutover one tool at a time.
 *
 * RULES OF CHANGE
 * - Field NAMES are load-bearing across boundaries (CLAUDE.md "Field
 *   name parity"). Never rename `servicesCatalog`, `subcategories`,
 *   `transportationTypes`, etc.
 * - Adding a field = one entry here, end-to-end.
 * - Conditional requirements use `requiredWhen` (predicate), not a
 *   custom check elsewhere.
 * - Anything the registry shape can't express (e.g. per-row catalog
 *   validation for `transportationTypes`) goes in the field's
 *   `customGate` — keep that hatch narrow.
 */
import { z } from 'zod';
import type { FieldRegistry, ListingType } from './field-registry.types.js';
import type { OnboardingProfileState } from '../types.js';
import { validateServerTransportationTypes } from '../transport-catalog.js';
import { verifyIndiaLocation } from '../../../../../common/services/geocode.service.js';
import { filterToSupportedLanguages } from './supported-languages.js';

// ── Shared sub-schemas (mirror extract-fields.tool.ts) ────────────────────
const ServiceModeEnum = z.enum(['at-home', 'visit-provider', 'online']);
const TransportModeEnum = z.enum(['hourly', 'day', 'package']);
const PricingUnitEnum = z.enum(['per_hour', 'per_visit', 'per_session', 'per_day', 'fixed']);
const TransportTypePricingUnitEnum = z.enum([
  'per_km', 'per_hour', 'per_day', 'per_trip', 'per_package', 'fixed',
]);

const ServiceAddOnSchema = z.object({
  id: z.string().max(60).optional(),
  label: z.string().min(1).max(80),
  price: z.number().min(0).max(100_000),
});

const ServicesCatalogGroupSchema = z.object({
  id: z.string().max(60).optional(),
  name: z.string().min(1).max(80),
  basePrice: z.number().min(1).max(1_000_000),
  addOns: z.array(ServiceAddOnSchema).max(20).default([]),
});

// Multi-room stays (hotel/lodge/heritage/sathram). One entry per bookable
// room CLASS. Price in rupees/night — the client converts to paise. The
// stay parallel to ServicesCatalogGroupSchema / TransportationTypeEntrySchema.
const RoomTypeEntrySchema = z.object({
  id: z.string().max(60).optional(),
  name: z.string().min(1).max(80),
  pricePerNight: z.number().min(1).max(1_000_000),
  maxGuests: z.number().int().positive().max(100).optional(),
  quantity: z.number().int().positive().max(500).optional(),
  bedrooms: z.number().int().min(0).max(50).optional(),
  bathrooms: z.number().int().min(0).max(50).optional(),
  amenities: z.array(z.string().min(1).max(60)).max(40).optional(),
});

/** Pull the first number out of a model-emitted string: "₹3,500" → 3500,
 *  "8 hours" → 8, "90" → 90. Non-strings pass through untouched. The model
 *  routinely emits these loose shapes no matter what the JSON schema says —
 *  rejecting them used to fail the whole extract_fields call, which made the
 *  agent re-ask the user for data it already had (the package re-ask loop). */
const looseNumber = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  const m = v.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : v;
};

const PackageStopSchema = z.preprocess(
  // The model often emits stops as bare strings ("Charminar") instead of
  // {place} objects. Coerce rather than reject.
  (s) => (typeof s === 'string' ? { place: s.trim() } : s),
  z.object({
    place: z.string().min(1).max(120),
    dwellMinutes: z.preprocess(looseNumber, z.number().positive().max(24 * 60)).optional(),
  }),
);

const PackageOptionSchema = z.preprocess(
  (row) => {
    if (!row || typeof row !== 'object') return row;
    const r = { ...(row as Record<string, unknown>) };
    // Models love "title" for the package name.
    if (r.label == null && typeof r.title === 'string') r.label = r.title;
    // "90-100 km" handed to distanceKmMin → split the range into min/max.
    if (typeof r.distanceKmMin === 'string') {
      const range = (r.distanceKmMin as string).replace(/,/g, '')
        .match(/(\d+(?:\.\d+)?)\s*(?:[-–—]|to)\s*(\d+(?:\.\d+)?)/i);
      if (range) {
        r.distanceKmMin = Number(range[1]);
        if (r.distanceKmMax == null) r.distanceKmMax = Number(range[2]);
      }
    }
    // One comma-separated string instead of a stops array → split it.
    if (typeof r.stops === 'string') {
      r.stops = (r.stops as string).split(/[,·|]/).map((s) => s.trim()).filter(Boolean);
    }
    return r;
  },
  z.object({
    id: z.string().max(60).optional(),
    label: z.string().max(120),
    price: z.preprocess(looseNumber, z.number().min(0).max(1_000_000)),
    hours: z.preprocess(looseNumber, z.number().min(0).max(48)).optional(),
    description: z.string().max(500).optional(),
    // Ordered itinerary — required on submit; the agent should always collect
    // at least one named stop per package so customers know what they're booking.
    stops: z.array(PackageStopSchema).max(40).optional(),
    // Approximate distance covered by the tour, in km. Min required, max
    // optional; max defaults to min when omitted by the agent.
    distanceKmMin: z.preprocess(looseNumber, z.number().positive().max(10_000)).optional(),
    distanceKmMax: z.preprocess(looseNumber, z.number().positive().max(10_000)).optional(),
    // Per-package language overrides; falls back to listing languages at
    // display time when omitted.
    languages: z.array(z.string().min(1).max(40)).max(20).optional(),
  }),
);

const TransportationTypeEntrySchema = z.object({
  type: z.string().min(1).max(60),
  displayName: z.string().max(80).optional(),
  details: z.object({
    vehicleName: z.string().max(80).optional(),
    seatingCapacity: z.number().int().positive().max(120).optional(),
    acAvailable: z.boolean().optional(),
    luggageCapacity: z.string().max(120).optional(),
    goodsCapacityKg: z.number().positive().max(50_000).optional(),
    pricingUnit: TransportTypePricingUnitEnum.optional(),
    basePrice: z.number().positive().max(1_000_000).optional(),
    perKmPrice: z.number().positive().max(10_000).optional(),
    perHourPrice: z.number().positive().max(100_000).optional(),
    perDayPrice: z.number().positive().max(1_000_000).optional(),
    operatingAreas: z.string().max(500).optional(),
    routesOrAirports: z.string().max(500).optional(),
    minHours: z.number().positive().max(48).optional(),
    maxHours: z.number().positive().max(48).optional(),
    packageNotes: z.string().max(500).optional(),
    notes: z.string().max(500).optional(),
  }).partial().optional(),
});

// ── Listing-type inference (mirrors submit-listing.tool.ts) ───────────────
const STAY_CATEGORIES = new Set([
  'hotel', 'homestay', 'lodge', 'village-stay', 'farm-stay', 'heritage', 'sathram',
]);
const TRANSPORT_CATEGORY_PREFIX = 'driver-';

/** Returns the listing type implied by the profile's `category`, or
 *  `null` if category isn't filled yet. Anything not a stay or transport
 *  is treated as a service (including custom kebab-case slugs the user
 *  invented — same convention as the manual onboarding form). */
export function inferListingType(profile: OnboardingProfileState): ListingType | null {
  const cat = typeof profile.category === 'string' ? profile.category : '';
  if (!cat) return null;
  if (STAY_CATEGORIES.has(cat)) return 'stay';
  if (cat.startsWith(TRANSPORT_CATEGORY_PREFIX)) return 'transport';
  return 'service';
}

/** True iff the profile is a service listing whose ONLY mode is 'online'.
 *  Such providers have no physical base; the manual form hides "Where
 *  you are" and the submit gate skips `location`. */
export function isOnlineOnlyService(profile: OnboardingProfileState): boolean {
  if (inferListingType(profile) !== 'service') return false;
  const modes = Array.isArray(profile.serviceModes) ? profile.serviceModes : [];
  return modes.length > 0 && modes.every((m) => m === 'online');
}

/** True iff a stay is one of the multi-room shapes — those defer per-
 *  room price/layout to the room-types step, so the agent's submit gate
 *  (and the FE form / activation gate) skip the property-level
 *  price/bedrooms/maxGuests check.
 *
 *  Matches `isMultiRoomStay` in server/src/modules/listings/services/
 *  listing-readiness.ts:102 — category is the primary signal (hotel /
 *  lodge / heritage), with sathram as a property-type override on top
 *  of the homestay category. Keep the two in sync.
 */
function isMultiRoomStay(profile: OnboardingProfileState): boolean {
  const category = typeof profile.category === 'string' ? profile.category : '';
  if (category === 'hotel' || category === 'lodge' || category === 'heritage') return true;
  const pt = typeof profile.propertyType === 'string' ? profile.propertyType : '';
  if (pt === 'sathram') return true;
  return false;
}

// ── Helpers used by isFilled / customGate ─────────────────────────────────
const nonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;
const positiveNumber = (v: unknown): v is number =>
  typeof v === 'number' && v > 0;

// ── THE REGISTRY ──────────────────────────────────────────────────────────
export const FIELD_REGISTRY: FieldRegistry = {
  // Core — required for everything except online-only services (location).
  category: {
    name: 'category',
    appliesTo: 'all',
    requiredFor: ['stay', 'service', 'transport'],
    description: 'Listing category. Stays: hotel, homestay, lodge, village-stay, farm-stay, heritage, sathram. Services: cleaning, plumber, electrician, cook, carpenter, mechanic, tour-guide, photographer, helper, freelancer, OR a custom kebab-case slug (massage, salon, yoga-teacher, etc). Transport: driver-cab or driver-auto.',
    examples: ['"I run a homestay" → homestay', '"I drive an auto" → driver-auto', '"massage therapy" → massage (custom slug)'],
    readinessCode: 'category_required',
    readinessLabel: 'Category',
    readinessMessage: 'Pick a category.',
    zodSchema: z.string(),
    jsonSchema: {
      type: 'string',
      description: 'One of: hotel, homestay, driver-auto, driver-cab, cleaning, electrician, plumber, cook, carpenter, mechanic, tour-guide, photographer, helper, freelancer.',
    },
    // Stays: the manual form's stay-type picker (and multi-room detection)
    // bind to `propertyType`, not `category`. The model is told to set both,
    // but when it sends only `category` (a stay sub-type), mirror it into
    // `propertyType` so the form tile isn't left blank and hotels/lodges are
    // correctly treated as multi-room. Only fires for stay categories and
    // only when propertyType is still empty — never clobbers an explicit
    // value (e.g. category=hotel + propertyType=lodge stays distinct).
    mirrorTo: [{
      field: 'propertyType',
      transform: (value, profile) => {
        if (typeof value !== 'string' || !STAY_CATEGORIES.has(value)) return undefined;
        const current = typeof profile.propertyType === 'string' ? profile.propertyType.trim() : '';
        if (current.length > 0) return undefined;
        return value;
      },
    }],
  },
  name: {
    name: 'name',
    appliesTo: 'all',
    requiredFor: ['stay', 'service', 'transport'],
    description: 'The provider, host, or listing display name customers see.',
    readinessCode: 'name_required',
    readinessLabel: 'Name',
    readinessMessage: 'Add a listing name.',
    zodSchema: z.string().max(120),
    jsonSchema: { type: 'string' },
  },
  location: {
    name: 'location',
    appliesTo: 'all',
    description: 'Customer-visible location: neighborhood + city minimum, full street + landmark + pincode preferred. NOT just a bare city.',
    examples: ['"Madikeri Road, Coorg, near St. Mary\'s" → that full string', '"Hyderabad" → push for the area, then save'],
    // Required for everyone EXCEPT online-only services. Mirrors the
    // submit-listing.tool.ts isOnlineOnlyService guard.
    requiredWhen: (profile) => !isOnlineOnlyService(profile),
    readinessCode: 'location_required',
    readinessLabel: 'Location',
    readinessMessage: 'Add a location/address.',
    zodSchema: z.string().max(2000),
    jsonSchema: { type: 'string' },
    // India-only guardrail. Geocode the free text and HARD-reject only a
    // CONFIRMED non-India place ("New York" → United States) — the user's
    // explicit rule is "must be in India, not the US". An UNRESOLVED string
    // (gibberish, or a tier-3 village the geocoder doesn't index) is left
    // for the create-gate semantic check rather than risk false-rejecting a
    // legitimate rural Indian address (geocoder coverage in tier-3 towns is
    // spotty — see geocode.service.ts). Never throws; a geocode failure
    // returns resolved:false and is therefore not rejected here.
    validateValue: async (value) => {
      if (typeof value !== 'string' || value.trim().length === 0) return [];
      const v = await verifyIndiaLocation(value);
      if (v.resolved && !v.inIndia) {
        return [{
          field: 'location',
          code: 'location_not_in_india',
          message: `That location looks like it's in ${v.country ?? 'another country'}. IstaSeva only operates in India — please give a location inside India.`,
        }];
      }
      return [];
    },
  },
  lat: {
    name: 'lat',
    appliesTo: 'all',
    description: 'Latitude (decimal degrees). Optional — fill only when you have GPS data.',
    zodSchema: z.number(),
    jsonSchema: { type: 'number' },
  },
  lng: {
    name: 'lng',
    appliesTo: 'all',
    description: 'Longitude (decimal degrees). Optional.',
    zodSchema: z.number(),
    jsonSchema: { type: 'number' },
  },
  serviceArea: {
    name: 'serviceArea',
    appliesTo: 'all',
    description: 'Free-text description of the area the provider covers ("South Bangalore", "Coorg + Mysore").',
    zodSchema: z.string().max(2000),
    jsonSchema: { type: 'string' },
  },
  price: {
    name: 'price',
    appliesTo: ['stay', 'service'],
    description: 'For stays/services: include the unit ("₹500/visit", "₹2500/night"). For TRANSPORT, leave empty — use pricePerHour / pricePerDay / packageOptions / per-vehicle catalog instead.',
    // Required for single-unit stays only. Multi-room stays do per-room
    // pricing in the room-types step; services use servicesCatalog now.
    requiredWhen: (profile) => inferListingType(profile) === 'stay' && !isMultiRoomStay(profile),
    isFilled: nonEmptyString,
    readinessCode: 'price_required',
    readinessLabel: 'Price',
    readinessMessage: 'Set a price per night.',
    zodSchema: z.string().max(50),
    jsonSchema: {
      type: 'string',
      description: 'For stays: "₹2500/night". For services: prefer servicesCatalog. For transport: leave empty.',
    },
  },
  availability: {
    name: 'availability',
    appliesTo: 'all',
    description: 'Free-text availability ("Year-round", "Mon-Sat 9am-7pm"). Always emit alongside workingHours when concrete days+hours are given.',
    zodSchema: z.string().max(120),
    jsonSchema: { type: 'string' },
  },
  description: {
    name: 'description',
    appliesTo: 'all',
    // Required for everyone, mirroring listing-readiness.ts:190
    // (`description_required` in validateCommon). Previously a drift
    // bug: submit_listing flipped to-preview without it, then publish
    // silently failed at activation. Now both gates agree.
    requiredFor: ['stay', 'service', 'transport'],
    description: 'Two-to-three sentences of free-text describing the listing. Required for activation — submit_listing blocks without it.',
    isFilled: (v) => typeof v === 'string' && v.trim().length > 0,
    readinessCode: 'description_required',
    readinessLabel: 'Description',
    readinessMessage: 'Add a description.',
    zodSchema: z.string().max(2000),
    jsonSchema: { type: 'string' },
  },

  // Languages — applies to every listing type; REQUIRED for service +
  // transport (parity with the manual forms, which mark it required, and the
  // prompt that always asks). Restricted to the supported allow-list — see
  // supported-languages.ts. Stays don't require it.
  languages: {
    name: 'languages',
    appliesTo: 'all',
    requiredFor: ['service', 'transport'],
    description: 'Languages the provider/host can serve customers in — ONLY from the supported set: English, Hindi, Telugu, Tamil, Kannada, Malayalam, Marathi, Bengali. Any language outside that set is dropped and does NOT persist. Capture every supported one the user names.',
    examples: ['"English and Hindi" → ["English","Hindi"]', '"Telugu only" → ["Telugu"]', '"English, German" → ["English"] (German unsupported → dropped)'],
    readinessCode: 'languages_required',
    readinessLabel: 'Languages',
    readinessMessage: 'Pick at least one language you serve customers in.',
    isFilled: (v) => Array.isArray(v) && v.length > 0,
    // Filter to the supported allow-list — canonical casing + dedupe.
    // Unsupported languages never persist (the prompt has the agent tell the
    // user which ones it couldn't accept). This also fixes the old
    // double-casing bug where agent-extracted lowercase + form Title Case
    // stored both variants.
    normalize: (value) => filterToSupportedLanguages(value),
    zodSchema: z.array(z.string()).max(10),
    jsonSchema: { type: 'array', items: { type: 'string' } },
  },

  experience: {
    name: 'experience',
    appliesTo: ['service', 'transport'],
    requiredFor: ['service', 'transport'],
    description: 'Years the provider has been doing this work. Convert "since 2018" to "8 years" (current year 2026). One-shot answer counts as done — do not press for an exact start date.',
    examples: ['"5 years" → 5 years', '"since 2018" → 8 years', '"saade tin saal" → 3.5 years'],
    isFilled: nonEmptyString,
    readinessCode: 'experience_required',
    readinessLabel: 'Experience',
    readinessMessage: 'Add years of driving/service experience.',
    zodSchema: z.string().max(80),
    jsonSchema: { type: 'string' },
  },
  duration: {
    name: 'duration',
    appliesTo: ['service'],
    requiredFor: ['service'],
    description: 'Typical length of one job ("1 hour", "2-3 hr", "half day"). MUST be <= 24 hours when parseable.',
    isFilled: nonEmptyString,
    readinessCode: 'duration_required',
    readinessLabel: 'Service duration',
    readinessMessage: 'Set how long a typical job takes.',
    zodSchema: z.string().max(80),
    jsonSchema: { type: 'string' },
    // Extra constraint: parseable duration must be <= 24h. Submit gate
    // calls this for the "duration (must be 24 hours or less)" rule.
    customGate: (profile) => {
      if (!nonEmptyString(profile.duration)) return [];
      const hours = parseDurationHours(profile.duration);
      if (hours != null && hours > 24) return ['duration (must be 24 hours or less)'];
      return [];
    },
  },

  // Sub-skills — mirrored pair (subcategory legacy scalar, subcategories canonical array).
  subcategory: {
    name: 'subcategory',
    appliesTo: ['service'],
    description: 'Legacy single sub-skill. Prefer subcategories (array). Mirror of subcategories[0].',
    zodSchema: z.string().max(80),
    jsonSchema: { type: 'string', description: 'Legacy single sub-skill. Prefer `subcategories` (array).' },
    // Reverse mirror: when the model sends ONLY `subcategory` (no
    // subcategories array yet), wrap into a one-element array on
    // subcategories so the new chip UI / filter aggregator pick it up.
    // Only fires when `subcategories` is empty / missing — does NOT
    // clobber a multi-value list with a single corrected primary label.
    mirrorTo: [{
      field: 'subcategories',
      transform: (value, profile) => {
        if (typeof value !== 'string' || value.trim().length === 0) return undefined;
        const current = Array.isArray(profile.subcategories) ? profile.subcategories : [];
        if (current.length > 0) return undefined;
        return [value.trim()];
      },
    }],
  },
  subcategories: {
    name: 'subcategories',
    appliesTo: ['service'],
    description: 'Multi-value sub-skills the provider offers. Extract EVERY one in the SAME call. First entry mirrors to legacy `subcategory`.',
    examples: ['salon → ["Haircut","Beard trim","Nails"]', 'tutor → ["Math","Physics"]'],
    extractionHint: 'Patches overwrite — when adding a sub-skill later, re-emit the FULL combined list.',
    zodSchema: z.array(z.string().max(80)).max(20),
    jsonSchema: {
      type: 'array',
      items: { type: 'string' },
      description: 'Multi-value sub-skills. Extract every one in a single call.',
    },
    // Clean: trim each entry, drop empties.
    normalize: (value) => {
      if (!Array.isArray(value)) return value;
      return value
        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter((s) => s.length > 0);
    },
    // Mirror first entry into legacy `subcategory` scalar so older
    // readers (search providers, marketplace adapter fallbacks) keep
    // working. CLAUDE.md "Don't drop the legacy scalar mirror".
    mirrorTo: [{
      field: 'subcategory',
      transform: (value) => {
        if (!Array.isArray(value) || value.length === 0) return undefined;
        return value[0];
      },
    }],
  },

  // Service add-ons (legacy flat shape — still accepted alongside servicesCatalog).
  addOns: {
    name: 'addOns',
    appliesTo: ['service'],
    description: 'Service-only — flat add-ons stacking onto the top-level price. Superseded by servicesCatalog[*].addOns; only emit when the listing uses the legacy flat shape.',
    zodSchema: z.array(ServiceAddOnSchema).max(20),
    jsonSchema: {
      type: 'array',
      description: 'Service only — optional add-ons (legacy flat shape).',
      items: {
        type: 'object',
        required: ['label', 'price'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          price: { type: 'number' },
        },
      },
    },
    // Clean up labels, ensure stable ids, dedupe by case-insensitive
    // label (the model often re-emits the same set on a follow-up turn).
    normalize: (value) => {
      if (!Array.isArray(value)) return value;
      const seen = new Set<string>();
      const out: Array<{ id: string; label: string; price: number }> = [];
      value.forEach((entry, i) => {
        if (!entry || typeof entry !== 'object') return;
        const e = entry as Record<string, unknown>;
        const label = typeof e.label === 'string' ? e.label.trim() : '';
        if (!label) return;
        const key = label.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        const price = Number(e.price);
        out.push({
          id: typeof e.id === 'string' && e.id.trim()
            ? e.id.trim()
            : `addon-${i + 1}-${key.replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`,
          label,
          price: Number.isFinite(price) && price >= 0 ? Math.round(price) : 0,
        });
      });
      return out;
    },
  },

  // SERVICES CATALOG — load-bearing per CLAUDE.md. The salon-bug-fix
  // rules live here as extractionHint + disambiguationRules; the prompt
  // builder will emit them verbatim.
  servicesCatalog: {
    name: 'servicesCatalog',
    appliesTo: ['service'],
    requiredFor: ['service'],
    description: 'Service only — every bookable service the provider offers. Each entry: { name, basePrice, addOns: [{label, price}] }. Replaces the legacy top-level price.',
    examples: [
      'haircut ₹500 + beard trim ₹100 → [{name:"Haircut", basePrice:500, addOns:[{label:"Beard trim", price:100}]}]',
      'men\'s ₹700 + women\'s ₹1200 → two groups, each with its own add-ons',
    ],
    extractionHint: 'Extract every base service AND every add-on the user names — even in the same sentence — in ONE call. Patches overwrite, so re-emit the FULL list on any correction.',
    disambiguationRules: [
      'If the user says "X and Y" with two prices and no "with/optional/add-on" framing, ASK whether Y is standalone (= second group) or only available with X (= add-on under X).',
      'When the user says "optional", "extra", or "add-on", treat as add-on without asking.',
    ],
    // Filled = at least one group with name + basePrice > 0, OR (legacy
    // grace) a non-empty top-level `price`. The legacy grace covers
    // pre-migration single-service listings whose pricing lives in the
    // string `price` column instead of a per-service catalog. The
    // bookings flow already coerces these at runtime; keep the
    // activation gate aligned so they stay activatable.
    isFilled: (value, profile) => {
      if (Array.isArray(value)) {
        const ok = value.some((g) => g && typeof g === 'object'
          && typeof (g as Record<string, unknown>).name === 'string'
          && ((g as Record<string, unknown>).name as string).trim().length > 0
          && typeof (g as Record<string, unknown>).basePrice === 'number'
          && ((g as Record<string, unknown>).basePrice as number) > 0);
        if (ok) return true;
      }
      if (nonEmptyString(profile.price)) return true;
      return false;
    },
    zodSchema: z.array(ServicesCatalogGroupSchema).max(20),
    jsonSchema: {
      type: 'array',
      description: 'Service only — bookable services catalog.',
      items: {
        type: 'object',
        required: ['name', 'basePrice'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          basePrice: { type: 'number' },
          addOns: {
            type: 'array',
            items: {
              type: 'object',
              required: ['label', 'price'],
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                price: { type: 'number' },
              },
            },
          },
        },
      },
    },
    // Drop invalid rows, dedupe by case-insensitive name, stamp ids on
    // groups + nested add-ons. The booking modal and the backend
    // re-validator both match catalog entries by id, so every group and
    // add-on must have one before persistence.
    normalize: (value) => {
      if (!Array.isArray(value)) return value;
      const slug = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'svc';
      const seenNames = new Set<string>();
      const out: Array<{
        id: string;
        name: string;
        basePrice: number;
        addOns: Array<{ id: string; label: string; price: number }>;
      }> = [];
      value.forEach((entry, i) => {
        if (!entry || typeof entry !== 'object') return;
        const e = entry as Record<string, unknown>;
        const name = typeof e.name === 'string' ? e.name.trim() : '';
        if (!name) return;
        const basePrice = Number(e.basePrice);
        if (!Number.isFinite(basePrice) || basePrice <= 0) return;
        const key = name.toLowerCase();
        if (seenNames.has(key)) return;
        seenNames.add(key);

        const rawAddOns = Array.isArray(e.addOns) ? e.addOns : [];
        const seenAddOnLabels = new Set<string>();
        const normalizedAddOns: Array<{ id: string; label: string; price: number }> = [];
        rawAddOns.forEach((a, j) => {
          if (!a || typeof a !== 'object') return;
          const aRec = a as Record<string, unknown>;
          const label = typeof aRec.label === 'string' ? aRec.label.trim() : '';
          if (!label) return;
          const akey = label.toLowerCase();
          if (seenAddOnLabels.has(akey)) return;
          seenAddOnLabels.add(akey);
          const price = Number(aRec.price);
          normalizedAddOns.push({
            id: typeof aRec.id === 'string' && aRec.id.trim()
              ? aRec.id.trim()
              : `addon-${j + 1}-${slug(label)}`,
            label,
            price: Number.isFinite(price) && price >= 0 ? Math.round(price) : 0,
          });
        });

        out.push({
          id: typeof e.id === 'string' && e.id.trim()
            ? e.id.trim()
            : `svc-${i + 1}-${slug(name)}`,
          name,
          basePrice: Math.round(basePrice),
          addOns: normalizedAddOns,
        });
      });
      return out;
    },
  },

  // Service-mode trio: serviceModes + dependent visitAddress / meetingDetails / serviceRadius.
  serviceModes: {
    name: 'serviceModes',
    appliesTo: ['service'],
    requiredFor: ['service'],
    description: 'How the provider delivers their service. Multi-select: any combo of at-home / visit-provider / online.',
    examples: ['"I come to your home" → ["at-home"]', '"my clinic" → ["visit-provider"]', '"Zoom" → ["online"]'],
    isFilled: (v) => Array.isArray(v) && v.length > 0,
    readinessCode: 'service_modes_required',
    readinessLabel: 'Service modes',
    readinessMessage: 'Pick at least one service mode (at-home / visit-provider / online).',
    zodSchema: z.array(ServiceModeEnum).max(3),
    jsonSchema: {
      type: 'array',
      items: { type: 'string', enum: ['at-home', 'visit-provider', 'online'] },
    },
  },
  pricingUnit: {
    name: 'pricingUnit',
    appliesTo: ['service'],
    requiredFor: ['service'],
    description: 'How the service price is metered.',
    examples: ['₹500/visit → per_visit', '₹300/hour → per_hour', '₹1500/session → per_session'],
    isFilled: nonEmptyString,
    readinessCode: 'pricing_unit_required',
    readinessLabel: 'Pricing unit',
    readinessMessage: 'Set how you charge (per hour, per visit, etc.).',
    zodSchema: PricingUnitEnum,
    jsonSchema: { type: 'string', enum: ['per_hour', 'per_visit', 'per_session', 'per_day', 'fixed'] },
  },
  visitAddress: {
    name: 'visitAddress',
    appliesTo: ['service'],
    description: 'Provider\'s shop/studio/clinic address customers visit. Required when serviceModes includes "visit-provider". Push for full street + pincode, not just neighborhood.',
    requiredWhen: (profile) => {
      const modes = Array.isArray(profile.serviceModes) ? profile.serviceModes : [];
      return modes.includes('visit-provider');
    },
    isFilled: nonEmptyString,
    readinessCode: 'visit_address_required',
    readinessLabel: 'Visit address',
    readinessMessage: 'Add the address customers will visit you at.',
    zodSchema: z.string().max(2000),
    jsonSchema: { type: 'string' },
  },
  showAddressPublicly: {
    name: 'showAddressPublicly',
    appliesTo: ['service'],
    description: 'WS6 host consent: true ONLY when the host says their visitAddress is a walk-in business premises (shop/salon/clinic) they want shown on the public listing. Default false = the address is shared only after a confirmed booking. NEVER set true for a service run from the host\'s home; when unsure, leave it unset and it stays private.',
    examples: ['"it\'s my salon, customers just walk in" → true', '"I run classes from my flat" → leave unset (private)'],
    // Optional everywhere — privacy-safe default is "absent = private".
    isFilled: (v) => typeof v === 'boolean',
    zodSchema: z.boolean(),
    jsonSchema: { type: 'boolean' },
  },
  meetingDetails: {
    name: 'meetingDetails',
    appliesTo: ['service'],
    description: 'How customers reach the provider for an online session ("I share a Zoom link 30 min before"). Required when serviceModes includes "online".',
    requiredWhen: (profile) => {
      const modes = Array.isArray(profile.serviceModes) ? profile.serviceModes : [];
      return modes.includes('online');
    },
    isFilled: nonEmptyString,
    readinessCode: 'meeting_details_required',
    readinessLabel: 'Meeting details',
    readinessMessage: 'Add meeting/online delivery details.',
    zodSchema: z.string().max(500),
    jsonSchema: { type: 'string' },
  },
  serviceRadius: {
    name: 'serviceRadius',
    appliesTo: ['service', 'transport'],
    description: 'Km the provider travels from their home base. Convert city-extent phrases to integer km — see prompt for the lookup table.',
    examples: ['"5 km radius" → 5', '"all of Bangalore" → 25', '"Coorg only" → 10'],
    // Required when (service + at-home) OR (transport).
    requiredWhen: (profile) => {
      const t = inferListingType(profile);
      if (t === 'transport') return true;
      if (t === 'service') {
        const modes = Array.isArray(profile.serviceModes) ? profile.serviceModes : [];
        return modes.includes('at-home');
      }
      return false;
    },
    isFilled: positiveNumber,
    readinessCode: 'service_radius_required',
    readinessLabel: 'Service radius',
    readinessMessage: 'Set the area/radius you cover.',
    zodSchema: z.number().int().min(0).max(500),
    jsonSchema: { type: 'number' },
  },

  bufferMinutes: {
    name: 'bufferMinutes',
    appliesTo: ['service', 'transport'],
    description: 'Buffer between back-to-back bookings (minutes). Default 15 server-side. Only extract when the user explicitly mentions a buffer/travel/prep gap.',
    zodSchema: z.number().int().min(0).max(240),
    jsonSchema: { type: 'integer' },
  },
  vehicleClass: {
    name: 'vehicleClass',
    appliesTo: ['service'],
    description: 'How service providers get to jobs. Legacy / no longer asked. Only extract if the user volunteers.',
    zodSchema: z.enum(['walk', 'scooter', 'car', 'van']),
    jsonSchema: { type: 'string', enum: ['walk', 'scooter', 'car', 'van'] },
  },
  maxJobsPerDay: {
    name: 'maxJobsPerDay',
    appliesTo: ['service'],
    description: 'Cap on bookings per day for this provider. Legacy / no longer required.',
    zodSchema: z.number().int().min(1).max(50),
    jsonSchema: { type: 'number' },
  },
  workingHours: {
    name: 'workingHours',
    appliesTo: ['service', 'transport'],
    // Required for service + transport, mirroring
    // listing-readiness.ts:350,466 (`working_hours_required`). At
    // least one weekday must carry a non-empty 2-tuple — otherwise
    // the slot generator yields nothing and the listing publishes
    // unbookable. Previously a drift bug: submit_listing didn't
    // enforce this; activation did.
    requiredFor: ['service', 'transport'],
    readinessCode: 'working_hours_required',
    readinessLabel: 'Working hours',
    readinessMessage: 'Set weekly working hours.',
    description: 'Per-weekday open hours: {mon: ["09:00","18:00"], tue: [...], ..., sun: null}. ALWAYS emit all 7 keys; null = day off. At least one day must have a non-null window — without it the slot generator returns nothing.',
    examples: ['"weekdays 9-6" → all weekdays 09:00-18:00, sat/sun null'],
    // "Filled" = at least one day with a 2-tuple of non-empty strings.
    isFilled: (v) => {
      if (!v || typeof v !== 'object') return false;
      return Object.values(v as Record<string, unknown>).some((slot) =>
        Array.isArray(slot)
          && slot.length === 2
          && typeof slot[0] === 'string' && slot[0].length > 0
          && typeof slot[1] === 'string' && slot[1].length > 0,
      );
    },
    zodSchema: z.record(z.string(), z.union([z.tuple([z.string(), z.string()]), z.null()])),
    jsonSchema: { type: 'object' },
  },
  flexibleHours: {
    name: 'flexibleHours',
    appliesTo: ['transport'],
    description: 'Transport — OPTIONAL informational flag. True when the driver is willing to arrange trips outside the workingHours above by talking to the customer (e.g. an early-morning airport run, a late return). Ask plainly ("Are you flexible on timing if a rider needs hours outside your usual schedule?"). Does NOT relax workingHours — bookable slots are still generated from the schedule; this only surfaces a "Flexible hours" tag so customers know they can message to discuss timing. Never block submit on it.',
    examples: ['"I can adjust for early flights, just message me" → true', '"Strictly my listed hours" → false'],
    zodSchema: z.boolean(),
    jsonSchema: { type: 'boolean' },
  },

  // Stay-specific fields.
  amenities: {
    name: 'amenities',
    appliesTo: ['stay'],
    description: 'Stay amenities/facilities. Single-unit stays (homestay/village-stay/farm-stay): property amenities (wifi, AC, parking, breakfast, ...). Multi-room stays (hotel/lodge/heritage/sathram): property-WIDE FACILITIES shared by all guests (pool, gym, restaurant, parking, spa, bar, garden, laundry) — NOT in-room amenities, those go per-room inside roomTypes. Optional for multi-room; never blocks submit.',
    examples: ['hotel host: "we have a restaurant, pool, gym, parking" → amenities=["restaurant","pool","gym","parking"] (facilities), per-room AC/Wi-Fi stay inside roomTypes'],
    zodSchema: z.array(z.string()).max(40),
    jsonSchema: { type: 'array', items: { type: 'string' } },
  },
  // ROOM TYPES — the stay parallel to servicesCatalog / transportationTypes.
  // Only meaningful for multi-room stays; the agent captures the room
  // catalog from chat so the room-types editor opens PRE-FILLED instead of
  // empty. Per-room photos / unit numbers stay form-only.
  roomTypes: {
    name: 'roomTypes',
    appliesTo: ['stay'],
    requiredWhen: (profile) => inferListingType(profile) === 'stay' && isMultiRoomStay(profile),
    description: 'Multi-room stays (hotel/lodge/heritage/sathram) ONLY — one entry per bookable room CLASS the host describes. Each entry: { name, pricePerNight (₹/night), maxGuests?, quantity?, bedrooms?, bathrooms?, amenities?[] }. This is where per-room price + amenities go; do NOT use property-level price/bedrooms/maxGuests/amenities for these stays.',
    examples: [
      'single ₹200/night + double ₹300/night → [{name:"Single Room", pricePerNight:200}, {name:"Double Room", pricePerNight:300}]',
      'both have parking, wifi, ac → put those amenities on EACH room entry',
    ],
    extractionHint: 'Capture every room class AND its per-room amenities in ONE call. Patches overwrite, so re-emit the FULL list on any correction. Amenities the host says apply to "both"/"all" rooms go onto every entry.',
    // NO readinessCode on purpose. Room types are NOT carried on the
    // listing row / metadata — they live in the separate `listing_room_types`
    // table, so the registry-derived activation gate (getReadinessMissingFromRegistry,
    // which reads a profile reconstructed from the listing row) would always
    // see an empty roomTypes and block activation even when rooms exist.
    // listing-readiness.ts owns the real activation check by querying that
    // table (validateStayActivationOnly). requiredWhen/customGate below still
    // apply to the AI onboarding submit_listing gate, where roomTypes IS on
    // the live profile.
    isFilled: (v) => Array.isArray(v) && v.length > 0,
    // Per-row check — mirrors the edit-mode room gate (RoomTypesManager)
    // so AI-created rooms hold to the same bar as edited ones: name,
    // positive price, max guests, room count, and >=3 amenities. PHOTOS
    // are deliberately NOT gated here — the agent can't capture images in
    // chat; the host adds a photo per room in the review/form, which is
    // where the photo requirement is enforced.
    customGate: (profile) => {
      const rooms = Array.isArray(profile.roomTypes) ? profile.roomTypes : [];
      if (rooms.length === 0) return [];
      const ROOM_AMENITY_MIN = 3;
      const errors: string[] = [];
      rooms.forEach((r, i) => {
        const rec = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
        const name = typeof rec.name === 'string' ? rec.name.trim() : '';
        const amenities = Array.isArray(rec.amenities) ? rec.amenities : [];
        const missing: string[] = [];
        if (!name) missing.push('name');
        if (!positiveNumber(rec.pricePerNight)) missing.push('pricePerNight');
        if (!positiveNumber(rec.maxGuests)) missing.push('maxGuests');
        if (!positiveNumber(rec.quantity)) missing.push('quantity');
        if (amenities.length < ROOM_AMENITY_MIN) missing.push(`amenities (>=${ROOM_AMENITY_MIN})`);
        if (missing.length > 0) {
          errors.push(`roomTypes[${name || `#${i + 1}`}]: ${missing.join(', ')}`);
        }
      });
      return errors;
    },
    zodSchema: z.array(RoomTypeEntrySchema).max(30),
    jsonSchema: {
      type: 'array',
      description: 'Multi-room stays only — bookable room classes.',
      items: {
        type: 'object',
        required: ['name', 'pricePerNight'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          pricePerNight: { type: 'number', description: 'Rupees per night.' },
          maxGuests: { type: 'integer' },
          quantity: { type: 'integer', description: 'How many physical rooms of this class.' },
          bedrooms: { type: 'integer' },
          bathrooms: { type: 'integer' },
          amenities: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    // Drop invalid rows (no name / non-positive price), dedupe by
    // case-insensitive name, dedupe amenities, stamp stable ids. Mirrors
    // the servicesCatalog normalizer.
    normalize: (value) => {
      if (!Array.isArray(value)) return value;
      const slug = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'room';
      const seenNames = new Set<string>();
      const out: Array<{
        id: string;
        name: string;
        pricePerNight: number;
        maxGuests?: number;
        quantity?: number;
        bedrooms?: number;
        bathrooms?: number;
        amenities: string[];
      }> = [];
      value.forEach((entry, i) => {
        if (!entry || typeof entry !== 'object') return;
        const e = entry as Record<string, unknown>;
        const name = typeof e.name === 'string' ? e.name.trim() : '';
        if (!name) return;
        const price = Number(e.pricePerNight);
        if (!Number.isFinite(price) || price <= 0) return;
        const key = name.toLowerCase();
        if (seenNames.has(key)) return;
        seenNames.add(key);

        const rawAmenities = Array.isArray(e.amenities) ? e.amenities : [];
        const seenAmenities = new Set<string>();
        const amenities: string[] = [];
        rawAmenities.forEach((a) => {
          const label = typeof a === 'string' ? a.trim() : '';
          if (!label) return;
          const akey = label.toLowerCase();
          if (seenAmenities.has(akey)) return;
          seenAmenities.add(akey);
          amenities.push(label);
        });

        const intOrUndef = (v: unknown) => {
          const n = Number(v);
          return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
        };
        out.push({
          id: typeof e.id === 'string' && e.id.trim() ? e.id.trim() : `room-${i + 1}-${slug(name)}`,
          name,
          pricePerNight: Math.round(price),
          maxGuests: intOrUndef(e.maxGuests),
          quantity: intOrUndef(e.quantity),
          bedrooms: intOrUndef(e.bedrooms),
          bathrooms: intOrUndef(e.bathrooms),
          amenities,
        });
      });
      return out;
    },
  },
  bedrooms: {
    name: 'bedrooms',
    appliesTo: ['stay'],
    description: 'Property-level bedrooms (single-unit stays only — multi-room stays do per-room layout in the room-types step).',
    requiredWhen: (profile) => inferListingType(profile) === 'stay' && !isMultiRoomStay(profile),
    isFilled: positiveNumber,
    readinessCode: 'bedrooms_required',
    readinessLabel: 'Bedrooms',
    readinessMessage: 'Set bedrooms.',
    zodSchema: z.number().int().min(0).max(50),
    jsonSchema: { type: 'number' },
  },
  bathrooms: {
    name: 'bathrooms',
    appliesTo: ['stay'],
    description: 'Property-level bathrooms (single-unit stays only).',
    zodSchema: z.number().int().min(0).max(50),
    jsonSchema: { type: 'number' },
  },
  maxGuests: {
    name: 'maxGuests',
    appliesTo: ['stay'],
    description: 'Property-level max guests (single-unit stays only). Fallback: bedrooms × 2 if host doesn\'t volunteer.',
    requiredWhen: (profile) => inferListingType(profile) === 'stay' && !isMultiRoomStay(profile),
    isFilled: positiveNumber,
    readinessCode: 'max_guests_required',
    readinessLabel: 'Max guests',
    readinessMessage: 'Set max guests.',
    zodSchema: z.number().int().min(0).max(100),
    jsonSchema: { type: 'number' },
  },
  propertyType: {
    name: 'propertyType',
    appliesTo: ['stay'],
    description: 'Sub-type of stay: hotel / homestay / lodge / village-stay / farm-stay / heritage / sathram. ALWAYS set together with category.',
    zodSchema: z.string().max(60),
    jsonSchema: { type: 'string' },
  },
  checkInTime: {
    name: 'checkInTime',
    appliesTo: ['stay'],
    description: 'Stay-only daily check-in time, "HH:MM" 24h.',
    zodSchema: z.string().regex(/^\d{2}:\d{2}$/),
    jsonSchema: { type: 'string', description: 'HH:MM 24h, e.g. "14:00".' },
  },
  checkOutTime: {
    name: 'checkOutTime',
    appliesTo: ['stay'],
    description: 'Stay-only daily check-out time, "HH:MM" 24h.',
    zodSchema: z.string().regex(/^\d{2}:\d{2}$/),
    jsonSchema: { type: 'string', description: 'HH:MM 24h.' },
  },

  // Transport-specific fields.
  vehicleName: {
    name: 'vehicleName',
    appliesTo: ['transport'],
    requiredFor: ['transport'],
    description: 'Transport — vehicle make + model ("Maruti Swift Dzire", "Bajaj RE auto"). REQUIRED: ask plainly ("What car/vehicle will you be driving — make and model?"). Shown to riders in the booking summary so they know what to look for.',
    examples: ['"I drive a white Swift Dzire" → "Maruti Swift Dzire"', '"it\'s a Bajaj auto" → "Bajaj RE"'],
    isFilled: nonEmptyString,
    readinessCode: 'vehicle_name_required',
    readinessLabel: 'Vehicle model',
    readinessMessage: 'Add the vehicle make and model.',
    zodSchema: z.string().max(80),
    jsonSchema: { type: 'string' },
  },
  vehicleColor: {
    name: 'vehicleColor',
    appliesTo: ['transport'],
    requiredFor: ['transport'],
    description: 'Transport — the vehicle\'s colour ("White", "Silver", "Yellow"). REQUIRED: ask plainly ("What colour is the vehicle?"). Helps a waiting rider identify the car.',
    examples: ['"white Swift" → "White"', '"yellow and black auto" → "Yellow"'],
    isFilled: nonEmptyString,
    readinessCode: 'vehicle_color_required',
    readinessLabel: 'Vehicle colour',
    readinessMessage: 'Add the vehicle colour.',
    zodSchema: z.string().max(40),
    jsonSchema: { type: 'string' },
  },
  licensePlate: {
    name: 'licensePlate',
    appliesTo: ['transport'],
    requiredFor: ['transport'],
    description: 'Transport — the vehicle registration / number plate ("KA 01 AB 1234"). REQUIRED: ask plainly ("What\'s the vehicle number plate?"). Snapshotted onto every booking so the rider can match the car that arrives.',
    examples: ['"KA01AB1234" → "KA 01 AB 1234"', '"my plate is TS 09 X 5678" → "TS 09 X 5678"'],
    isFilled: nonEmptyString,
    readinessCode: 'license_plate_required',
    readinessLabel: 'Number plate',
    readinessMessage: 'Add the vehicle number plate.',
    zodSchema: z.string().max(20),
    jsonSchema: { type: 'string' },
  },
  vehicleYear: {
    name: 'vehicleYear',
    appliesTo: ['transport'],
    description: 'Transport — vehicle year. Legacy / NOT required.',
    zodSchema: z.string().max(10),
    jsonSchema: { type: 'string' },
  },
  vehicleType: {
    name: 'vehicleType',
    appliesTo: ['transport'],
    description: 'Transport — free-text vehicle category ("Sedan", "SUV", "Tempo"). Extract whenever named in plain words.',
    zodSchema: z.string().max(80),
    jsonSchema: { type: 'string' },
  },
  seatingCapacity: {
    name: 'seatingCapacity',
    appliesTo: ['transport'],
    description: 'Transport — top-level passenger capacity.',
    zodSchema: z.number().int().min(1).max(120),
    jsonSchema: { type: 'integer' },
  },
  pricePerKm: {
    name: 'pricePerKm',
    appliesTo: ['transport'],
    description: 'Transport — legacy per-km rate. Phase 6 dropped per-km bookings. DO NOT ask; only extract if the driver volunteers.',
    zodSchema: z.string().max(20),
    jsonSchema: { type: 'string' },
  },
  acceptsQuotes: {
    name: 'acceptsQuotes',
    appliesTo: ['transport'],
    description: 'Transport — legacy quotes opt-in. DO NOT ask.',
    zodSchema: z.boolean(),
    jsonSchema: { type: 'boolean' },
  },
  transportMode: {
    name: 'transportMode',
    appliesTo: ['transport'],
    requiredFor: ['transport'],
    description: 'Transport — primary booking mode: hourly / day / package. Point ride is beta and intentionally not selectable.',
    isFilled: (v) => typeof v === 'string' && (v === 'hourly' || v === 'day' || v === 'package'),
    readinessCode: 'transport_mode_required',
    readinessLabel: 'Transport mode',
    readinessMessage: 'Pick a transport mode (hourly / day / package).',
    zodSchema: TransportModeEnum,
    jsonSchema: { type: 'string', enum: ['hourly', 'day', 'package'] },
  },
  transportModes: {
    name: 'transportModes',
    appliesTo: ['transport'],
    description: 'Transport — multi-select of every booking mode enabled. Always emit when more than one mode is offered.',
    zodSchema: z.array(TransportModeEnum).max(4),
    jsonSchema: {
      type: 'array',
      items: { type: 'string', enum: ['hourly', 'day', 'package'] },
    },
  },
  pricePerHour: {
    name: 'pricePerHour',
    appliesTo: ['transport'],
    description: 'Transport — hourly rate as a numeric string ("350"). REQUIRED when transportMode is "hourly".',
    requiredWhen: (profile) => profile.transportMode === 'hourly',
    // Filled = strictly positive numeric value. Accept either a string
    // ("350" from the AI agent / form input) or a number (legacy DB
    // rows stored the value as a numeric jsonb field).
    isFilled: (v) => {
      const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN);
      return Number.isFinite(n) && n > 0;
    },
    readinessCode: 'price_per_hour_required',
    readinessLabel: 'Price per hour',
    readinessMessage: 'Set the hourly price.',
    zodSchema: z.string().max(20),
    jsonSchema: { type: 'string' },
  },
  pricePerDay: {
    name: 'pricePerDay',
    appliesTo: ['transport'],
    description: 'Transport — full-day rate as a numeric string ("4500"). REQUIRED when transportMode is "day".',
    requiredWhen: (profile) => profile.transportMode === 'day',
    isFilled: (v) => {
      const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN);
      return Number.isFinite(n) && n > 0;
    },
    readinessCode: 'price_per_day_required',
    readinessLabel: 'Price per day',
    readinessMessage: 'Set the per-day price.',
    zodSchema: z.string().max(20),
    jsonSchema: { type: 'string' },
  },
  packageOptions: {
    name: 'packageOptions',
    appliesTo: ['transport'],
    description: 'Transport — predefined tour packages. REQUIRED when transportMode is "package". Each row needs: label, price>0, at least one named stop, and a distance range (distanceKmMin/Max). Capture per-package languages when the driver mentions them.',
    requiredWhen: (profile) => profile.transportMode === 'package',
    readinessCode: 'package_options_required',
    readinessLabel: 'Package options',
    readinessMessage: 'Each package needs a label, price, at least one stop, and a distance range.',
    isFilled: (v) => {
      if (!Array.isArray(v) || v.length === 0) return false;
      return v.every((row) => {
        if (!row || typeof row !== 'object') return false;
        const r = row as Record<string, unknown>;
        const label = typeof r.label === 'string' ? r.label.trim() : '';
        if (!label) return false;
        if (!(typeof r.price === 'number' && r.price > 0)) return false;
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
        const minKm = typeof r.distanceKmMin === 'number' ? r.distanceKmMin : NaN;
        const maxKm = typeof r.distanceKmMax === 'number' ? r.distanceKmMax : minKm;
        if (!(minKm > 0)) return false;
        if (!(maxKm >= minKm)) return false;
        return true;
      });
    },
    customGate: (profile) => {
      if (profile.transportMode !== 'package') return [];
      const rows = Array.isArray(profile.packageOptions) ? profile.packageOptions : [];
      if (rows.length === 0) return ['packageOptions (at least one row required)'];
      const problems: string[] = [];
      rows.forEach((row, idx) => {
        if (!row || typeof row !== 'object') {
          problems.push(`packageOptions[${idx}] invalid shape`);
          return;
        }
        const r = row as Record<string, unknown>;
        const label = typeof r.label === 'string' ? r.label.trim() : '';
        const tag = label || `row ${idx + 1}`;
        if (!label) problems.push(`packageOptions[${idx}].label`);
        if (!(typeof r.price === 'number' && r.price > 0)) problems.push(`packageOptions[${tag}].price`);
        const stops = Array.isArray(r.stops) ? r.stops : [];
        const stopCount = stops.filter((s) => {
          if (typeof s === 'string') return s.trim().length > 0;
          if (s && typeof s === 'object') {
            const place = (s as Record<string, unknown>).place;
            return typeof place === 'string' && place.trim().length > 0;
          }
          return false;
        }).length;
        if (stopCount === 0) problems.push(`packageOptions[${tag}].stops (add at least one place)`);
        const minKm = typeof r.distanceKmMin === 'number' ? r.distanceKmMin : NaN;
        const maxKm = typeof r.distanceKmMax === 'number' ? r.distanceKmMax : minKm;
        if (!(minKm > 0)) problems.push(`packageOptions[${tag}].distanceKmMin`);
        if (!(maxKm >= minKm)) problems.push(`packageOptions[${tag}].distanceKmMax (must be >= min)`);
        // NOTE: no hours-vs-workingHours fit gate here. Packages book the
        // WHOLE day (product decision) — the stated hours are descriptive,
        // so a 10h tour on 9–5 windows is the driver's own call, not a data
        // error. The only calendar rule (closed weekday → unbookable) is
        // enforced at booking time.
      });
      return problems;
    },
    // Stamp stable ids (bookings match notes.packageId against these) and
    // default distanceKmMax to min. Mirrors the roomTypes/servicesCatalog
    // normalizers.
    normalize: (value) => {
      if (!Array.isArray(value)) return value;
      return value.map((entry, i) => {
        if (!entry || typeof entry !== 'object') return entry;
        const e = { ...(entry as Record<string, unknown>) };
        if (typeof e.id !== 'string' || !(e.id as string).trim()) {
          const slug = String(e.label ?? 'package').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'package';
          e.id = `pkg-${i + 1}-${slug}`;
        }
        if (e.distanceKmMax == null && typeof e.distanceKmMin === 'number') e.distanceKmMax = e.distanceKmMin;
        return e;
      });
    },
    zodSchema: z.array(PackageOptionSchema).max(20),
    jsonSchema: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'price', 'stops', 'distanceKmMin'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          price: { type: 'number' },
          hours: { type: 'number' },
          description: { type: 'string' },
          stops: {
            type: 'array',
            items: {
              type: 'object',
              required: ['place'],
              properties: {
                place: { type: 'string' },
                dwellMinutes: { type: 'number' },
              },
            },
          },
          distanceKmMin: { type: 'number' },
          distanceKmMax: { type: 'number' },
          languages: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  transportationTypes: {
    name: 'transportationTypes',
    appliesTo: ['transport'],
    requiredFor: ['transport'],
    description: 'Transport — multi-type catalog. One entry per vehicle/service kind, each with details.basePrice > 0 + per-mode rates / seats / AC / routes when relevant.',
    extractionHint: 'PREFERRED over vehicleName when the driver describes any of: multiple vehicles, a non-cab vehicle, a route service, or a driver-only / tour-package offering.',
    isFilled: (v) => Array.isArray(v) && v.length > 0,
    readinessCode: 'transportation_types_required',
    readinessLabel: 'Transportation types',
    readinessMessage: 'Pick at least one vehicle or driver service type you offer.',
    // Per-row validation lives in transport-catalog.ts. Surface its
    // structured errors verbatim so the agent loop can ask for the
    // missing per-row fields by name.
    customGate: (profile) => {
      const types = Array.isArray(profile.transportationTypes) ? profile.transportationTypes : [];
      if (types.length === 0) return ['transportationTypes'];
      const check = validateServerTransportationTypes(types);
      if (check.ok) return [];
      return check.errors.map((err) =>
        `transportationTypes[${err.type}]: ${err.missing.join(', ')}`,
      );
    },
    // The prompt steers per-vehicle attributes INTO each entry's details —
    // so the agent saves details.vehicleName/seatingCapacity and never emits
    // the top-level fields the manual forms read ("Model" showed up blank
    // after AI onboarding). Lift the first entry's values to the top level
    // when the host hasn't already provided them.
    mirrorTo: [
      {
        field: 'vehicleName',
        transform: (value, profile) => {
          if (profile.vehicleName) return undefined;
          const first = Array.isArray(value) ? value[0] as { details?: { vehicleName?: unknown } } | undefined : undefined;
          const name = first?.details?.vehicleName;
          return typeof name === 'string' && name.trim() ? name.trim() : undefined;
        },
      },
      {
        field: 'seatingCapacity',
        transform: (value, profile) => {
          if (profile.seatingCapacity) return undefined;
          const first = Array.isArray(value) ? value[0] as { details?: { seatingCapacity?: unknown } } | undefined : undefined;
          const seats = Number(first?.details?.seatingCapacity);
          return Number.isFinite(seats) && seats > 0 ? Math.round(seats) : undefined;
        },
      },
    ],
    zodSchema: z.array(TransportationTypeEntrySchema).max(12),
    jsonSchema: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string' },
          displayName: { type: 'string' },
          details: { type: 'object' },
        },
      },
    },
  },
};

// ── Local helpers exported for tests ──────────────────────────────────────
export { STAY_CATEGORIES, TRANSPORT_CATEGORY_PREFIX, isMultiRoomStay };

/**
 * Duration parser ported from submit-listing.tool.ts. Lives here so the
 * `duration` field's `customGate` can express the <=24h rule inline
 * with the rest of the registry. Returns hours, or null if unparseable.
 */
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
