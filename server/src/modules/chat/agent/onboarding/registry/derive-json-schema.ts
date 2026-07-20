/**
 * Build the `parametersJsonSchema` for Gemini's functionDeclarations
 * from FIELD_REGISTRY.
 *
 * Mirrors the shape currently hand-written in extract-fields.tool.ts:
 *   { type: 'object', properties: { <field>: <jsonSchema>, ... } }
 *
 * Each field's body comes verbatim from its `jsonSchema` spec; per-field
 * descriptions are augmented with the spec's `description` (and any
 * extractionHint) so the model sees the same guidance the prompt
 * builder will eventually emit, without us having to repeat it.
 */
import type { FieldRegistry, ListingType } from './field-registry.types.js';
import { fieldAppliesTo } from './derive-zod.js';

export function deriveParametersJsonSchema(
  registry: FieldRegistry,
  listingType?: ListingType,
): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const spec of Object.values(registry)) {
    if (listingType && !fieldAppliesTo(spec.appliesTo, listingType)) continue;

    // Stitch the registry's free-text description onto whatever the
    // jsonSchema body already says. If the spec's jsonSchema includes
    // its own `description`, the registry-level prose wins (it's the
    // human-curated one); the schema-level description becomes a
    // suffix if present, otherwise we keep just the registry text.
    const body: Record<string, unknown> = { ...spec.jsonSchema };
    const schemaDesc = typeof body.description === 'string' ? body.description : '';
    const parts = [spec.description, schemaDesc].filter((s) => s && s.length > 0);
    body.description = parts.join(' — ');

    properties[spec.name] = body;
  }
  return { type: 'object', properties };
}
