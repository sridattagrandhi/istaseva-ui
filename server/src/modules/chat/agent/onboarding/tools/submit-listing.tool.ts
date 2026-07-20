import { z } from 'zod';
import type { ToolDefinition } from '../../types.js';
import type { OnboardingAgentContext } from '../types.js';
import { FIELD_REGISTRY } from '../registry/field-registry.js';
import { getMissingRequiredFields } from '../registry/derive-submit-gate.js';
import { checkViability, summaryFromOnboardingProfile } from '../../../../../common/guardrails/listing-guardrails.js';

/**
 * Signals "I have enough — show the preview". The actual listing
 * creation stays client-side because (a) photos are uploaded directly
 * to S3 from the browser, (b) hotel listings spawn a room-types step
 * after, and (c) KYC follows. The agent decides WHEN we're ready, not
 * HOW the row gets written.
 *
 * On the client side, the final reply with `finished: true` triggers
 * the existing OnboardingPreview overlay; the user reviews, edits if
 * needed, and taps publish.
 *
 * Phase B note: the previously hand-rolled `missingModeFields()` +
 * `REQUIRED_CORE` filter have moved into the field registry (one
 * `requiredFor` / `requiredWhen` / `customGate` per field). The error
 * shape the model sees is unchanged — a sorted list of missing field
 * names joined into the same "Not ready: missing X, Y, Z" string —
 * so the agent's recovery loop is not affected. See
 * `registry/__tests__/derive-submit-gate.test.ts` for parity coverage.
 */
const ArgsSchema = z.object({
  /** Optional one-line summary the agent wants the UI to surface above
   *  the preview — adds context to a long form. */
  note: z.string().max(200).optional(),
});
type Args = z.infer<typeof ArgsSchema>;

interface Result {
  ready: true;
  /** Echoed for telemetry — the loop reads this to mark the turn done. */
  fieldsCovered: number;
}

export const submitListingTool: ToolDefinition<Args, Result> = {
  name: 'submit_listing',
  description:
    "Mark the listing as ready for the user to preview + submit. Call this ONLY when the manual-onboarding required fields are filled with real content: category, name, location, and the category-specific required fields. The UI will verify the same rules, route the user to finish anything missing, then show a review overlay. DO NOT call this prematurely — half-filled listings are the #1 onboarding drop-off.",
  sideEffect: 'write',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      note: { type: 'string' },
    },
  },

  async execute(_args, ctx) {
    const onboardingCtx = ctx as OnboardingAgentContext;

    // Single registry-derived gate. Replaces the prior REQUIRED_CORE
    // sequence + missingModeFields() per-listing-type branching: the
    // field registry now expresses every requirement (universal,
    // category-conditional, and serviceModes/transportMode-conditional)
    // alongside its own zod + JSON Schema, so adding a new required
    // field touches exactly one place.
    const missing = getMissingRequiredFields(FIELD_REGISTRY, onboardingCtx.profile);
    if (missing.length > 0) {
      throw new Error(`Not ready: missing ${missing.join(', ')}`);
    }

    // Semantic legal/safe/viable catch, in-conversation — so the user fixes
    // a non-viable value (e.g. a vehicle "model" that isn't a real vehicle)
    // here rather than hitting the create-gate error at the review. Mirrors
    // the same checkViability the create gate runs; fails open (no-op under
    // the dev mock LLM), so it only ever blocks on a clear negative verdict.
    const viability = await checkViability(
      summaryFromOnboardingProfile(onboardingCtx.profile as Record<string, unknown>),
    );
    if (viability.length > 0) {
      throw new Error(`Not ready: ${viability.map((v) => v.message).join(' ')}`);
    }

    // Use the marker the agent loop's final-reply assembly checks.
    // We don't have a real listingId yet — the client creates the row
    // post-preview — so this is the turn-marker, not a row id.
    onboardingCtx.createdListingId = '__pending_preview__';

    const fieldsCovered = Object.values(onboardingCtx.profile).filter((v) => {
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === 'number') return v > 0;
      return typeof v === 'string' && v.length > 0;
    }).length;

    return { ready: true, fieldsCovered };
  },

  summarize(_args, result) {
    return `Ready for preview (${result.fieldsCovered} fields)`;
  },
};
