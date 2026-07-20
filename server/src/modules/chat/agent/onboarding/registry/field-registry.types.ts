/**
 * Schema-driven onboarding scaffold — shared types.
 *
 * The `FieldSpec` is the source of truth for one extractable field on an
 * onboarding profile. Three derivers consume the registry:
 *   - derive-zod.ts            → `ProfilePatch` zod schema used by extract_fields
 *   - derive-json-schema.ts    → `parametersJsonSchema` shown to Gemini
 *   - derive-submit-gate.ts    → "what's still missing?" check used by submit_listing
 *   - derive-prompt.ts (Phase B) → the "fields you can extract" prompt section
 *
 * Adding a field becomes one registry entry instead of edits across
 * extract-fields.tool.ts, submit-listing.tool.ts, the agent prompt, and
 * the FE form. The invariants test under __tests__/ enforces the
 * cross-field consistency rules (e.g. `requiredFor: ['service']` implies
 * `appliesTo` includes `'service'`).
 *
 * IMPORTANT — read CLAUDE.md before changing this file. Field NAMES are
 * load-bearing (`servicesCatalog`, `selectedServiceCatalogId`, ...). The
 * registry MUST preserve them exactly; do not rename.
 */
import type { z } from 'zod';
import type { OnboardingProfileState } from '../types.js';

/** The three listing categories the onboarding agent serves. */
export type ListingType = 'stay' | 'service' | 'transport';

/** Special marker meaning "this field is valid for every listing type". */
export type AppliesToAll = 'all';

/** A predicate over the in-progress profile — used by `requiredWhen` to
 *  express conditional requirements ("visitAddress is required IFF
 *  serviceModes includes 'visit-provider'"). Return `true` to mark the
 *  field required. The richer object form lets the gate render a more
 *  helpful "missing" message ("visitAddress (because serviceModes
 *  includes visit-provider)"). */
export type RequirementPredicate = (
  profile: OnboardingProfileState,
) => boolean | { required: true; reason: string };

/**
 * A rejected field VALUE — distinct from a "missing required field".
 *
 * `requiredFor`/`requiredWhen`/`isFilled` answer "is this field PRESENT?".
 * A `ValidationIssue` answers "is the value the user gave ACCEPTABLE?" —
 * the legal / safe / viable + India-location guardrails. When a value is
 * rejected at extract time it is NOT written to the profile (the field
 * stays blank, so the normal missing-field gate also fires) and the
 * `message` is what the agent re-asks the user with.
 */
export interface ValidationIssue {
  /** Field name the issue is about. */
  field: string;
  /** Stable machine code ('location_not_in_india', 'prohibited_content', …). */
  code: string;
  /** Human-readable reason the agent re-asks with / the form surfaces. */
  message: string;
}

/**
 * One field in the onboarding profile.
 *
 * `zodSchema` and `jsonSchema` MUST describe the same shape — the zod
 * one is for server-side validation of model-emitted args; the JSON
 * Schema is what we hand to Gemini's `functionDeclarations`. Keep them
 * in sync. The derive helpers do not cross-check (they trust the spec).
 */
export interface FieldSpec {
  /** The exact name of the field on `OnboardingProfileState`. Used as
   *  the key in the derived zod object, the derived JSON Schema's
   *  `properties`, and the submit-gate's "missing fields" output. */
  name: keyof OnboardingProfileState & string;

  /** Validation schema for this field's value. Made `.optional()` by the
   *  zod deriver — every field is optional on a patch (the model may
   *  send any subset). */
  zodSchema: z.ZodTypeAny;

  /** JSON-Schema fragment for `parametersJsonSchema`. Should NOT include
   *  the wrapping `{ type: 'object', properties: { ... } }` — only the
   *  per-property body (e.g. `{ type: 'string', description: '...' }`). */
  jsonSchema: Record<string, unknown>;

  /** Which listing types this field is meaningful for. `'all'` = always
   *  included in the prompt + schema. A typed array filters the field
   *  out of the prompt + JSON Schema for non-matching listing types
   *  (Phase B will start filtering once `category` is known). */
  appliesTo: ListingType[] | AppliesToAll;

