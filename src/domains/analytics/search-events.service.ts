import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { hasTrackingConsent } from "@/lib/tracking-consent";
import type { ServiceResult } from "@/types/domain";

export interface DateRangeEventInput {
  /** Marketplace surface the range was picked on. Defaults to "stay". */
  listingType?: "stay" | "service" | "transport";
  /** Check-in day, YYYY-MM-DD. */
  fromDate: string;
  /** Check-out day, YYYY-MM-DD. */
  toDate: string;
  /** Optional snapshot of whatever search context was active (query, location). */
  context?: Record<string, unknown>;
}

/**
 * Logs marketplace search signals (date-range selections, etc.) to the
 * backend, which appends them to the `search_events` DynamoDB table.
 * Fire-and-forget from the caller's perspective — failures are swallowed so
 * analytics never disrupts the browsing flow.
 */
export class SearchEventsService {
  async logDateRange(input: DateRangeEventInput): Promise<ServiceResult<{ searchId: string }>> {
    // CONSENT GATE (LEG-014): search signals are measurement, not function —
    // nothing leaves the browser until the user allows analytics in the banner.
    if (!hasTrackingConsent()) return { success: false, code: "analytics_consent_denied" };
    return apiRequest<{ searchId: string }>("/api/search/events/date-range", {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify({
        listingType: input.listingType ?? "stay",
        fromDate: input.fromDate,
        toDate: input.toDate,
        ...(input.context ? { context: input.context } : {}),
      }),
    });
  }
}

let _instance: SearchEventsService | null = null;

export function getSearchEventsService() {
  if (!_instance) _instance = new SearchEventsService();
  return _instance;
}
