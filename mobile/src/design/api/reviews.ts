// design/api/reviews.ts — read guest reviews for a listing (stays + services + transport).
// GET /api/reviews/listing/:id resolves stays by stay_id and service/transport by provider_id.
import { api } from "@/lib/api";
import { Review } from "../types";
import { kindOf } from "./bookings";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const reviewWhen = (iso?: string) => {
  if (!iso) return "Verified review";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Verified review";
  return `Reviewed in ${MON[d.getMonth()]} ${d.getFullYear()}`;
};

export function mapReview(r: any): Review {
  return {
    name: r.metadata?.display_name || r.display_name || "Guest",
    when: reviewWhen(r.created_at),
    rating: Number(r.rating) || 0,
    text: r.comment || r.review_text || r.title || "",
  };
}

export async function fetchListingReviews(listingId: string): Promise<Review[]> {
  const res = await api.get(`/api/reviews/listing/${listingId}`);
  const items = res.data?.data ?? res.data ?? [];
  return (Array.isArray(items) ? items : []).map(mapReview);
}

/**
 * Create a review for a completed booking. The server's eligibility check
 * (findEligibleBookingForReview) matches `stay_id` against the booking's
 * `listing_id` for EVERY listing type, and reviews are read back by listing id
 * via GET /api/reviews/listing/:id — so we send `stay_id = listingId` for
 * stays, services AND transport (verified against real data). `provider_id` is
 * only a fallback if a listing id isn't available.
 */
export async function createReview(params: {
  kind: "stay" | "service" | "transport";
  listingId?: string;
  providerId?: string;
  /** WHICH booking is being reviewed — the server pins the review to it after
   *  re-verifying ownership/eligibility (spoofed ids are ignored). */
  bookingId?: string;
  rating: number;
  comment: string;
  displayName?: string;
}): Promise<void> {
  const body: Record<string, any> = {
    rating: params.rating,
    comment: params.comment,
    title: params.comment.slice(0, 60),
  };
  if (params.listingId) body.stay_id = params.listingId;
  else if (params.providerId) body.provider_id = params.providerId;
  if (params.bookingId) body.booking_id = params.bookingId;
  if (params.displayName) body.metadata = { display_name: params.displayName };
  await api.post("/api/reviews", body);
}

/** One finished-but-unreviewed booking from GET /api/reviews/me/pending —
 *  feeds the post-completion review prompt (ReviewPromptHost). */
export type PendingReviewPrompt = {
  bookingId: string;
  listingId?: string | null;
  providerId?: string | null;
  listingName?: string | null;
  serviceCategory?: string | null;
  kind: "stay" | "service" | "transport";
};

export async function fetchPendingReviewPrompts(): Promise<PendingReviewPrompt[]> {
  const res = await api.get("/api/reviews/me/pending");
  const items = res.data?.data ?? [];
  return (Array.isArray(items) ? items : []).map((row: any) => ({
    bookingId: String(row.bookingId),
    listingId: row.listingId ?? null,
    providerId: row.providerId ?? null,
    listingName: row.listingName ?? null,
    serviceCategory: row.serviceCategory ?? null,
    // Same category→vertical rule the dashboards use (kindOf in bookings.ts).
    kind: kindOf(String(row.serviceCategory ?? row.listingCategory ?? "")),
  }));
}
