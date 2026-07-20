import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { wishlistsService } from '../../../wishlists/services/wishlists.service.js';

/**
 * Add or remove a listing from the user's saved/wishlist.
 *
 * Why a single toggle tool rather than two (add/remove):
 *   The user's intent in natural language ("save this", "favorite it",
 *   "remove that one") is rarely about "I know what's already saved" —
 *   it's about getting to the right end state. The agent shouldn't have
 *   to read the existing list first. The action parameter lets the agent
 *   be explicit when the intent is clearly directional ("unsave Coorg
 *   homestay" → action='remove'), and the underlying service is
 *   idempotent (ON CONFLICT DO NOTHING for add, no-op for missing remove)
 *   so re-firing the same action is safe.
 *
 * Auth: user is implicit from ctx.userId (server-set), never from args.
 *   This is the same scoping pattern the bookings + memory tools use.
 */
const ArgsSchema = z.object({
  listingId: z.string().min(1).max(80),
  /** Mirrors the wishlist table's listing_type column. Stay listings
   *  ('hotel','homestay') get listingType='stay'; everything else is
   *  'service' or 'transport' depending on the category. The agent
   *  infers this from the listing context, but if it's wrong on add,
   *  the dashboard's filter just won't show it — no data corruption. */
  listingType: z.enum(['stay', 'service', 'transport']),
  action: z.enum(['add', 'remove']),
});
type Args = z.infer<typeof ArgsSchema>;

interface Result {
  ok: true;
  action: 'add' | 'remove';
  listingId: string;
}

export const toggleWishlistTool: ToolDefinition<Args, Result> = {
  name: 'toggle_wishlist',
  description:
    "Add or remove a listing from the user's Saved list. Call when the user says 'save this' / 'add to favorites' / 'remove from saved' / 'unfavorite'. listingType is the kind of listing: 'stay' for hotels & homestays, 'service' for cleaners/plumbers/etc, 'transport' for drivers. action is 'add' or 'remove'. Both directions are idempotent — re-firing the same action is safe.",
  sideEffect: 'write',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      listingId: { type: 'string' },
      listingType: { type: 'string', enum: ['stay', 'service', 'transport'] },
      action: { type: 'string', enum: ['add', 'remove'] },
    },
    required: ['listingId', 'listingType', 'action'],
  },

  async execute(args, ctx) {
    if (args.action === 'add') {
      await wishlistsService.add(ctx.userId, args.listingId, args.listingType);
    } else {
      await wishlistsService.remove(ctx.userId, args.listingId, args.listingType);
    }
    return { ok: true, action: args.action, listingId: args.listingId };
  },

  summarize(args) {
    return args.action === 'add' ? 'Saved to your list' : 'Removed from saved';
  },
};
