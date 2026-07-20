/**
 * Derive `ReadinessMissing[]` entries from FIELD_REGISTRY for the
 * server-side activation gate.
 *
 * Background — the activation gate (`server/src/modules/listings/services/
 * listing-readiness.ts`) is the third consumer of the registry, after:
 *   - submit_listing tool (AI agent "ready for preview" check)
 *   - onboarding-validation.ts (FE form Submit check)
 *
 * Before this helper, listing-readiness re-implemented every shared
 * required-field rule by hand — which created drift bugs whenever a
 * rule changed in the registry but not in listing-readiness (or vice
 * versa). This helper closes that loop by producing the same wire
 * format listing-readiness already returns (`{code, label, message}`)
 * from a single rule walk over the registry.
 *
 * Activation-only rules (KYC, photo counts, room types, per-row
 * transportation-type base price, property_type, availability free
 * text, etc.) remain hand-rolled in listing-readiness — they have no
 * AI/form equivalent and don't belong in the shared registry.
 */
import { FIELD_REGISTRY } from './field-registry.js';
import { getMissingRequiredFields } from './derive-submit-gate.js';
import type { OnboardingProfileState } from '../types.js';

/** Mirror of `ReadinessMissing` in listing-readiness.ts — duplicated
 *  here as a structural type so this file doesn't import from the
 *  listings module (which would invert the dependency direction: chat
 *  → listings is fine, but the deriver should stay above the modules
 *  that consume it). */
export interface RegistryReadinessMissing {
  code: string;
  label: string;
  message: string;
}

/**
 * Convert a `listings` DB row (flat columns + a `metadata` JSON column)
 * into the flat `OnboardingProfileState` shape the registry expects.
 *
 * The conversion handles the column aliases the activation gate
 * tolerates today:
 *   - name        ← name || title
 *   - location    ← location || address || city || metadata.pickupArea || service_area
 *   - price       ← price || price_per_night (stringified)
 *   - bedrooms / bathrooms / max_guests come from top-level columns;
 *     everything else lives under `metadata`.
 *
 * Anything not in this mapping the registry will treat as undefined,
 * which is fine — the readiness wrapper still runs its own checks for
 * activation-only fields.
 */
export function listingRowToProfile(listing: Record<string, unknown>): OnboardingProfileState {
  const meta = (listing.metadata && typeof listing.metadata === 'object' && !Array.isArray(listing.metadata)
    ? listing.metadata as Record<string, unknown>
    : {});

  const pickFirstNonEmpty = (...candidates: unknown[]): string | undefined => {
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim().length > 0) return c;
    }
    return undefined;
  };

  const profile: OnboardingProfileState = {
    category: pickFirstNonEmpty(listing.category),
    name: pickFirstNonEmpty(listing.name, listing.title),
    // location accepts any of the activation gate's tolerated aliases;
    // the registry's `location` requirement is satisfied if ANY of them
    // resolves to a non-empty string.
    location: pickFirstNonEmpty(
      listing.location,
      listing.address,
      listing.city,
      meta.pickupArea,
      listing.service_area,
    ),
    description: pickFirstNonEmpty(listing.description),
    propertyType: pickFirstNonEmpty(listing.property_type, meta.propertyType),
    // Stay single-unit numeric fields live at the listing row level.
    bedrooms: toNumber(listing.bedrooms),
    bathrooms: toNumber(listing.bathrooms),
    maxGuests: toNumber(listing.max_guests),
    // Price: prefer the rupee-string `price`; fall back to the legacy
    // numeric `price_per_night` column, stringified so the registry's
    // string-typed `price` check works.
    price: pickFirstNonEmpty(
      listing.price,
      typeof listing.price_per_night === 'number' && listing.price_per_night > 0
        ? String(listing.price_per_night)
        : undefined,
    ),

    // Metadata-housed fields. Most are pass-through; types are loose
    // because metadata is unstructured JSON.
    experience: pickFirstNonEmpty(meta.experience),
    duration: pickFirstNonEmpty(meta.duration),
    pricingUnit: meta.pricingUnit as OnboardingProfileState['pricingUnit'],
    serviceModes: Array.isArray(meta.serviceModes)
      ? meta.serviceModes as OnboardingProfileState['serviceModes']
      : undefined,
    serviceRadius: toNumber(meta.serviceRadius),
    visitAddress: pickFirstNonEmpty(meta.visitAddress),
    meetingDetails: pickFirstNonEmpty(meta.meetingDetails),
    languages: Array.isArray(meta.languages) ? meta.languages as string[] : undefined,
    workingHours: meta.workingHours as OnboardingProfileState['workingHours'],
    transportMode: meta.transportMode as OnboardingProfileState['transportMode'],
    // Transport vehicle identity. Model prefers the `vehicle_name` column
    // (where the create/update path writes it) with a metadata fallback;
    // colour + plate live only in metadata. All three are required for
    // transport, so the activation gate reads them here.
    vehicleName: pickFirstNonEmpty(listing.vehicle_name, meta.vehicleName),
    vehicleColor: pickFirstNonEmpty(meta.vehicleColor),
    licensePlate: pickFirstNonEmpty(meta.licensePlate),
    // Legacy DB rows store these as raw numbers in jsonb; current AI /
    // form writes them as numeric strings. Stringify numbers so the
    // registry's string-typed price fields see a consistent shape.
    pricePerHour: typeof meta.pricePerHour === 'number'
      ? String(meta.pricePerHour)
      : pickFirstNonEmpty(meta.pricePerHour),
    pricePerDay: typeof meta.pricePerDay === 'number'
      ? String(meta.pricePerDay)
      : pickFirstNonEmpty(meta.pricePerDay),
    packageOptions: Array.isArray(meta.packageOptions)
      ? meta.packageOptions as OnboardingProfileState['packageOptions']
      : undefined,
    transportationTypes: Array.isArray(meta.transportationTypes)
      ? meta.transportationTypes as OnboardingProfileState['transportationTypes']
      : undefined,
    servicesCatalog: Array.isArray(meta.servicesCatalog)
      ? meta.servicesCatalog as OnboardingProfileState['servicesCatalog']
      : undefined,
    subcategory: pickFirstNonEmpty(meta.subcategory),
    subcategories: Array.isArray(meta.subcategories) ? meta.subcategories as string[] : undefined,
  };

  return profile;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Run the registry's required-field check against a listing row and
 * return the structured-error entries the activation gate uses.
 *
 * Fields without a `readinessCode` on their spec are SKIPPED — those
 * are typically AI/form-only rules (e.g. agent-side prompt hints) that
 * the activation gate doesn't enforce. The wrapper in
 * listing-readiness.ts then layers on activation-only rules that have
 * no registry equivalent (KYC, photos, room types, etc.).
 */
export function getReadinessMissingFromRegistry(
  listing: Record<string, unknown>,
): RegistryReadinessMissing[] {
  const profile = listingRowToProfile(listing);
  const missingNames = getMissingRequiredFields(FIELD_REGISTRY, profile);

  const out: RegistryReadinessMissing[] = [];
  for (const rawName of missingNames) {
    // Strip any "(reason)" or composite suffix the gate may append —
    // we only need the bare field name to look up its spec.
    const fieldName = rawName.replace(/\s*\(.*\)$|:.*$/g, '').trim();
    const spec = FIELD_REGISTRY[fieldName];
    if (!spec || !spec.readinessCode) continue;
    out.push({
      code: spec.readinessCode,
      label: spec.readinessLabel ?? spec.name,
      message: spec.readinessMessage ?? `Set ${spec.name}.`,
    });
  }
  return out;
}
