import { useEffect, useMemo, useRef, useState } from "react";
import { X, Calendar as CalendarIcon, Users, Shield, CheckCircle, MessageCircle, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import InsuranceToggle from "@/components/InsuranceToggle";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { foldAvailabilityOverrides } from "@/lib/stay-pricing";
import type { Stay } from "@/types/listings";
import { getBookingService, getPaymentService, getListingService } from "@/domains";
import { getCouponsService, type CouponQuote } from "@/domains/coupons/coupons.service";
import { apiRequest } from "@/lib/api-client";
import { trackRazorpayFailure } from "@/lib/razorpay-checkout";
import { computeBookingFees, insurancePremiumRupees } from "@/lib/pricing";
import { displayRef } from "@/lib/reference";
import { toast } from "sonner";

const DEFAULT_CHECK_IN_TIME = "14:00";
const DEFAULT_CHECK_OUT_TIME = "11:00";
const RAZORPAY_CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

function formatRupees(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function loadRazorpayCheckoutScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("Browser only"));
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_CHECKOUT_SRC}"]`);
    if (existing) { existing.addEventListener("load", () => resolve(), { once: true }); existing.addEventListener("error", () => reject(new Error("Unable to load Razorpay")), { once: true }); return; }
    const s = document.createElement("script"); s.src = RAZORPAY_CHECKOUT_SRC; s.async = true;
    s.onload = () => resolve(); s.onerror = () => reject(new Error("Unable to load Razorpay")); document.body.appendChild(s);
  });
}

function createIdempotencyKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Timezone-safe "YYYY-MM-DD" ⇄ Date helpers — using `new Date("2026-04-19")`
// parses as UTC midnight and renders as the previous day in negative offsets.
function toYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseYMD(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

interface BookingModalProps {
  stay: Stay;
  isOpen: boolean;
  onClose: () => void;
  /** Selected room (for hotel-style stays). Overrides stay.price if present. */
  roomTypeId?: string;
  roomName?: string;
  roomPricePerNight?: number;
}

type BookingStep = "details" | "confirm" | "paying" | "payment_failed" | "payment_pending" | "success";

const BookingModal = ({ stay, isOpen, onClose, roomTypeId, roomName, roomPricePerNight }: BookingModalProps) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const bookingService = getBookingService();
  const paymentService = getPaymentService();

  const [step, setStep] = useState<BookingStep>("details");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [guests, setGuests] = useState(1);
  const [insurance, setInsurance] = useState(false);
  const [bookingId, setBookingId] = useState("");
  const [paymentId, setPaymentId] = useState("");
  // Backend-confirmed total in rupees — populated from PaymentOrderResult so
  // the success screen always shows what the server actually charged, not
  // the locally-computed preview number.
  const [confirmedTotal, setConfirmedTotal] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [couponCode, setCouponCode] = useState("");
  const [couponQuote, setCouponQuote] = useState<CouponQuote | null>(null);
  const [couponChecking, setCouponChecking] = useState(false);
  const [bookedDates, setBookedDates] = useState<string[]>([]);
  // Host-set per-date overrides — blocked days are unselectable, custom prices
  // replace the base nightly rate when computing the total.
  const [overrides, setOverrides] = useState<Array<{ date: string; blocked: boolean; pricePaise: number | null; roomTypeId: string | null }>>([]);

  // Tracks bookingIds we've already released so rapid-fire close clicks don't
  // hit the API twice. MUST be declared with the other hooks (before the
  // `!isOpen` early return) — putting it after the conditional return would
  // change the hook count when the modal toggles open and crash with
  // "Rendered more hooks than during the previous render".
  const releasedHoldsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isOpen || !stay?.id) return;
    let cancelled = false;
    (async () => {
      // Scope booked-dates by the selected room when present so multi-quantity
      // rooms only mark a date as full when ALL their physical rooms are taken.
      const url = `/api/listings/${stay.id}/booked-dates${roomTypeId ? `?roomTypeId=${encodeURIComponent(roomTypeId)}` : ''}`;
      const res = await apiRequest<{ dates: string[] }>(url, { method: "GET" });
      if (!cancelled && res.success && Array.isArray(res.data?.dates)) setBookedDates(res.data.dates);
    })().catch(() => { /* non-fatal; calendar still functional */ });

    (async () => {
      const today = new Date().toISOString().slice(0, 10);
      const end = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);
      const res = await getListingService().listAvailability(stay.id, today, end);
      if (!cancelled && res.success && res.data) {
        setOverrides(res.data.map((o) => ({
          date: o.date, blocked: o.blocked, pricePaise: o.pricePaise, roomTypeId: o.roomTypeId,
        })));
      }
    })().catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, [isOpen, stay?.id, roomTypeId]);

  const bookedSet = useMemo(() => new Set(bookedDates), [bookedDates]);
  // Delegate to the canonical helper so guest pricing/blocking matches
  // backend `createHold` invariants exactly:
  //   - a listing-level block applies to every room and CANNOT be undone
  //     by a room-level row
  //   - a room-level price can shadow the listing-level price only when
  //     the date is not listing-blocked
  //   - a room-level block adds a block and never removes one
  // The previous ad-hoc merge here unconditionally let any room-level row
  // win, which could surface a listing-blocked date as bookable in the UI
  // even though the backend would later reject the hold.
  const { blockedSet: overrideBlockedSet, priceByDate } = useMemo(
    () => foldAvailabilityOverrides(
      overrides.map((o) => ({ roomTypeId: o.roomTypeId, date: o.date, blocked: o.blocked, pricePaise: o.pricePaise })),
      roomTypeId ?? null,
    ),
    [overrides, roomTypeId],
  );
  const overrideForDate = useMemo(() => {
    const map = new Map<string, { blocked: boolean; pricePaise: number | null }>();
    const allDates = new Set<string>([...overrideBlockedSet, ...priceByDate.keys()]);
    for (const date of allDates) {
      map.set(date, {
        blocked: overrideBlockedSet.has(date),
        pricePaise: priceByDate.get(date) ?? null,
      });
    }
    return map;
  }, [overrideBlockedSet, priceByDate]);
  const blockedSet = overrideBlockedSet;

  if (!isOpen) return null;

  if (!user) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-foreground/50 backdrop-blur-sm" onClick={onClose} />
        <div className="relative bg-card rounded-2xl border border-border shadow-2xl w-full max-w-md p-6 space-y-4">
          <h3 className="font-display font-bold text-lg">{t("bookingModal.signInTitle", { defaultValue: "Please sign in to continue" })}</h3>
          <p className="text-sm text-muted-foreground">{t("bookingModal.signInBody", { defaultValue: "You can explore this stay freely, but booking requires an account." })}</p>
          <div className="flex gap-3">
            <Button variant="outline" className="flex-1 rounded-xl" onClick={onClose}>{t("bookingModal.close", { defaultValue: "Close" })}</Button>
            <Button className="flex-1 rounded-xl" onClick={() => navigate(`/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`)}>
              {t("bookingModal.signIn", { defaultValue: "Sign in" })}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const nights = checkIn && checkOut ? Math.max(1, Math.ceil((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000)) : 1;
  // Hotel-style stays bill at the selected room's price; everything else uses
  // the listing-level price.
  const baseNightlyPrice = roomPricePerNight && roomPricePerNight > 0 ? roomPricePerNight : stay.price;
  // Apply the host-set discount (if any) to the per-night rate so the subtotal
  // and coupon math both operate on what the guest actually pays.
  const hostDiscountPercent = Math.max(0, Math.min(90, Number(stay.discountPercent) || 0));
  const effectiveNightlyPrice = hostDiscountPercent > 0
    ? Math.round(baseNightlyPrice * (1 - hostDiscountPercent / 100))
    : baseNightlyPrice;
  // Walk the selected date range and sum nightly prices. Per-date overrides
  // (set by the host in the Calendar) replace the base rate for that night;
  // unset nights use the base. The host discount applies on top of the base
  // rate but NOT to override prices — host overrides are intentional and the
  // host already chose that exact number for that date. Computed inline (not
  // useMemo) because we sit below early-return branches where hooks aren't
  // safe to call conditionally.
  const subtotal = (() => {
    if (!checkIn || !checkOut) return effectiveNightlyPrice;
    let sum = 0;
    const cur = new Date(checkIn + "T00:00:00");
    const end = new Date(checkOut + "T00:00:00");
    while (cur < end) {
      const key = cur.toISOString().slice(0, 10);
      const ovr = overrideForDate.get(key);
      sum += ovr?.pricePaise != null ? ovr.pricePaise / 100 : effectiveNightlyPrice;
      cur.setDate(cur.getDate() + 1);
    }
    return sum;
  })();
  // PREVIEW only — the backend is the source of truth for the actual
  // total persisted on the booking and validated at payment time. We
  // mirror the backend's rates here (10% platform fee + category GST) so
  // the customer sees roughly what they'll be charged before tapping
  // "Book", but rounding can drift by ±₹1; the success screen and the
  // invoice display the server-returned amount, not these locals.
  const couponDiscount = couponQuote ? Math.min(couponQuote.discountAmount, subtotal) : 0;
  // Insurance is 2% of the host-side agreed price (subtotal + platform fee +
  // GST), clamped to ₹2–₹49. Mirrors `insurancePremiumRupees` on the server —
  // computing here would otherwise drift from what `paymentsService.createOrder`
  // stamps onto the invoice. We compute the pre-insurance breakdown first so
  // the premium is anchored to the same `agreedPricePaise` the backend uses.
  const preInsuranceFees = computeBookingFees({
    subtotal,
    category: stay.category ?? "stay",
    nightlyPaise: effectiveNightlyPrice * 100,
    discount: couponDiscount,
    insurance: 0,
  });
  const insurancePremium = insurance ? insurancePremiumRupees(preInsuranceFees.total) : 0;
  const fees = computeBookingFees({
    subtotal,
    category: stay.category ?? "stay",
    nightlyPaise: effectiveNightlyPrice * 100,
    discount: couponDiscount,
    insurance: insurancePremium,
  });
  const discountedSubtotal = fees.subtotal;
  const serviceFee = fees.platformFee;
  const taxes = fees.taxes;
  const gstRatePct = Math.round(fees.gstRate * 100);
  const total = fees.total;
  const totalPaise = total * 100;

  const handleApplyCoupon = async () => {
    const code = couponCode.trim();
    if (!code) return;
    if (!subtotal || subtotal <= 0) {
      toast.error(t("bookingModal.couponPickDates", { defaultValue: "Pick your dates first, then apply the coupon." }));
      return;
    }
    setCouponChecking(true);
    try {
      const res = await getCouponsService().validate({
        code,
        listingId: stay.id,
        basePrice: subtotal,
      });
      if (!res.success || !res.data) {
        setCouponQuote(null);
        toast.error(res.error || t("bookingModal.couponNotValid", { defaultValue: "Coupon not valid" }));
        return;
      }
      setCouponQuote(res.data);
      toast.success(t("bookingModal.couponApplied", { defaultValue: "Coupon applied — ₹{{amount}} off", amount: formatRupees(res.data.discountAmount) }));
    } finally {
      setCouponChecking(false);
    }
  };

  const handleClearCoupon = () => {
    setCouponQuote(null);
    setCouponCode("");
  };

  const handleBook = () => setStep("confirm");

  const handleConfirm = async () => {
    if (!total || total <= 0) {
      toast.error(t("bookingModal.invalidPrice", { defaultValue: "Invalid price. Please select valid dates." }));
      return;
    }
    setIsProcessing(true);
    setStep("paying");

    try {
      // Step 1: Create the hold (pending booking)
      const holdResult = await bookingService.createHold({
        providerId: stay.providerProfileId,
        listingId: stay.id,
        serviceCategory: `stay:${stay.type}`,
        scheduledDate: checkIn || new Date().toISOString().slice(0, 10),
        // Checkout date (exclusive) — server uses this to validate every
        // occupied night against existing bookings and host-blocked dates.
        endDate: checkOut || undefined,
        startTime: stay.metadata?.checkInTime || DEFAULT_CHECK_IN_TIME,
        endTime: stay.metadata?.checkOutTime || DEFAULT_CHECK_OUT_TIME,
        // Client computes the post-discount total; server validates + consumes
        // the coupon atomically inside the hold transaction and records coupon_id.
        // Insurance is added later in createOrder — NOT part of the held booking —
        // so we strip it here, otherwise the server's hold-price drift check
        // (±₹2 tolerance) would reject any stay with insurance toggled on. The
        // insurance premium is forwarded explicitly via `insuranceOptIn` below.
        agreedPrice: total - (insurance ? insurancePremium : 0),
        // Snapshot the guest's name on the booking. The dashboards normally
        // pull it from `user_profiles.display_name`, but that row can still
        // hold the schema default 'User' for accounts created before the
        // auth-middleware backfill. Stashing it in `notes` is a reliable
        // backup the host UI can fall back on.
        notes: JSON.stringify({ checkOut, guests, stayId: stay.id, stayTitle: stay.title, roomName, guestName: user?.name || null }),
        idempotencyKey: createIdempotencyKey("stay-hold"),
        couponCode: couponQuote ? couponQuote.code : undefined,
        roomTypeId,
      });

      if (!holdResult.success || !holdResult.data) {
        throw new Error(holdResult.error || t("bookingModal.errUnableReserve", { defaultValue: "Unable to reserve this stay" }));
      }

      const holdBookingId = holdResult.data.booking.id;
      setBookingId(holdBookingId);

      // Step 2: Create a payment order. The server is the source of truth
      // for the fee/GST breakdown — it persists the authoritative agreed
      // price on the booking row during the hold, and `createOrder` then
      // rejects ANY mismatch (no drift allowed). Frontend rupee-rounded math
      // can drift by a few paise vs the server's paise-precise math for
      // low-value rooms — sending `total` here would deterministically
      // fail validation. Use the server-stored `agreedPricePaise` directly
      // so the order amount matches what the hold persisted.
      const paymentKey = createIdempotencyKey("stay-payment");
      const serverAgreedPaise = holdResult.data.booking.agreedPricePaise;
      const paymentAmount = typeof serverAgreedPaise === "number" && serverAgreedPaise > 0
        ? serverAgreedPaise / 100
        : total;
      const orderResult = await paymentService.createOrder({
        bookingId: holdBookingId,
        amount: paymentAmount,
        currency: "INR",
        insuranceOptIn: insurance,
        idempotencyKey: paymentKey,
      });

      if (!orderResult.success || !orderResult.data) {
        throw new Error(orderResult.error || t("bookingModal.errUnableStartPayment", { defaultValue: "Unable to start payment" }));
      }

      const order = orderResult.data;
      // Trust the server's amount, not the local preview — the server
      // recomputes from booking + listing + coupon + insurance and is the
      // authority for what was charged.
      setConfirmedTotal(order.amount);
      const isMock = order.keyId === "rzp_test_mock" || order.orderId?.startsWith("order_mock_");

      // Step 3a: Mock payment — auto-verify
      if (isMock) {
        const verifyResult = await paymentService.verifyPayment({
          bookingId: holdBookingId,
          razorpay_order_id: order.orderId,
          razorpay_payment_id: `pay_mock_${Date.now()}`,
          razorpay_signature: "mock_signature",
          idempotencyKey: paymentKey,
        });
        if (!verifyResult.success) throw new Error(verifyResult.error || t("bookingModal.errVerifyFailed", { defaultValue: "Payment verification failed" }));
        setPaymentId(verifyResult.data?.paymentId || "");
        setStep("success");
        await queryClient.invalidateQueries({ queryKey: ["bookings"] });
        toast.success(t("bookingModal.toastConfirmed", { defaultValue: "Booking confirmed!" }));
        return;
      }

      // Step 3b: Real Razorpay checkout
      await loadRazorpayCheckoutScript();
      if (!window.Razorpay) throw new Error(t("bookingModal.errRazorpayInit", { defaultValue: "Razorpay checkout failed to initialize" }));

      await new Promise<void>((resolve, reject) => {
        const razorpay = new window.Razorpay({
          key: order.keyId,
          order_id: order.orderId,
          amount: order.amountPaise,
          currency: order.currency,
          name: "IstaSeva",
          description: t("bookingModal.razorpayStayDesc", { defaultValue: "Stay: {{title}}", title: stay.title }),
          prefill: { email: user.email, contact: user.phone, name: user.name },
          notes: { bookingId: holdBookingId },
          modal: {
            ondismiss: () => {
              trackRazorpayFailure(null, { listingId: String(stay.id), listingType: "stay" });
              setStep("confirm");
              toast.message(t("bookingModal.toastPaymentWindowClosed", { defaultValue: "Payment window closed. You can try again." }));
              resolve();
            },
          },
          handler: async (response: any) => {
            try {
              const verifyResult = await paymentService.verifyPayment({
                bookingId: holdBookingId,
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
                idempotencyKey: paymentKey,
              });
              if (!verifyResult.success) throw new Error(verifyResult.error || t("bookingModal.errVerifyFailed", { defaultValue: "Payment verification failed" }));

              if (verifyResult.data?.pending) {
                // Capture not yet confirmed by Razorpay — don't show
                // "confirmed" or invalidate booking caches as if it landed.
                setPaymentId(verifyResult.data?.paymentId || "");
                setStep("payment_pending");
                toast.message(t("bookingModal.toastProcessingCapture", { defaultValue: "Payment is processing; we’ll confirm once Razorpay capture completes." }));
                resolve();
                return;
              }

              setPaymentId(verifyResult.data?.paymentId || "");
              setStep("success");
              await queryClient.invalidateQueries({ queryKey: ["bookings"] });
              toast.success(t("bookingModal.toastConfirmed", { defaultValue: "Booking confirmed!" }));
              resolve();
            } catch (err: any) {
              setStep("payment_failed");
              toast.error(err.message || t("bookingModal.errVerifyFailed", { defaultValue: "Payment verification failed" }));
              resolve();
            }
          },
          theme: { color: "#0f766e" },
        });
        razorpay.on("payment.failed", (payload) => {
          trackRazorpayFailure(payload, { listingId: String(stay.id), listingType: "stay" });
          setStep("payment_failed");
          toast.error(t("bookingModal.toastPaymentFailed", { defaultValue: "Payment failed. Please try again." }));
          resolve();
        });
        razorpay.open();
      });
    } catch (error: any) {
      setStep("payment_failed");
      toast.error(error?.message || t("bookingModal.errUnableComplete", { defaultValue: "Unable to complete your booking" }));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRetry = () => setStep("confirm");

  const handleClose = () => {
    // Release the slot hold if the user is bailing on a pending booking that
    // never finished payment. We deliberately skip:
    //   - "success": booking already confirmed; releasing would wipe a paid slot
    //   - "payment_pending": Razorpay accepted but capture webhook is in flight,
    //     the captured webhook will confirm the booking — must not free the slot
    //   - "paying": Razorpay Checkout is up; close button is hidden in this
    //     state anyway, but defend in depth
    const idToRelease = bookingId;
    const shouldRelease =
      idToRelease &&
      step !== "success" &&
      step !== "payment_pending" &&
      step !== "paying" &&
      !releasedHoldsRef.current.has(idToRelease);

    if (shouldRelease) {
      releasedHoldsRef.current.add(idToRelease);
      // Fire-and-forget — the user shouldn't wait for the API to close the modal.
      void bookingService.releaseHold(idToRelease).catch(() => {
        // Best-effort: hold will expire on its own via TTL if this fails.
      });
    }

    setStep("details");
    setInsurance(false);
    setBookingId("");
    setPaymentId("");
    setConfirmedTotal(null);
    setCouponCode("");
    setCouponQuote(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/50 backdrop-blur-sm" onClick={step === "paying" ? undefined : handleClose} />
      <div className="relative bg-card rounded-2xl border border-border shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto animate-scale-in">
        <div className="sticky top-0 bg-card border-b border-border p-4 flex items-center justify-between rounded-t-2xl">
          <h3 className="font-display font-bold text-lg">
            {step === "success" ? t("bookingModal.hdrConfirmed", { defaultValue: "Booking Confirmed!" }) : step === "paying" ? t("bookingModal.hdrProcessingPayment", { defaultValue: "Processing Payment..." }) : step === "payment_pending" ? t("bookingModal.hdrPaymentProcessing", { defaultValue: "Payment Processing" }) : step === "payment_failed" ? t("bookingModal.hdrPaymentFailed", { defaultValue: "Payment Failed" }) : step === "confirm" ? t("bookingModal.hdrConfirmBooking", { defaultValue: "Confirm Booking" }) : t("bookingModal.hdrBookStay", { defaultValue: "Book Your Stay" })}
          </h3>
          {step !== "paying" && <button onClick={handleClose} className="p-1 hover:bg-muted rounded-lg transition-colors"><X className="w-5 h-5" /></button>}
        </div>

        <div className="p-6">
          {/* Paying step */}
          {step === "paying" && (
            <div className="text-center py-12 space-y-4">
              <Loader2 className="w-12 h-12 text-primary mx-auto animate-spin" />
              <h4 className="font-display text-lg font-semibold">{t("bookingModal.processingPayment", { defaultValue: "Processing your payment..." })}</h4>
              <p className="text-sm text-muted-foreground">{t("bookingModal.dontClose", { defaultValue: "Please don't close this window." })}</p>
            </div>
          )}

          {/* Payment processing (capture not yet confirmed) step */}
          {step === "payment_pending" && (
            <div className="text-center py-8 space-y-4">
              <Loader2 className="w-12 h-12 text-primary mx-auto animate-spin" />
              <h4 className="font-display text-lg font-semibold">{t("bookingModal.paymentIsProcessing", { defaultValue: "Payment is processing" })}</h4>
              <p className="text-sm text-muted-foreground">
                {t("bookingModal.paymentProcessingBody", { defaultValue: "We’ll confirm your booking once Razorpay finishes capturing the payment. You can close this window — we’ll notify you when it’s done." })}
              </p>
              <Button variant="outline" className="rounded-xl" onClick={handleClose}>{t("bookingModal.close", { defaultValue: "Close" })}</Button>
            </div>
          )}

          {/* Payment failed step */}
          {step === "payment_failed" && (
            <div className="text-center py-8 space-y-4">
              <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
                <X className="w-8 h-8 text-destructive" />
              </div>
              <h4 className="font-display text-lg font-semibold">{t("bookingModal.hdrPaymentFailed", { defaultValue: "Payment Failed" })}</h4>
              <p className="text-sm text-muted-foreground">{t("bookingModal.paymentFailedBody", { defaultValue: "Something went wrong with the payment. Your hold is still active — you can try again." })}</p>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1 rounded-xl" onClick={handleClose}>{t("bookingModal.cancel", { defaultValue: "Cancel" })}</Button>
                <Button className="flex-1 rounded-xl" onClick={handleRetry}>{t("bookingModal.tryAgain", { defaultValue: "Try Again" })}</Button>
              </div>
            </div>
          )}

          {/* Success step */}
          {step === "success" && (
            <div className="text-center py-6 space-y-4">
              <div className="w-20 h-20 rounded-full bg-success/10 flex items-center justify-center mx-auto">
                <CheckCircle className="w-10 h-10 text-success" />
              </div>
              <h4 className="font-display text-xl font-bold">{t("bookingModal.hdrConfirmed", { defaultValue: "Booking Confirmed!" })}</h4>
              <p className="text-muted-foreground">{t("bookingModal.successStayBookedPre", { defaultValue: "Your stay at" })} <strong>{stay.title}</strong> {t("bookingModal.successStayBookedPost", { defaultValue: "has been booked." })}</p>
              <div className="bg-muted/50 rounded-xl p-4 text-sm space-y-2 text-left">
                <div className="flex justify-between"><span className="text-muted-foreground">{t("bookingModal.bookingId", { defaultValue: "Booking ID" })}</span><span className="font-mono font-medium">{bookingId ? displayRef(bookingId) : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("bookingModal.checkIn", { defaultValue: "Check-in" })}</span><span className="font-medium">{checkIn || t("bookingModal.datesNotSelected", { defaultValue: "Dates not selected" })}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("bookingModal.checkOut", { defaultValue: "Check-out" })}</span><span className="font-medium">{checkOut || t("bookingModal.datesNotSelected", { defaultValue: "Dates not selected" })}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("bookingModal.guests", { defaultValue: "Guests" })}</span><span className="font-medium">{guests}</span></div>
                {insurance && (
                  <div className="flex justify-between text-primary"><span>🛡️ {t("bookingModal.protection", { defaultValue: "Protection" })}</span><span className="font-medium">{t("bookingModal.active", { defaultValue: "Active" })}</span></div>
                )}
                <div className="flex justify-between font-bold pt-2 border-t border-border"><span>{t("bookingModal.totalPaid", { defaultValue: "Total Paid" })}</span><span>₹{formatRupees(confirmedTotal ?? total)}</span></div>
              </div>
              <div className="flex items-center gap-2 justify-center text-xs text-success"><Shield className="w-3.5 h-3.5" />{t("bookingModal.paymentSecured", { defaultValue: "Payment secured • Instant confirmation" })}</div>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1 rounded-xl h-11 font-semibold" onClick={() => { handleClose(); navigate("/messages"); }}>
                  <MessageCircle className="w-4 h-4 mr-2" />{t("bookingModal.messageHost", { defaultValue: "Message Host" })}
                </Button>
                <Button onClick={handleClose} className="flex-1 rounded-xl h-11 font-semibold">{t("bookingModal.done", { defaultValue: "Done" })}</Button>
              </div>
            </div>
          )}

          {/* Confirm step */}
          {step === "confirm" && (
            <div className="space-y-5">
              <div className="flex gap-4 p-4 bg-muted/50 rounded-xl">
                {stay.image ? <img src={stay.image} alt={stay.title} className="w-20 h-20 rounded-xl object-cover" /> : <div className="flex h-20 w-20 items-center justify-center rounded-xl bg-primary/10 text-3xl">🏨</div>}
                <div>
                  <h4 className="font-semibold text-sm">{stay.title}</h4>
                  <p className="text-xs text-muted-foreground mt-0.5">{stay.location}</p>
                  <p className="text-xs text-muted-foreground mt-1">{nights > 1 ? t("bookingModal.nightsPlural", { defaultValue: "{{count}} nights", count: nights }) : t("bookingModal.nightsSingular", { defaultValue: "{{count}} night", count: nights })} • {guests > 1 ? t("bookingModal.guestsPlural", { defaultValue: "{{count}} guests", count: guests }) : t("bookingModal.guestsSingular", { defaultValue: "{{count}} guest", count: guests })}</p>
                </div>
              </div>
              <div className="space-y-2 text-sm">
                {checkIn && checkOut ? (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground flex items-center gap-1.5">
                      {hostDiscountPercent > 0 && <span className="line-through text-muted-foreground/70">₹{formatRupees(stay.price)}</span>}
                      ₹{formatRupees(effectiveNightlyPrice)} × {nights > 1 ? t("bookingModal.nightsPlural", { defaultValue: "{{count}} nights", count: nights }) : t("bookingModal.nightsSingular", { defaultValue: "{{count}} night", count: nights })}
                      {hostDiscountPercent > 0 && <span className="text-[10px] font-semibold text-success bg-success/10 px-1.5 py-0.5 rounded-full">{t("bookingModal.percentOff", { defaultValue: "{{percent}}% off", percent: hostDiscountPercent })}</span>}
                    </span>
                    <span>₹{formatRupees(subtotal)}</span>
                  </div>
                ) : (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t("bookingModal.baseRate", { defaultValue: "Base rate" })}</span>
                    <span>
                      {hostDiscountPercent > 0 && <span className="line-through text-muted-foreground/70 mr-1">₹{formatRupees(stay.price)}</span>}
                      {t("bookingModal.pricePerNight", { defaultValue: "₹{{price}} / night", price: formatRupees(effectiveNightlyPrice) })}
                    </span>
                  </div>
                )}
                {couponDiscount > 0 && (
                  <div className="flex justify-between text-success"><span>{t("bookingModal.couponLabel", { defaultValue: "Coupon ({{code}})", code: couponQuote?.code })}</span><span>−₹{formatRupees(couponDiscount)}</span></div>
                )}
                <div className="flex justify-between"><span className="text-muted-foreground">{t("bookingModal.platformFee", { defaultValue: "Platform fee" })}</span><span>₹{formatRupees(serviceFee)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("bookingModal.taxesGst", { defaultValue: "Taxes (GST {{rate}}%)", rate: gstRatePct })}</span><span>₹{formatRupees(taxes)}</span></div>
                {insurance && (
                  <div className="flex justify-between text-primary"><span>🛡️ {t("bookingModal.protection", { defaultValue: "Protection" })}</span><span>₹{formatRupees(insurancePremium)}</span></div>
                )}
                <div className="flex justify-between font-bold text-base pt-3 border-t border-border"><span>{t("bookingModal.total", { defaultValue: "Total" })}</span><span>₹{formatRupees(total)}</span></div>
              </div>
              <div className="flex items-center gap-2 p-3 bg-success/5 rounded-xl text-xs text-success border border-success/10">
                <Shield className="w-4 h-4 shrink-0" />{t("bookingModal.fullRefund", { defaultValue: "Full refund on cancellation" })}
              </div>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1 rounded-xl" onClick={() => setStep("details")}>{t("bookingModal.back", { defaultValue: "Back" })}</Button>
                <Button className="flex-1 rounded-xl font-semibold" onClick={handleConfirm} disabled={isProcessing}>
                  {isProcessing ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("bookingModal.processing", { defaultValue: "Processing..." })}</> : t("bookingModal.confirmAndPay", { defaultValue: "Confirm & Pay" })}
                </Button>
              </div>
            </div>
          )}

          {/* Details step */}
          {step === "details" && (
            <div className="space-y-5">
              <div className="flex gap-4 p-4 bg-muted/50 rounded-xl">
                {stay.image ? <img src={stay.image} alt={stay.title} className="w-20 h-20 rounded-xl object-cover" /> : <div className="flex h-20 w-20 items-center justify-center rounded-xl bg-primary/10 text-3xl">🏨</div>}
                <div>
                  <h4 className="font-semibold text-sm">{stay.title}</h4>
                  <p className="text-xs text-muted-foreground mt-0.5">{stay.location}</p>
                  <p className="text-sm font-bold mt-1">
                    {hostDiscountPercent > 0 && (
                      <span className="text-xs font-normal line-through text-muted-foreground mr-1.5">₹{formatRupees(stay.price)}</span>
                    )}
                    ₹{formatRupees(effectiveNightlyPrice)}<span className="text-xs font-normal text-muted-foreground">{t("bookingModal.perNightSuffix", { defaultValue: "/night" })}</span>
                    {hostDiscountPercent > 0 && (
                      <span className="ml-1.5 text-[10px] font-semibold text-success bg-success/10 px-1.5 py-0.5 rounded-full">{t("bookingModal.percentOff", { defaultValue: "{{percent}}% off", percent: hostDiscountPercent })}</span>
                    )}
                  </p>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1.5 flex items-center gap-1"><CalendarIcon className="w-3 h-3" />{t("bookingModal.checkInOutLabel", { defaultValue: "Check-in → Check-out" })}</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background hover:bg-muted/40 focus:ring-2 focus:ring-primary/20 outline-none text-left flex items-center justify-between gap-2"
                    >
                      <span className="flex items-center gap-2">
                        <CalendarIcon className="w-4 h-4 text-primary/70" />
                        {checkIn && checkOut ? (
                          <span>
                            <span className="font-medium">{parseYMD(checkIn).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                            <span className="text-muted-foreground mx-1.5">→</span>
                            <span className="font-medium">{parseYMD(checkOut).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>
                          </span>
                        ) : checkIn ? (
                          <span className="text-muted-foreground"><span className="font-medium text-foreground">{parseYMD(checkIn).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span> {t("bookingModal.pickCheckout", { defaultValue: "→ pick checkout" })}</span>
                        ) : (
                          <span className="text-muted-foreground">{t("bookingModal.selectTravelDates", { defaultValue: "Select your travel dates" })}</span>
                        )}
                      </span>
                      {nights > 0 && checkIn && checkOut && (
                        <span className="text-[11px] font-semibold text-primary bg-primary/5 px-2 py-0.5 rounded-full">{nights > 1 ? t("bookingModal.nightsPlural", { defaultValue: "{{count}} nights", count: nights }) : t("bookingModal.nightsSingular", { defaultValue: "{{count}} night", count: nights })}</span>
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0 rounded-2xl" align="start">
                    <div className="flex items-center justify-between px-3 pt-3">
                      <p className="text-xs text-muted-foreground">
                        {!checkIn ? t("bookingModal.calTapStart", { defaultValue: "Tap a date to start" }) : !checkOut ? t("bookingModal.calTapCheckout", { defaultValue: "Now tap your checkout date" }) : t("bookingModal.calTapStartOver", { defaultValue: "Tap any date to start over" })}
                      </p>
                      {(checkIn || checkOut) && (
                        <button
                          type="button"
                          onClick={() => { setCheckIn(""); setCheckOut(""); }}
                          className="text-xs text-primary font-medium hover:underline"
                        >
                          {t("bookingModal.reset", { defaultValue: "Reset" })}
                        </button>
                      )}
                    </div>
                    <Calendar
                      mode="range"
                      numberOfMonths={1}
                      selected={checkIn || checkOut ? { from: checkIn ? parseYMD(checkIn) : undefined, to: checkOut ? parseYMD(checkOut) : undefined } as DateRange : undefined}
                      onDayClick={(day) => {
                        const ymd = toYMD(day);
                        if (bookedSet.has(ymd)) { toast.error(t("bookingModal.dateAlreadyBooked", { defaultValue: "That date is already booked" })); return; }
                        if (blockedSet.has(ymd)) { toast.error(t("bookingModal.dateHostBlocked", { defaultValue: "Host has blocked this date" })); return; }
                        // Re-pick logic: starts fresh whenever a full range is
                        // already set, or when the user taps an existing endpoint.
                        if (checkIn && checkOut) { setCheckIn(ymd); setCheckOut(""); return; }
                        if (checkIn && ymd === checkIn) { setCheckIn(""); return; }
                        if (!checkIn) { setCheckIn(ymd); return; }
                        // checkIn set, checkOut not set — finish the range.
                        const [from, to] = ymd < checkIn ? [ymd, checkIn] : [checkIn, ymd];
                        if (from === to) return;
                        // Reject if any booked or host-blocked date falls inside the range
                        // (exclusive of checkout night, since checkout is the morning the
                        // guest leaves — that night isn't actually booked by them).
                        for (const d of bookedDates) {
                          if (d >= from && d < to) { toast.error(t("bookingModal.selectionSpansBooked", { defaultValue: "Your selection spans an already-booked date" })); return; }
                        }
                        for (const d of blockedSet) {
                          if (d >= from && d < to) { toast.error(t("bookingModal.selectionIncludesBlocked", { defaultValue: "Your selection includes a host-blocked date" })); return; }
                        }
                        if (ymd < checkIn) { setCheckIn(ymd); setCheckOut(checkIn); return; }
                        setCheckOut(ymd);
                      }}
                      disabled={[
                        { before: new Date(new Date().setHours(0, 0, 0, 0)) },
                        (d: Date) => bookedSet.has(toYMD(d)) || blockedSet.has(toYMD(d)),
                      ]}
                      modifiers={{
                        booked: (d: Date) => bookedSet.has(toYMD(d)),
                        blocked: (d: Date) => blockedSet.has(toYMD(d)),
                      }}
                      modifiersClassNames={{
                        booked: "line-through text-muted-foreground opacity-50",
                        blocked: "text-muted-foreground opacity-40",
                      }}
                      classNames={{
                        // Roomier cells so we can fit a price label below each date.
                        cell: "h-12 w-12 text-center text-sm p-0 relative [&:has([aria-selected].day-range-end)]:rounded-r-md [&:has([aria-selected].day-outside)]:bg-accent/50 [&:has([aria-selected])]:bg-accent first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md focus-within:relative focus-within:z-20",
                        day: "h-12 w-12 p-0 font-normal aria-selected:opacity-100 hover:bg-accent rounded-md",
                        head_cell: "text-muted-foreground rounded-md w-12 font-normal text-[0.8rem]",
                        day_range_start: "day-range-start bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground rounded-l-md",
                        day_range_end: "day-range-end bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground rounded-r-md",
                        day_range_middle: "aria-selected:bg-primary/15 aria-selected:text-foreground rounded-none",
                        day_selected: "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground",
                        // Soft lilac for today so it reads as "current date" without
                        // shouting over the actual check-in / check-out pills.
                        day_today: "bg-primary/10 text-foreground font-semibold rounded-md",
                      }}
                      components={{
                        // Custom day content — shows the per-night price (using
                        // host overrides where set) or "Blocked" / "Booked" so
                        // the guest sees what each day will cost before picking.
                        DayContent: ({ date }) => {
                          const ymd = toYMD(date);
                          const isBlocked = blockedSet.has(ymd);
                          const isBooked = bookedSet.has(ymd);
                          const isPast = date < new Date(new Date().setHours(0, 0, 0, 0));
                          const ovr = overrideForDate.get(ymd);
                          const nightPrice = ovr?.pricePaise != null
                            ? ovr.pricePaise / 100
                            : effectiveNightlyPrice;
                          const hasOverride = ovr?.pricePaise != null;
                          return (
                            <div className="flex flex-col items-center justify-center leading-none gap-0.5">
                              <span className="text-sm">{date.getDate()}</span>
                              {isPast || isBlocked ? null : isBooked ? (
                                <span className="text-[8px] text-muted-foreground">{t("bookingModal.booked", { defaultValue: "Booked" })}</span>
                              ) : (
                                <span className={`text-[9px] tabular-nums ${hasOverride ? "text-primary font-semibold" : "text-muted-foreground"}`}>
                                  ₹{formatRupees(nightPrice)}
                                </span>
                              )}
                            </div>
                          );
                        },
                      }}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1.5 flex items-center gap-1"><Users className="w-3 h-3" />{t("bookingModal.guests", { defaultValue: "Guests" })}</label>
                <select value={guests} onChange={e => setGuests(Number(e.target.value))}
                  className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background focus:ring-2 focus:ring-primary/20 outline-none">
                  {Array.from({ length: stay.guests }, (_, i) => i + 1).map(n => (
                    <option key={n} value={n}>{n > 1 ? t("bookingModal.guestsPlural", { defaultValue: "{{count}} guests", count: n }) : t("bookingModal.guestsSingular", { defaultValue: "{{count}} guest", count: n })}</option>
                  ))}
                </select>
              </div>
              <InsuranceToggle enabled={insurance} onToggle={setInsurance} premium={insurancePremium} label={t("bookingModal.protectYourStay", { defaultValue: "Protect your stay" })} />
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1.5">{t("bookingModal.haveCoupon", { defaultValue: "Have a coupon?" })}</label>
                {couponQuote ? (
                  <div className="flex items-center justify-between gap-2 px-3 py-2.5 border border-success/30 bg-success/5 rounded-xl text-sm">
                    <span className="font-medium text-success">{t("bookingModal.couponAppliedInline", { defaultValue: "{{code}} applied — ₹{{amount}} off", code: couponQuote.code, amount: formatRupees(couponQuote.discountAmount) })}</span>
                    <button type="button" onClick={handleClearCoupon} className="text-muted-foreground hover:text-foreground" aria-label={t("bookingModal.removeCoupon", { defaultValue: "Remove coupon" })}><X className="w-4 h-4" /></button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={couponCode}
                      onChange={e => setCouponCode(e.target.value)}
                      placeholder={t("bookingModal.enterCode", { defaultValue: "Enter code" })}
                      className="flex-1 px-3 py-2.5 border border-border rounded-xl text-sm bg-background focus:ring-2 focus:ring-primary/20 outline-none uppercase"
                      autoCapitalize="characters"
                      spellCheck={false}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-xl"
                      onClick={handleApplyCoupon}
                      disabled={couponChecking || !couponCode.trim() || !checkIn || !checkOut}
                    >
                      {couponChecking ? <Loader2 className="w-4 h-4 animate-spin" /> : t("bookingModal.apply", { defaultValue: "Apply" })}
                    </Button>
                  </div>
                )}
              </div>
              <div className="space-y-2 text-sm border-t border-border pt-4">
                {checkIn && checkOut ? (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground flex items-center gap-1.5">
                      {hostDiscountPercent > 0 && <span className="line-through text-muted-foreground/70">₹{formatRupees(stay.price)}</span>}
                      ₹{formatRupees(effectiveNightlyPrice)} × {nights > 1 ? t("bookingModal.nightsPlural", { defaultValue: "{{count}} nights", count: nights }) : t("bookingModal.nightsSingular", { defaultValue: "{{count}} night", count: nights })}
                      {hostDiscountPercent > 0 && <span className="text-[10px] font-semibold text-success bg-success/10 px-1.5 py-0.5 rounded-full">{t("bookingModal.percentOff", { defaultValue: "{{percent}}% off", percent: hostDiscountPercent })}</span>}
                    </span>
                    <span>₹{formatRupees(subtotal)}</span>
                  </div>
                ) : (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t("bookingModal.baseRate", { defaultValue: "Base rate" })}</span>
                    <span>
                      {hostDiscountPercent > 0 && <span className="line-through text-muted-foreground/70 mr-1">₹{formatRupees(stay.price)}</span>}
                      {t("bookingModal.pricePerNight", { defaultValue: "₹{{price}} / night", price: formatRupees(effectiveNightlyPrice) })}
                    </span>
                  </div>
                )}
                {couponDiscount > 0 && (
                  <div className="flex justify-between text-success"><span>{t("bookingModal.couponLabel", { defaultValue: "Coupon ({{code}})", code: couponQuote?.code })}</span><span>−₹{formatRupees(couponDiscount)}</span></div>
                )}
                <div className="flex justify-between"><span className="text-muted-foreground">{t("bookingModal.platformFee", { defaultValue: "Platform fee" })}</span><span>₹{formatRupees(serviceFee)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("bookingModal.taxesGst", { defaultValue: "Taxes (GST {{rate}}%)", rate: gstRatePct })}</span><span>₹{formatRupees(taxes)}</span></div>
                {insurance && (
                  <div className="flex justify-between text-primary"><span>🛡️ {t("bookingModal.protection", { defaultValue: "Protection" })}</span><span>₹{formatRupees(insurancePremium)}</span></div>
                )}
                <div className="flex justify-between font-bold text-base pt-2 border-t border-border"><span>{t("bookingModal.total", { defaultValue: "Total" })}</span><span>₹{formatRupees(total)}</span></div>
              </div>
              <Button className="w-full h-12 rounded-xl text-base font-semibold" onClick={handleBook} disabled={!checkIn || !checkOut}>
                {!checkIn || !checkOut ? t("bookingModal.selectDatesToContinue", { defaultValue: "Select dates to continue" }) : t("bookingModal.reserveNow", { defaultValue: "Reserve Now" })}
              </Button>
              <p className="text-center text-xs text-muted-foreground">{t("bookingModal.payNextStep", { defaultValue: "You'll pay on the next step" })}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BookingModal;
