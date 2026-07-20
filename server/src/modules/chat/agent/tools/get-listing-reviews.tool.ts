import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { reviewsService } from '../../../reviews/services/reviews.service.js';

/**
 * Surface real reviews for a listing so the agent can quote them when a
 * user is on the fence ("is it actually clean?", "any good for kids?").
 *
 * Without this tool the agent was inventing review snippets — grounding
 * caught the worst hallucinations but the lighter "it has great reviews"
 * filler was passing through. Reviews are public data with a public HTTP
 * endpoint already, so no auth scoping concerns; we just truncate the
 * comment field to keep the model from drowning in noise.
 *
 * Returns at most 5 most-recent reviews to bound token cost. The agent
 * should quote 1–2 in its reply, not list them all.
 */
const ArgsSchema = z.object({
  listingId: z.string().min(1).max(80),
  /** Cap on rows returned. The model can ask for more in a follow-up
   *  if needed, but >5 in one turn usually isn't useful. */
  limit: z.number().int().min(1).max(10).optional(),
});
type Args = z.infer<typeof ArgsSchema>;

interface ReviewSummary {
  id: string;
  rating: number;
  /** Truncated to 280 chars for prompt sanity. */
  comment: string;
  displayName: string;
  helpfulCount: number;
  createdAt: string;
}

interface Result {
  listingId: string;
  count: number;
  averageRating: number | null;
  reviews: ReviewSummary[];
}

export const getListingReviewsTool: ToolDefinition<Args, Result> = {
  name: 'get_listing_reviews',
  description:
    "Fetch recent guest reviews for a listing — useful when the user is comparing options or asking 'is this place actually good?'. Returns up to 5 most-recent reviews plus the average rating. Quote 1–2 specific ones in your reply when relevant ('a recent guest said the breakfast was great'); don't list them all. Reviews are tied to verified bookings so they aren't astroturfed.",
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      listingId: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['listingId'],
  },

  async execute(args) {
    const limit = args.limit ?? 5;
    const { data } = await reviewsService.listByStay(args.listingId);
    const sliced = data.slice(0, limit);

    let avg: number | null = null;
    if (data.length > 0) {
      const sum = data.reduce((acc: number, r: Record<string, unknown>) => {
        const r2 = r as { rating?: unknown };
        return acc + (typeof r2.rating === 'number' ? r2.rating : 0);
      }, 0);
      avg = Math.round((sum / data.length) * 10) / 10;
    }

    const reviews: ReviewSummary[] = sliced.map((row: Record<string, unknown>) => {
      const r = row as {
        id: string;
        rating?: number;
        comment?: string | null;
        display_name?: string | null;
        helpful_count?: number;
        created_at?: string;
      };
      const comment = typeof r.comment === 'string' ? r.comment : '';
      return {
        id: r.id,
        rating: typeof r.rating === 'number' ? r.rating : 0,
        comment: comment.length > 280 ? comment.slice(0, 277) + '…' : comment,
        displayName: typeof r.display_name === 'string' && r.display_name ? r.display_name : 'Anonymous',
        helpfulCount: typeof r.helpful_count === 'number' ? r.helpful_count : 0,
        createdAt: typeof r.created_at === 'string' ? r.created_at : '',
      };
    });

    return {
      listingId: args.listingId,
      count: data.length,
      averageRating: avg,
      reviews,
    };
  },

  summarize(_args, result) {
    if (result.count === 0) return 'No reviews yet';
    const avgPart = result.averageRating != null ? `${result.averageRating}★ avg` : '';
    return `${result.count} review${result.count === 1 ? '' : 's'}${avgPart ? ' (' + avgPart + ')' : ''}`;
  },
};