  // ── Prompt-builder surface (Phase B) ──────────────────────────────────
  /** One-line description shown to the model. */
  description: string;
  /** Short "phrase → extracted value" examples. */
  examples?: string[];
  /** Imperative hint about HOW to extract ("Extract every X in ONE
   *  call"). The salon-bug-fix rules live here for `servicesCatalog`. */
  extractionHint?: string;
  /** Rules the model must follow when extraction is ambiguous. */
  disambiguationRules?: string[];

  // ── Submit-gate surface ────────────────────────────────────────────────
  /** Listing types where this field is ALWAYS required for submit. */
  requiredFor?: ListingType[];
  /** Predicate for conditional requirement (e.g. `serviceModes.includes('at-home')`).
   *  Evaluated only when the profile's listing type matches `appliesTo`. */
  requiredWhen?: RequirementPredicate;
  /** Custom non-emptiness check. Defaults to "is the value present and
   *  non-empty by JS truthiness/length". Override for fields like
   *  `servicesCatalog` where "present" means "≥1 valid group". */
  isFilled?: (value: unknown, profile: OnboardingProfileState) => boolean;
  /** When the registry can't express the validation (e.g. per-row
   *  catalog requirements for `transportationTypes`), the gate calls
   *  this and merges the returned strings into its "missing" list. */
  customGate?: (profile: OnboardingProfileState) => string[];

  // ── Value guardrails (used by extract_fields + the create gate) ───────
  /** Field-SPECIFIC value check, run at extract time on the (normalized)
   *  value before it's written. Return `[]` to accept, or one/more
   *  `ValidationIssue`s to reject — a rejected value is NOT persisted and
   *  the agent re-asks with the issue's `message`. This is for legal /
   *  safe / viable rules a particular field needs (e.g. `location` must
   *  resolve to a place in India). Blanket prohibited-content scanning of
   *  free-text values happens generically in extract_fields and does NOT
   *  need a per-field hook. May be async (e.g. a geocode round-trip). */
  validateValue?: (
    value: unknown,
    profile: OnboardingProfileState,
  ) => ValidationIssue[] | Promise<ValidationIssue[]>;

  // ── Extract-time normalization (used by extract_fields tool) ──────────
  /** Coerce / clean / dedupe / id-stamp the model-emitted value before
   *  it lands on the profile. Receives the raw value AS-PARSED by zod
   *  and returns the canonical form (or `undefined` to skip writing).
   *  Examples in this codebase: deduping `addOns` by case-insensitive
   *  label, stamping stable ids on `servicesCatalog` groups + nested
   *  add-ons so the booking modal / server validator can match by id. */
  normalize?: (value: unknown, profile: OnboardingProfileState) => unknown;
  /** When the model writes THIS field, also mirror a derived value to
   *  another field (e.g. `subcategories[0] → subcategory` to keep the
   *  legacy scalar reader working). Each mirror runs AFTER `normalize`
   *  and reads the post-normalization value. Skip the mirror by
   *  returning `undefined`. */
  mirrorTo?: Array<{
    field: keyof OnboardingProfileState & string;
    /** Derive the mirrored value from the source field's
     *  (normalized) value plus the current profile. Return `undefined`
     *  to leave the target untouched. */
    transform: (value: unknown, profile: OnboardingProfileState) => unknown;
  }>;

  // ── Activation-gate (listing-readiness.ts) surface ────────────────────
  // listing-readiness.ts produces a structured ReadinessMissing array
  // ({code, label, message}) so the dashboard can render specific fix-it
  // prompts. When this field's registry-derived requirement fires there,
  // these strings populate the entry. Only set on fields that are also
  // checked at activation time — pure-AI / pure-form fields can leave
  // them undefined and the readiness deriver will skip them.
  /** Activation-gate error code (e.g. 'experience_required'). Wire-format
   *  string the dashboard reads to pick the right fix-it call to action.
   *  KEEP STABLE — changing it breaks shipped dashboard error mappings. */
  readinessCode?: string;
  /** Short human-readable label for this field on the dashboard. */
  readinessLabel?: string;
  /** One-sentence "do this to fix it" message shown to the host/provider. */
  readinessMessage?: string;
}

/** Map of field name → spec. Order is preserved in the derived prompt
 *  and JSON Schema, so put core fields (category, name, location) first
 *  for readability. */
export type FieldRegistry = Record<string, FieldSpec>;
