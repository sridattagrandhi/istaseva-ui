/**
 * Review Domain Service
 */

import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import type { Review, ServiceResult, UUID } from "@/types/domain";

/** One finished-but-unreviewed booking, as served by GET /api/reviews/me/pending. */
export interface PendingReviewPrompt {
  bookingId: string;
  listingId: string | null;
  providerId: string | null;
  listingName: string | null;
  serviceCategory: string | null;
}

export class ReviewService {
  async getByStayId(stayId: string): Promise<ServiceResult<Review[]>> {
    const result = await apiRequest<{ data: any[] }>(`/api/reviews/stay/${stayId}`);
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: (result.data.data || []).map(this.mapReview) };
  }

  /** Generic listing lookup — covers stays (via `stay_id`) and
   *  service/transport (via provider_id, derived through the listing's
   *  provider_profile join). Use this from any detail page that has a
   *  listing UUID and doesn't know whether it's a stay or a provider
   *  listing. */
  async getByListingId(listingId: string): Promise<ServiceResult<Review[]>> {
    const result = await apiRequest<{ data: any[] }>(`/api/reviews/listing/${listingId}`);
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: (result.data.data || []).map(this.mapReview) };
  }

  async create(review: { userId: UUID; stayId: string; rating: number; reviewText: string; displayName: string; tags?: string[]; bookingId?: string }): Promise<ServiceResult<Review>> {
    const result = await apiRequest<{ data: any }>("/api/reviews", {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify({
        stay_id: review.stayId,
        rating: review.rating,
        title: review.reviewText.trim().slice(0, 60) || "Guest review",
        comment: review.reviewText,
        // Names WHICH booking is being reviewed so the server pins the review
        // to it (it re-verifies ownership/eligibility; spoofs are ignored).
        ...(review.bookingId ? { booking_id: review.bookingId } : {}),
        metadata: {
          display_name: review.displayName,
          tags: review.tags || [],
        },
      }),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: this.mapReview(result.data.data) };
  }

  /** Finished-but-unreviewed bookings for the signed-in user — feeds the
   *  post-completion review prompt shown on app open (ReviewPromptGate). */
  async getPendingPrompts(): Promise<ServiceResult<PendingReviewPrompt[]>> {
    const result = await apiRequest<{ data: any[] }>("/api/reviews/me/pending");
    if (!result.success || !result.data) return { success: false, error: result.error };
    return {
      success: true,
      data: (result.data.data || []).map((row) => ({
        bookingId: row.bookingId,
        listingId: row.listingId ?? null,
        providerId: row.providerId ?? null,
        listingName: row.listingName ?? null,
        serviceCategory: row.serviceCategory ?? null,
      })),
    };
  }

  async markHelpful(reviewId: UUID): Promise<ServiceResult<void>> {
    const result = await apiRequest<{ data: any }>(`/api/reviews/${reviewId}/helpful`, {
      method: "PATCH",
      headers: getJsonHeaders(),
    });
    if (!result.success) return { success: false, error: result.error };
    return { success: true };
  }

  private mapReview(row: any): Review {
    return {
      id: row.id,
      userId: row.user_id,
      stayId: row.stay_id,
      rating: row.rating,
      reviewText: row.comment || row.review_text || row.title || "",
      displayName: row.metadata?.display_name || row.display_name || "Guest",
      tags: row.metadata?.tags || row.tags || [],
      helpfulCount: row.helpful_count || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

let _instance: ReviewService | null = null;
export function getReviewService(): ReviewService {
  if (!_instance) _instance = new ReviewService();
  return _instance;
}
