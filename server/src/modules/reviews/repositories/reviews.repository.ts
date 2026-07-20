import { dbQuery, dbTransaction } from '../../../common/repositories/database.js';

const REVIEW_MUTABLE_FIELDS = new Set([
  'stay_id',
  'provider_id',
  'booking_id',
  'rating',
  'title',
  'comment',
  'photos',
  'metadata',
]);

export class ReviewsRepository {
  listByStay(stayId: string) {
    return dbQuery(
      'SELECT * FROM reviews WHERE stay_id = $1 ORDER BY created_at DESC',
      [stayId]
    );
  }

  /** Reviews tied to ANY listing — stays, services, or transport.
   *
   *  Stays write `stay_id` (the listing UUID as text). Service / transport
   *  reviews are pinned via `provider_id` (provider_profiles.id) — we
   *  derive that here by joining listings → provider_profiles on user_id,
   *  matching the read path in listings.repository.ts:79. Either match
   *  surfaces the review.
   *
   *  Cast `l.id::text` so the OR clauses can short-circuit on stay-style
   *  rows without hitting the join when the stay_id matches directly. */
  listByListing(listingId: string) {
    return dbQuery(
      `SELECT r.*
       FROM reviews r
       WHERE r.stay_id = $1
          OR r.provider_id = (
            SELECT pp.id
            FROM provider_profiles pp
            INNER JOIN listings l ON pp.user_id = l.user_id
            WHERE l.id::text = $1
            LIMIT 1
          )
       ORDER BY r.created_at DESC`,
      [listingId]
    );
  }

  /**
   * Bookings by this user that are finished but not yet reviewed — the feed
   * for the "rate your stay" prompt shown on app open (web + mobile).
   *
   * "Finished" mirrors findEligibleBookingForReview exactly (completed, or
   * confirmed/in_progress with a past scheduled_date) so every candidate we
   * prompt for is guaranteed to pass the create() eligibility gate. One review
   * per booking: a booking disappears from this feed the moment a review row
   * pins it. Newest completion first; LIMIT keeps the payload bounded — new
   * completions always sort to the top so they're never crowded out.
   */
  listPromptCandidates(userId: string) {
    return dbQuery(
      `SELECT b.id AS booking_id, b.listing_id, b.provider_id, b.service_category,
              b.scheduled_date, b.end_date,
              l.name AS listing_name, l.category AS listing_category
       FROM bookings b
       LEFT JOIN listings l ON l.id = b.listing_id
       WHERE b.user_id = $1
         AND (
           b.status = 'completed'
           OR (b.status IN ('confirmed', 'in_progress') AND b.scheduled_date < CURRENT_DATE)
         )
         AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id)
       ORDER BY COALESCE(b.end_date, b.scheduled_date) DESC, b.created_at DESC
       LIMIT 20`,
      [userId]
    );
  }

  create(userId: string, payload: Record<string, unknown>) {
    const record = Object.fromEntries(
      Object.entries(payload).filter(([key]) => REVIEW_MUTABLE_FIELDS.has(key))
    );

    const entries = Object.entries({ ...record, user_id: userId });
    const columns = entries.map(([key]) => `"${key}"`);
    const placeholders = entries.map((_, index) => `$${index + 1}`);
    const values = entries.map(([, value]) => value);

    return dbQuery(
      `INSERT INTO reviews (${columns.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING *`,
      values
    );
  }

  /**
   * Record a per-user "helpful" vote and bump the counter only on the first
   * vote for this (review, user). Repeat calls are idempotent — they return the
   * current review row without incrementing. Returns an empty result when the
   * review doesn't exist so the service can raise NotFound.
   */
  incrementHelpful(reviewId: string, userId: string) {
    return dbTransaction(async (client) => {
      // Insert the vote only if the review exists; ON CONFLICT makes repeat
      // votes by the same user a no-op. rowCount === 1 means this is the user's
      // first vote on an existing review — the only case that bumps the counter.
      const vote = await client.query(
        `INSERT INTO review_helpful_votes (review_id, user_id)
         SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM reviews WHERE id = $1)
         ON CONFLICT (review_id, user_id) DO NOTHING`,
        [reviewId, userId]
      );

      if (vote.rowCount && vote.rowCount > 0) {
        return client.query(
          `UPDATE reviews
           SET helpful_count = COALESCE(helpful_count, 0) + 1
           WHERE id = $1
           RETURNING *`,
          [reviewId]
        );
      }
      // Either already voted (returns the current row) or the review doesn't
      // exist (returns no rows → service raises NotFound).
      return client.query(`SELECT * FROM reviews WHERE id = $1`, [reviewId]);
    });
  }
}

export const reviewsRepository = new ReviewsRepository();
