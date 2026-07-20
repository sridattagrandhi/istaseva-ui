import { z } from 'zod';
import type { ToolDefinition } from '../../types.js';
import type { OnboardingAgentContext, OnboardingProfileState } from '../types.js';
import type { ValidationIssue } from '../registry/field-registry.types.js';
import { FIELD_REGISTRY } from '../registry/field-registry.js';
import { deriveProfilePatchSchema } from '../registry/derive-zod.js';
import { deriveParametersJsonSchema } from '../registry/derive-json-schema.js';
import { getMissingRequiredFields } from '../registry/derive-submit-gate.js';
import { scanProhibitedContent } from '../../../../../common/guardrails/prohibited-content.js';

/**
 * The agent's primary mechanism for saving what it learned this turn.
 *
 * Whenever the user says something the agent can confidently parse
 * ("plumber in Hyderabad, 8 years experience, ₹500/visit"), the agent
 * calls extract_fields with whatever subset of the profile it could
 * fill. The tool merges into the per-turn profile state; the final
 * reply ships the merged state back to the client where it overwrites
 * local React state.
 *
 * Phase B: the per-field zod schema, the parametersJsonSchema, and the
 * per-field normalization (id-stamping, dedupe, legacy subcategory
 * mirror) are now derived from FIELD_REGISTRY. Adding a field becomes
 * one registry entry. See `agent/onboarding/registry/` for the spec.
 *
 * Why a tool instead of a JSON field on the final reply (legacy
 * `profile_updates`):
 *   - Multiple extracts per turn are natural ("oh wait, also veg-only,
 *     and Sundays off") — each becomes a tool call, the agent's own
 *     reasoning loop sees the merged state before composing its reply.
 *   - Server can validate / coerce per-field with zod, instead of
 *     trusting whatever string the model put in JSON.
 */
const ProfilePatch = deriveProfilePatchSchema(FIELD_REGISTRY);
type Args = z.infer<typeof ProfilePatch>;

interface Result {
  /** Merged profile so the agent's NEXT turn (or the final reply) sees
   *  everything that's known, not just this patch. */
  merged: Args;
  /** Echoed for telemetry / chip summaries. */
  applied: Args;
  /** The SAME registry gate submit_listing enforces, evaluated on the
   *  merged profile after this patch. Per-row catalog problems show up
   *  here the moment they're saved — e.g. "roomTypes[Single Room]:
   *  amenities (>=3)" right after a room is extracted with only 2 — so
   *  the agent can collect the gap in the very next question instead of
   *  discovering it at submit time (or never, and stranding the user at
   *  the form's validation wall). */
  outstanding: string[];
  /** Values REJECTED by a guardrail (legal / safe / India-location) and
   *  therefore NOT written — the field is still blank. The agent must
   *  re-ask using each `message`; it must NOT treat a rejected value as
   *  saved. Empty when everything passed. */
  rejected: ValidationIssue[];
}

const PARAMETERS_JSON_SCHEMA = deriveParametersJsonSchema(FIELD_REGISTRY);

export const extractFieldsTool: ToolDefinition<Args, Result> = {
  name: 'extract_fields',
  description:
    "Save EVERY field you can pick up from the user's recent messages. Be aggressive — extract everything that has real signal, not just the field you asked about. People share info mid-thought ('I'm a plumber in Hyderabad, 8 years, ₹500/visit') — capture all of it in one call. Loose phrasings count: 'around 500-700' → price='around ₹500-700', 'weekdays' → availability='weekdays', 'I cook biryani for parties' → category='cook' + subcategory='catering'. Skip fields you genuinely have no signal on; don't invent. Multiple calls per turn are fine. Returns the merged profile PLUS `outstanding` — the exact validation gate submit_listing will enforce. READ IT: if the field you just saved still appears there (e.g. \"roomTypes[Single Room]: amenities (>=3)\" after saving a room with 2 amenities), fix THAT before moving to a new topic. ALSO returns `rejected`: any value a guardrail refused (illegal/unsafe content, or a location outside India) was NOT saved — that field is still empty. Do NOT pretend it's saved; re-ask the user for a valid answer using the rejected `message`.",
  sideEffect: 'write',
  argsSchema: ProfilePatch,
  parametersJsonSchema: PARAMETERS_JSON_SCHEMA,

  async execute(args, ctx) {
    const onboardingCtx = ctx as OnboardingAgentContext;
    const profile = onboardingCtx.profile as Record<string, unknown>;

    // Phase B: registry-driven apply. For every key the model emitted,
    // look up the field spec, run its `normalize` if present, write
    // the result, then run any `mirrorTo` entries (e.g. subcategories
    // → subcategory legacy scalar). The fields the model didn't touch
    // this turn stay as-is — patches are ADDITIVE per turn, OVERWRITING
    // per key.
    //
    // Order matters: we normalize+write the primary value first, then
    // each mirrorTo reads the post-normalization value via the spec's
    // transform. Mirrors that return `undefined` leave the target
    // untouched (used by the subcategory-only patch path so we don't
    // clobber an existing multi-value subcategories array).
    const rejected: ValidationIssue[] = [];

    for (const [key, rawValue] of Object.entries(args)) {
      if (rawValue === undefined) continue;
      const spec = FIELD_REGISTRY[key];
      const value = spec?.normalize
        ? spec.normalize(rawValue, onboardingCtx.profile)
        : rawValue;
      if (value === undefined) continue;

      // Value guardrails run BEFORE the write, on the normalized value:
      //   1. blanket prohibited-content scan (legal/safe) over free text,
      //   2. the field's own validateValue (e.g. location must be in India).
      // A rejected value is NOT persisted — the field stays blank, so the
      // missing-required gate below also fires for required fields, and the
      // agent re-asks with the issue message. Both validators are
      // contracted to never throw (geocode catches internally; the scan is
      // a pure regex); keep that contract for any new validateValue.
      const issues = [
        ...scanProhibitedContent(key, value),
        ...(spec?.validateValue ? await spec.validateValue(value, onboardingCtx.profile) : []),
      ];
      if (issues.length > 0) {
        rejected.push(...issues);
        continue;
      }

      profile[key] = value;

      if (spec?.mirrorTo) {
        for (const mirror of spec.mirrorTo) {
          const mirrored = mirror.transform(value, onboardingCtx.profile);
          if (mirrored === undefined) continue;
          (profile as Record<string, unknown>)[mirror.field] = mirrored;
        }
      }
    }

    return {
      merged: { ...(onboardingCtx.profile as OnboardingProfileState) },
      applied: { ...args },
      outstanding: getMissingRequiredFields(FIELD_REGISTRY, onboardingCtx.profile),
      rejected,
    };
  },

  summarize(args, _result) {
    const keys = Object.keys(args);
    if (keys.length === 0) return 'No fields applied';
    if (keys.length <= 3) return `Saved ${keys.join(', ')}`;
    return `Saved ${keys.length} fields`;
  },
};
