import { z } from 'zod';
import { wishlistsService } from '../../../wishlists/services/wishlists.service.js';
import { listingsService } from '../../../listings/services/listings.service.js';
import { approximateListingGeo } from '../../../listings/services/listing-geo-privacy.js';
import { logger } from '../../../../common/logging/logger.js';
import type { ToolDefinition } from '../types.js';

/**
 * Read-only listing of what the user has saved/wishlisted.
 *
 * Pairs with `toggle_wishlist` (write): this tool answers "show me my saved
 * stays" / "what's on my wishlist?" without the model having to invent ids.
 * Hydrates with the listing record so the agent can name titles + prices in
 * the reply rather than spitting out raw uuids.
 */
const ArgsSchema = z.object({
  listingType: z.enum(['stay', 'service', 'transport']).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
type Args = z.infer<typeof ArgsSchema>;

interface SavedRow {
  id: string;
  title?: string;
  type: 'stay' | 'service' | 'transport';
  location?: string;
  price?: string;
  rating?: number;
  image?: string;
}

interface Result {
  count: number;
  items: SavedRow[];
}

export const getSavedListingsTool: ToolDefinition<Args, Result> = {
  name: 'get_saved_listings',
  description:
    "Return the user's saved/wishlist listings — what they've hearted across stays, services, and transport. Call when the user asks 'show my saved listings' / 'what's on my wishlist' / 'my favorites'. Optional `listingType` filter narrows to one bucket. Returns id + title + type + location + price + rating + image so you can name real listings in the reply, not just count them.",
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      listingType: { type: 'string', enum: ['stay', 'service', 'transport'] },
      limit: { type: 'number' },
    },
  },

  async execute(args, ctx) {
    const buckets = await wishlistsService.list(ctx.userId);
    const ids: Array<{ id: string; type: 'stay' | 'service' | 'transport' }> = [];
    const types: Array<'stay' | 'service' | 'transport'> = args.listingType
      ? [args.listingType]
      : ['stay', 'service', 'transport'];
    for (const t of types) for (const id of buckets[t] ?? []) ids.push({ id, type: t });
    const cap = args.limit ?? 10;
    const sliced = ids.slice(0, cap);

    const items: SavedRow[] = [];
    for (const row of sliced) {
      try {
        const res = await listingsService.getById(row.id);
        const raw = res.data as Record<string, unknown> | undefined;
        if (!raw) {
          items.push({ id: row.id, type: row.type });
          continue;
        }
        // GEO PRIVACY (WS6): getById returns the raw row; a saved listing is
        // not a booked one, so mask like every other discovery surface.
        const listing = approximateListingGeo(raw);
        const priceVal =
          typeof listing.price_paise === 'number'
            ? `₹${Math.round((listing.price_paise as number) / 100)}`
            : typeof listing.price === 'string' || typeof listing.price === 'number'
              ? `₹${listing.price}`
              : undefined;
        const imageVal = (() => {
          const photos = listing.photos;
          if (Array.isArray(photos) && photos.length > 0 && typeof photos[0] === 'string') return photos[0] as string;
          if (typeof listing.image === 'string') return listing.image;
          return undefined;
        })();
        items.push({
          id: String(listing.id),
          title: typeof listing.title === 'string' ? listing.title
            : typeof listing.name === 'string' ? listing.name : undefined,
          type: row.type,
          location: typeof listing.location === 'string' ? listing.location
            : typeof listing.city === 'string' ? listing.city : undefined,
          price: priceVal,
          rating: typeof listing.rating === 'number' ? listing.rating : undefined,
          image: imageVal,
        });
      } catch (err) {
        logger.debug('get_saved_listings: hydrate failed', { id: row.id, error: (err as Error).message });
        items.push({ id: row.id, type: row.type });
      }
    }

    return { count: items.length, items };
  },

  summarize(_args, result) {
    return result.count > 0 ? `Found ${result.count} saved` : 'No saved listings';
  },
};
