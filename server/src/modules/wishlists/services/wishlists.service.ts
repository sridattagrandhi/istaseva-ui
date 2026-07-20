import { wishlistsRepository, WishlistType } from '../repositories/wishlists.repository.js';

/**
 * Saved listings ("Saved" tab on the Guest Dashboard, heart icon on cards).
 *
 * Thin wrapper on top of the repository — the invariants worth noting:
 *  - Add is idempotent (ON CONFLICT DO NOTHING) so double-clicking hearts is safe.
 *  - Remove is idempotent (missing row = no-op) so the client never sees
 *    a 404 from a race where two tabs unsaved the same listing.
 *  - We don't FK onto listings: stale ids render conditionally on the client
 *    because the user's dashboard filters them against the live listings feed.
 */
export class WishlistsService {
  list(userId: string) {
    return wishlistsRepository.listForUser(userId);
  }

  async add(userId: string, listingId: string, listingType: WishlistType) {
    await wishlistsRepository.add(userId, listingId, listingType);
    return { success: true };
  }

  async remove(userId: string, listingId: string, listingType: WishlistType) {
    await wishlistsRepository.remove(userId, listingId, listingType);
    return { success: true };
  }
}

export const wishlistsService = new WishlistsService();
