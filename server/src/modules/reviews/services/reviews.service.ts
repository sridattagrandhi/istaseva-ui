import { ForbiddenError, NotFoundError, ValidationError } from '../../../common/errors/app-error.js';
import { bookingsRepository } from '../../bookings/repositories/bookings.repository.js';
import { reviewsRepository } from '../repositories/reviews.repository.js';
import { trackServerEvent } from '../../analytics/services/analytics-track.js';

// Public review lists must not expose the reviewer's account id (a stable
// identifier that lets anyone correlate one user's reviews across listings).
// Display uses metadata.display_name; nothing client-side keys on user_id.
const stripReviewerId = (row: Record<string, unknown>) => {
  const { user_id: _reviewerId, ...rest } = row;
  return rest;
};

export class ReviewsService {
  async listByStay(stayId: string) {
    const result = await reviewsRepository.listByStay(stayId);
    return { data: result.rows.map((row) => stripReviewerId(row as Record<string, unknown>)) };
  }

  async listByListing(listingId: string) {
    const result = await reviewsRepository.listByListing(listingId);
    return { data: result.rows.map((row) => stripReviewerId(row as Record<string, unknown>)) };
  }

  /** Finished-but-unreviewed bookings for the signed-in user — feeds the
   *  post-completion review prompt on web + mobile. Client-facing camelCase;
   *  the clients decide which candidates to actually surface (first-run
   *  backlog seeding + dismissals live device-side). */
  async pendingPrompts(userId: string) {
    const result = await reviewsRepository.listPromptCandidates(userId);
    return {
      data: result.rows.map((row) => ({
        bookingId: row.booking_id,
        listingId: row.listing_id,
        providerId: row.provider_id,
        listingName: row.listing_name,
        listingCategory: row.listing_category,
        serviceCategory: row.service_category,
        scheduledDate: row.scheduled_date,
        endDate: row.end_date,
      })),
    };
  }

  async create(userId: string, payload: Record<string, unknown>) {
    // Reviews must be tied to a real experience — the user has to have a
    // qualifying booking (completed, or past its scheduled date and still
    // confirmed/in-progress) for the listing or provider being reviewed.
    const stayId = typeof payload.stay_id === 'string' && payload.stay_id.trim() !== ''
      ? payload.stay_id.trim()
      : null;
    const providerId = typeof payload.provider_id === 'string' && payload.provider_id.trim() !== ''
      ? payload.provider_id.trim()
      : null;

    if (!stayId && !providerId) {
      throw new ValidationError('Review must reference a stay_id or provider_id.');
    }

    // When the client names the booking it's reviewing (booking card / review
    // prompt), prefer pinning to THAT booking — the repository re-verifies
    // ownership + eligibility, so a spoofed or foreign id is simply ignored
    // rather than trusted. Non-UUID values never reach the ::uuid cast.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const preferredBookingId = typeof payload.booking_id === 'string' && UUID_RE.test(payload.booking_id.trim())
      ? payload.booking_id.trim()
      : null;

    const eligible = await bookingsRepository.findEligibleBookingForReview(userId, stayId, providerId, preferredBookingId);
    if (!eligible.rows[0]) {
      // Also fires when every qualifying booking already carries a review —
      // one review per booking.
      throw new ForbiddenError(
        'You can only review a listing or service after completing a booking with them, and each booking can be reviewed once.',
      );
    }

    // Pin the review to the qualifying booking so we can show "Verified stay"
    // / "Verified service" badges and prevent duplicate reviews per booking
    // later. Caller-supplied booking_id is overridden to keep this trustworthy.
    const result = await reviewsRepository.create(userId, {
      ...payload,
      booking_id: eligible.rows[0].id,
    });
    // Analytics: review count + rating (for average-rating rollup).
    const rating = Number(payload.rating);
    trackServerEvent('review_submitted', {
      userId,
      listingId: stayId ?? undefined,
      listingType: stayId ? 'stay' : undefined,
      source: 'server',
      props: { rating: Number.isFinite(rating) ? rating : 0 },
    });
    return { data: result.rows[0] };
  }

  async incrementHelpful(reviewId: string, userId: string) {
    const result = await reviewsRepository.incrementHelpful(reviewId, userId);

    if (!result.rows[0]) throw new NotFoundError('Review', reviewId);
    return { data: result.rows[0] };
  }
}

export const reviewsService = new ReviewsService();
