import { z } from 'zod';
import { listingsService } from '../../../listings/services/listings.service.js';
import { searchService } from '../../../search/services/search.service.js';
import { getLlmProvider } from '../../../../common/providers/registry.js';
import { logger } from '../../../../common/logging/logger.js';
import { recordRecentHits } from '../recent-hits.js';
import { checkListingAvailability, checkListingWindowAvailability } from './check-availability.tool.js';
import type { ToolDefinition } from '../types.js';

/**
 * Two-stage search: cheap pre-filter pulls a wide candidate set, then an LLM
 * reranks for genuine intent match.
 *
 * Why this shape:
 *   - Lexical search (tsquery + ILIKE) misses synonyms — "tuition" doesn't
 *     match "tutor", "deep clean" doesn't match "housekeeping". The model
 *     handles those gaps natively.
 *   - LLM-only "read the whole catalog" works at IstaSeva's current scale
 *     (<50 listings) but doesn't scale — adding a pre-filter NOW means we
 *     just tune the candidate cap as the catalog grows; the agent contract
 *     and rerank prompt stay the same.
 *   - The previous implementation fell back to listPublic on zero hits and
 *     presented every active listing as if it matched the query (e.g. a
 *     salon + cleaning service shown as "options for maths tuition"). That
 *     fallback is deleted — the rerank decides honestly, returning an empty
 *     array when nothing fits.
 *
 * Cap stays at 5 returned hits — the agent ranks + converses, not paginates.
 */
