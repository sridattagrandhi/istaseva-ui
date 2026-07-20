/**
 * Build the `ProfilePatch` zod schema from FIELD_REGISTRY.
 *
 * Every registry field becomes an OPTIONAL key on the patch (the model
 * may send any subset on a given turn — the loop merges the patch into
 * the running profile). Phase B will swap extract-fields.tool.ts's
 * hand-rolled `ProfilePatch` for this derived schema.
 */
import { z } from 'zod';
import type { FieldRegistry, ListingType } from './field-registry.types.js';

/** Derive the per-turn profile-patch zod schema.
 *
 *  @param registry The field registry to derive from.
 *  @param listingType Optional filter — when set, only fields whose
 *         `appliesTo` includes this type (or is 'all') are included.
 *         Useful once `category` is known and we want the model to see
 *         a narrower schema. Pass `undefined` (default) for the union
 *         schema covering every listing type. */
/**
 * Wrap a plain string field so the model may send a NUMBER for it. The model
 * routinely emits `pricePerHour: 10` / `experience: 5` (numbers) for
 * string-typed fields — which used to fail the WHOLE extract_fields call
 * ("expected string, received number") and lose every other field in the
 * same turn. Coerce number → string; leave every non-string schema untouched.
 */
function coerceNumberToString(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodString) {
    return z.preprocess((v) => (typeof v === 'number' ? String(v) : v), schema);
  }
  return schema;
}

export function deriveProfilePatchSchema(
  registry: FieldRegistry,
  listingType?: ListingType,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const spec of Object.values(registry)) {
    if (listingType && !fieldAppliesTo(spec.appliesTo, listingType)) continue;
    // `.optional()` — the model may send any subset of fields.
    // `.catch(undefined)` — a field that STILL fails validation after the
    // number→string coercion is DROPPED (becomes undefined) rather than
    // failing the entire patch. One bad value no longer discards the turn's
    // other good fields; the dropped field simply reappears in `outstanding`
    // and the agent re-asks for it.
    shape[spec.name] = coerceNumberToString(spec.zodSchema).optional().catch(undefined);
  }
  return z.object(shape);
}

export function fieldAppliesTo(
  appliesTo: ListingType[] | 'all',
  listingType: ListingType,
): boolean {
  if (appliesTo === 'all') return true;
  return appliesTo.includes(listingType);
}
