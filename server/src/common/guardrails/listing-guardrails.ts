/**
 * Listing-level legal / safe / viable guardrails — the SERVER chokepoint
 * that both onboarding paths converge on.
 *
 * Two tiers:
 *   1. Deterministic (cheap, no LLM): blanket prohibited-content scan over
 *      every free-text field + an India-only check on the location.
 *   2. Semantic (one LLM call): is each value a REAL, coherent instance of
 *      what its field should hold — catches "Toyota Spaceship 9000" as a
 *      vehicle model, a nonsense category, a description that describes
 *      nothing. FAIL-OPEN: a missing/garbled/unavailable LLM verdict (incl.
 *      the dev mock provider) never blocks — the deterministic tier is the
 *      hard floor.
 *
 * Call sites:
 *   - listings.service.create()      → runListingGuardrails(payload, {semantic:true})
 *   - submit_listing.tool (onboarding) → checkViability(summaryFromOnboardingProfile)
 *     for an in-conversation catch before the user reaches the review.
 *
 * Never throws — failures degrade to "no issues found" so a transient
 * geocode/LLM hiccup can't wall off a legitimate host. Callers decide how
 * to surface a non-empty issue list.
 */
import { logger } from '../logging/logger.js';
import { getLlmProvider } from '../providers/registry.js';
import { verifyIndiaLocation } from '../services/geocode.service.js';
import { scanProhibitedContent, type GuardrailIssue } from './prohibited-content.js';
import { scanAddressInProse } from './address-in-prose.js';

export type { GuardrailIssue } from './prohibited-content.js';

// ── Text collection ────────────────────────────────────────────────────────

/** One scannable free-text field pulled out of a listing payload. */
type ScannableText = { field: string; value: string | string[] };

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/** Collect the free-text fields worth scanning from a snake_case listing
 *  payload (the shape POST /api/listings receives), including the nested
 *  `metadata` catalog rows. Absent fields are simply skipped. */
function collectScannableTexts(payload: Record<string, unknown>): ScannableText[] {
  const out: ScannableText[] = [];
  const push = (field: string, v: unknown) => {
    const s = asString(v);
    if (s) out.push({ field, value: s });
  };
  push('name', payload.name ?? payload.title);
  push('description', payload.description);
  push('location', payload.location);
  push('address', payload.address);
  push('city', payload.city);
  push('state', payload.state);
  push('service_area', payload.service_area);
  push('vehicle_name', payload.vehicle_name);
  push('category', payload.category);

  const meta = (payload.metadata && typeof payload.metadata === 'object'
    ? payload.metadata : {}) as Record<string, unknown>;
  push('visitAddress', meta.visitAddress);
  push('meetingDetails', meta.meetingDetails);
  push('serviceArea', meta.serviceArea);

  const collectNames = (rows: unknown, key: string, field: string) => {
    if (!Array.isArray(rows)) return;
    const names = rows
      .map((r) => (r && typeof r === 'object' ? asString((r as Record<string, unknown>)[key]) : null))
      .filter((s): s is string => !!s);
    if (names.length > 0) out.push({ field, value: names });
  };
  collectNames(meta.servicesCatalog, 'name', 'servicesCatalog');
  collectNames(meta.roomTypes, 'name', 'roomTypes');
  collectNames(meta.packageOptions, 'label', 'packageOptions');
  collectNames(meta.transportationTypes, 'displayName', 'transportationTypes');

  if (Array.isArray(meta.subcategories)) out.push({ field: 'subcategories', value: (meta.subcategories as unknown[]).filter((x): x is string => typeof x === 'string') });
  if (Array.isArray(meta.amenities)) out.push({ field: 'amenities', value: (meta.amenities as unknown[]).filter((x): x is string => typeof x === 'string') });

  return out;
}

// ── Deterministic tier ───────────────────────────────────────────────────────

/** Prohibited-content scan over all free-text + India-only location check. */
export async function runDeterministicListingGuardrails(
  payload: Record<string, unknown>,
): Promise<GuardrailIssue[]> {
  const issues: GuardrailIssue[] = [];
  for (const { field, value } of collectScannableTexts(payload)) {
    issues.push(...scanProhibitedContent(field, value));
  }

  // WARN-ONLY: a street address typed into the public prose fields (the
  // structured location/address fields legitimately hold addresses and are
  // masked on public reads; the prose is not).
  issues.push(...scanAddressInProse('name', payload.name ?? payload.title));
  issues.push(...scanAddressInProse('description', payload.description));

  // India-only: hard-reject a CONFIRMED non-India location. An unresolved
  // string is left to the semantic tier rather than false-rejecting a
  // tier-3 Indian address the geocoder doesn't index (see geocode.service).
  const location = asString(payload.location);
  if (location) {
    const v = await verifyIndiaLocation(location);
    if (v.resolved && !v.inIndia) {
      issues.push({
        field: 'location',
        code: 'location_not_in_india',
        message: `The location looks like it's in ${v.country ?? 'another country'}. IstaSeva only operates in India — please use a location inside India.`,
      });
    }
  }
  return issues;
}

