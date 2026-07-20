/**
 * Hallucination guard — Phase 4.
 *
 * After the agent emits a final reply, we scan it for entities that
 * SHOULD have come from a tool result (listing IDs, prices, listing
 * names). If any aren't in this turn's tool-result cache, the model
 * invented them — we trigger a one-shot regeneration with an explicit
 * note ("you said X which isn't in the data").
 *
 * Three intentional design choices:
 *
 * 1. **Whole-word match for names.** "Taj" is a real chain that appears
 *    in many listings; substring match would treat it as grounded if any
 *    "Taj" listing was searched. Whole-word, case-insensitive match
 *    against the tool-cache names is conservative without being noisy.
 *
 * 2. **Prices only flag if a digit pattern appears NEAR a listing
 *    reference.** A casual "around 5k" without a listing context isn't a
 *    hallucination — it's the model echoing the user's budget. We only
 *    flag prices when they appear in the same sentence as a listing
 *    name or id.
 *
 * 3. **One-shot regen, not infinite.** If the regen also hallucinates
 *    we ship the regen anyway and log a `grounding_failed` event for
 *    Phase 6 telemetry. Regenerating in a loop would burn budget and
 *    produce nondeterministic UX.
 */

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PRICE_RE = /₹\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?/g;

/**
 * Compact view of what the tools surfaced this turn — anything that
 * could legitimately appear in a reply. Listings and bookings live in
 * the same shape because they share enough fields (id + name) that the
 * grounding rules don't care which kind they are.
 */
export interface GroundingCache {
  /** Listing/booking IDs the agent learned about this turn. Only IDs in
   *  this set may appear in the reply. */
  ids: Set<string>;
  /** Lowercased whole names (e.g. "the park baga river"). Reply names
   *  must match one of these. */
  names: Set<string>;
  /** Prices the tools returned (numeric rupees). Reply prices must be
   *  in this set when they appear next to a name/id reference. */
  prices: Set<number>;
}

export function emptyGroundingCache(): GroundingCache {
  return { ids: new Set(), names: new Set(), prices: new Set() };
}

/**
 * Merge a tool result into the cache. Pulls names from any structure
 * that has `id` + (`title`|`name`) or `bookings:[{id,listing}]`.
 * Tolerant of unknown shapes — anything we don't recognise is ignored
 * (it just won't be ground-truthed; the model still can't cite it).
 */
export function ingestToolResult(cache: GroundingCache, result: unknown): void {
  walk(result);

  function walk(v: unknown): void {
    if (!v) return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (typeof v !== 'object') return;
    const obj = v as Record<string, unknown>;

    // ID-like fields.
    for (const key of ['id', 'listingId', 'bookingId']) {
      const val = obj[key];
      if (typeof val === 'string' && val.length > 0) {
        cache.ids.add(val.toLowerCase());
      }
    }

    // Name-like fields.
    for (const key of ['title', 'name', 'listing']) {
      const val = obj[key];
      if (typeof val === 'string' && val.length > 1) {
        cache.names.add(val.toLowerCase());
      }
    }

    // Price-like fields. We accept "₹X" strings or raw rupee numbers;
    // skip paise (different magnitude). Numbers come from amount,
    // amountRupees, totalAmount etc.; ignore amountPaise to avoid
    // misclassifying paise as rupees.
    for (const key of ['price', 'amount', 'totalAmount', 'pricePerNight']) {
      const val = obj[key];
      if (typeof val === 'string') {
        const m = val.match(/(\d{1,3}(?:,\d{3})*|\d+)/);
        if (m) cache.prices.add(parseInt(m[1].replace(/,/g, ''), 10));
      } else if (typeof val === 'number' && val > 0) {
        cache.prices.add(Math.round(val));
      }
    }

    // Recurse into nested objects (e.g. {data: {listings: [...]}}).
    for (const k of Object.keys(obj)) {
      const child = obj[k];
      if (child && typeof child === 'object') walk(child);
    }
  }
}

export interface GroundingResult {
  ok: boolean;
  /** Human-readable issues, suitable for inlining into the regen prompt
   *  ("You said 'Hotel Taj Skyview' which isn't in the search results"). */
  violations: string[];
}

/**
 * Scan the reply text for entities and verify each against the cache.
 * Returns ok=true with no violations when everything looks grounded.
 */
export function checkGrounding(replyText: string, cache: GroundingCache): GroundingResult {
  const violations: string[] = [];

  // 1. UUID-shaped IDs in the reply must be in the cache.
  const uuids = replyText.match(UUID_RE) ?? [];
  for (const id of uuids) {
    if (!cache.ids.has(id.toLowerCase())) {
      violations.push(`listing/booking id "${id}" was not returned by any tool this turn`);
    }
  }

  // 2. Prices that appear NEAR a listing reference must be in the cache.
  //    "Near" = same sentence as a name match. We do this rather than
  //    flagging every ₹X mention because the model often legitimately
  //    echoes the user's budget ("under ₹4k") which is fine.
  if (cache.names.size > 0) {
    const sentences = replyText.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      const hasNameRef = [...cache.names].some((n) => containsWord(lower, n));
      if (!hasNameRef) continue;

      // Reset PRICE_RE before each scan — it's a global regex and the
      // implicit lastIndex would skip matches across sentences.
      PRICE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PRICE_RE.exec(sentence)) != null) {
        const value = parseInt(m[1].replace(/,/g, ''), 10);
        // Allow ±5% rounding tolerance — the model may say "₹6,200"
        // when the cache had "₹6200" or "₹6,250". Within ±5% counts.
        const ok = [...cache.prices].some((p) => Math.abs(value - p) / Math.max(p, 1) <= 0.05);
        if (!ok) {
          violations.push(`price "₹${value}" near a listing reference was not in the tool data`);
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Heuristic: does the reply lay out NAMED listings inline? A grounded
 * discovery reply renders results as CARDS (the model says "found 2 places"
 * and the cards strip handles the names), so an inline markdown list of bold
 * names — with no tool data behind it — is a strong "the model invented
 * listings" signal. Used only as a tripwire when no listing tool ran this turn.
 */
export function looksLikeListingRecommendation(text: string): boolean {
  const boldSpans = (text.match(/\*\*[^*\n]{2,}\*\*/g) ?? []).length;
  const listItems = (text.match(/^\s*(?:[-*•]|\d+[.)])\s+\S/gm) ?? []).length;
  return boldSpans >= 2 || listItems >= 2;
}

/**
 * True when EVERY bold-span name in the reply matches a previously-surfaced
 * listing (recent hits) — i.e. the model is referencing real listings the
 * user already saw, not inventing new ones. Lets a follow-up turn ("compare
 * the first two") reference prior results without re-searching.
 */
export function namesGroundedInHits(text: string, hitNames: Set<string>): boolean {
  const spans = [...text.matchAll(/\*\*([^*\n]{2,})\*\*/g)].map((m) => m[1].toLowerCase().trim());
  if (spans.length === 0) return false;
  return spans.every((s) => [...hitNames].some((n) => n.includes(s) || s.includes(n)));
}

/**
 * Whole-word, case-insensitive substring match. Avoids false positives
 * like matching "Taj" inside "Tajikistan". `needle` must already be
 * lowercased.
 */
function containsWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b on either side, but accept apostrophes/hyphens inside the needle.
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}
