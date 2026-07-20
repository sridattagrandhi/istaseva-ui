/**
 * Derive "what required fields are still missing?" from FIELD_REGISTRY.
 *
 * Phase B will swap this in for the hand-rolled REQUIRED_CORE +
 * missingModeFields() logic in submit-listing.tool.ts. The output
 * shape (an array of human-readable field-name strings) is
 * intentionally identical to the current `submit_listing` error
 * format so the error string the model sees doesn't change:
 *
 *     "Not ready: missing servicesCatalog, experience, languages"
 *
 * Logic order — matches submit-listing.tool.ts:
 *   1. If category isn't filled yet, no listing-type-specific check
 *      can run; return only the core misses.
 *   2. Otherwise, walk every registry field that `appliesTo` the
 *      inferred listing type. For each:
 *        - If `requiredFor` includes the type, OR `requiredWhen` is
 *          truthy on the current profile, check `isFilled` (or the
 *          default truthiness check).
 *        - Run any `customGate` regardless of required-ness — that's
 *          where extra rules like "duration <= 24 hours" or
 *          "transportationTypes[X] missing seatingCapacity" live.
 */
import type { FieldRegistry } from './field-registry.types.js';
import type { OnboardingProfileState } from '../types.js';
import { inferListingType } from './field-registry.js';
import { fieldAppliesTo } from './derive-zod.js';

/** Default emptiness check: present, non-empty by JS truthiness/length. */
function defaultIsFilled(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return !!v;
}

/**
 * Return the list of missing/invalid required fields. Empty array =
 * ready to submit. The returned strings are displayed verbatim to the
 * model in the submit-listing error message, so prefer "fieldName" or
 * "fieldName (because <reason>)" rather than long sentences.
 */
export function getMissingRequiredFields(
  registry: FieldRegistry,
  profile: OnboardingProfileState,
): string[] {
  const missing: string[] = [];
  const listingType = inferListingType(profile);

  for (const spec of Object.values(registry)) {
    // appliesTo gate — only consider fields meaningful for this listing.
    if (listingType && spec.appliesTo !== 'all'
        && !fieldAppliesTo(spec.appliesTo, listingType)) continue;
    // If listing type isn't known yet, we can only evaluate the
    // applies-to-all fields. Listing-type-specific fields are deferred
    // until category is set.
    if (!listingType && spec.appliesTo !== 'all') continue;

    // Determine required-ness on this profile.
    let required = false;
    if (spec.requiredFor) {
      if (listingType && spec.requiredFor.includes(listingType)) {
        required = true;
      } else if (!listingType
        && spec.appliesTo === 'all'
        && spec.requiredFor.length === 3) {
        // Listing type not yet inferable (category empty), but the field
        // is required across every listing type — treat as universally
        // required so `category` / `name` still surface as missing on a
        // bare-empty profile.
        required = true;
      }
    }
    if (!required && spec.requiredWhen) {
      const verdict = spec.requiredWhen(profile);
      if (verdict === true || (typeof verdict === 'object' && verdict?.required)) {
        required = true;
      }
    }

    if (required) {
      const isFilled = spec.isFilled ?? defaultIsFilled;
      if (!isFilled((profile as Record<string, unknown>)[spec.name], profile)) {
        missing.push(spec.name);
      }
    }

    // customGate runs regardless of required-ness. It's the escape
    // hatch for rules the registry shape can't express on its own
    // (per-row catalog checks, parseable-but-out-of-bounds values).
    if (spec.customGate) {
      const extra = spec.customGate(profile);
      for (const m of extra) {
        if (!missing.includes(m)) missing.push(m);
      }
    }
  }

  return missing;
}
