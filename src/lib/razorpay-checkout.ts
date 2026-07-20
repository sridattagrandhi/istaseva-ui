/**
 * Razorpay checkout helper — shared between the booking modal flow and the
 * agent-driven "Confirm & Pay" card in the assistant.
 *
 * We deliberately keep this a standalone helper (not a React hook) so it can
 * be called imperatively from a button click in any component without
 * pulling in the whole useBookingFlow state machine.
 */

import { getAnalyticsEventsService } from "@/domains/analytics/events.service";

const RAZORPAY_CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

// Razorpay's payment.failed payload. Only the categorical fields go to
// analytics — error.description is free text and can echo user input, so it
// stays out (DPDP).
interface RazorpayFailurePayload {
  error?: {
    code?: string;
    step?: string;
    source?: string;
    reason?: string;
    description?: string;
  };
}

// One payment_failed per outcome, emitted centrally so every checkout surface
// (marketplace modal, legacy modals, assistant card) reports identically.
// Pass Razorpay's payment.failed payload, or null for a user dismiss.
// NOTE for rollups: client-side failures other than user_dismissed are ALSO
// reported authoritatively by the payment.failed webhook (platform:'server');
// the rollup counts server events + client user_dismissed only, and keeps the
// rest as diagnostics.
export function trackRazorpayFailure(
  payload: unknown,
  analytics?: RazorpayLaunchParams["analytics"],
): void {
  const failure = payload as RazorpayFailurePayload | null | undefined;
  getAnalyticsEventsService().track("payment_failed", {
    ...(analytics?.listingId ? { listingId: analytics.listingId } : {}),
    ...(analytics?.listingType ? { listingType: analytics.listingType } : {}),
    source: "razorpay_checkout",
    props: {
      reasonCode: failure ? String(failure.error?.code ?? "unknown") : "user_dismissed",
      ...(failure?.error?.step ? { step: failure.error.step } : {}),
      ...(failure?.error?.source ? { src: failure.error.source } : {}),
    },
  });
}

export function loadRazorpayCheckoutScript(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Razorpay checkout is only available in the browser."));
  }
  if (window.Razorpay) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_CHECKOUT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Unable to load Razorpay checkout.")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = RAZORPAY_CHECKOUT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Unable to load Razorpay checkout."));
    document.body.appendChild(script);
  });
}

export interface RazorpayLaunchParams {
  keyId: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  bookingId: string;
  description: string;
  prefill?: { email?: string; contact?: string; name?: string };
  /** Listing context for the payment_failed analytics event. */
  analytics?: { listingId?: string; listingType?: "stay" | "service" | "transport" };
  onSuccess: (response: RazorpayCheckoutResponse) => void | Promise<void>;
  onDismiss?: () => void;
  onFailure?: (payload?: unknown) => void;
}

/**
 * Opens Razorpay checkout. Handles the mock-order shortcut so dev envs
 * without Razorpay credentials can still complete the flow.
 *
 * Returns true if the mock path fired onSuccess synchronously, false if
 * the real Razorpay modal was opened (success/failure will come via the
 * callbacks).
 */
export async function launchRazorpayCheckout(params: RazorpayLaunchParams): Promise<boolean> {
  const isMock = params.keyId === "rzp_test_mock" || params.orderId?.startsWith("order_mock_");
  if (isMock) {
    await params.onSuccess({
      razorpay_order_id: params.orderId,
      razorpay_payment_id: `pay_mock_${Date.now()}`,
      razorpay_signature: "mock_signature",
    });
    return true;
  }

  await loadRazorpayCheckoutScript();
  if (!window.Razorpay) throw new Error("Razorpay checkout failed to initialize.");

  const rp = new window.Razorpay({
    key: params.keyId,
    order_id: params.orderId,
    amount: params.amountPaise,
    currency: params.currency,
    name: "IstaSeva",
    description: params.description,
    prefill: params.prefill,
    notes: { bookingId: params.bookingId },
    modal: {
      ondismiss: () => {
        trackRazorpayFailure(null, params.analytics);
        params.onDismiss?.();
      },
    },
    handler: async (resp) => { await params.onSuccess(resp); },
    theme: { color: "#0f766e" },
  });
  rp.on("payment.failed", (payload) => {
    trackRazorpayFailure(payload, params.analytics);
    params.onFailure?.(payload);
  });
  rp.open();
  return false;
}
