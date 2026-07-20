/**
 * Speculative-execution pre-classifier — Phase 5.
 *
 * The agent's most common first move is `search_listings(category,
 * location)`. From the user's plain text we can usually guess the right
 * args before the LLM finishes parsing — so we kick the search off in
 * parallel, attached to an AbortController. If the LLM's first tool
 * call agrees with our guess (within tolerance), we reuse the result;
 * if it doesn't, we abort and let the loop run normally.
 *
 * Hard rules:
 *   1. NO LLM calls in here — that defeats the purpose. Pure regex.
 *   2. Conservative — false positives waste a search; false negatives
 *      just lose us a perf win, never break correctness.
 *   3. Only fires for `search_listings`. The tool surface is small
 *      enough that adding more speculative paths can wait until we
 *      see real data on hit rates.
 */
import { searchListingsTool } from './tools/search-listings.tool.js';
import type { AgentTurnContext, ToolDefinition } from './types.js';
import { logger } from '../../../common/logging/logger.js';

interface SpeculativePrediction {
  category: 'stay' | 'service' | 'transport';
  location?: string;
  query?: string;
  maxPrice?: number;
  /** Transport-only: hourly/day/package. Predicted from phrases like
   *  "by the hour" / "day rental" / "tour package" so the speculative
   *  search applies the same hard mode filter the LLM would pass — without
   *  this, a "hourly driver" query specs a generic transport search and the
   *  daily/package-only drivers leak into the result set. */
  transportPricingMode?: 'hourly' | 'day' | 'package';
}

const STAY_KEYWORDS = /\b(hotel|homestay|stay|room|lodge|guesthouse|villa|resort|hostel|airbnb)\b/i;
const TRANSPORT_KEYWORDS = /\b(auto|cab|taxi|driver|ride|car\s*hire|rickshaw|tempo|van)\b/i;
const SERVICE_KEYWORDS = /\b(plumber|electrician|cook|cleaning|cleaner|carpenter|mechanic|tour\s*guide|photographer|helper|freelancer|chef|maid)\b/i;

// Common Indian city names. Not exhaustive — speculative path falls back
// to no-location when nothing matches, which still hits the search.
const CITY_RE = new RegExp(
  '\\b(' + [
    'Bangalore', 'Bengaluru', 'Mumbai', 'Delhi', 'Chennai', 'Hyderabad',
    'Kolkata', 'Pune', 'Ahmedabad', 'Jaipur', 'Lucknow', 'Kochi', 'Cochin',
    'Goa', 'Coorg', 'Mysore', 'Mysuru', 'Ooty', 'Munnar', 'Manali', 'Shimla',
    'Rishikesh', 'Varanasi', 'Udaipur', 'Jodhpur', 'Agra', 'Pondicherry',
    'Puducherry', 'Hampi', 'Hospet', 'Chikmagalur', 'Wayanad', 'Alleppey',
    'Alappuzha', 'Darjeeling', 'Gangtok', 'Nainital', 'Mussoorie',
    'Trivandrum', 'Thiruvananthapuram', 'Vizag', 'Visakhapatnam', 'Indore',
    'Bhopal', 'Chandigarh', 'Dehradun', 'Amritsar', 'Surat', 'Nagpur',
  ].join('|') + ')\\b',
  'i',
);

const PRICE_RE = /(?:under|below|less\s*than|upto|up\s*to|max(?:imum)?)\s*(?:₹|rs\.?|inr)?\s*(\d{1,2}(?:[,.]?\d{3})*)\s*(k|thousand|lakh)?/i;

/**
 * Classify the user's most recent message into a speculative
 * search_listings call. Returns null when the heuristics aren't
 * confident enough — the loop then runs without speculation.
 */
