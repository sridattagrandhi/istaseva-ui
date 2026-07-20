// design/api/searchEvents.ts — marketplace search analytics (date-range signals).
//
// Mobile mirror of the web `src/domains/analytics/search-events.service.ts`.
// Logs completed date-range selections to the backend, which appends them to the
// `search_events` DynamoDB table. Fire-and-forget: failures are swallowed so
// analytics never disrupts browsing. The endpoint is optionalAuth, so the axios
// client's token injection captures the userId when signed in and anonymous
// browsing still logs.
import { api } from "@/lib/api";
import { hasAnalyticsConsent } from "./analyticsEvents";

export type DateRangeEventInput = {
  /** Marketplace surface the range was picked on. Defaults to "stay". */
  listingType?: "stay" | "service" | "transport";
  /** Check-in day, YYYY-MM-DD. */
  fromDate: string;
  /** Check-out day, YYYY-MM-DD. */
  toDate: string;
  /** Optional snapshot of whatever search context was active (query, location). */
  context?: Record<string, unknown>;
};

/** Best-effort POST /api/search/events/date-range. Never throws. */
export async function logDateRange(input: DateRangeEventInput): Promise<void> {
  // CONSENT GATE (LEG-014): search signals are measurement, not function —
  // nothing is sent until "Usage analytics" is enabled in Privacy & safety.
  if (!(await hasAnalyticsConsent())) return;
  try {
    await api.post("/api/search/events/date-range", {
      listingType: input.listingType ?? "stay",
      fromDate: input.fromDate,
      toDate: input.toDate,
      ...(input.context ? { context: input.context } : {}),
    });
  } catch {
    // analytics is non-blocking — ignore network/auth failures.
  }
}
