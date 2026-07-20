// design/api/payment.ts — booking payment orchestration.
// prepare (server prices + creates the Razorpay order) → checkout → verify.
//
// Two checkout paths, chosen at runtime so one build works everywhere:
//   • REAL: a live Razorpay key ("rzp_...") AND the native SDK is present →
//     open the native checkout sheet, then verify the real payment signature.
//   • MOCK: dev backend issues a mock order (no live key) or the native module
//     is absent (Expo Go) → verify with the mock signature the dev server
//     accepts. Lets the flow complete end-to-end without a native build.
import { prepareBooking, verifyBooking, CreateBookingInput, PreparedBooking } from "./bookings";
import { track } from "./analyticsEvents";

// Native module is unavailable in Expo Go — require lazily so importing this
// file never throws there. `RazorpayCheckout` stays null when absent.
type RazorpayCheckoutResult = { razorpay_payment_id: string; razorpay_signature: string };
let RazorpayCheckout: { open: (opts: Record<string, unknown>) => Promise<RazorpayCheckoutResult> } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  RazorpayCheckout = require("react-native-razorpay").default;
} catch {
  RazorpayCheckout = null;
}

// A real Razorpay key looks like "rzp_live_..." / "rzp_test_<realchars>". The
// dev backend returns the sentinel "rzp_test_mock" with a "order_mock_..." order
// — those must NOT open native checkout (Razorpay would reject the fake order).
const isLiveKey = (k?: string) => !!k && k.startsWith("rzp_") && !k.includes("mock");
const isMockOrder = (orderId?: string) => !orderId || orderId.includes("mock");

/** Thrown when the user dismisses the Razorpay sheet (vs a real failure). */
export class PaymentCancelledError extends Error {
  constructor() {
    super("Payment was cancelled.");
    this.name = "PaymentCancelledError";
  }
}

export type PayerInfo = { name?: string; email?: string; contact?: string; description?: string };

/**
 * Prepare + pay + verify a booking. Returns the confirmed {bookingId, amount}
 * (amount is the server total). Throws PaymentCancelledError on user dismissal
 * and a generic Error on failure — callers should NOT show a confirmation in
 * either case.
 */
export async function payForBooking(
  input: CreateBookingInput,
  payer: PayerInfo = {},
): Promise<{ bookingId: string; amount: number; driver?: PreparedBooking["driver"]; pending?: boolean }> {
  const prep = await prepareBooking(input);
  return payPreparedBooking(prep, payer);
}

/**
 * Checkout + verify for an ALREADY-prepared booking (hold + order exist).
 * Used both by payForBooking and by the AI assistant's inline Confirm & Pay
 * card, where the agent's prepare_booking tool created the hold server-side.
 */
export async function payPreparedBooking(
  prep: Pick<PreparedBooking, "bookingId" | "orderId" | "keyId" | "amount" | "amountPaise" | "currency" | "driver">,
  payer: PayerInfo = {},
): Promise<{ bookingId: string; amount: number; driver?: PreparedBooking["driver"]; pending?: boolean }> {
  if (RazorpayCheckout && isLiveKey(prep.keyId) && !isMockOrder(prep.orderId)) {
    let result: RazorpayCheckoutResult;
    try {
      result = await RazorpayCheckout.open({
        key: prep.keyId,
        order_id: prep.orderId,
        amount: prep.amountPaise,
        currency: prep.currency,
        name: "IstaSeva",
        description: payer.description || "Booking",
        prefill: { name: payer.name, email: payer.email, contact: payer.contact },
        theme: { color: "#8b5e4a" },
      });
    } catch (e) {
      // react-native-razorpay rejects with { code, description } on cancel.
      // Categorical reasonCode only in analytics — never e.description (free
      // text, can contain PII). Web mirror: trackRazorpayFailure in
      // src/lib/razorpay-checkout.ts; the rollup counts user_dismissed from
      // clients and everything else from the payment.failed webhook.
      const err = e as { code?: number; description?: string; message?: string } | null | undefined;
      if (err && (err.code === 0 || err.code === 2 || /cancel/i.test(String(err?.description || err?.message)))) {
        void track("payment_failed", { source: "razorpay_checkout", props: { reasonCode: "user_dismissed" } });
        throw new PaymentCancelledError();
      }
      void track("payment_failed", { source: "razorpay_checkout", props: { reasonCode: String(err?.code ?? "unknown") } });
      throw new Error(err?.description || err?.message || "Payment failed.");
    }
    const verified = await verifyBooking({
      bookingId: prep.bookingId,
      orderId: prep.orderId,
      paymentId: result.razorpay_payment_id,
      signature: result.razorpay_signature,
    });
    return { bookingId: prep.bookingId, amount: prep.amount, driver: prep.driver, pending: verified.pending };
  }

  // Dev / mock-payments backend — no live order to open. Verify with the mock
  // signature the dev server accepts so the booking still confirms.
  const verified = await verifyBooking({
    bookingId: prep.bookingId,
    orderId: prep.orderId,
    paymentId: "pay_mock_" + prep.bookingId.slice(0, 8),
    signature: "mock_signature",
  });
  return { bookingId: prep.bookingId, amount: prep.amount, driver: prep.driver, pending: verified.pending };
}
