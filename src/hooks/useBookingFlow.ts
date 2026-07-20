/**
 * useBookingFlow — Extracted booking business logic
 *
 * Uses backend-owned booking holds and payment verification.
 */

import { useState, useEffect, useCallback } from "react";
import { getBookingService, getPaymentService } from "@/domains";
import { trackRazorpayFailure } from "@/lib/razorpay-checkout";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

/**
 * Inject guest name into a JSON-encoded notes string. If the caller already
 * passed structured JSON, we merge; if it's free text or empty, we wrap it
 * into a JSON object that preserves the original under `freeText`.
 */
function mergeGuestNameIntoNotes(notes: string | undefined, guestName: string | null): string | undefined {
  if (!guestName) return notes;
  if (!notes) return JSON.stringify({ guestName });
  try {
    const parsed = JSON.parse(notes);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, guestName: parsed.guestName ?? guestName });
    }
  } catch { /* free-text */ }
  return JSON.stringify({ freeText: notes, guestName });
}


export type BookingStep =
  | "details"
  | "confirm"
  | "locking"
  | "claiming"
  | "rejected"
  | "slot_lost"
  | "payment_failed"
  | "payment_pending"
  | "safety"
  | "success";

interface SelectedSlot {
  provider_id: string;
  provider_name: string;
  start_time: string;
  end_time: string;
  estimated_travel_minutes: number;
  distance_km: number;
  is_zone_optimized: boolean;
  score: number;
}

interface UseBookingFlowParams {
  serviceCategory: string;
  isOpen: boolean;
}

function createIdempotencyKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const RAZORPAY_CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

function loadRazorpayCheckoutScript(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Razorpay checkout is only available in the browser."));
  }

  if (window.Razorpay) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_CHECKOUT_SRC}"]`);
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", () => reject(new Error("Unable to load Razorpay checkout.")), { once: true });
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

interface ActivePaymentOrder {
  orderId: string;
  amount: number;
  amountPaise: number;
  currency: "INR" | "USD";
  keyId: string;
  bookingId: string;
  paymentId?: string;
  status?: string;
  idempotencyKey: string;
}

