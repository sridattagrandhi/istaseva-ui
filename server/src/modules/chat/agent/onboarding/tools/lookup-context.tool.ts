import { z } from 'zod';
import { dbQuery } from '../../../../../common/repositories/database.js';
import { logger } from '../../../../../common/logging/logger.js';
import type { ToolDefinition } from '../../types.js';

/**
 * Onboarding read-tool — gives the agent enough live database context to
 * guide a new host or provider without hallucinating.
 *
 * Returns:
 *   - `categories`: distinct sub-categories currently in use for the chosen
 *     listing_type (e.g. ['hotel', 'homestay', 'lodge']) so we suggest values
 *     the platform actually supports, not whatever the model invents.
 *   - `comparablePrices`: a small p10/p50/p90 sketch of base prices for the
 *     listing_type, optionally narrowed to a city. Lets the agent advise on
 *     pricing realistically ("most hotels in Hyderabad on IstaSeva charge
 *     ₹3,000–₹8,000/night") instead of making numbers up.
 *   - `nearbyCount`: how many comparable listings already exist in that city —
 *     a signal for whether to encourage them to publish or warn about
 *     saturation.
 *
 * All reads are best-effort: failures degrade to empty arrays. The agent
 * can always still extract fields, set pickers, and submit listings — the
 * tool only enriches advice.
 */
const ArgsSchema = z.object({
  listingType: z
    .enum(['stay', 'service', 'transport'])
    .describe('Which platform vertical the user is onboarding into.'),
  city: z
    .string()
    .max(80)
    .optional()
    .describe('Optional city to scope the price stats and nearby count.'),
});
type Args = z.infer<typeof ArgsSchema>;

interface LookupResult {
  categories: string[];
  comparablePrices: {
    currency: 'INR';
    count: number;
    p10?: number;
    p50?: number;
    p90?: number;
  };
  nearbyCount: number;
}

export const lookupContextTool: ToolDefinition<Args, LookupResult> = {
  name: 'lookup_onboarding_context',
  description:
    'Look up the categories and price ranges already live on the platform for this listing_type (optionally filtered by city). Use this BEFORE suggesting a category value or a price range so advice is grounded in real data.',
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      listingType: { type: 'string', enum: ['stay', 'service', 'transport'] },
      city: { type: 'string' },
    },
    required: ['listingType'],
  },

  async execute(args, _ctx) {
    const empty: LookupResult = {
      categories: [],
      comparablePrices: { currency: 'INR', count: 0 },
      nearbyCount: 0,
    };

    try {
      // Categories actually in use for this listing_type — only verified +
      // active listings so we don't surface dead values.
      const catResult = await dbQuery<{ category: string }>(
        `SELECT DISTINCT l.category
           FROM listings l
           LEFT JOIN user_profiles up ON up.user_id = l.user_id
          WHERE l.listing_type = $1
            AND l.is_active = true
            AND l.category IS NOT NULL
            AND (up.verification_status = 'verified' OR up.user_id IS NULL)
          ORDER BY l.category
          LIMIT 20`,
        [args.listingType],
      );
      const categories = catResult.rows.map((r) => r.category).filter(Boolean);

      // Price percentiles. stays use price_per_night (rupees), services /
      // transport use `price` (rupees). Read both columns; coalesce.
      const priceParams: any[] = [args.listingType];
      let priceWhere = `l.listing_type = $1 AND l.is_active = true`;
      if (args.city) {
        priceParams.push(args.city);
        priceWhere += ` AND (l.city ILIKE '%' || $${priceParams.length} || '%' OR l.location ILIKE '%' || $${priceParams.length} || '%')`;
      }
      const priceResult = await dbQuery<{
        count: string;
        p10: string | null;
        p50: string | null;
        p90: string | null;
      }>(
        `SELECT COUNT(*)::text AS count,
                percentile_cont(0.10) WITHIN GROUP (ORDER BY COALESCE(l.price_per_night, l.price)) AS p10,
                percentile_cont(0.50) WITHIN GROUP (ORDER BY COALESCE(l.price_per_night, l.price)) AS p50,
                percentile_cont(0.90) WITHIN GROUP (ORDER BY COALESCE(l.price_per_night, l.price)) AS p90
           FROM listings l
          WHERE ${priceWhere}
            AND COALESCE(l.price_per_night, l.price) IS NOT NULL`,
        priceParams,
      );
      const priceRow = priceResult.rows[0];

      const toNum = (v: string | null | undefined) => {
        if (v == null) return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? Math.round(n) : undefined;
      };
      const comparablePrices = {
        currency: 'INR' as const,
        count: Number(priceRow?.count ?? 0),
        p10: toNum(priceRow?.p10),
        p50: toNum(priceRow?.p50),
        p90: toNum(priceRow?.p90),
      };

      // Nearby count — same scope as price percentiles when a city was given,
      // otherwise total comparable listings on the platform.
      const nearbyCount = comparablePrices.count;

      return { categories, comparablePrices, nearbyCount };
    } catch (err) {
      logger.warn('lookup_onboarding_context failed', { err: String(err) });
      return empty;
    }
  },

  summarize(args, result) {
    const where = args.city ? ` in ${args.city}` : '';
    return `Found ${result.categories.length} categories · ${result.comparablePrices.count} comparable ${args.listingType}${result.comparablePrices.count === 1 ? '' : 's'}${where}`;
  },
};