// ── Semantic tier ────────────────────────────────────────────────────────────

const VIABILITY_SYSTEM_PROMPT = `You review provider listings for an India-only services/stays/transport marketplace (IstaSeva).
For the JSON of listing fields you are given, flag ONLY fields whose value is clearly:
 - illegal or unsafe (weapons, drugs, sexual services, violence, anything criminal), OR
 - not a REAL, coherent instance of what the field should contain (e.g. a "vehicleName" that is not a real vehicle make+model like "Toyota with a gun" or "Spaceship 9000"; a "category" that is gibberish; a "description" that describes nothing real).
Do NOT flag a field for being empty, short, vague, or merely incomplete — that is handled elsewhere. When in doubt, do NOT flag it.
Respond ONLY with JSON: {"ok": boolean, "issues": [{"field": string, "reason": string}]}. "ok" is true when there is nothing to flag. "reason" is a short, friendly sentence telling the provider what to fix.`;

/** A normalized field→value map handed to the semantic reviewer. */
export type ViabilitySummary = Record<string, unknown>;

/**
 * Semantic legal/safe/viable check. Returns issues (code 'not_viable') or
 * `[]`. FAIL-OPEN on any non-negative or unparsable verdict — the dev mock
 * provider (which returns an unrelated object) and any LLM error both
 * resolve to "no issues", leaving the deterministic tier as the hard floor.
 */
export async function checkViability(summary: ViabilitySummary): Promise<GuardrailIssue[]> {
  // Nothing meaningful to judge → skip the call.
  const hasContent = Object.values(summary).some((v) =>
    (typeof v === 'string' && v.trim().length > 0) || (Array.isArray(v) && v.length > 0));
  if (!hasContent) return [];

  let raw: Record<string, unknown>;
  try {
    const llm = await getLlmProvider();
    raw = await llm.generateStructuredJson({
      systemPrompt: VIABILITY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(summary) }],
      temperature: 0,
      maxTokens: 600,
    });
  } catch (error) {
    logger.warn('checkViability: LLM call failed, failing open', { err: String(error) });
    return [];
  }

  // Fail-open: only act on an explicit negative verdict carrying issues.
  if (!raw || typeof raw !== 'object' || raw.ok !== false) return [];
  const rawIssues = Array.isArray(raw.issues) ? raw.issues : [];
  const issues: GuardrailIssue[] = [];
  for (const it of rawIssues) {
    if (!it || typeof it !== 'object') continue;
    const field = asString((it as Record<string, unknown>).field) ?? 'listing';
    const reason = asString((it as Record<string, unknown>).reason);
    if (!reason) continue;
    issues.push({ field, code: 'not_viable', message: reason });
  }
  return issues;
}

/** Build the semantic summary from a snake_case listing payload. */
export function summaryFromListingPayload(payload: Record<string, unknown>): ViabilitySummary {
  const meta = (payload.metadata && typeof payload.metadata === 'object'
    ? payload.metadata : {}) as Record<string, unknown>;
  return {
    listing_type: payload.listing_type ?? meta.listingType,
    category: payload.category,
    name: payload.name ?? payload.title,
    description: payload.description,
    location: payload.location,
    vehicle_name: payload.vehicle_name ?? meta.vehicleName,
    services: Array.isArray(meta.servicesCatalog)
      ? (meta.servicesCatalog as Array<Record<string, unknown>>).map((s) => s?.name).filter(Boolean)
      : undefined,
  };
}

/** Build the semantic summary from the camelCase onboarding profile. */
export function summaryFromOnboardingProfile(profile: Record<string, unknown>): ViabilitySummary {
  return {
    category: profile.category,
    name: profile.name,
    description: profile.description,
    location: profile.location,
    vehicle_name: profile.vehicleName,
    services: Array.isArray(profile.servicesCatalog)
      ? (profile.servicesCatalog as Array<Record<string, unknown>>).map((s) => s?.name).filter(Boolean)
      : undefined,
  };
}

// ── Orchestration + formatting ───────────────────────────────────────────────

/**
 * Full guardrail pass for the create gate. Runs the deterministic tier
 * first; only runs the (LLM) semantic tier when `semantic` is set AND the
 * deterministic tier is clean — a value already rejected for prohibited
 * content / non-India location doesn't need a second opinion.
 */
export async function runListingGuardrails(
  payload: Record<string, unknown>,
  opts: { semantic: boolean } = { semantic: false },
): Promise<GuardrailIssue[]> {
  const deterministic = await runDeterministicListingGuardrails(payload);
  // Warnings must not short-circuit the semantic tier — only a BLOCKING
  // deterministic hit makes the LLM call pointless.
  const blocking = deterministic.filter((i) => i.severity !== 'warn');
  if (blocking.length > 0 || !opts.semantic) return deterministic;
  const warnings = deterministic.filter((i) => i.severity === 'warn');
  return [...warnings, ...await checkViability(summaryFromListingPayload(payload))];
}

/** Join issue messages into one user-facing error string. */
export function formatGuardrailIssues(issues: GuardrailIssue[]): string {
  return issues.map((i) => i.message).join(' ');
}