export function predictSearchArgs(userText: string): SpeculativePrediction | null {
  const text = userText.trim();
  if (!text || text.length < 4) return null;

  // Pick category from keywords. Order matters: transport is the most
  // ambiguous (e.g. "driver" can also mean a service category), so test
  // it last after stay + service.
  let category: SpeculativePrediction['category'] | null = null;
  if (STAY_KEYWORDS.test(text)) category = 'stay';
  else if (SERVICE_KEYWORDS.test(text)) category = 'service';
  else if (TRANSPORT_KEYWORDS.test(text)) category = 'transport';
  if (!category) return null;

  const cityMatch = text.match(CITY_RE);
  const location = cityMatch ? cityMatch[1] : undefined;

  let maxPrice: number | undefined;
  const priceMatch = text.match(PRICE_RE);
  if (priceMatch) {
    const num = parseInt(priceMatch[1].replace(/[,.]/g, ''), 10);
    if (Number.isFinite(num) && num > 0) {
      const unit = priceMatch[2]?.toLowerCase();
      if (unit === 'k' || unit === 'thousand') maxPrice = num * 1000;
      else if (unit === 'lakh') maxPrice = num * 100_000;
      else maxPrice = num;
    }
  }

  // Transport-only pricing mode. Only set for category='transport' so
  // service/stay searches stay unaffected. Match order matters: "tour
  // package" / "by the day" need to be checked before bare "hour" /
  // "day" to avoid e.g. "8-day tour package" being miscategorised as day.
  let transportPricingMode: SpeculativePrediction['transportPricingMode'];
  if (category === 'transport') {
    if (/\b(tour\s*package|package\s*tour|package\b)/i.test(text)) transportPricingMode = 'package';
    else if (/\b(by\s*the\s*day|per\s*day|day\s*rental|daily)\b/i.test(text)) transportPricingMode = 'day';
    else if (/\b(by\s*the\s*hour|per\s*hour|hourly|hour\s*rental)\b/i.test(text)) transportPricingMode = 'hourly';
  }

  return { category, location, query: undefined, maxPrice, transportPricingMode };
}

/**
 * Are two arg sets close enough to reuse the speculative result?
 *
 * Tolerance:
 *   - category MUST match exactly. A stay search isn't useful for
 *     a service query.
 *   - location compared case-insensitive with whitespace stripped.
 *     A null vs "Bangalore" mismatch is a real divergence — abort.
 *   - maxPrice within ±10% counts as a match (model rounds "4k" to
 *     "4000" or "5000" routinely).
 *   - query: if either side is missing, that's fine; if both present,
 *     they should share at least one word.
 */
export function argsMatch(predicted: SpeculativePrediction, actual: Record<string, unknown>): boolean {
  if (predicted.category !== actual.category) return false;

  const pLoc = predicted.location?.toLowerCase().replace(/\s+/g, '') ?? '';
  const aLoc = typeof actual.location === 'string' ? actual.location.toLowerCase().replace(/\s+/g, '') : '';
  if (pLoc !== aLoc) return false;

  if (predicted.maxPrice && typeof actual.maxPrice === 'number') {
    const tol = Math.max(predicted.maxPrice, actual.maxPrice) * 0.1;
    if (Math.abs(predicted.maxPrice - actual.maxPrice) > tol) return false;
  }

  // transportPricingMode is a HARD filter — predicting wrong (or missing)
  // gives a stale, unfiltered result and the daily/package drivers leak
  // through. Treat any divergence as a miss so the loop re-runs the
  // search with the LLM's correct args.
  const pMode = predicted.transportPricingMode;
  const aMode = typeof actual.transportPricingMode === 'string' ? actual.transportPricingMode : undefined;
  if (pMode !== aMode) return false;

  return true;
}

/**
 * Kick off the speculative search in the background. Returns a handle
 * the loop can either harvest (on arg match) or abort (on mismatch /
 * loop completion). Reads through the same tool's `execute` so the
 * grounding cache (Phase 4) sees the same data either way.
 */
export interface SpeculativeHandle {
  prediction: SpeculativePrediction;
  promise: Promise<unknown>;
  abort: AbortController;
}

export function startSpeculativeSearch(
  prediction: SpeculativePrediction,
  ctx: AgentTurnContext,
): SpeculativeHandle {
  const abort = new AbortController();

  // Build a child context that shares everything with the loop's ctx
  // EXCEPT abort — we want our local controller so cancelling the
  // speculation doesn't kill the loop. The shared toolResultCache /
  // realtime emit are inherited, which is the point.
  const speculativeCtx: AgentTurnContext = {
    ...ctx,
    abortSignal: abort.signal,
  };

  const promise = (searchListingsTool as unknown as ToolDefinition)
    .execute(prediction as unknown as Record<string, unknown>, speculativeCtx)
    .catch((err) => {
      // Aborted speculations end up here — silent. Log unexpected ones
      // at debug; the loop will just run the search itself.
      logger.debug('speculative: search failed', {
        requestId: ctx.requestId,
        error: (err as Error).message,
      });
      return null;
    });

  return { prediction, promise, abort };
}