export function useBookingFlow({ serviceCategory }: UseBookingFlowParams) {
  const { user } = useAuth();
  const bookingService = getBookingService();
  const paymentService = getPaymentService();

  const [step, setStep] = useState<BookingStep>("details");
  const [selectedSlot, setSelectedSlot] = useState<SelectedSlot | null>(null);
  const [selectedDate, setSelectedDate] = useState("");
  const [holdBookingId, setHoldBookingId] = useState<string | null>(null);
  const [lockId, setLockId] = useState<string | null>(null);
  const [lockExpiresAt, setLockExpiresAt] = useState<Date | null>(null);
  const [lockCountdown, setLockCountdown] = useState(0);
  const [bookingResult, setBookingResult] = useState<any>(null);
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const [activePaymentOrder, setActivePaymentOrder] = useState<ActivePaymentOrder | null>(null);
  // Store the price that was agreed upon at hold creation time.
  // This prevents mismatches if dynamic pricing changes between hold and payment.
  const [agreedPrice, setAgreedPrice] = useState<number | null>(null);

  useEffect(() => {
    if (!lockExpiresAt) return;
    const tick = () => {
      const remaining = Math.max(0, Math.floor((lockExpiresAt.getTime() - Date.now()) / 1000));
      setLockCountdown(remaining);
      if (remaining <= 0) {
        setLockId(null);
        setLockExpiresAt(null);
        setHoldBookingId(null);
        setActivePaymentOrder(null);
        if (step === "confirm" || step === "payment_failed" || step === "claiming") {
          setStep("slot_lost");
          toast.error("Your slot reservation expired. Please try again.");
        }
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [lockExpiresAt, step]);

  const releaseLock = useCallback(async () => {
    if (holdBookingId && user) {
      await bookingService.releaseHold(holdBookingId);
      setHoldBookingId(null);
      setLockId(null);
      setLockExpiresAt(null);
      setActivePaymentOrder(null);
    }
  }, [holdBookingId, user, bookingService]);

  const acquireLock = async (params: {
    providerId?: string;
    listingId?: string;
    scheduledDate: string;
    startTime: string;
    endTime: string;
    agreedPrice?: number;
    address?: string;
    lat?: number;
    lng?: number;
    notes?: string;
  }) => {
    if (!user) {
      toast.error("Please log in to book");
      return false;
    }

    if (!params.providerId && !params.listingId) {
      toast.error("This listing is not bookable yet. Please try again later.");
      return false;
    }

    setStep("locking");

    const result = await bookingService.createHold({
      providerId: params.providerId || undefined,
      listingId: params.listingId || undefined,
      serviceCategory,
      scheduledDate: params.scheduledDate,
      startTime: params.startTime,
      endTime: params.endTime,
      agreedPrice: params.agreedPrice,
      address: params.address,
      lat: params.lat,
      lng: params.lng,
      // Inject the guest's display name into the notes JSON so the host /
      // partner dashboard can render a real name even when the user_profiles
      // row still holds the schema default. Preserves any existing structured
      // notes the caller passed in.
      notes: mergeGuestNameIntoNotes(params.notes, user?.name || null),
      idempotencyKey: createIdempotencyKey("hold"),
    });

    if (result.success && result.data) {
      setHoldBookingId(result.data.booking.id);
      setLockId(result.data.hold.lockId);
      setLockExpiresAt(new Date(result.data.hold.expiresAt));
      setBookingResult({ booking_id: result.data.booking.id });
      // Use the SERVER-stored total — it's the authoritative number the
      // backend just computed (subtotal + platform fee + GST + coupon).
      // Falling back to the local estimate keeps legacy callers working
      // until they migrate.
      const serverPaise = result.data.booking.agreedPricePaise;
      const serverRupees = typeof serverPaise === "number" && serverPaise > 0
        ? serverPaise / 100
        : null;
      setAgreedPrice(serverRupees ?? params.agreedPrice ?? null);
      setStep("confirm");
      toast.success("Slot reserved for 5 minutes!");
      return true;
    }

    setStep("slot_lost");
    toast.error(result.error || "Slot unavailable");
    return false;
  };

  const claimSlot = async (params: {
    amount: number;
    insurance?: { premium: number; coverage: number };
  }) => {
    if (!user || !holdBookingId) {
      toast.error("Please log in");
      return null;
    }

    // Always use the price agreed at hold time to prevent mismatches
    // if dynamic pricing changed between "Book Now" and "Confirm & Pay"
    const paymentAmount = agreedPrice ?? params.amount;

    if (!paymentAmount || paymentAmount <= 0 || !Number.isFinite(paymentAmount)) {
      toast.error("Invalid price. Please close and try booking again.");
      setStep("payment_failed");
      return null;
    }

    setStep("claiming");

    const paymentKey = activePaymentOrder?.idempotencyKey ?? createIdempotencyKey("payment");
    const orderResult = activePaymentOrder
      ? { success: true as const, data: activePaymentOrder }
      : await paymentService.createOrder({
          bookingId: holdBookingId,
          amount: paymentAmount,
          currency: "INR",
          insuranceOptIn: Boolean(params.insurance),
          idempotencyKey: paymentKey,
        });

    if (!orderResult.success || !orderResult.data) {
      setStep("payment_failed");
      toast.error(orderResult.error || "Unable to start payment");
      return null;
    }

    const paymentOrder = {
      ...orderResult.data,
      idempotencyKey: paymentKey,
    };
    setActivePaymentOrder(paymentOrder);

    // Mock payment mode: skip Razorpay checkout and auto-verify
    const isMockPayment = paymentOrder.keyId === "rzp_test_mock" || paymentOrder.orderId?.startsWith("order_mock_");

    if (isMockPayment) {
      const verifyResult = await paymentService.verifyPayment({
        bookingId: holdBookingId,
        razorpay_order_id: paymentOrder.orderId,
        razorpay_payment_id: `pay_mock_${Date.now()}`,
        razorpay_signature: "mock_signature",
        idempotencyKey: paymentKey,
      });

      if (!verifyResult.success) {
        setStep("payment_failed");
        toast.error(verifyResult.error || "Payment verification failed");
        return null;
      }

      const payload = {
        bookingId: holdBookingId,
        booking_id: holdBookingId,
        payment_id: verifyResult.data?.paymentId,
        queuePosition: 1,
        queue_position: 1,
        success: true,
      };

      setActivePaymentOrder(null);
      setBookingResult(payload);
      setLockId(null);
      setLockExpiresAt(null);
      return payload;
    }

    // Real Razorpay payment flow
    try {
      await loadRazorpayCheckoutScript();

      if (!window.Razorpay) {
        throw new Error("Razorpay checkout failed to initialize.");
      }

      return await new Promise((resolve) => {
        const razorpay = new window.Razorpay({
          key: paymentOrder.keyId,
          order_id: paymentOrder.orderId,
          amount: paymentOrder.amountPaise,
          currency: paymentOrder.currency,
          name: "IstaSeva",
          description: `${serviceCategory} booking`,
          prefill: {
            email: user.email,
            contact: user.phone,
            name: user.name,
          },
          notes: {
            bookingId: holdBookingId,
          },
          modal: {
            ondismiss: () => {
              trackRazorpayFailure(null, { listingType: "service" });
              setStep("confirm");
              toast.message("Payment window closed. Your hold is still active until the timer expires.");
              resolve(null);
            },
          },
          handler: async (response) => {
            const verifyResult = await paymentService.verifyPayment({
              bookingId: holdBookingId,
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
              idempotencyKey: paymentKey,
            });

            if (!verifyResult.success) {
              setStep("payment_failed");
              toast.error(verifyResult.error || "Payment verification failed");
              resolve(null);
              return;
            }

            // Razorpay accepted the payment but the captured webhook hasn't
            // landed yet — keep the hold/state intact and surface a "processing"
            // message instead of declaring the booking confirmed.
            if (verifyResult.data?.pending) {
              setStep("payment_pending");
              toast.message("Payment is processing; we’ll confirm once Razorpay capture completes.");
              resolve(null);
              return;
            }

            const payload = {
              bookingId: holdBookingId,
              booking_id: holdBookingId,
              payment_id: verifyResult.data?.paymentId,
              queuePosition: 1,
              queue_position: 1,
              success: true,
            };

            setActivePaymentOrder(null);
            setBookingResult(payload);
            setLockId(null);
            setLockExpiresAt(null);
            resolve(payload);
          },
          theme: {
            color: "#0f766e",
          },
        });

        razorpay.on("payment.failed", (payload) => {
          trackRazorpayFailure(payload, { listingType: "service" });
          setStep("payment_failed");
          toast.error("Payment failed. Your slot hold is still active until the timer expires.");
          resolve(null);
        });

        razorpay.open();
      });
    } catch (error) {
      setStep("payment_failed");
      toast.error(error instanceof Error ? error.message : "Unable to open Razorpay checkout");
      return null;
    }
  };

  // `releaseHold` defaults true — most callers want to free the slot when
  // bailing out of an unfinished booking. Pass false from close-handlers when
  // the booking is already confirmed or its payment is pending capture; in
  // those cases we must NOT release the slot or we'd undo a paid booking
  // (success) or race with the payment.captured webhook (payment_pending).
  const reset = (options?: { releaseHold?: boolean }) => {
    if (options?.releaseHold !== false) {
      releaseLock();
    } else {
      setHoldBookingId(null);
      setLockId(null);
      setLockExpiresAt(null);
    }
    setStep("details");
    setSelectedSlot(null);
    setSelectedDate("");
    setBookingResult(null);
    setQueuePosition(null);
    setActivePaymentOrder(null);
    setAgreedPrice(null);
  };

  return {
    step,
    setStep,
    selectedSlot,
    setSelectedSlot,
    selectedDate,
    setSelectedDate,
    holdBookingId,
    lockId,
    lockCountdown,
    bookingResult,
    queuePosition,
    agreedPrice,
    acquireLock,
    claimSlot,
    releaseLock,
    reset,
  };
}
