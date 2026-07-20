import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiRequest } from "@/lib/api-client";
import { setTrackingConsent } from "@/lib/tracking-consent";
import { getSearchEventsService } from "./search-events.service";

vi.mock("@/lib/api-client", () => ({
  apiRequest: vi.fn().mockResolvedValue({ success: true, data: { searchId: "s1" } }),
  getJsonHeaders: vi.fn().mockReturnValue({}),
}));

/**
 * CONSENT GATE (LEG-014). search_events is measurement, not function — this
 * sender historically bypassed the banner choice and logged the user's search
 * query + place against their userId regardless of consent. These pin the
 * gate so it can't silently regress again.
 */
describe("search-events consent gate (LEG-014)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(apiRequest).mockClear();
  });

  const input = { fromDate: "2026-08-01", toDate: "2026-08-03" } as const;

  it("does NOT hit the network when consent is denied", async () => {
    setTrackingConsent(false);
    const result = await getSearchEventsService().logDateRange(input);
    expect(apiRequest).not.toHaveBeenCalled();
    // Nothing was logged — the result must say so, not pretend success.
    expect(result.success).toBe(false);
    expect(result.code).toBe("analytics_consent_denied");
  });

  it("does NOT hit the network before any choice is made (unset)", async () => {
    const result = await getSearchEventsService().logDateRange(input);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("logs normally once consent is granted", async () => {
    setTrackingConsent(true);
    const result = await getSearchEventsService().logDateRange(input);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiRequest).mock.calls[0][0]).toBe("/api/search/events/date-range");
    expect(result.success).toBe(true);
  });
});
