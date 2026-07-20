/**
 * Short-term per-listing cache of the normalized `priceableOptions` the
 * assistant last loaded for a listing.
 *
 * Why this exists: the full-menu backstop (full-menu-backstop.ts) re-appends
 * any priced option the model dropped from a price list — but it could only
 * read `priceableOptions` when `get_listing_details` ran on the SAME turn as
 * the partial reply. The common failure is cross-turn: the model fetches
 * details once, then a turn or two later re-quotes prices from context and
 * silently drops a variant (e.g. lists Men's + Kid's haircut, forgets
 * Women's). By that turn the tool result is gone, so the backstop no-ops.
 *
 * This cache replays the last-seen full menu for a listing so the backstop can
 * complete a partial list regardless of which turn the details were fetched.
 *
 * Keep it small and short-lived — a conversational scratchpad, not durable
 * memory. Mirrors recent-hits.ts (same Redis client, TTL, best-effort writes).
 */
import { redis } from '../../../common/cache/redis.js';
import { logger } from '../../../common/logging/logger.js';

const TTL_SECONDS = 30 * 60; // 30 min — covers a typical chat session

export interface PriceableOptionCacheEntry {
  group?: string;
  name: string;
  price: number;
  unit?: string;
  maxGuests?: number;
  addOns?: Array<{ name: string; price: number }>;
}

function key(userId: string, listingId: string): string {
  return `assistant:listing-priceables:${userId}:${listingId}`;
}

/** Cache the full normalized menu for one listing the user just viewed. */
export async function recordListingPriceables(
  userId: string,
  listingId: string,
  options: PriceableOptionCacheEntry[],
): Promise<void> {
  if (!userId || !listingId || !Array.isArray(options) || options.length === 0) return;
  try {
    await redis.set(key(userId, listingId), JSON.stringify(options), 'EX', TTL_SECONDS);
  } catch (err) {
    // Cache is best-effort — never break the tool call on a Redis hiccup.
    logger.warn('recent-priceables: write failed', { error: (err as Error).message });
  }
}

/** Read back the last-seen full menu for a listing, or [] when nothing cached. */
export async function readListingPriceables(
  userId: string,
  listingId: string,
): Promise<PriceableOptionCacheEntry[]> {
  if (!userId || !listingId) return [];
  try {
    const raw = await redis.get(key(userId, listingId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((o) => o && typeof o.name === 'string' && typeof o.price === 'number')
      : [];
  } catch (err) {
    logger.warn('recent-priceables: read failed', { error: (err as Error).message });
    return [];
  }
}
