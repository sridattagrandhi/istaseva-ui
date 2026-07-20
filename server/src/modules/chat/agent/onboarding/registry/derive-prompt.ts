/**
 * Build the "fields you can extract" prompt section from FIELD_REGISTRY.
 *
 * STATUS — Phase B: written but NOT WIRED. The live SYSTEM_PROMPT in
 * onboarding-agent.service.ts contains ~500 lines of hand-tuned
 * behavioral guidance interleaved with field-specific rules
 * ("Stay categories: ALWAYS set category AND propertyType together",
 * the salon disambiguation paragraph, etc.). Auto-deriving that prose
 * is the riskiest step in the design doc — the model is prompt-
 * sensitive in ways our parity tests can't catch.
 *
 * Phase 2 plan: gradually peel the field-specific rules out of the
 * SYSTEM_PROMPT and into the registry's `description` / `examples` /
 * `extractionHint` / `disambiguationRules` slots, replacing the prose
 * block one field at a time. This helper is the target the migrations
 * pour into. Until then, the deriver is exported for tests and for
 * future use; the live agent still uses the hand-tuned prompt.
 */
import type { FieldRegistry, ListingType } from './field-registry.types.js';
import { fieldAppliesTo } from './derive-zod.js';

export function buildFieldPromptSection(
  registry: FieldRegistry,
  listingType?: ListingType,
): string {
  const blocks: string[] = [];
  for (const spec of Object.values(registry)) {
    if (listingType && spec.appliesTo !== 'all'
        && !fieldAppliesTo(spec.appliesTo, listingType)) continue;

    const scopeLabel = spec.appliesTo === 'all'
      ? 'all'
      : spec.appliesTo.join('/');
    const lines = [`### ${spec.name} (${scopeLabel})`, spec.description];

    if (spec.examples && spec.examples.length > 0) {
      lines.push('Examples:');
      for (const ex of spec.examples) lines.push(`  - ${ex}`);
    }
    if (spec.extractionHint) {
      lines.push(`EXTRACTION RULE: ${spec.extractionHint}`);
    }
    if (spec.disambiguationRules && spec.disambiguationRules.length > 0) {
      lines.push('DISAMBIGUATION:');
      for (const r of spec.disambiguationRules) lines.push(`  - ${r}`);
    }

    const requiredNotes: string[] = [];
    if (spec.requiredFor && spec.requiredFor.length > 0) {
      requiredNotes.push(`Required for: ${spec.requiredFor.join(', ')}`);
    }
    if (spec.requiredWhen) {
      requiredNotes.push('Conditionally required (see profile-aware predicate)');
    }
    if (requiredNotes.length > 0) lines.push(requiredNotes.join('. '));

    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}