const ArgsSchema = z.object({
  category: z
    .enum(['stay', 'service', 'transport'])
    .describe('Listing type to search within'),
  query: z
    .string()
    .max(120)
    .optional()
    .describe('Free-text search query (e.g. "vegetarian cook", "near airport"). Omit for category-only browse.'),
  location: z
    .string()
    .max(80)
    .optional()
    .describe('City or area name. Used as a filter; combine with query for best match.'),
  maxPrice: z
    .number()
    .int()
    .positive()
    .max(10_000_000)
    .optional()
    .describe('Maximum price in INR (whole rupees, not paise).'),
  transportPricingMode: z
    .enum(['hourly', 'day', 'package'])
    .optional()
    .describe('Transport only. Constrain results to drivers/vehicles that actually price by this mode (hourly / day / package). Use when the user names the mode ("hourly driver", "day rental", "tour package") OR implies it: a time range ("2pm to 5pm") or duration ("for 3 hours") implies hourly; "for the day" or a multi-day span implies day; a named tour implies package. Listings without the requested mode are filtered out before ranking.'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('YYYY-MM-DD. Pass whenever the user has named or implied a concrete date (resolve relative references like "tomorrow" / "the 15th" first using Today (IST)). Results are then availability-checked server-side: listings blocked or fully booked on this date are DROPPED before you see them, and `unavailableDroppedCount` tells you how many were hidden.'),
  checkOutDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Stays only — check-out date YYYY-MM-DD when the user named a range. The availability gate then checks every night in [date, checkOutDate).'),
  startTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional()
    .describe('Services/transport only — HH:MM. Pass with `date` AND `endTime` whenever the user named a time window ("2pm to 5pm" → startTime "14:00", endTime "17:00"). The gate then checks the EXACT window and DROPS listings already booked for it — so a driver booked 9 AM–5 PM never appears for a 2–5 PM search. Without it, a partly-booked day can only be flagged "unknown".'),
  endTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional()
    .describe('Services/transport only — HH:MM end of the requested window. Pass alongside startTime.'),
});
type Args = z.infer<typeof ArgsSchema>;

interface SearchHit {
  id: string;
  title: string;
  type: string;
  location?: string;
  price?: string;
  rating?: number;
  /** First real photo URL — rendered on the inline chat cards. */
  image?: string;
  /** What modes the listing actually supports — populated from metadata so
   *  the agent doesn't have to call get_listing_details per result just to
   *  answer "do these drivers do hourly?". For transport: subset of
   *  ['hourly','day','package']. For service: subset of
   *  ['at-home','visit-provider','online']. Undefined for stays (or when
   *  the listing has no mode metadata yet). */
  availableModes?: string[];
  /** All sub-skills the provider explicitly offers (multi-value). Lets the
   *  agent say "that salon does haircut, beard trim, and nails" without a
   *  follow-up get_listing_details call. Falls back to the legacy scalar
   *  when the listing predates the chip input. */
  subcategories?: string[];
  /** Compact summary of the listing's service variants — populated only for
   *  service listings whose `metadata.servicesCatalog` has ≥2 entries. Each
   *  entry carries the variant id (the real `serviceCatalogId` to pass
   *  forward), display name, base price (rupees), and an add-on count so the
   *  agent can answer "how much for a haircut?" with EVERY variant + price
   *  on the first turn — not just the cheapest. When this is present the
   *  hit's headline `price` is the cheapest variant; do NOT quote it as
   *  "the" price. For the full per-variant add-on list, call get_listing_details. */
  serviceCatalog?: Array<{
    id: string;
    name: string;
    basePrice: number;
    addOnsCount: number;
  }>;
  /** Set when the caller passed `date`: the hard availability gate's verdict
   *  for that date. 'busy' hits are dropped before the model sees them, so
   *  surfaced hits carry 'free' (verified) or 'unknown' (probe errored —
   *  treat as unverified, not as free). */
  availability?: 'free' | 'unknown';
}

const RETURN_LIMIT = 5;
// Pull deliberately more than we return so the rerank step has room to
// reject false positives the pre-filter let through. 30 is generous for the
// current ~10-listing catalog and stays well under Gemini Flash's input
// budget when serialised (~6k tokens for 30 listings of ~200 chars each).
const CANDIDATE_LIMIT = 30;

/** Build the candidate pool the rerank step picks from. */
async function fetchCandidates(args: Args): Promise<Record<string, unknown>[]> {
  const locationNeedle = args.location?.trim().toLowerCase() || '';
  const matchesLocation = (r: Record<string, unknown>) => {
    if (!locationNeedle) return true;
    const haystack = [r.city, r.state, r.location, r.address, r.name, r.title]
      .filter((v): v is string => typeof v === 'string')
      .join(' ')
      .toLowerCase();
    return haystack.includes(locationNeedle);
  };

  let rows: Record<string, unknown>[] = [];
  const hasText = Boolean(args.query?.trim() || args.location?.trim());

  if (hasText) {
    // Loose lexical retrieve: pull whatever tsquery/ILIKE matches the
    // user-visible terms. We intentionally accept noisy results because the
    // rerank step will throw out the unrelated ones — better to over-pull
    // and let the LLM filter than to miss the real answer.
    const searchQuery = [args.query, args.location].filter(Boolean).join(' ').trim();
    try {
      const result = await searchService.search({
        searchQuery,
        category: args.category,
        radiusKm: 50,
        page: 1,
        limit: CANDIDATE_LIMIT,
        sortBy: 'relevance',
      });
      const raw = (result as { data?: unknown; listings?: unknown });
      rows = (Array.isArray(raw.data) ? raw.data
            : Array.isArray(raw.listings) ? raw.listings
            : []) as Record<string, unknown>[];
    } catch (err) {
      logger.warn('search_listings: text retrieve failed, using listPublic', {
        error: (err as Error).message,
      });
      rows = [];
    }

    // If the lexical retrieve returned nothing, broaden to "every active
    // listing in this category" and let the rerank decide. This is NOT the
    // old "present everything as a match" bug — the rerank below will
    // return [] when nothing in this set actually matches the user's
    // intent, and we honour that honestly.
    if (rows.length === 0) {
      const fallback = await listingsService.listPublic({ type: args.category, limit: CANDIDATE_LIMIT });
      rows = (fallback.data ?? []) as Record<string, unknown>[];
    }
  } else {
    // Category-only browse — no query to rerank against, just return top-N.
    const result = await listingsService.listPublic({ type: args.category, limit: RETURN_LIMIT });
    rows = (result.data ?? []) as Record<string, unknown>[];
  }

  rows = rows.filter(matchesLocation);

  if (args.category === 'transport' && args.transportPricingMode) {
    // Hard-filter by pricing mode — if the user asked for "hourly drivers",
    // a driver who only prices by tour-package should not even reach the
    // reranker, let alone the cards. Listings without the requested mode are
    // dropped here so the agent can't claim hourly support that isn't there.
    rows = rows.filter((r) => {
      const t = String(r.listing_type ?? r.type ?? 'transport').toLowerCase();
      const modes = deriveAvailableModes(r, t) ?? [];
      return modes.includes(args.transportPricingMode!);
    });
  }

  if (args.maxPrice != null) {
    const limitPaise = args.maxPrice * 100;
    rows = rows.filter((r) => {
      const paise = typeof r.price_paise === 'number' ? r.price_paise : null;
      return paise == null || paise <= limitPaise;
    });
  }

  return rows.slice(0, CANDIDATE_LIMIT);
}

/**
 * Ask the LLM to pick which candidates genuinely match the user's intent.
 * Returns an ordered list of IDs (best first). Throws on LLM failure so the
 * caller can decide whether to fall back or surface the failure.
 */
async function rerankWithLlm(query: string, candidates: Record<string, unknown>[]): Promise<string[]> {
  // Serialise listings compactly — only the fields a model needs to judge
  // relevance. Truncate descriptions so 30 listings stay under ~6k input
  // tokens. Keep `id` first so the JSON-shape contract is unambiguous.
  const compact = candidates.map((r) => {
    const listingType = String(r.listing_type ?? r.type ?? '').toLowerCase();
    const modes = deriveAvailableModes(r, listingType);
    // Subcategories: a salon listing might be category="mens-haircut" but
    // also offer "beard trim", "shampoo", "facial" via the chip input.
    // Surfacing each one lets the reranker match a user query for "beard
    // trim" against this listing even though the row's `category` doesn't
    // mention it. Reads BOTH the new array shape and the legacy scalar.
    const meta = (r.metadata && typeof r.metadata === 'object')
      ? r.metadata as Record<string, unknown>
      : {};
    const subsArray = Array.isArray(meta.subcategories)
      ? (meta.subcategories as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [];
    const subs = subsArray.length > 0
      ? subsArray
      : (typeof meta.subcategory === 'string' && meta.subcategory.trim() ? [meta.subcategory.trim()] : []);
    const variants = deriveServiceCatalog(r, listingType);
    return {
      id: String(r.id),
      name: String(r.title ?? r.name ?? 'Untitled'),
      category: typeof r.category === 'string' ? r.category : '',
      location: typeof r.location === 'string' ? r.location
              : (typeof r.city === 'string' ? r.city : ''),
      description: typeof r.description === 'string'
        ? r.description.slice(0, 200)
        : '',
      // Modes tell the reranker which transport listings actually support
      // "hourly" / "day" / "package", or which service listings do at-home
      // vs visit-provider vs online. A listing missing the requested mode
      // should rank below one that has it (or be dropped entirely).
      ...(modes ? { modes } : {}),
      // Sub-skills the provider explicitly offers (multi-value, host-authored).
      // Match against these when the user query names a specific service the
      // category column alone wouldn't mention.
      ...(subs.length > 0 ? { subcategories: subs } : {}),
      // Service variants the host priced separately. Lets a "men's haircut"
      // query rank a salon with both Men's and Women's above one with only
      // the variant name in its description.
      ...(variants ? { serviceVariants: variants.map((v) => v.name) } : {}),
    };
  });

  const systemPrompt =
    'You are a search relevance ranker for a marketplace. Given a user query '
    + 'and a list of candidate listings, return ONLY the listings that genuinely '
    + 'match the user\'s stated need. Reason about meaning, not just keywords — '
    + '"tuition" matches "tutor", "deep clean" matches "housekeeping", '
    + '"8th grade math" matches a math tutor with experience. If NOTHING in '
    + 'the candidate list matches the intent, return an empty array. Never '
    + 'invent IDs. Order best-match first. Cap at ' + RETURN_LIMIT + ' results.\n\n'
    + 'Return strict JSON in this shape:\n'
    + '{ "matches": [ { "id": "<listing-id-verbatim>", "reason": "<one short sentence>" } ] }';

  const userMessage =
    `User query: ${JSON.stringify(query)}\n\n`
    + `Candidates:\n${JSON.stringify(compact, null, 2)}`;

  const llm = await getLlmProvider();
  const raw = await llm.generateStructuredJson({
    systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 400,
    // Low temp for deterministic ranking — this is a classifier, not creative.
    temperature: 0.1,
  });

  const matches = Array.isArray((raw as any)?.matches) ? (raw as any).matches : [];
  const validIds = new Set(candidates.map((c) => String(c.id)));
  const ranked: string[] = [];
  for (const m of matches) {
    if (typeof m?.id !== 'string') continue;
    if (!validIds.has(m.id)) continue; // ignore hallucinated IDs
    if (ranked.includes(m.id)) continue;
    ranked.push(m.id);
    if (ranked.length >= RETURN_LIMIT) break;
  }
  return ranked;
}

/** Derive the supported modes for a listing from its metadata. Transport
 *  reads three priced-mode signals (pricePerHour, pricePerDay, packageOptions);
 *  services read the serviceModes array set during onboarding. Returns
 *  undefined when nothing's set so the prompt rule can say "I haven't
 *  verified this yet" rather than assume an empty array means no modes. */
function deriveAvailableModes(row: Record<string, unknown>, listingType: string): string[] | undefined {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  if (listingType === 'transport') {
    const modes: string[] = [];
    const num = (v: unknown) => {
      const n = typeof v === 'string' ? Number(v.replace(/[^\d.]/g, '')) : Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    if (num(meta.pricePerHour) != null) modes.push('hourly');
    if (num(meta.pricePerDay) != null) modes.push('day');
    if (Array.isArray(meta.packageOptions) && meta.packageOptions.length > 0) modes.push('package');
    return modes.length > 0 ? modes : undefined;
  }
  if (listingType === 'service') {
    const serviceModes = Array.isArray(meta.serviceModes)
      ? meta.serviceModes.filter((m): m is string => typeof m === 'string')
      : [];
    return serviceModes.length > 0 ? serviceModes : undefined;
  }
  return undefined;
}

/** Compact per-variant menu for a service listing — only returned when there
 *  are ≥2 priced variants, since a single-variant listing's headline `price`
 *  is already the right answer. Mirrors the catalog shape get_listing_details
 *  builds (same id resolution, same rounding) so the assistant can hand the
 *  same `id` back as `serviceCatalogId` without a second tool call. */
function deriveServiceCatalog(
  row: Record<string, unknown>,
  listingType: string,
): Array<{ id: string; name: string; basePrice: number; addOnsCount: number }> | undefined {
  if (listingType !== 'service') return undefined;
  const meta = (row.metadata && typeof row.metadata === 'object')
    ? row.metadata as Record<string, unknown>
    : {};
  const raw = meta.servicesCatalog;
  if (!Array.isArray(raw)) return undefined;
  const out: Array<{ id: string; name: string; basePrice: number; addOnsCount: number }> = [];
  raw.forEach((g, idx) => {
    if (!g || typeof g !== 'object') return;
    const r = g as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    const basePrice = Number(r.basePrice);
    if (!name || !Number.isFinite(basePrice) || basePrice <= 0) return;
    const addOnsCount = Array.isArray(r.addOns) ? r.addOns.length : 0;
    out.push({
      id: typeof r.id === 'string' && r.id.trim() ? r.id : `svc-${idx}`,
      name,
      basePrice: Math.round(basePrice),
      addOnsCount,
    });
  });
  // Single-variant listings → headline price already tells the whole story.
  return out.length >= 2 ? out : undefined;
}

function deriveSubcategories(row: Record<string, unknown>): string[] | undefined {
  const meta = (row.metadata && typeof row.metadata === 'object')
    ? row.metadata as Record<string, unknown>
    : {};
  const arr = Array.isArray(meta.subcategories)
    ? (meta.subcategories as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : [];
  if (arr.length > 0) return arr;
  if (typeof meta.subcategory === 'string' && meta.subcategory.trim()) {
    return [meta.subcategory.trim()];
  }
  return undefined;
}

/** Build the user-visible price string. Transport listings don't usually
 *  carry a single `price_paise` — their pricing lives across metadata
 *  (pricePerHour, pricePerDay, packageOptions). Surface the cheapest and
 *  most-expensive priced modes as a compact range ("₹350/hr · ₹2,500/day")
 *  so the chat card shows actual numbers instead of an empty slot. */
function derivePriceLabel(r: Record<string, unknown>, listingType: string): string | undefined {
  if (listingType === 'transport') {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number | null => {
      const n = typeof v === 'string' ? Number(v.replace(/[^\d.]/g, '')) : Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const parts: string[] = [];
    const ph = num(meta.pricePerHour);
    if (ph != null) parts.push(`₹${Math.round(ph)}/hr`);
    const pd = num(meta.pricePerDay);
    if (pd != null) parts.push(`₹${Math.round(pd).toLocaleString('en-IN')}/day`);
    if (Array.isArray(meta.packageOptions)) {
      const pkgPrices = (meta.packageOptions as Array<Record<string, unknown>>)
        .map((p) => num(p.price))
        .filter((n): n is number => n != null);
      if (pkgPrices.length > 0) {
        const min = Math.min(...pkgPrices);
        const max = Math.max(...pkgPrices);
        parts.push(min === max
          ? `₹${Math.round(min).toLocaleString('en-IN')} pkg`
          : `₹${Math.round(min).toLocaleString('en-IN')}–${Math.round(max).toLocaleString('en-IN')} pkg`);
      }
    }
    if (parts.length > 0) return parts.join(' · ');
  }
  if (typeof r.price_paise === 'number') return `₹${(r.price_paise / 100).toFixed(0)}`;
  if (typeof r.price === 'string') return r.price;
  return undefined;
}

/** First real photo URL — same precedence the booking card uses. Non-http
 *  values (mock slugs, local file refs) are dropped so cards show the
 *  placeholder instead of a broken image. */
function deriveImage(r: Record<string, unknown>): string | undefined {
  const candidates = [
    Array.isArray(r.photos) ? r.photos[0] : undefined,
    Array.isArray(r.images) ? r.images[0] : undefined,
    r.image_url,
    r.image,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:/.test(c)) return c;
  }
  return undefined;
}

function toHit(r: Record<string, unknown>, fallbackType: string): SearchHit {
  const listingType = String(r.listing_type ?? r.type ?? fallbackType).toLowerCase();
  return {
    id: String(r.id),
    title: String(r.title ?? r.name ?? 'Untitled'),
    type: String(r.type ?? fallbackType),
    location: typeof r.location === 'string' ? r.location
            : (typeof r.city === 'string' ? r.city : undefined),
    price: derivePriceLabel(r, listingType),
    rating: typeof r.rating === 'number' ? r.rating : undefined,
    image: deriveImage(r),
    availableModes: deriveAvailableModes(r, fallbackType),
    subcategories: deriveSubcategories(r),
    serviceCatalog: deriveServiceCatalog(r, listingType),
  };
}

interface SearchResult {
  results: SearchHit[];
  count: number;
  /** Echo of args.date when the availability gate ran. */
  checkedDate?: string;
  /** How many matching listings were hidden because they're blocked or
   *  fully booked on `checkedDate`. Surface this honestly ("2 others were
   *  already booked that day") instead of pretending they don't exist. */
  unavailableDroppedCount?: number;
}

export const searchListingsTool: ToolDefinition<Args, SearchResult> = {
  name: 'search_listings',
  description:
    'Search listings the user can book. Call this BEFORE recommending or naming any listing — never invent listing names. Returns up to 5 ranked results with id+title+location+price+rating, plus `availableModes` (for transport: subset of ["hourly","day","package"]; for service: subset of ["at-home","visit-provider","online"]) and — for service listings with ≥2 priced variants — a compact `serviceCatalog` array [{id,name,basePrice,addOnsCount}]. When `serviceCatalog` is present the hit\'s headline `price` is just the CHEAPEST variant (i.e. NOT "the price"): your first reply must enumerate EVERY variant with its price OR ask which variant — never quote the headline price as if there were only one. addOnsCount > 0 means call get_listing_details before locking, to read the per-variant add-on names. For transport, `price` is a compact range built from priced modes (e.g. "₹350/hr · ₹2,500/day"). When the user names a transport pricing mode ("hourly driver", "day rental", "package tour") OR implies one (a time range like "2pm to 5pm" or a duration implies hourly; "for the day" or a multi-day span implies day; a named tour implies package), pass `transportPricingMode` so non-matching drivers are filtered out before ranking. When the user has named or implied a concrete DATE (resolve "tomorrow" / "the 15th" via Today (IST) first), pass `date` (+ `checkOutDate` for stay ranges): every hit is then availability-checked server-side and unbookable ones dropped (stays: blocked or fully-booked nights; transport day/package: host-blocked OR any booking that whole day; hourly transport / services: host-blocked days — a partly-booked day flags "unknown" unless you pass a window, below). **For services/transport, ALSO pass `startTime`+`endTime` whenever the user named a time window ("2pm to 5pm" → "14:00"/"17:00")** — the gate then checks the EXACT window and drops listings already booked for it, so a driver booked 9 AM–5 PM never appears for a 2–5 PM search. Without the window a partly-booked day only flags availability "unknown" (verify with find_available_slots before promising a time). `unavailableDroppedCount` reports how many were hidden — mention it honestly ("2 others were unavailable that day"). An LLM relevance step picks only listings that genuinely match — if the result is empty, the catalog truly has no match (do not retry with looser filters expecting different listings to surface; tell the user honestly). NEVER claim a transport listing supports a mode that is not in its `availableModes`; if `availableModes` is missing, call get_listing_details to check before claiming.',
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['stay', 'service', 'transport'] },
      query: { type: 'string' },
      location: { type: 'string' },
      maxPrice: { type: 'number' },
      transportPricingMode: { type: 'string', enum: ['hourly', 'day', 'package'] },
      date: { type: 'string', description: 'YYYY-MM-DD — pass when the user named/implied a date; hits get availability-checked and busy ones dropped.' },
      checkOutDate: { type: 'string', description: 'YYYY-MM-DD — stays only, when the user named a range.' },
      startTime: { type: 'string', description: 'HH:MM — services/transport; pass with date+endTime when the user named a time window so booked slots are dropped.' },
      endTime: { type: 'string', description: 'HH:MM — services/transport; end of the requested window.' },
    },
    required: ['category'],
  },

  async execute(args, ctx) {
    const candidates = await fetchCandidates(args);

    // Nothing in the catalog → honest empty result.
    if (candidates.length === 0) {
      return { results: [], count: 0 };
    }

    // HARD availability gate (suggestion integrity): when the model passed a
    // concrete date, probe every hit through the SAME check the
    // check_availability tool runs and DROP blocked / fully-booked listings
    // before the model can pitch them. Probe errors degrade to 'unknown'
    // (surfaced, labelled unverified) — never to a false 'free'. Runs over
    // ≤5 hits in parallel; one round-trip.
    const finalize = async (hits: SearchHit[]): Promise<SearchResult> => {
      let droppedUnavailable = 0;
      if (args.date && hits.length > 0) {
        // Window-precise gate for services/transport when the user named a
        // time window: drops listings whose EXACT [start,end) is taken (same
        // overlap predicate as the hold). This is the hard snip — a booked
        // driver never reaches the model, so it can't be suggested.
        const useWindow = args.category !== 'stay' && !!args.startTime && !!args.endTime;
        const verdicts = await Promise.all(hits.map(async (h) => {
          try {
            if (useWindow) {
              // 'free' / 'busy' / 'unknown' already — busy ⇒ dropped below.
              return await checkListingWindowAvailability({
                listingId: h.id,
                date: args.date!,
                startTime: args.startTime!,
                endTime: args.endTime!,
              });
            }
            const check = await checkListingAvailability({
              listingId: h.id,
              date: args.date!,
              checkOutDate: args.checkOutDate,
            });
            if (check.available) return 'free' as const;
            if (check.reason === 'unknown_listing') return 'unknown' as const;
            // A host BLOCK is whole-day truth for every category → drop.
            if (check.reason === 'blocked') return 'busy' as const;
            // Remaining: something is BOOKED that date. What that means depends
            // on how the listing is being booked:
            //   • Stays — the night/room is genuinely taken → drop.
            //   • Transport DAY / PACKAGE — whole-day modes need the entire day
            //     free, so ANY booking that date makes the vehicle unavailable
            //     → drop. (We know the intent from transportPricingMode.)
            //   • Hourly transport / services WITHOUT a window — the repo marks
            //     the whole date booked off a single slot (no room types), so a
            //     driver with one morning ride must NOT vanish for an afternoon
            //     ask → surface 'unknown'; the window gate above / hold-time
            //     check own the precise answer.
            if (args.category === 'stay') return 'busy' as const;
            if (args.category === 'transport'
              && (args.transportPricingMode === 'day' || args.transportPricingMode === 'package')) {
              return 'busy' as const;
            }
            return 'unknown' as const;
          } catch (err) {
            logger.warn('search_listings: availability probe failed', {
              listingId: h.id,
              error: (err as Error).message,
            });
            return 'unknown' as const;
          }
        }));
        const kept: SearchHit[] = [];
        hits.forEach((h, i) => {
          const verdict = verdicts[i];
          if (verdict === 'busy') {
            droppedUnavailable += 1;
            return;
          }
          kept.push({ ...h, availability: verdict });
        });
        hits = kept;
      }
      // Remember only what we actually surfaced — a dropped-busy listing
      // shouldn't be quotable as "that one" next turn.
      void recordRecentHits(
        ctx.userId,
        hits.map((r) => ({ id: r.id, title: r.title, type: r.type, location: r.location, price: r.price })),
      );
      return {
        results: hits,
        count: hits.length,
        ...(args.date ? { checkedDate: args.date, unavailableDroppedCount: droppedUnavailable } : {}),
      };
    };

    // Category-only browse (no text query) → skip the rerank, return top-N
    // by whatever order the retrieve gave us. No relevance signal to apply.
    if (!args.query?.trim()) {
      return finalize(candidates.slice(0, RETURN_LIMIT).map((r) => toHit(r, args.category)));
    }

    // Single candidate → also skip the rerank. Saves a Gemini call without
    // changing the answer (the model would either pass it or reject it; if
    // the pre-filter pulled exactly one match the user gets to see it and
    // the agent can decide whether to recommend it).
    if (candidates.length === 1) {
      return finalize([toHit(candidates[0], args.category)]);
    }

    let rankedIds: string[];
    try {
      rankedIds = await rerankWithLlm(args.query.trim(), candidates);
    } catch (err) {
      // Rerank failure is a degradation, not a hard error. Fall back to the
      // top of the lexical pre-filter so the agent still gets something to
      // work with rather than a tool-error chip. The user-facing risk is a
      // slightly less-relevant ordering, not the old false-positive flood.
      logger.warn('search_listings: rerank failed, falling back to lexical order', {
        error: (err as Error).message,
      });
      rankedIds = candidates.slice(0, RETURN_LIMIT).map((c) => String(c.id));
    }

    const byId = new Map(candidates.map((c) => [String(c.id), c]));
    const results: SearchHit[] = rankedIds
      .map((id) => byId.get(id))
      .filter((c): c is Record<string, unknown> => c != null)
      .map((r) => toHit(r, args.category));

    // finalize() runs the availability gate AND persists the short-term
    // scratchpad of what we surfaced (the assistant's next turn loses tool
    // history, so without it "tell me more" can't quote a real id).
    return finalize(results);
  },

  summarize(args, result) {
    const where = args.location ? ` in ${args.location}` : '';
    return result.count > 0
      ? `Found ${result.count} ${args.category}${result.count === 1 ? '' : 's'}${where}`
      : `No ${args.category}s found${where}`;
  },
};
