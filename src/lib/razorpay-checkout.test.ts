import { describe, expect, it, vi, beforeEach } from "vitest";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/domains/analytics/events.service", () => ({
  getAnalyticsEventsService: () => ({ track }),
}));

import { trackRazorpayFailure } from "./razorpay-checkout";

beforeEach(() => track.mockClear());

describe("trackRazorpayFailure — payment_failed analytics", () => {
  it("reports user_dismissed for a null payload (modal dismiss)", () => {
    trackRazorpayFailure(null, { listingId: "l1", listingType: "stay" });
    expect(track).toHaveBeenCalledWith("payment_failed", {
      listingId: "l1",
      listingType: "stay",
      source: "razorpay_checkout",
      props: { reasonCode: "user_dismissed" },
    });
  });

  it("keeps categorical fields and drops the free-text description (DPDP)", () => {
    trackRazorpayFailure(
      {
        error: {
          code: "BAD_REQUEST_ERROR",
          step: "payment_authorization",
          source: "bank",
          reason: "payment_failed",
          description: "Card declined for Anita Sharma", // must never reach analytics
        },
      },
      { listingType: "service" },
    );
    const [eventType, input] = track.mock.calls[0];
    expect(eventType).toBe("payment_failed");
    expect(input.props).toEqual({
      reasonCode: "BAD_REQUEST_ERROR",
      step: "payment_authorization",
      src: "bank",
    });
    expect(JSON.stringify(input)).not.toContain("Anita");
  });

  it("falls back to 'unknown' when the payload carries no error code", () => {
    trackRazorpayFailure({ error: {} });
    expect(track.mock.calls[0][1].props.reasonCode).toBe("unknown");
  });

  it("omits listing fields when no analytics context is provided", () => {
    trackRazorpayFailure(null);
    const input = track.mock.calls[0][1];
    expect(input.listingId).toBeUndefined();
    expect(input.listingType).toBeUndefined();
  });
});
