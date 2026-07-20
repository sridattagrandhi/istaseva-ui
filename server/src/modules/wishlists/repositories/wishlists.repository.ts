import { dbQuery } from '../../../common/repositories/database.js';

export type WishlistType = 'stay' | 'service' | 'transport';

export class WishlistsRepository {
  /** Everything a given user has saved, bucketed by listing type. */
  async listForUser(userId: string): Promise<{ stay: string[]; service: string[]; transport: string[] }> {
    const { rows } = await dbQuery<{ listing_id: string; listing_type: WishlistType }>(
      'SELECT listing_id, listing_type FROM user_wishlists WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    );
    const bucket: { stay: string[]; service: string[]; transport: string[] } = { stay: [], service: [], transport: [] };
    for (const r of rows) bucket[r.listing_type].push(r.listing_id);
    return bucket;
  }

  /** Idempotent save — repeated calls with the same (user, listing, type) are no-ops. */
  async add(userId: string, listingId: string, listingType: WishlistType): Promise<void> {
    await dbQuery(
      `INSERT INTO user_wishlists (user_id, listing_id, listing_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, listing_id, listing_type) DO NOTHING`,
      [userId, listingId, listingType],
    );
  }

  async remove(userId: string, listingId: string, listingType: WishlistType): Promise<void> {
    await dbQuery(
      'DELETE FROM user_wishlists WHERE user_id = $1 AND listing_id = $2 AND listing_type = $3',
      [userId, listingId, listingType],
    );
  }
}

export const wishlistsRepository = new WishlistsRepository();
