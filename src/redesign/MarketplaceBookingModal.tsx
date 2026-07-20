// Unified marketplace booking modal.
//
// Mounts once from each detail page. Receives a `request` describing what
// the user is trying to book (kind + the underlying mock item + any pre-
// selected fields like room type) and renders a full Airbnb-style modal:
//
//   • Hero summary (image, title, address, price, optional strike-through).
//   • Date-range calendar that opens inline from a "Select your travel dates"
//     field — this is the dropdown-style flow shown in the user's reference.
//   • Stay-only: room type selector (when the listing exposes roomTypes).
//   • Stepper for guests.
//   • Service / transport-specific fields (slot, mode, hours, package, etc.)
//     so a single modal covers every category.
//   • Optional "Protect your booking" toggle.
//   • Coupon code field with mock validation (SAVE10 / FIRST200 / TEMPLE50).
//   • Live price breakdown with platform fee + GST.
//   • Login-gating + mock success state.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getListingService } from "@/domains";
import { getCouponsService, type CouponQuote } from "@/domains/coupons/coupons.service";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { placeLine } from "@/lib/marketplace-adapters";
import { toast } from "sonner";
import {
  AlertCircle,
  BadgeCheck,
  Bath,
  BedDouble,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Crosshair,
  Globe2,
  Home,
  Languages,
  Lock,
  MapPin,
  MessageCircle,
  Navigation,
  Minus,
  Plus,
  ShieldCheck,
  Sparkles,
  Store,
  Ticket,
  Users,
  X,
  Download,
} from "lucide-react";
import { getCurrentPosition, reverseGeocode } from "@/lib/geo";
import { istDateIso, istNow, istToday, istTodayIso, istNowMinutes, BOOKING_LEAD_MINUTES } from "@/lib/ist-time";
import { useBookingDraft } from "@/lib/booking-draft";
import { downloadBookingTaxInvoice } from "@/lib/booking-invoice";
import AddressAutocompleteInput from "@/components/AddressAutocompleteInput";
import TransportScheduleStrip, { workingHoursForDate, type BookingBlock } from "@/components/TransportScheduleStrip";
import {
  formatDwell,
  formatKmRange,
  summarizeWorkingWindow,
} from "@/lib/tour-package";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { getBookingService } from "@/domains/bookings/booking.service";
import { getPaymentService } from "@/domains/payments/payment.service";
import { getAnalyticsEventsService } from "@/domains/analytics/events.service";
import { launchRazorpayCheckout } from "@/lib/razorpay-checkout";
import type {
  MarketplaceRoomType,
  MarketplaceService,
  MarketplaceStay,
  MarketplaceTransport,
  ServiceMode,
  TransportMode,
} from "@/types/marketplace";
import { DateRangeCalendar, ServiceSlotPicker } from "./MarketplaceControls";
import { useUserBookings } from "@/hooks/use-marketplace-data";
import { gstRateFor, insurancePremiumRupees, INSURANCE_FLAT_RUPEES, platformFeeRupees } from "@/lib/pricing";
import { computeStayBreakdownPaise, foldAvailabilityOverrides, formatNightlyRowLabel } from "@/lib/stay-pricing";
import { useFeeSpec } from "@/hooks/use-fee-spec";
import { displayRef } from "@/lib/reference";
import { fullPctLabel, gstStateCodeFromText, halfPctLabel, isInterStateText, splitTax } from "@/lib/gst-states";

// ---------- request shape ---------------------------------------------------

export type BookingRequest =
  | { kind: "stay"; stay: MarketplaceStay; preselectedRoomId?: string }
  | { kind: "service"; service: MarketplaceService; preselectedMode?: ServiceMode; preselectedGroupId?: string; preselectedAddOnIds?: string[] }
  | { kind: "transport"; transport: MarketplaceTransport; preselectedMode?: TransportMode; preselectedPackageId?: string };

// Mock coupons recognized by the booking modal. Real backend will replace
// this with an API call.
const MOCK_COUPONS: Record<string, { label: string; type: "percent" | "flat"; value: number }> = {
  SAVE10: { label: "10% off", type: "percent", value: 10 },
  FIRST200: { label: "₹200 off first booking", type: "flat", value: 200 },
  TEMPLE50: { label: "₹50 off temple loops", type: "flat", value: 50 },
};

// Shared "summary at review stage" shape — every kind-specific body builds
// one of these from its own internal state and hands it to the modal root
// to render the final review screen before the success state.
export type BookingReceipt = {
  image: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  facts: Array<{ label: string; value: string }>;
  contact: { name: string; phone: string };
  rows: Array<{ label: string; amount: number }>;
  total: number;
  protectOn?: boolean;
  couponCode?: string;
  /** Optional async submission. Stay bookings use this to drive the full
   *  hold → order → Razorpay → verify lifecycle (matching
   *  `src/components/BookingModal.tsx`); service/transport leave it
   *  undefined and fall through to the mock success state.
   *
   *  Resolves with `{ status: "confirmed" }` after verifyPayment returns a
   *  captured payment, or `{ status: "pending" }` when Razorpay accepted
   *  but the captured webhook hasn't landed (mirrors useBookingFlow's
   *  payment_pending step). The hold is NOT released in the pending case —
   *  the captured webhook will confirm it later.
   *
   *  Reserved special-case: throw `HOLD_PRESERVED_ERROR` to route the root
   *  back to the review stage without releasing the booking hold (used
   *  when the Razorpay sheet is dismissed or payment.failed fires — the
   *  hold stays alive until TTL so the guest can retry, same as the old
   *  flow). */
  onSubmit?: (hooks: {
    /** Called by the closure as soon as createHold returns with a booking id.
     *  The root tracks this so it can release the hold if the user dismisses
     *  the modal before completing payment — matching the
     *  `BookingModal.handleClose` logic that release-on-close unless the
     *  flow is in success/pending/submitting state. */
    onHoldCreated: (bookingId: string) => void;
  }) => Promise<{ status: "confirmed" | "pending"; bookingId: string; paymentId?: string }>;
};

/** Sentinel error used by stay `onSubmit` to ask the root to bounce back
 *  to the review screen without surfacing a hard failure state and
 *  without releasing the hold. */
const HOLD_PRESERVED_ERROR = "__hold_preserved__";

// All booking prices render with exactly two decimal places so guests see
// `₹123.00` / `₹123.45` instead of an inconsistent mix of integers and
// rupees. Underlying math keeps full precision until this final formatter.
function rupee(n: number) {
  const v = Number.isFinite(n) ? n : 0;
  return `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Inject the guest's display name into a JSON-encoded notes string.
 *
 * Mirrors `useBookingFlow.ts`'s private helper of the same name. The host
 * dashboards prefer `user_profiles.display_name`, but accounts created
 * before the auth-middleware backfill still hold the schema default
 * "User"; stashing the auth name in notes gives the host UI a reliable
 * fallback. If the caller already structured the notes as JSON we merge;
 * if it's free text or empty, we wrap it under `freeText` to preserve.
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

// Match `DEFAULT_CHECK_IN_TIME` / `DEFAULT_CHECK_OUT_TIME` in
// `src/components/BookingModal.tsx` — the old stay flow falls back to these
// when `listing.metadata.checkInTime` / `checkOutTime` aren't set.
const DEFAULT_STAY_CHECK_IN_TIME = "14:00";
const DEFAULT_STAY_CHECK_OUT_TIME = "11:00";

function formatStayTime(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

// Stay pricing math lives in src/lib/stay-pricing.ts so it can be unit-tested
// against the server's resolveNightlyStayPaiseList + subtotalForStayPaise
// semantics. See that module for the math and rationale.
/** Build a user-facing reason string when a transport pickup can't be
 *  pinned. When the driver has an `area` and the pickup text doesn't
 *  mention it, prefer "this pickup is outside <area>" so the user
 *  understands the real problem (service-area mismatch, not a vague
 *  address). When we have nothing to compare against, fall back to the
 *  legacy "add more detail" copy. Pure function so it can be reused by
 *  both the debounced pre-check and the submit-time gate.
 *
 *  Heuristic: the pickup text is "out of area" when it has commas (looks
 *  like a real, complete address) AND it doesn't contain the driver's
 *  area / city as a substring. We deliberately don't try to detect every
 *  Indian state name — false positives ("HYD-12 Tamil Bakery, Hyderabad")
 *  are worse than the generic fallback.
 */
function describePickupRejection(
  pickupText: string,
  item: { area?: string | null; city?: string | null },
): string {
  const text = pickupText.trim();
  const lower = text.toLowerCase();
  const candidates = [item.area, item.city]
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0 && s.toLowerCase() !== "local area")
    .map((s) => s.toLowerCase());
  const mentionsArea = candidates.some((c) => lower.includes(c));
  const looksLikeAddress = text.includes(",") || text.split(/\s+/).length >= 3;
  if (candidates.length > 0 && looksLikeAddress && !mentionsArea) {
    const where = item.area || item.city;
    return `This pickup looks like it's outside ${where}. The driver only serves ${where} — enter a pickup in that area, or pick a different driver.`;
  }
  return "We couldn't pin that pickup on the map. Add more detail (street, area, landmark) or use the Use my location button.";
}

function isoTomorrow(off = 0) {
  // IST calendar, not toISOString (UTC) — both drift a day behind/ahead of
  // the marketplace day for users outside IST.
  return istDateIso(1 + off);
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isLikelyUuid(value: string | number | undefined | null): value is string {
  return typeof value === "string" && UUID_REGEX.test(value);
}
function generateIdempotencyKey(): string {
  // Crypto.randomUUID is available in all modern browsers we target; fall
  // back to a timestamp-suffixed random string for older runtimes.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `booking-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- root component --------------------------------------------------

export function MarketplaceBookingModal({ request, onClose }: { request: BookingRequest | null; onClose: () => void }) {
  const { t } = useLanguage();
  const { isAuthenticated, user } = useAuth();
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<"form" | "review" | "submitting" | "success" | "pending" | "error">("form");
  const [receipt, setReceipt] = useState<BookingReceipt | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Ids returned by verifyPayment — persisted so SuccessBody / PendingBody
  // can show the booking reference and link to the dashboard (parity with
  // BookingModal.tsx, which stashes bookingId + paymentId in local state).
  const [confirmedBookingId, setConfirmedBookingId] = useState<string | null>(null);
  const [confirmedPaymentId, setConfirmedPaymentId] = useState<string | null>(null);
  // Active backend booking-hold id. Set by the submit closure right after
  // createHold returns; consumed by the close handler to release the hold
  // when the user bails mid-flow (matches `BookingModal.handleClose`).
  const activeHoldRef = useRef<string | null>(null);
  // Track stage in a ref so the close handler reads the current value
  // without re-binding on every render.
  const stageRef = useRef(stage);
  useEffect(() => { stageRef.current = stage; }, [stage]);

  // Analytics: listing identity for the booking-funnel events. `kind` maps 1:1
  // to listingType (stay/service/transport). `city` is the listing's city —
  // sent as props.destCity so the rollup can pair it with the customer's
  // originCity (origin→destination hotspots).
  const bookingMeta = useMemo(() => {
    if (!request) return null;
    if (request.kind === "stay") return { listingType: "stay" as const, listingId: String(request.stay.id), city: request.stay.city };
    if (request.kind === "service") return { listingType: "service" as const, listingId: String(request.service.id), city: request.service.city };
    return { listingType: "transport" as const, listingId: String(request.transport.id), city: request.transport.city };
  }, [request]);

  useEffect(() => {
    if (!request) return;
    setStage("form");
    setReceipt(null);
    setSubmitError(null);
    setConfirmedBookingId(null);
    setConfirmedPaymentId(null);
    activeHoldRef.current = null;
    const destCity = request.kind === "stay" ? request.stay.city : request.kind === "service" ? request.service.city : request.transport.city;
    getAnalyticsEventsService().track("booking_modal_opened", {
      listingId: request.kind === "stay" ? String(request.stay.id) : request.kind === "service" ? String(request.service.id) : String(request.transport.id),
      listingType: request.kind,
      source: "booking_modal",
      ...(destCity ? { props: { destCity } } : {}),
    });
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [request]);

  // Release the hold on close UNLESS the booking already landed (success),
  // payment is mid-capture (pending), or we're still in flight (submitting).
  // Mirrors `BookingModal.tsx:414–446`.
  const handleCloseAndMaybeReleaseHold = () => {
    const stage = stageRef.current;
    const heldId = activeHoldRef.current;
    if (heldId && stage !== "success" && stage !== "pending" && stage !== "submitting") {
      activeHoldRef.current = null;
      void getBookingService().releaseHold(heldId).catch(() => undefined);
    }
    onClose();
  };

  const goReview = (r: BookingReceipt) => { setReceipt(r); setStage("review"); };
  const goForm = () => setStage("form");
  // Wire real backend submission when the receipt provides one (stay path);
  // otherwise treat the confirm click as a mock success (services/transport).
  const goConfirm = async () => {
    if (receipt?.onSubmit) {
      setSubmitError(null);
      getAnalyticsEventsService().track("payment_started", {
        ...(bookingMeta ? { listingType: bookingMeta.listingType, listingId: bookingMeta.listingId } : {}),
        source: "booking_modal",
        ...(bookingMeta?.city ? { props: { destCity: bookingMeta.city } } : {}),
      });
      setStage("submitting");
      try {
        const result = await receipt.onSubmit({
          onHoldCreated: (id) => { activeHoldRef.current = id; },
        });
        // Confirmed/pending — past the point where close-handler should
        // release the hold.
        activeHoldRef.current = null;
        setConfirmedBookingId(result.bookingId);
        setConfirmedPaymentId(result.paymentId ?? null);
        if (result.status === "pending") {
          // Razorpay accepted but the captured webhook is in flight.
          // Match BookingModal.tsx: do NOT invalidate `["bookings"]` yet —
          // the dashboard polling + the eventual capture will surface it.
          // Keep the hold; surface a processing message.
          toast.message(t("rd.modal.toastPaymentProcessing", { defaultValue: "Payment is processing — we'll confirm once Razorpay capture completes." }));
          setStage("pending");
          return;
        }
        // Refresh anything that should reflect the new confirmed booking.
        // Guest dashboard reads `["bookings"]`; provider/transport/host
        // dashboards read `["partner-bookings"]` (Phase 6 dashboards);
        // the per-listing service + transport booking queries power the
        // booking modal's slot greying so they MUST refetch — otherwise
        // a customer who just booked 10 AM Mon May 25 still sees the
        // 10 AM chip available if they reopen the modal within staleTime.
        // wishlist / listings caches are unaffected so we don't touch them.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["bookings"] }),
          queryClient.invalidateQueries({ queryKey: ["partner-bookings"] }),
          // HostDashboard reads its bookings under this separate key — it
          // was the one dashboard a fresh booking didn't refresh.
          queryClient.invalidateQueries({ queryKey: ["provider-bookings"] }),
          queryClient.invalidateQueries({ queryKey: ["service-bookings"] }),
          queryClient.invalidateQueries({ queryKey: ["transport-bookings"] }),
          // Host-side schedule dialog reads via a separate cache key —
          // without this it stays stale, so a host with the dialog open
          // wouldn't see the new booking light up pink.
          queryClient.invalidateQueries({ queryKey: ["transport-schedule"] }),
        ]);
        setStage("success");
      } catch (e) {
        const message = e instanceof Error ? e.message : t("rd.modal.errCreateBooking", { defaultValue: "Could not create booking. Please try again." });
        if (message === HOLD_PRESERVED_ERROR) {
          // Razorpay dismissed or payment.failed: old flow keeps the hold
          // alive until TTL and bounces back to the confirm screen so the
          // user can retry without losing their reserved room. Mirror that.
          toast.message(t("rd.modal.toastPaymentWindowClosed", { defaultValue: "Payment window closed. Your hold is still active until the timer expires." }));
          setStage("review");
          return;
        }
        setSubmitError(message);
        // Payment verification (or anything else mid-submit) failed — release
        // the hold so the booking row gets expired immediately, instead of
        // lingering as 'pending' until the sweeper marks it cancelled. Hosts
        // would otherwise see a phantom "cancelled" booking they never agreed
        // to.
        const heldId = activeHoldRef.current;
        if (heldId) {
          activeHoldRef.current = null;
          void getBookingService().releaseHold(heldId).catch(() => undefined);
        }
        setStage("error");
      }
    } else {
      setStage("success");
    }
  };

  if (!request) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      // Backdrop starts below the sticky navbar (top-20 ≈ 80px) so the modal
      // never sits underneath the IstaSeva header. Solid bg-white panel
      // keeps the text crisp regardless of the page behind.
      className="fixed inset-x-0 bottom-0 top-20 z-[140] flex items-center justify-center bg-black/55 p-3 backdrop-blur-sm sm:p-6"
      onClick={handleCloseAndMaybeReleaseHold}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative flex h-full max-h-[min(calc(100vh-7rem),860px)] w-full max-w-[680px] flex-col overflow-hidden rounded-[22px] border border-border bg-white shadow-[0_30px_90px_rgba(34,31,39,0.28)]"
      >
        <header className="flex items-center justify-between gap-2 border-b border-border/60 px-5 py-4 sm:px-6">
          <h2 className="font-display text-lg font-extrabold text-foreground sm:text-xl">
            {stage === "success"
              ? t("rd.modal.headerBookingConfirmed", { defaultValue: "Booking confirmed" })
              : stage === "submitting"
                ? t("rd.modal.headerConfirming", { defaultValue: "Confirming…" })
                : stage === "pending"
                  ? t("rd.modal.headerPaymentProcessing", { defaultValue: "Payment processing" })
                  : stage === "error"
                    ? t("rd.modal.headerBookingFailed", { defaultValue: "Booking failed" })
                    : stage === "review"
                      ? t("rd.modal.headerReviewConfirm", { defaultValue: "Review & confirm" })
                      : request.kind === "stay"
                        ? t("rd.modal.headerBookYourStay", { defaultValue: "Book your stay" })
                        : request.kind === "service"
                          ? t("rd.modal.headerBookThisService", { defaultValue: "Book this service" })
                          : t("rd.modal.headerRequestTransport", { defaultValue: "Request transport" })}
          </h2>
          <button type="button" onClick={handleCloseAndMaybeReleaseHold} aria-label={t("rd.modal.closeAria", { defaultValue: "Close" })} className="inline-grid h-9 w-9 place-items-center rounded-full border border-foreground/40 bg-[#8b5e4a]/10 text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-90">
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Keep the form body MOUNTED across stage changes so that clicking
            Back from the Review screen preserves the user's date, time-slot
            selection, contact info, etc. Previously the body was conditionally
            rendered against ReviewBody — going to review unmounted it and
            losing all useState, so coming back showed an empty form. We now
            hide the form body with `hidden` instead, so React keeps it in
            the tree and its state survives the round trip. */}
        {isAuthenticated && (
          // flex-1 + min-h-0 propagates the height constraint down to the
          // body's ModalBody (which uses overflow-y-auto + flex-1 to scroll).
          // Without these, the wrapper collapses to content height and the
          // inner scroll area can't compute its bounds — the modal grew past
          // the panel and lost its scrollbar.
          //
          // We must toggle `display:none` via a class (not the `hidden` HTML
          // attribute) because Tailwind's `flex` class otherwise wins on
          // specificity grounds — the form body would still render
          // underneath the Review screen.
          <div className={stage === "form" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            {request.kind === "stay" ? (
              <StayBody request={request} user={user} onReview={goReview} onClose={handleCloseAndMaybeReleaseHold} />
            ) : request.kind === "service" ? (
              <ServiceBody request={request} user={user} onReview={goReview} onClose={handleCloseAndMaybeReleaseHold} />
            ) : (
              <TransportBody request={request} user={user} onReview={goReview} onClose={handleCloseAndMaybeReleaseHold} />
            )}
          </div>
        )}
        {stage === "success" ? (
          <SuccessBody request={request} onClose={handleCloseAndMaybeReleaseHold} bookingId={confirmedBookingId} paymentId={confirmedPaymentId} receipt={receipt} />
        ) : stage === "pending" ? (
          <PendingBody bookingId={confirmedBookingId} onClose={handleCloseAndMaybeReleaseHold} />
        ) : stage === "submitting" ? (
          <SubmittingBody kind={request.kind} />
        ) : stage === "error" ? (
          <ErrorBody message={submitError} onRetry={() => setStage("review")} onClose={handleCloseAndMaybeReleaseHold} />
        ) : stage === "review" && receipt ? (
          <ReviewBody receipt={receipt} onBack={goForm} onConfirm={goConfirm} ctaLabel={ctaLabelFor(request.kind, t)} />
        ) : !isAuthenticated ? (
          <LoginGate request={request} />
        ) : null}
      </div>
    </div>
  );
}

// ---------- shared shells ---------------------------------------------------

function ModalBody({ children }: { children: React.ReactNode }) {
  return <div className="grid flex-1 gap-5 overflow-y-auto px-5 pb-5 pt-4 sm:px-6 sm:pb-6">{children}</div>;
}

function HeroSummary({
  image, eyebrow, title, subtitle, price, originalPrice,
}: {
  image: string; eyebrow: string; title: string; subtitle: string;
  price: number; originalPrice?: number;
}) {
  const { t } = useLanguage();
  // Hero badge percentage stays an integer — "12% off" reads more naturally
  // than "12.34% off". The line-item amounts below preserve decimals.
  const discount = originalPrice && originalPrice > price ? Math.round(100 - (price / originalPrice) * 100) : 0;
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-muted/50 p-3">
      <div
        className="h-20 w-24 shrink-0 rounded-xl bg-cover bg-center shadow-sm"
        style={{ backgroundImage: `url(${image})` }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-extrabold uppercase tracking-wide text-accent">{eyebrow}</p>
        <p className="truncate font-display text-base font-extrabold text-foreground">{title}</p>
        <p className="line-clamp-2 text-xs text-muted-foreground">{subtitle}</p>
        <p className="mt-1 flex items-center gap-1.5 text-sm">
          {originalPrice && originalPrice > price && <span className="text-muted-foreground line-through">{rupee(originalPrice)}</span>}
          <span className="font-extrabold text-foreground">{rupee(price)}</span>
          {discount > 0 && <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-extrabold text-success">{t("rd.modal.percentOff", { defaultValue: "{{discount}}% off", discount })}</span>}
        </p>
      </div>
    </div>
  );
}

function SectionLabel({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">
      {icon}{children}
    </p>
  );
}

/**
 * GST rows for a price breakdown: IGST (inter-state supply) or CGST + SGST
 * halves (intra-state). Pure relabeling — the amounts sum to the same tax
 * either way, and the server (`pricing-breakdown.ts`) stays authoritative
 * for the invoice. SGST absorbs the odd paisa, mirroring the server split.
 */
function gstRows(
  taxes: number,
  rate: number,
  interState: boolean,
  t: ReturnType<typeof useLanguage>["t"],
): { label: string; amount: number }[] {
  const s = splitTax(taxes, interState);
  if (interState) {
    return [{ label: t("rd.modal.igst", { defaultValue: "IGST ({{pct}}%)", pct: fullPctLabel(rate) }), amount: s.igst }];
  }
  return [
    { label: t("rd.modal.cgst", { defaultValue: "CGST ({{pct}}%)", pct: halfPctLabel(rate) }), amount: s.cgst },
    { label: t("rd.modal.sgst", { defaultValue: "SGST ({{pct}}%)", pct: halfPctLabel(rate) }), amount: s.sgst },
  ];
}

/** Review-gate UX: smooth-scroll the first missing required field into view.
 *  Highlights use RINGS, not borders — `.client-redesign button { border: 0 }`
 *  strips borders from buttons inside the redesign shell. */
const scrollToMissingField = (el: HTMLElement | null) => {
  el?.scrollIntoView({ behavior: "smooth", block: "center" });
};

function FieldShell({ children, onClick, active }: { children: React.ReactNode; onClick?: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-2xl border bg-white/85 px-4 py-3 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-all hover:bg-white ${
        active ? "border-foreground" : "border-border"
      }`}
    >
      {children}
    </button>
  );
}

function FooterTotal({
  total, originalTotal, onConfirm, disabled, ctaLabel,
}: {
  total: number; originalTotal?: number; onConfirm: () => void; disabled?: boolean; ctaLabel: string;
}) {
  const { t } = useLanguage();
  return (
    <div className="flex flex-col gap-2 border-t border-border/60 bg-white/90 px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div>
        <p className="text-[10px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.modal.total", { defaultValue: "Total" })}</p>
        <p className="flex items-baseline gap-2">
          {originalTotal && originalTotal > total && <span className="text-xs text-muted-foreground line-through">{rupee(originalTotal)}</span>}
          <span className="font-display text-xl font-extrabold text-foreground">{rupee(total)}</span>
        </p>
      </div>
      <button
        type="button"
        onClick={onConfirm}
        disabled={disabled}
        className="inline-flex h-12 items-center justify-center gap-2 rounded-full px-6 text-sm font-extrabold text-white shadow-[0_14px_30px_rgba(58,50,71,0.20)] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
        style={{ background: "linear-gradient(135deg, #2b2436 0%, #7b5244 60%, #8b5e4a 100%)" }}
      >
        {ctaLabel} <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

// ---------- protect + coupon (reused across kinds) ---------------

function ProtectToggle({ checked, onChange, price, kind }: {
  checked: boolean; onChange: (b: boolean) => void; price: number; kind: BookingRequest["kind"];
}) {
  const { t } = useLanguage();
  const protectLabel = kind === "stay"
    ? t("rd.modal.protectYourStay", { defaultValue: "Protect your stay" })
    : kind === "service"
      ? t("rd.modal.protectYourAppointment", { defaultValue: "Protect your appointment" })
      : t("rd.modal.protectYourRide", { defaultValue: "Protect your ride" });
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition-all ${
        checked ? "border-foreground bg-foreground/[0.04]" : "border-border bg-white/85 hover:bg-white"
      }`}
    >
      <span className="inline-grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
        <ShieldCheck className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-foreground">{protectLabel}</span>
        <span className="block text-xs text-muted-foreground">
          {t("rd.modal.protectSubtitle", { defaultValue: "Cancellation cover, damage protection, and 24/7 support." })}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-[10px] font-extrabold uppercase tracking-wide text-accent">+ {rupee(price)}</span>
        <span className={`mt-1 inline-flex h-6 w-11 items-center rounded-full border transition-colors ${checked ? "border-foreground bg-foreground" : "border-foreground/30 bg-foreground/15"}`}>
          <span className={`h-5 w-5 rounded-full bg-white shadow ring-1 ring-foreground/10 transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
        </span>
      </span>
    </button>
  );
}

function CouponField({ code, setCode, applied, onApply, onClear }: {
  code: string; setCode: (v: string) => void;
  applied: { code: string; label: string } | null;
  onApply: () => void; onClear: () => void;
}) {
  const { t } = useLanguage();
  return (
    <div>
      <SectionLabel icon={<Ticket className="h-3 w-3" />}>{t("rd.modal.haveACoupon", { defaultValue: "Have a coupon?" })}</SectionLabel>
      <div className="mt-1.5 flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder={t("rd.modal.enterCode", { defaultValue: "ENTER CODE" })}
          className="flex-1 rounded-xl border border-border bg-white/85 px-3 py-2 text-sm font-bold uppercase tracking-wide outline-none placeholder:text-muted-foreground/60"
        />
        {applied ? (
          <button type="button" onClick={onClear} className="inline-flex h-10 items-center justify-center rounded-full border border-destructive/40 bg-[#8b5e4a]/10 px-4 text-xs font-bold text-destructive shadow-sm transition-all hover:border-destructive hover:bg-destructive hover:text-white hover:shadow active:scale-95">
            {t("rd.modal.remove", { defaultValue: "Remove" })}
          </button>
        ) : (
          <button type="button" onClick={onApply} className="inline-flex h-10 items-center justify-center rounded-full border border-foreground/40 bg-[#8b5e4a]/10 px-4 text-xs font-bold text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-95">
            {t("rd.modal.apply", { defaultValue: "Apply" })}
          </button>
        )}
      </div>
      {applied && (
        <p className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-success">
          <BadgeCheck className="h-3.5 w-3.5" /> {t("rd.modal.couponApplied", { defaultValue: "{{label}} applied", label: applied.label })}
        </p>
      )}
    </div>
  );
}

function useCoupon() {
  const [code, setCode] = useState("");
  const [applied, setApplied] = useState<{ code: string; label: string; type: "percent" | "flat"; value: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = () => {
    const hit = MOCK_COUPONS[code.trim().toUpperCase()];
    if (!hit) { setError("Coupon not recognised"); setApplied(null); return; }
    setError(null);
    setApplied({ code: code.toUpperCase(), ...hit });
  };
  const clear = () => { setApplied(null); setCode(""); setError(null); };
  const discount = (amount: number) => applied
    ? applied.type === "percent" ? (amount * applied.value) / 100 : applied.value
    : 0;
  return { code, setCode, applied, error, apply, clear, discount };
}

// ---------- review stage ---------------------------------------------------

type TFunc = ReturnType<typeof useLanguage>["t"];

function ctaLabelFor(kind: BookingRequest["kind"], t: TFunc) {
  return kind === "stay"
    ? t("rd.modal.ctaConfirmPay", { defaultValue: "Confirm & pay" })
    : kind === "service"
      ? t("rd.modal.ctaConfirmBookSlot", { defaultValue: "Confirm & book slot" })
      : t("rd.modal.ctaConfirmRequest", { defaultValue: "Confirm & request" });
}

function ReviewBody({
  receipt, onBack, onConfirm, ctaLabel,
}: { receipt: BookingReceipt; onBack: () => void; onConfirm: () => void; ctaLabel: string }) {
  const { t } = useLanguage();
  return (
    <>
      <ModalBody>
        <HeroSummary
          image={receipt.image}
          eyebrow={receipt.eyebrow}
          title={receipt.title}
          subtitle={receipt.subtitle}
          price={receipt.total}
        />

        <section className="grid gap-2">
          <SectionLabel>{t("rd.modal.yourBooking", { defaultValue: "Your booking" })}</SectionLabel>
          <dl className="grid gap-1.5 rounded-2xl border border-border bg-white px-4 py-3 text-sm">
            {receipt.facts.map((f) => (
              <div key={f.label} className="flex items-start justify-between gap-3">
                <dt className="text-muted-foreground">{f.label}</dt>
                <dd className="text-right font-semibold text-foreground">{f.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="grid gap-2">
          <SectionLabel>{t("rd.modal.contact", { defaultValue: "Contact" })}</SectionLabel>
          <div className="rounded-2xl border border-border bg-white px-4 py-3 text-sm">
            <p className="font-semibold text-foreground">{receipt.contact.name || t("rd.modal.you", { defaultValue: "You" })}</p>
            <p className="text-muted-foreground">{receipt.contact.phone || t("rd.modal.fromYourAccount", { defaultValue: "From your account" })}</p>
          </div>
        </section>

        <PriceBreakdown rows={receipt.rows} />
      </ModalBody>
      <div className="flex flex-col gap-2 border-t border-border/60 bg-white px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-foreground/40 bg-[#8b5e4a]/10 px-5 text-sm font-bold text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-95 sm:order-1"
        >
          {t("rd.modal.back", { defaultValue: "← Back" })}
        </button>
        <div className="sm:order-2 sm:ml-auto sm:text-right">
          <p className="text-[10px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.modal.total", { defaultValue: "Total" })}</p>
          <p className="font-display text-xl font-extrabold text-foreground">{rupee(receipt.total)}</p>
        </div>
        <button
          type="button"
          onClick={onConfirm}
          className="inline-flex h-12 items-center justify-center gap-2 rounded-full px-6 text-sm font-extrabold text-white shadow-[0_14px_30px_rgba(58,50,71,0.20)] transition-transform hover:-translate-y-0.5 sm:order-3"
          style={{ background: "linear-gradient(135deg, #2b2436 0%, #7b5244 60%, #8b5e4a 100%)" }}
        >
          {ctaLabel} <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </>
  );
}

// ---------- stay body -------------------------------------------------------

function StayBody({
  request, user, onReview,
}: {
  request: Extract<BookingRequest, { kind: "stay" }>;
  user: ReturnType<typeof useAuth>["user"];
  onReview: (r: BookingReceipt) => void;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const stay = request.stay;
  const stayId = String(stay.id);
  const isBackendListing = isLikelyUuid(stayId);
  // Server-resolved platform-fee spec (admin fee rules). Legacy flat ₹3
  // until it loads or when the listing is a local demo row.
  const feeSpec = useFeeSpec(isBackendListing ? stayId : null);
  const [checkIn, setCheckIn] = useState<string | null>(isoTomorrow());
  const [checkOut, setCheckOut] = useState<string | null>(isoTomorrow(2));
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [roomId, setRoomId] = useState<string>(request.preselectedRoomId ?? stay.roomTypes?.[0]?.id ?? "");
  // Number of rooms of the picked room type. Capped on the client at
  // `selectedRoom.quantity` (host-set inventory); the backend enforces the
  // same cap minus current overlapping bookings in createHold.
  const [roomCount, setRoomCount] = useState(1);
  const [guests, setGuests] = useState(2);
  const [protectOn, setProtectOn] = useState(false);
  // Real coupon flow for stays — matches `src/components/BookingModal.tsx`:
  // validate against `getCouponsService().validate({ code, listingId, basePrice })`,
  // forward the resolved `couponCode` to createHold (which atomically consumes
  // it inside the hold transaction). Services + transport still use the mock
  // `useCoupon()` because their flows don't reach the backend yet.
  const [couponCode, setCouponCode] = useState("");
  const [couponQuote, setCouponQuote] = useState<CouponQuote | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [couponChecking, setCouponChecking] = useState(false);
  const [bookedDates, setBookedDates] = useState<Set<string>>(() => new Set());
  const [rangeError, setRangeError] = useState<string | null>(null);
  // Host-set availability overrides for this listing — used to grey out
  // host-blocked nights (separately from already-booked nights) and to render
  // per-night custom prices on the calendar + breakdown.
  type AvailabilityRow = { roomTypeId: string | null; date: string; blocked: boolean; pricePaise: number | null };
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);

  const selectedRoom: MarketplaceRoomType | null =
    stay.roomTypes?.find((r) => r.id === roomId) ?? null;
  const nightRate = selectedRoom?.price ?? stay.price;
  // Sleeps per single physical room of the selected type. The Guests
  // stepper below caps at `roomSleeps × roomCount` so multi-room bookings
  // can fit the full party (4 guests across 2 doubles, etc.).
  const roomSleeps = selectedRoom?.sleeps ?? stay.guests;
  const selectedRoomIsUuid = selectedRoom ? isLikelyUuid(selectedRoom.id) : false;

  // Total head-count capacity scales with the number of physical rooms
  // booked — 2 doubles fit 4 guests, etc.
  const maxGuests = Math.max(1, roomSleeps * Math.max(1, roomCount));
  // Guests stepper auto-rebounds when capacity drops (room count down, or
  // a smaller room picked).
  useEffect(() => { setGuests((g) => Math.min(g, maxGuests)); }, [maxGuests]);
  // Host's configured max for this room type (capped at 20 in the UI to
  // keep the stepper sane; backend hard-cap is 50). Live-availability
  // (after subtracting overlapping bookings) is queried below and may
  // tighten this further.
  const hostMaxRooms = Math.max(1, Math.min(20, Number(selectedRoom?.quantity ?? 1) || 1));
  // Live remaining inventory across the picked date range. `null` while
  // we haven't received an answer yet — in that case the stepper falls
  // back to `hostMaxRooms` (best-effort) and the backend's createHold
  // conflict check is the final authority.
  const [availableRooms, setAvailableRooms] = useState<number | null>(null);
  // Max the Rooms stepper is actually allowed to reach right now. Takes
  // the MIN of host cap and what's still bookable for the chosen nights.
  const maxRooms = availableRooms != null
    ? Math.max(1, Math.min(hostMaxRooms, availableRooms))
    : hostMaxRooms;
  // Whether the live cap is tighter than the host cap — drives the
  // friendly "X rooms left for these dates" copy vs. the plain "host
  // limit is X" copy.
  const cappedByAvailability = availableRooms != null && availableRooms < hostMaxRooms;
  // Clamp roomCount whenever the cap drops (e.g. user lengthened the
  // stay into nights that have fewer rooms left).
  useEffect(() => { setRoomCount((n) => Math.min(Math.max(1, n), maxRooms)); }, [maxRooms]);

  // Fetch booked nights from the backend so the calendar can disable them.
  // Re-fetches per room change because per-room availability differs. Failure
  // is non-fatal: we just fall back to "everything bookable" and let the
  // server-side conflict check on createHold catch any race.
  useEffect(() => {
    if (!isBackendListing) { setBookedDates(new Set()); return; }
    let cancelled = false;
    (async () => {
      const result = await getListingService().getBookedDates(
        stayId,
        selectedRoomIsUuid ? selectedRoom!.id : undefined,
      );
      if (cancelled) return;
      if (result.success && result.data) setBookedDates(new Set(result.data));
      else setBookedDates(new Set());
    })();
    return () => { cancelled = true; };
  }, [isBackendListing, stayId, selectedRoomIsUuid, selectedRoom?.id]);

  // Fetch host availability overrides (blocked dates + per-night custom prices)
  // for a wide future window so the calendar shows them without re-fetching
  // every range pick. Listing-level rows (room_type_id = null) apply to all
  // rooms; room-level rows shadow them when a room is selected.
  useEffect(() => {
    if (!isBackendListing) { setAvailability([]); return; }
    let cancelled = false;
    (async () => {
      const today = new Date();
      const to = new Date(today.getTime() + 365 * 86400000);
      const result = await getListingService().getAvailability(stayId, {
        from: today.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
      });
      if (cancelled) return;
      if (result.success && result.data) setAvailability(result.data);
      else setAvailability([]);
    })();
    return () => { cancelled = true; };
  }, [isBackendListing, stayId]);

  // Live "rooms left for these nights" lookup. Re-runs whenever the room
  // type or the date range changes. Failure (network blip, missing room)
  // falls back to `availableRooms = null` so the host cap stays the
  // active ceiling rather than blocking the booking entirely.
  useEffect(() => {
    if (!isBackendListing || !selectedRoomIsUuid || !selectedRoom || !checkIn || !checkOut) {
      setAvailableRooms(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const result = await getListingService().getRoomAvailability(
        stayId,
        selectedRoom.id,
        checkIn,
        checkOut,
      );
      if (cancelled) return;
      if (result.success && result.data) setAvailableRooms(result.data.remaining);
      else setAvailableRooms(null);
    })();
    return () => { cancelled = true; };
  }, [isBackendListing, stayId, selectedRoomIsUuid, selectedRoom?.id, checkIn, checkOut]);

  // Fold availability rows into a per-date map respecting room precedence
  // (room override beats listing override). Lives in src/lib/stay-pricing.ts
  // so we can unit-test against the server's resolveNightlyStayPaiseList.
  const { blockedSet, priceByDate } = useMemo(
    () => foldAvailabilityOverrides(availability, selectedRoomIsUuid ? selectedRoom!.id : null),
    [availability, selectedRoomIsUuid, selectedRoom?.id],
  );
  // Calendar-display copies of the per-date map + base nightly with the host
  // discount factor pre-applied, so what the user sees on each cell matches
  // what the breakdown actually charges. `priceByDate` itself stays as LIST
  // paise — `computeStayBreakdownPaise` applies the factor in pricing math.
  const hostDiscountFactor = useMemo(() => {
    const pct = Math.max(0, Math.min(90, stay.discountPercent ?? 0));
    return 1 - pct / 100;
  }, [stay.discountPercent]);
  const discountedBaseNightlyPaise = useMemo(
    () => nightRate > 0 ? Math.max(0, Math.round(nightRate * 100 * hostDiscountFactor)) : null,
    [nightRate, hostDiscountFactor],
  );
  const discountedPriceByDate = useMemo(() => {
    if (priceByDate.size === 0) return priceByDate;
    if (hostDiscountFactor === 1) return priceByDate;
    const out = new Map<string, number>();
    priceByDate.forEach((listPaise, date) => {
      out.set(date, Math.max(0, Math.round(listPaise * hostDiscountFactor)));
    });
    return out;
  }, [priceByDate, hostDiscountFactor]);

  const nights = checkIn && checkOut
    ? Math.max(1, Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000))
    : 0;

  // Pricing in paise, mirroring server math (subtotalForStayPaise + applyFees).
  //
  // hostDiscountPercent comes from the listing row (`listings.discount_percent`)
  // so the preview applies the same per-night `× (1 - pct/100)` factor the
  // backend does. Mock stays don't set this, so it defaults to 0. For room-
  // selected bookings the backend pulls the room's `base_price_paise` and then
  // STILL applies the listing-level discount_percent on top — same as here.
  //
  // Per-date availability overrides ARE modelled in this preview: we fetch
  // /api/listings/:id/availability and fold listing- and room-level rows into
  // `priceByDate` (room-specific wins) before pricing. The preview's total
  // therefore matches what `subtotalForStayPaise` will compute server-side,
  // so `agreedPrice` on createHold passes the strict ±₹2 drift check.
  // Breakdown mirrors `subtotalForStayPaise` + `applyFees` server-side. The
  // host discount comes from `listings.discount_percent` (surfaced via the
  // adapter). The coupon discount comes from the server-validated quote so
  // the preview matches what `couponsService.consume` will deduct inside the
  // createHold transaction.
  // Keep the discount in its actual rupees-with-paise precision — the pricing
  // helper converts to paise via `Math.round(value * 100)` so a ₹1.40 quote
  // lands as 140 paise. The previous `Math.round(discountAmount)` collapsed
  // the value to an integer rupee first (₹1.40 → ₹1.00), so the banner above
  // the breakdown showed "₹1.40 off" but the line item read "-₹1.00".
  const couponRupeesOff = couponQuote ? Math.max(0, couponQuote.discountAmount) : 0;
  const breakdown = useMemo(
    () => computeStayBreakdownPaise({
      nightlyRateRupees: nightRate,
      nights,
      hostDiscountPercent: stay.discountPercent ?? 0,
      couponRupeesOff,
      checkIn,
      nightlyPaiseByDate: priceByDate,
      roomCount,
      feeSpec,
    }),
    [nightRate, nights, stay.discountPercent, couponRupeesOff, checkIn, priceByDate, roomCount, feeSpec],
  );
  // Protection fee is opt-in and is NOT part of the host-side booking total
  // the backend validates. Same convention as `BookingModal.tsx`: send
  // `total - insurancePremium` as agreedPrice; the premium is applied later
  // inside createOrder via `insuranceOptIn: true`. Math uses the shared
  // `insurancePremiumRupees` helper so the preview matches what the backend
  // stores at order time (2%, clamped to ₹2–₹49 of agreed price).
  const protectFeeRupees = protectOn
    ? insurancePremiumRupees(Math.round(breakdown.totalPaise / 100))
    : 0;

  // Paise-precise rupee values for display — preserve decimals all the way
  // through to the `rupee()` formatter so the breakdown rows + total never
  // hide cents behind a round.
  const base = breakdown.subtotalPaise / 100;
  const couponOff = breakdown.discountPaise / 100;
  const platformFee = breakdown.platformFeePaise / 100;
  const taxes = breakdown.taxesPaise / 100;
  // bookingTotal = the host-side total we POST as `agreedPrice`. Backend
  // recomputes the same number from listing + room + coupon + applyFees and
  // rejects on >₹2 drift, so we must keep this an integer rupee value to
  // match the legacy payload contract.
  const bookingTotal = Math.round(breakdown.totalPaise / 100);
  // displayTotal = what the guest sees in the footer + receipt. Includes the
  // optional protection addon so the bill column matches the line items.
  // Uses the paise-precise total (not the rounded `bookingTotal`) so the
  // ₹.XX line items can't disagree with the displayed grand total.
  const displayTotal = breakdown.totalPaise / 100 + protectFeeRupees;

  const rangeHitsClosedNight = useMemo(() => {
    if (!checkIn || !checkOut) return false;
    if (bookedDates.size === 0 && blockedSet.size === 0) return false;
    const cur = new Date(`${checkIn}T00:00:00Z`);
    const end = new Date(`${checkOut}T00:00:00Z`);
    while (cur < end) {
      const iso = cur.toISOString().slice(0, 10);
      if (bookedDates.has(iso) || blockedSet.has(iso)) return true;
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return false;
  }, [checkIn, checkOut, bookedDates, blockedSet]);

  const canConfirm = nights > 0
    && !rangeHitsClosedNight
    && Boolean(roomId || !stay.roomTypes?.length);
  // Review-gate UX: CTA stays clickable; a click with missing fields flips
  // this on, red-highlights them, and scrolls the first one into view.
  const [showErrors, setShowErrors] = useState(false);
  const datesRef = useRef<HTMLDivElement | null>(null);
  const missingDates = nights === 0;

  // Coupon handlers — match `BookingModal.handleApplyCoupon` / `handleClearCoupon`.
  // Subtotal here is `base` (pre-discount, post-host-discount). Server's
  // `couponsService.consume` validates the same basePrice on createHold.
  const handleApplyCoupon = async () => {
    const code = couponCode.trim();
    if (!code) return;
    if (!isBackendListing) {
      setCouponError(t("rd.modal.couponNotOnPreview", { defaultValue: "Coupons aren't available on preview listings." }));
      return;
    }
    if (!base || base <= 0) {
      setCouponError(t("rd.modal.pickDatesFirst", { defaultValue: "Pick your dates first, then apply the coupon." }));
      return;
    }
    setCouponChecking(true);
    setCouponError(null);
    try {
      const res = await getCouponsService().validate({ code, listingId: stayId, basePrice: base });
      if (!res.success || !res.data) {
        setCouponQuote(null);
        setCouponError(res.error || t("rd.modal.couponNotValid", { defaultValue: "Coupon not valid" }));
        getAnalyticsEventsService().track("coupon_failed", { listingType: "stay", source: "booking_modal" });
        return;
      }
      setCouponQuote(res.data);
      getAnalyticsEventsService().track("coupon_applied", { listingType: "stay", source: "booking_modal", props: { discountPaise: Math.round((res.data.discountAmount || 0) * 100) } });
      toast.success(t("rd.modal.couponAppliedToast", { defaultValue: "Coupon applied — {{amount}} off", amount: rupee(res.data.discountAmount) }));
    } finally {
      setCouponChecking(false);
    }
  };
  const handleClearCoupon = () => {
    setCouponQuote(null);
    setCouponCode("");
    setCouponError(null);
  };

  return (
    <>
      <ModalBody>
        {/* Date field — single tappable field, opens the calendar inline. */}
        <div ref={datesRef} className="grid gap-2">
          <SectionLabel icon={<CalendarDays className="h-3 w-3" />}>{t("rd.modal.checkInCheckOut", { defaultValue: "Check-in → Check-out" })}</SectionLabel>
          <div className={showErrors && missingDates ? "rounded-2xl ring-2 ring-destructive/70" : undefined}>
          <FieldShell onClick={() => setCalendarOpen((v) => !v)} active={calendarOpen}>
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1 text-sm font-semibold text-foreground">
              {checkIn && checkOut
                ? `${labelOf(checkIn)} → ${labelOf(checkOut)}`
                : <span className="text-muted-foreground">{t("rd.modal.selectTravelDates", { defaultValue: "Select your travel dates" })}</span>}
            </span>
            {nights > 0 && <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-extrabold text-foreground">{nights === 1 ? t("rd.modal.nightCount_one", { defaultValue: "{{count}} night", count: nights }) : t("rd.modal.nightCount_other", { defaultValue: "{{count}} nights", count: nights })}</span>}
            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${calendarOpen ? "rotate-180" : ""}`} />
          </FieldShell>
          </div>
          {showErrors && missingDates && (
            <p className="-mt-1 text-[11px] font-bold text-destructive">
              {t("rd.modal.errPickDates", { defaultValue: "Select your check-in and check-out dates to continue." })}
            </p>
          )}
          {calendarOpen && (
            <DateRangeCalendar
              start={checkIn}
              end={checkOut}
              onChange={({ start, end }) => { setRangeError(null); setCheckIn(start); setCheckOut(end); }}
              disabledDates={bookedDates}
              blockedDates={blockedSet}
              // Display values for the calendar mirror what the booking
              // breakdown actually charges: pass POST host-discount paise so
              // ₹4,800/night with a 10% host discount shows ₹4,320 on each
              // cell — same number the per-night line items render below.
              // `priceByDate` itself stays LIST paise (computeStayBreakdownPaise
              // applies the discount factor); we project a discounted view here.
              priceForDate={discountedPriceByDate}
              basePricePaise={discountedBaseNightlyPaise}
              onInvalidRange={({ reason }) => {
                const msg = reason === 'blocked'
                  ? t("rd.modal.rangeBlocked", { defaultValue: "Your selection includes a host-blocked night — pick a range that doesn't cross those dates." })
                  : reason === 'mixed'
                    ? t("rd.modal.rangeMixed", { defaultValue: "Your selection includes nights that are blocked or already booked. Pick a different range." })
                    : t("rd.modal.rangeBooked", { defaultValue: "Your selection includes a night that's already booked. Pick a range that doesn't cross those dates." });
                setRangeError(msg);
              }}
            />
          )}
          {(rangeError || rangeHitsClosedNight) && (
            <p className="-mt-1 inline-flex items-center gap-1 text-[11px] font-bold text-destructive">
              {rangeError ?? t("rd.modal.rangeUnavailable", { defaultValue: "Your selection includes an unavailable night. Pick a different range." })}
            </p>
          )}
        </div>

        {/* Room type — only when the listing exposes more than one option. */}
        {stay.roomTypes && stay.roomTypes.length > 1 && (
          <div className="grid gap-2">
            <SectionLabel icon={<BedDouble className="h-3 w-3" />}>{t("rd.modal.selectARoom", { defaultValue: "Select a room" })}</SectionLabel>
            <div className="grid gap-2">
              {stay.roomTypes.map((r) => {
                const active = r.id === roomId;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setRoomId(r.id)}
                    className={`grid grid-cols-[36px_1fr_auto] items-center gap-3 rounded-2xl border px-3 py-3 text-left transition-all ${
                      active ? "border-foreground bg-foreground/[0.04]" : "border-border bg-white/85 hover:bg-white"
                    }`}
                  >
                    <span className={`inline-grid h-9 w-9 place-items-center rounded-xl ${active ? "bg-foreground text-white" : "bg-muted text-foreground"}`}>
                      <BedDouble className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-foreground">{r.name}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] font-semibold text-muted-foreground">
                        <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" /> {t("rd.modal.sleepsN", { defaultValue: "Sleeps {{count}}", count: r.sleeps })}</span>
                        <span className="inline-flex items-center gap-1"><Home className="h-3 w-3" /> {t("rd.modal.bedroomN", { defaultValue: "{{count}} bedroom", count: r.bedrooms })}</span>
                        <span className="inline-flex items-center gap-1"><Bath className="h-3 w-3" /> {t("rd.modal.bathN", { defaultValue: "{{count}} bath", count: r.bathrooms })}</span>
                      </span>
                      {r.description && <span className="mt-1 block text-xs text-muted-foreground">{r.description}</span>}
                    </span>
                    <span className="text-right">
                      <span className="block font-display text-base font-extrabold text-foreground">{rupee(r.price)}</span>
                      <span className="block text-[10px] font-semibold text-muted-foreground">{t("rd.modal.perNight", { defaultValue: "/ night" })}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid gap-2 sm:grid-cols-2">
          <Stepper
            label={t("rd.modal.guests", { defaultValue: "Guests" })}
            icon={<Users className="h-4 w-4" />}
            value={guests}
            min={1}
            max={maxGuests}
            onChange={setGuests}
            maxMessage={(() => {
              // Friendly nudge that tells the guest WHY +1 didn't work and
              // what to do — bump the room count, not just hit a wall.
              const roomName = selectedRoom?.name || t("rd.modal.roomWord", { defaultValue: "room" });
              if (roomCount > 1) {
                return t("rd.modal.guestsCapMultiRoom", { defaultValue: "Each {{room}} sleeps {{sleeps}} — that's {{maxGuests}} guests across {{roomCount}} rooms. Add another room to fit more.", room: roomName, sleeps: roomSleeps, maxGuests, roomCount });
              }
              if (hostMaxRooms > 1) {
                return t("rd.modal.guestsCapAddRoom", { defaultValue: "Each {{room}} sleeps {{sleeps}}. Add another room to fit more guests.", room: roomName, sleeps: roomSleeps });
              }
              return t("rd.modal.guestsCapSingleRoom", { defaultValue: "Each {{room}} sleeps {{sleeps}} — this room can't fit more guests.", room: roomName, sleeps: roomSleeps });
            })()}
          />
          {/* Multi-room picker for room-typed stays where the host has more
              than one physical room of the selected type (e.g. sathram with
              5 Non-AC rooms). Hidden for single-room listings. */}
          {hostMaxRooms > 1 ? (
            <Stepper
              label={t("rd.modal.rooms", { defaultValue: "Rooms" })}
              icon={<BedDouble className="h-4 w-4" />}
              value={roomCount}
              min={1}
              max={maxRooms}
              onChange={setRoomCount}
              maxMessage={
                // Two cases: host's own inventory exhausted vs. some
                // rooms are already booked for these nights. The copy
                // changes so the guest knows whether to pick different
                // dates or just accept the hard ceiling.
                cappedByAvailability
                  ? (maxRooms <= 0
                      ? t("rd.modal.roomsNoneAvailable", { defaultValue: "No {{rooms}} available for these dates — try different nights.", rooms: selectedRoom?.name || t("rd.modal.roomsWord", { defaultValue: "rooms" }) })
                      : t("rd.modal.roomsLeftForDates", { defaultValue: "Only {{count}} {{room}} left for these dates.", count: maxRooms, room: selectedRoom?.name || t("rd.modal.roomWord", { defaultValue: "room" }) }))
                  : t("rd.modal.roomsHostMax", { defaultValue: "Maximum is {{count}} — that's all the {{rooms}} the host has.", count: maxRooms, rooms: selectedRoom?.name || t("rd.modal.roomsWord", { defaultValue: "rooms" }) })
              }
            />
          ) : (
            <div className="rounded-2xl border border-border bg-white/85 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
              <SectionLabel icon={<MapPin className="h-3 w-3" />}>{t("rd.modal.location", { defaultValue: "Location" })}</SectionLabel>
              <p className="mt-1 truncate text-sm font-semibold text-foreground">{placeLine(stay.location, stay.district)}</p>
            </div>
          )}
        </div>


        <ProtectToggle
          checked={protectOn}
          onChange={setProtectOn}
          price={protectFeeRupees || insurancePremiumRupees(Math.round(breakdown.totalPaise / 100) || nightRate)}
          kind="stay"
        />

        <CouponField
          code={couponCode}
          setCode={setCouponCode}
          applied={couponQuote ? { code: couponQuote.code, label: `${rupee(couponQuote.discountAmount)} off` } : null}
          onApply={handleApplyCoupon}
          onClear={handleClearCoupon}
        />
        {couponChecking && <p className="-mt-2 text-xs font-semibold text-muted-foreground">{t("rd.modal.checking", { defaultValue: "Checking…" })}</p>}
        {couponError && <p className="-mt-2 text-xs font-semibold text-destructive">{couponError}</p>}

        {nights > 0 && (
          <PriceBreakdown
            rows={(() => {
              const items = breakdown.nightLineItems ?? [];
              const hasCustom = items.some((it) => it.custom);
              // When any night carries a custom price, expand into a per-night
              // table so the guest can see exactly which night the override
              // applies to (date · ₹ price · "custom" badge handled by label).
              // Otherwise collapse to the legacy "rate × nights" line.
              const nightRows = hasCustom
                ? items.map((it) => ({
                    label: `${labelOf(it.date)}${it.custom ? t("rd.modal.customNightSuffix", { defaultValue: " · custom" }) : ""}`,
                    amount: it.paise / 100,
                  }))
                : [{
                    label: (() => {
                      const nightLabel = formatNightlyRowLabel({
                        baseNightlyRupees: nightRate,
                        nights,
                        hostDiscountPercent: stay.discountPercent ?? 0,
                        formatRupees: rupee,
                      });
                      return roomCount > 1 ? t("rd.modal.nightRowRooms", { defaultValue: "{{label}} × {{count}} rooms", label: nightLabel, count: roomCount }) : nightLabel;
                    })(),
                    amount: base,
                  }];
              return [
                ...nightRows,
                ...(couponOff > 0 ? [{ label: t("rd.modal.couponRow", { defaultValue: "Coupon ({{code}})", code: couponQuote?.code }), amount: -couponOff }] : []),
                { label: t("rd.modal.platformFee", { defaultValue: "Platform fee" }), amount: platformFee },
                ...gstRows(taxes, breakdown.gstRate, false, t),
                ...(protectOn ? [{ label: t("rd.modal.protectStayAtPayment", { defaultValue: "Protect your stay (added at payment)" }), amount: protectFeeRupees }] : []),
              ];
            })()}
          />
        )}
      </ModalBody>
      <FooterTotal
        total={displayTotal}
        ctaLabel={t("rd.modal.reviewBooking", { defaultValue: "Review booking" })}
        onConfirm={() => {
          // Review gate: always clickable — a click with missing/invalid
          // fields highlights them and scrolls there instead of advancing.
          if (!canConfirm) {
            setShowErrors(true);
            scrollToMissingField(datesRef.current);
            return;
          }
          // Build the backend payload at review-build time so the closure
          // captures the form state as confirmed (not a later mutation).
          // Only attach a real submission when the stay id looks like a
          // backend UUID; legacy mock rows with numeric ids fall through to
          // the mock success state.
          //
          // The closure follows the exact lifecycle that
          // `src/components/BookingModal.tsx:handleConfirm` runs:
          //   1. createHold (server-authoritative agreedPricePaise persisted)
          //   2. createOrder using the server's stored agreedPricePaise
          //   3. Razorpay sheet (or mock auto-verify)
          //   4. verifyPayment → confirmed | pending
          //   5. release hold ONLY on createHold/createOrder failure or hard
          //      verify failure; preserve on dismiss / payment.failed (hold
          //      TTLs out, user can retry — same as the old flow)
          const submitToBackend: NonNullable<BookingReceipt["onSubmit"]> = async ({ onHoldCreated }) => {
            // Structured JSON notes — keys match what the host dashboard
            // expects (`receiptSnapshotFromNotes` keys on `roomName`, not
            // `roomTypeName`). `guestName` is injected via
            // `mergeGuestNameIntoNotes` (mirror of useBookingFlow's helper)
            // so host UIs render a real name even when the user_profiles row
            // still holds the schema default.
            // Notes assembly moved server-side (bookingService.prepare →
            // buildBookingNotes). Structured fields are sent below.

            // Match `BookingModal.tsx`: `serviceCategory: stay:${stay.type}`
            // so the booking row keeps property-type granularity for
            // downstream reporting / dashboards.
            const lowerType = String(stay.type || "stay").toLowerCase();
            const serviceCategory = lowerType.startsWith("stay") ? lowerType : `stay:${lowerType}`;

            let heldBookingId: string | null = null;
            let shouldReleaseHoldOnError = false;
            try {
              // Unified prepare: server builds notes, creates the hold +
              // Razorpay order (authoritative pricing — agreedPrice no longer
              // sent from the client; the room base price is the source of
              // truth), and returns the payload. The hold's endDate is derived
              // server-side from checkOutDate.
              const prep = await getBookingService().prepare({
                listingType: "stay",
                listingId: stayId,
                serviceCategory,
                scheduledDate: checkIn as string,
                checkOutDate: checkOut as string,
                startTime: stay.checkInTime || DEFAULT_STAY_CHECK_IN_TIME,
                endTime: stay.checkOutTime || DEFAULT_STAY_CHECK_OUT_TIME,
                // Only forward the room id when the backend can use it —
                // mock listings have non-UUID room ids that would 400.
                roomTypeId: selectedRoomIsUuid ? selectedRoom!.id : undefined,
                roomName: selectedRoom?.name,
                numberOfRooms: roomCount > 1 ? roomCount : undefined,
                guestCount: guests,
                insuranceOptIn: protectOn,
                contact: { name: user?.name ?? "", phone: user?.phone ?? "" },
                guestName: user?.name ?? undefined,
                couponCode: couponQuote?.code,
                address: placeLine(stay.location, stay.district),
                listingTitle: stay.title,
                listingName: stay.title,
                idempotencyKey: generateIdempotencyKey(),
              });
              if (!prep.success || !prep.data) {
                throw new Error(prep.error || t("rd.modal.errHoldStay", { defaultValue: "Could not hold this stay. Please try again." }));
              }
              const b = prep.data;
              heldBookingId = b.bookingId;
              shouldReleaseHoldOnError = true;
              onHoldCreated(heldBookingId);

              type VerifyOutcome =
                | { status: "confirmed"; paymentId?: string }
                | { status: "pending"; paymentId?: string }
                | { status: "hold_preserved" };

              // Non-async executor: the outcome resolves only through the
              // checkout callbacks; a rejected launch (script load / open
              // failure) rejects via the trailing .catch.
              const outcome = await new Promise<VerifyOutcome>((resolve, reject) => {
                launchRazorpayCheckout({
                  keyId: b.keyId,
                  orderId: b.orderId,
                  amountPaise: b.amountPaise,
                  currency: b.currency,
                  bookingId: heldBookingId as string,
                  description: t("rd.modal.razorpayStayDesc", { defaultValue: "Stay: {{title}}", title: stay.title }),
                  prefill: { email: user?.email, contact: user?.phone, name: user?.name },
                  analytics: { listingId: String(stay.id), listingType: "stay" },
                  // Match old flow: dismiss + payment.failed PRESERVE the
                  // hold and bounce back to review so the user can retry
                  // within the TTL window without losing their room.
                  onDismiss: () => resolve({ status: "hold_preserved" }),
                  onFailure: () => resolve({ status: "hold_preserved" }),
                  onSuccess: async (response) => {
                    const verifyResult = await getPaymentService().verifyPayment({
                      bookingId: heldBookingId as string,
                      razorpay_order_id: response.razorpay_order_id,
                      razorpay_payment_id: response.razorpay_payment_id,
                      razorpay_signature: response.razorpay_signature,
                    });
                    if (!verifyResult.success) {
                      reject(new Error(verifyResult.error || t("rd.modal.errPaymentVerification", { defaultValue: "Payment verification failed." })));
                      return;
                    }
                    if (verifyResult.data?.pending) {
                      // Razorpay accepted; capture webhook in flight. Match
                      // old flow: keep the hold, surface a pending screen.
                      resolve({ status: "pending", paymentId: verifyResult.data?.paymentId });
                      return;
                    }
                    resolve({ status: "confirmed", paymentId: verifyResult.data?.paymentId });
                  },
                }).catch(reject);
              });

              if (outcome.status === "hold_preserved") {
                // Do NOT release: hold stays alive until TTL so the user
                // can retry. Root catch interprets this sentinel and goes
                // back to the review screen.
                shouldReleaseHoldOnError = false;
                throw new Error(HOLD_PRESERVED_ERROR);
              }

              // Confirmed or pending: in both cases the captured (or
              // capturing) payment owns the slot — never release here.
              shouldReleaseHoldOnError = false;
              return {
                status: outcome.status,
                bookingId: heldBookingId,
                paymentId: outcome.paymentId,
              };
            } catch (error) {
              if (heldBookingId && shouldReleaseHoldOnError) {
                await getBookingService().releaseHold(heldBookingId).catch(() => undefined);
              }
              throw error;
            }
          };

          onReview({
            image: selectedRoom?.image ?? stay.image,
            eyebrow: `${stay.type} · ${placeLine(stay.location, stay.district)}`,
            title: stay.title,
            subtitle: selectedRoom ? t("rd.modal.roomSleepsSubtitle", { defaultValue: "{{room}} · sleeps {{sleeps}}", room: selectedRoom.name, sleeps: selectedRoom.sleeps }) : stay.description.slice(0, 100),
            facts: [
              { label: t("rd.modal.factCheckIn", { defaultValue: "Check-in" }), value: checkIn ? `${labelOf(checkIn)} · ${formatStayTime(stay.checkInTime || DEFAULT_STAY_CHECK_IN_TIME)}` : "—" },
              { label: t("rd.modal.factCheckOut", { defaultValue: "Check-out" }), value: checkOut ? `${labelOf(checkOut)} · ${formatStayTime(stay.checkOutTime || DEFAULT_STAY_CHECK_OUT_TIME)}` : "—" },
              { label: t("rd.modal.factNights", { defaultValue: "Nights" }), value: nights === 1 ? t("rd.modal.nightCount_one", { defaultValue: "{{count}} night", count: nights }) : t("rd.modal.nightCount_other", { defaultValue: "{{count}} nights", count: nights }) },
              { label: t("rd.modal.guests", { defaultValue: "Guests" }), value: `${guests}` },
              ...(selectedRoom ? [{ label: t("rd.modal.factRoom", { defaultValue: "Room" }), value: selectedRoom.name }] : []),
              // Surface the room count on multi-room bookings so the
              // Review screen reflects what the modal stepper captured
              // (matches the "Rooms: N" row in the confirmation email +
              // the room-count cell on the invoice).
              ...(roomCount > 1 ? [{ label: t("rd.modal.rooms", { defaultValue: "Rooms" }), value: `${roomCount}` }] : []),
              { label: t("rd.modal.location", { defaultValue: "Location" }), value: placeLine(stay.location, stay.district) },
              ...(protectOn ? [{ label: t("rd.modal.protectYourStay", { defaultValue: "Protect your stay" }), value: t("rd.modal.addedAtPayment", { defaultValue: "Added at payment" }) }] : []),
              ...(couponQuote ? [{ label: t("rd.modal.factCoupon", { defaultValue: "Coupon" }), value: t("rd.modal.couponValue", { defaultValue: "{{code}} ({{amount}} off)", code: couponQuote.code, amount: rupee(couponQuote.discountAmount) }) }] : []),
            ],
            contact: { name: user?.name ?? "", phone: user?.phone ?? "" },
            rows: [
              {
                // Mirror the modal's per-night row: append "× N rooms"
                // when the guest booked more than one room, so the line
                // amount reconciles visually (₹5 × 1 night × 5 rooms =
                // ₹25 instead of the confusing "₹5 × 1 night = ₹25").
                label: (() => {
                  const base = formatNightlyRowLabel({
                    baseNightlyRupees: nightRate,
                    nights,
                    hostDiscountPercent: stay.discountPercent ?? 0,
                    formatRupees: rupee,
                  });
                  return roomCount > 1 ? t("rd.modal.nightRowRooms", { defaultValue: "{{label}} × {{count}} rooms", label: base, count: roomCount }) : base;
                })(),
                amount: base,
              },
              ...(couponOff > 0 ? [{ label: t("rd.modal.couponRow", { defaultValue: "Coupon ({{code}})", code: couponQuote?.code }), amount: -couponOff }] : []),
              { label: t("rd.modal.platformFee", { defaultValue: "Platform fee" }), amount: platformFee },
              ...gstRows(taxes, breakdown.gstRate, false, t),
              ...(protectOn ? [{ label: t("rd.modal.protectStayAtPayment", { defaultValue: "Protect your stay (added at payment)" }), amount: protectFeeRupees }] : []),
            ],
            total: displayTotal,
            protectOn,
            couponCode: couponQuote?.code,
            onSubmit: isBackendListing ? submitToBackend : undefined,
          });
        }}
      />
    </>
  );
}

// ---------- service scheduling helpers --------------------------------------

/** Minimum granularity service bookings respect. Falls back when the listing
 *  has no `duration` set (or it parses to 0). */
const SERVICE_FALLBACK_DURATION_MIN = 60;

/** Parse a free-text service duration ("75 min", "2 hours", "1-2 hours",
 *  "half day", "full day") into a single integer minute count. Mirrors the
 *  range/single matchers in `marketplace-adapters.ts:parseDurationMinutes`
 *  but collapses ranges to the lower bound — the booking needs a single
 *  end-time, not a window. */
// Exported for ProviderOnBehalfBookingModal — the host-books-for-customer
// flow reuses the exact same duration + slot→schedule resolution so its
// holds land on identical windows to customer bookings.
export function parseServiceDurationMin(duration: string): number {
  if (!duration) return SERVICE_FALLBACK_DURATION_MIN;
  const lower = duration.toLowerCase().trim();
  const rangeHours = lower.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/);
  if (rangeHours) return Math.round(parseFloat(rangeHours[1]) * 60);
  const rangeMins = lower.match(/(\d+)\s*-\s*(\d+)\s*(?:mins?|minutes?)/);
  if (rangeMins) return parseInt(rangeMins[1]);
  const singleHours = lower.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/);
  if (singleHours) return Math.round(parseFloat(singleHours[1]) * 60);
  const singleMins = lower.match(/(\d+)\s*(?:mins?|minutes?)/);
  if (singleMins) return parseInt(singleMins[1]);
  if (lower.includes("half day")) return 240;
  if (lower.includes("full day")) return 480;
  return SERVICE_FALLBACK_DURATION_MIN;
}

/** Turn a free-text slot label ("Today 6:30 PM", "Tomorrow 11:00 AM",
 *  "Sat 8:00 AM", "Wed 6:15 PM", "On request") into a concrete date + start
 *  time the backend booking row expects. Unparseable inputs default to
 *  tomorrow at 09:00 — backend pricing/availability aren't yet wired for
 *  services, so the date just has to be valid and in the future.
 *
 *  `referenceDate` (YYYY-MM-DD): when the user has picked a specific date
 *  chip in the slot picker, pass that here so the resolved scheduledDate
 *  is that exact date instead of "the next matching weekday from today".
 *  Without this, every "Mon X:XX" slot collapses to a single date — so if
 *  the host blocks that one date, ALL upcoming Mondays appear empty even
 *  though only one Monday is actually blocked. Bug surfaced as "blocking
 *  a date kills every other listing on that weekday".
 */
export function resolveServiceSchedule(slot: string, durationMin: number, referenceDate?: string): {
  scheduledDate: string;
  startTime: string;
  endTime: string;
} {
  // IST wall-clock: "today"/"tomorrow"/next-weekday must resolve on the
  // marketplace's calendar, or the server's IST past-date gate rejects
  // dates that still look like "today" in a western browser timezone.
  const now = istNow();
  // Default: tomorrow at 09:00.
  const target = new Date(now);
  target.setDate(target.getDate() + 1);
  let hour = 9;
  let minute = 0;

  const lower = (slot || "").trim().toLowerCase();
  if (lower) {
    // Day token. If referenceDate is provided, that wins — the user has
    // explicitly chosen a date for this slot.
    if (referenceDate && /^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
      const [y, m, d] = referenceDate.split("-").map(Number);
      target.setTime(new Date(y, m - 1, d).getTime());
    } else if (lower.startsWith("today")) {
      target.setTime(now.getTime());
    } else if (lower.startsWith("tomorrow")) {
      target.setTime(now.getTime());
      target.setDate(now.getDate() + 1);
    } else {
      // Weekday match — pick the next occurrence (could be today).
      const dayMap: Record<string, number> = {
        sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
      };
      const dayMatch = lower.match(/^(sun|mon|tue|wed|thu|fri|sat)/);
      if (dayMatch) {
        const targetDay = dayMap[dayMatch[1]];
        const diff = (targetDay - now.getDay() + 7) % 7 || 7;
        target.setTime(now.getTime());
        target.setDate(now.getDate() + diff);
      }
    }
    // Time token.
    const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (timeMatch) {
      let h = parseInt(timeMatch[1], 10);
      const m = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const meridiem = timeMatch[3];
      if (meridiem === "pm" && h < 12) h += 12;
      if (meridiem === "am" && h === 12) h = 0;
      hour = Math.min(23, Math.max(0, h));
      minute = Math.min(59, Math.max(0, m));
    }
  }

  const scheduledDate = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;
  const startTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const endMinutesTotal = hour * 60 + minute + Math.max(1, durationMin);
  const endHour = Math.min(23, Math.floor(endMinutesTotal / 60));
  const endMin = endMinutesTotal % 60;
  const endTime = `${String(endHour).padStart(2, "0")}:${String(endMin).padStart(2, "0")}`;
  return { scheduledDate, startTime, endTime };
}

// ---------- service body ----------------------------------------------------

function ServiceBody({
  request, user, onReview,
}: {
  request: Extract<BookingRequest, { kind: "service" }>;
  user: ReturnType<typeof useAuth>["user"];
  onReview: (r: BookingReceipt) => void;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const service = request.service;
  // Server-resolved platform-fee spec (admin fee rules). Legacy flat ₹3
  // until it loads or when the listing is a local demo row.
  const feeSpec = useFeeSpec(isLikelyUuid(String(service.id)) ? String(service.id) : null);
  const [mode, setMode] = useState<ServiceMode>(request.preselectedMode ?? service.mode[0]);
  const [slot, setSlot] = useState<string>(service.slots[0] ?? service.nextSlot);
  // Per-listing draft persistence — address survives modal close, browser
  // back, and tab navigation within the same session.
  const draft = useBookingDraft<{ address: string }>("service", service.id);
  const [address, setAddress] = draft.useField("address", "");
  const [addressInvalid, setAddressInvalid] = useState<string | null>(null);
  const [verifyingAddress, setVerifyingAddress] = useState(false);
  // True when the current address text came from a Google Places pick — a
  // picked place is precise-by-construction, so the review gate and the
  // pay-time check both skip re-geocoding it. Any manual keystroke clears it.
  const [addressPicked, setAddressPicked] = useState(false);
  // Review-gate UX: CTA stays clickable; a click with missing fields flips
  // this on, red-highlights them, and scrolls the first one into view.
  const [showErrors, setShowErrors] = useState(false);
  const addressRef = useRef<HTMLDivElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const [addOns, setAddOns] = useState<string[]>(request.preselectedAddOnIds ?? []);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(
    request.preselectedGroupId ?? service.servicesCatalog?.[0]?.id ?? null,
  );
  const selectedGroup = service.servicesCatalog?.find((g) => g.id === selectedGroupId)
    ?? service.servicesCatalog?.[0]
    ?? null;
  const catalogAddOns = selectedGroup?.addOns ?? service.addOns;
  // Reset group + add-ons when the modal is reused for a different listing, or
  // when the caller preselected a specific catalog group (tapping a catalog
  // row on the detail page).
  useEffect(() => {
    setSelectedGroupId(request.preselectedGroupId ?? service.servicesCatalog?.[0]?.id ?? null);
    setAddOns(request.preselectedAddOnIds ?? []);
  }, [service.id, request.preselectedGroupId, request.preselectedAddOnIds]);
  const [protectOn, setProtectOn] = useState(false);
  // Real backend-validated coupon flow — mirrors the stay path. Sends the
  // listingId so the server can confirm the coupon's host_user_id + category
  // scope match THIS service (a transport-scoped coupon won't apply here),
  // and forwards the resolved couponCode into createHold so it's atomically
  // consumed inside the hold transaction. Replaces the old in-memory
  // useCoupon() mock that silently rejected real backend codes.
  const [couponCode, setCouponCode] = useState("");
  const [couponQuote, setCouponQuote] = useState<CouponQuote | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [couponChecking, setCouponChecking] = useState(false);
  const isBackendService = isLikelyUuid(service.id);

  useEffect(() => { if (!service.mode.includes(mode)) setMode(service.mode[0]); }, [service, mode]);

  // ---- Slot availability ---------------------------------------------------
  // Pull all currently-active service bookings for this listing so we can
  // grey out slots whose underlying date+time intersects an existing one,
  // AND drop slots whose date is on the host's blocked-dates list. Without
  // this, two customers could pick the same window and one would get
  // bounced at hold-time with a confusing "slot taken" error.
  const serviceListingIdForBookings = typeof service.id === "string" ? service.id : null;
  const { data: serviceBookings = [] } = useQuery({
    queryKey: ["service-bookings", serviceListingIdForBookings],
    enabled: Boolean(serviceListingIdForBookings),
    // Always refetch when the modal mounts. The previous 30s staleTime
    // caused a stale window right after the user completed a booking —
    // re-opening the modal would still show their own slot as
    // bookable. The query is small and cheap; per-mount freshness wins.
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      const res = await getListingService().getServiceBookings(serviceListingIdForBookings as string);
      return res.success && res.data ? res.data : [];
    },
  });

  // Second source for the slot-blocker: the user's OWN bookings. The
  // public service-bookings endpoint can lag (caching, replica delay, or
  // a quirk in how the row was inserted), but the user's bookings query
  // is invalidated on every successful hold AND polls every 30s — so
  // their own just-confirmed slot reliably appears here. Merging both
  // sources means the slot picker never offers a window they've already
  // committed to, even if the public endpoint hasn't caught up.
  const { data: myBookings = [] } = useUserBookings();

  // Duration → minutes, lifted out of the resolver so we can match conflicts.
  const durationMinForSlot = useMemo(
    () => parseServiceDurationMin(service.duration || ""),
    [service.duration],
  );

  // Host-blocked dates (YYYY-MM-DD). Source of truth for service blocks is the
  // listing_availability_overrides table (room_type_id = null = listing-level),
  // the same store the provider "Schedule" UI writes to and the backend's
  // createHold enforces. We still union any legacy `service.blockedDates`
  // (older metadata-backed transport-style blocks) so nothing regresses.
  const { data: serviceAvailability = [] } = useQuery({
    queryKey: ["service-availability", serviceListingIdForBookings],
    enabled: Boolean(serviceListingIdForBookings) && isBackendService,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      const today = new Date();
      const to = new Date(today.getTime() + 365 * 86400000);
      const res = await getListingService().getAvailability(serviceListingIdForBookings as string, {
        from: today.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
      });
      return res.success && res.data ? res.data : [];
    },
  });
  const blockedDates = useMemo(() => {
    const set = new Set<string>(Array.isArray(service.blockedDates) ? service.blockedDates : []);
    for (const row of serviceAvailability) {
      // Only listing-level blocks apply to a service (services have no rooms).
      if (row.blocked && row.roomTypeId == null) set.add(String(row.date).slice(0, 10));
    }
    return set;
  }, [service.blockedDates, serviceAvailability]);

  /** Convert "HH:MM" to a minutes-since-midnight integer. */
  const minutesOf = (t: string) => {
    const [h, m] = (t || "").split(":").map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };

  // Build a Map<YYYY-MM-DD, [{start, end}]> of existing bookings so the
  // slot-filter has O(1) per-slot lookup. Two sources are merged:
  //  1. The public per-listing endpoint (all customers, but may lag).
  //  2. The signed-in user's own bookings filtered to this listing
  //     (always-fresh, defends against the lag in source #1).
  // De-duplication isn't needed — overlapping rows just produce
  // identical intervals that the overlap predicate handles idempotently.
  const ACTIVE_STATUSES = new Set(["pending", "confirmed", "in_progress"]);
  const bookingsByDate = useMemo(() => {
    const m = new Map<string, Array<{ start: number; end: number }>>();
    const push = (date: string | null | undefined, start: string, end: string) => {
      if (!date) return;
      const iso = String(date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
      const arr = m.get(iso) ?? [];
      arr.push({ start: minutesOf(start), end: minutesOf(end) });
      m.set(iso, arr);
    };
    for (const b of serviceBookings) {
      push(b.scheduledDate, b.startTime, b.endTime);
    }
    if (serviceListingIdForBookings) {
      for (const b of myBookings) {
        if (b.listingId !== serviceListingIdForBookings) continue;
        if (!ACTIVE_STATUSES.has(String(b.status ?? "").toLowerCase())) continue;
        push(b.scheduledDate, b.startTime ?? "", b.endTime ?? "");
      }
    }
    return m;
  }, [serviceBookings, myBookings, serviceListingIdForBookings]);

  // Date the user picked in the slot picker (YYYY-MM-DD). Lifted up so
  // (a) the slot filter can resolve weekday-anchored labels against the
  //     actual day the user is viewing (not just "the next Monday")
  // (b) submission knows which date to send to prepare_booking.
  // Initially null = "All slots" view; the picker pushes a real ISO date
  // when the user taps a day chip or picks one from the calendar.
  const [activeServiceDate, setActiveServiceDate] = useState<string | null>(null);

  // Per-(slot, date) blocked / occupied check. Resolves the slot label
  // against the supplied iso date — so "Mon 9:00 AM" can mean May 25 OR
  // June 1 depending on which chip the user has active. Blocking May 25
  // on the host calendar takes ONLY May 25 out; Jun 1 stays bookable.
  const isSlotBlockedOnDate = useCallback((slotText: string, iso: string): boolean => {
    if (blockedDates.has(iso)) return true;
    const { startTime } = resolveServiceSchedule(slotText, durationMinForSlot, iso);
    const start = minutesOf(startTime);
    const end = start + durationMinForSlot;
    const intervals = bookingsByDate.get(iso) ?? [];
    return intervals.some((iv) => start < iv.end && end > iv.start);
  }, [blockedDates, bookingsByDate, durationMinForSlot]);

  // "All slots" view filter: when the user hasn't picked a date yet, we
  // hide labels whose default upcoming-weekday resolution lands on a
  // blocked/occupied date. This keeps the initial list usable without
  // re-broadcasting weekday-only labels that have no remaining dates.
  // Once the user picks a date chip, ServiceSlotPicker does its own
  // date-aware filtering inside slotsForDay (see below).
  const allDayFilteredSlots = useMemo(() => {
    return service.slots.filter((slotText) => {
      const { scheduledDate } = resolveServiceSchedule(slotText, durationMinForSlot);
      return !isSlotBlockedOnDate(slotText, scheduledDate);
    });
  }, [service.slots, durationMinForSlot, isSlotBlockedOnDate]);

  // What ServiceSlotPicker actually renders. Raw slots when a specific
  // date is active (picker filters via isSlotBlockedOnDate + activeDay);
  // pre-filtered "all" view when no date is active.
  const availableSlots = activeServiceDate ? service.slots : allDayFilteredSlots;

  // If the currently-selected slot disappeared (booked by someone else
  // while the modal was open, or because the host just blocked the date),
  // snap to the next available one so the user doesn't submit a stale
  // selection. Empty `availableSlots` simply clears the selection — the
  // confirm button gates on `slot` being non-empty.
  useEffect(() => {
    if (!slot || availableSlots.includes(slot)) return;
    setSlot(availableSlots[0] ?? "");
  }, [availableSlots, slot]);

  const addOnsTotal = addOns.reduce((sum, id) => sum + (catalogAddOns.find((o) => o.id === id)?.price ?? 0), 0);
  const base = selectedGroup?.basePrice ?? service.price;
  // Pricing math MUST mirror `applyFees` server-side: coupon comes off
  // FIRST, then platform fee + GST compute against the *discounted*
  // subtotal. The previous order (platform fee on the un-discounted
  // base, coupon subtracted afterwards) overstated the modal total by
  // ~0.118 × couponAmount vs. the Razorpay order — small for tiny
  // coupons but visible on every receipt the moment a coupon was used.
  // Keep variable names so the breakdown rows + receipt downstream
  // continue to read the same fields.
  const grossSubtotal = base + addOnsTotal;
  // Backend quote already returns rupees-off; cap to the gross so taxes
  // can't go negative on a fixed-amount coupon larger than the cart.
  const couponOff = couponQuote ? Math.min(Math.max(0, couponQuote.discountAmount), grossSubtotal) : 0;
  const discountedSubtotal = Math.max(0, grossSubtotal - couponOff);
  // Platform fee from the server-resolved fee spec (rupee mirror of the
  // backend's computePlatformFeePaise, applied to the discounted subtotal).
  const platformFee = platformFeeRupees(discountedSubtotal, feeSpec);
  // Flat ₹2 protection — added AFTER tax so the breakdown matches the
  // backend's order-amount math (payments.service.ts adds insurance to
  // the already-taxed agreed_price).
  const protectFee = protectOn ? INSURANCE_FLAT_RUPEES : 0;
  // GST rate must come from the SAME category string the booking payload
  // sends as `serviceCategory` (service.category), so the preview equals the
  // server's gstRateFor — a hardcoded 18% mischarged categories the server
  // taxes differently (e.g. "Lodge Support" matches the 12% stay regex).
  const gstRate = gstRateFor(service.category);
  const taxes = (discountedSubtotal + platformFee) * gstRate;
  const total = discountedSubtotal + platformFee + taxes + protectFee;
  // Retain `taxableSubtotal` for any downstream readers; equals the
  // discount-applied subtotal that fees + tax compute against.
  const taxableSubtotal = discountedSubtotal;
  const subtotal = grossSubtotal + protectFee;
  const needsAddress = mode === "at-home";
  // IGST vs CGST+SGST preview: inter-state only when the customer's typed
  // at-home address names a different state than the provider's. Visit /
  // online modes have no customer address → intra-state (server parity).
  const gstInterState = needsAddress ? isInterStateText(service.visitAddress || service.location, address) : false;

  // Backend-validated coupon apply: hit /api/coupons/validate with the
  // listing id + base price. The server gates by host ownership, category
  // (post-migration), expiry, and max-uses, returning a CouponQuote with the
  // authoritative discountAmount. Failure paths surface a typed error
  // string instead of throwing — keeps the apply button predictable.
  const handleApplyServiceCoupon = async () => {
    const code = couponCode.trim().toUpperCase();
    if (!code) { setCouponError(t("rd.modal.enterCouponCode", { defaultValue: "Enter a coupon code" })); return; }
    if (!isBackendService) {
      setCouponError(t("rd.modal.couponNotOnPreview", { defaultValue: "Coupons aren't available on preview listings." }));
      return;
    }
    if (!grossSubtotal || grossSubtotal <= 0) {
      setCouponError(t("rd.modal.noPriceSet", { defaultValue: "This listing has no price set yet — coupon won't apply." }));
      return;
    }
    setCouponChecking(true);
    setCouponError(null);
    try {
      // basePrice = base + selected add-ons. The server's `couponsService.consume`
      // computes the discount against the SAME subtotal that platform fee + GST
      // run against (base + add-ons), so the preview must mirror that. Passing
      // just `base` here was undercounting percent coupons whenever the user
      // had add-ons selected — modal showed e.g. "−₹0.70" but Razorpay charged
      // a discount of "−₹1.00", and the totals drifted by the difference.
      const res = await getCouponsService().validate({ code, listingId: String(service.id), basePrice: grossSubtotal });
      if (!res.success || !res.data) {
        setCouponQuote(null);
        setCouponError(res.error || t("rd.modal.couponNotValid", { defaultValue: "Coupon not valid" }));
        getAnalyticsEventsService().track("coupon_failed", { listingType: "service", source: "booking_modal" });
        return;
      }
      setCouponQuote(res.data);
      getAnalyticsEventsService().track("coupon_applied", { listingType: "service", source: "booking_modal", props: { discountPaise: Math.round((res.data.discountAmount || 0) * 100) } });
      toast.success(t("rd.modal.couponAppliedToast", { defaultValue: "Coupon applied — {{amount}} off", amount: rupee(res.data.discountAmount) }));
    } finally {
      setCouponChecking(false);
    }
  };

  // Re-validate the applied coupon whenever the cart total changes (user
  // toggles an add-on after applying). Percent coupons scale with subtotal,
  // and fixed-amount coupons can become invalid if the cart drops below the
  // minimum — either way we re-quote against the live `grossSubtotal` so the
  // modal preview always matches what `couponsService.consume` will resolve
  // at hold time. Skip when no coupon is applied or the user is mid-typing.
  useEffect(() => {
    if (!couponQuote) return;
    if (!isBackendService) return;
    if (!grossSubtotal || grossSubtotal <= 0) return;
    let cancelled = false;
    (async () => {
      const res = await getCouponsService().validate({
        code: couponQuote.code,
        listingId: String(service.id),
        basePrice: grossSubtotal,
      });
      if (cancelled) return;
      if (res.success && res.data) {
        // Avoid an extra render when the quote is unchanged (toggling
        // add-ons that don't actually move a percent-rounded discount).
        if (res.data.discountAmount !== couponQuote.discountAmount) {
          setCouponQuote(res.data);
        }
      } else {
        // Cart no longer qualifies — drop the coupon and surface the reason.
        setCouponQuote(null);
        setCouponError(res.error || t("rd.modal.couponNoLongerApplies", { defaultValue: "Coupon no longer applies to this cart" }));
      }
    })();
    return () => { cancelled = true; };
  }, [grossSubtotal, couponQuote?.code, isBackendService, service.id]);

  const handleClearServiceCoupon = () => {
    setCouponQuote(null);
    setCouponCode("");
    setCouponError(null);
  };
  // canConfirm hardens with three new gates over the old version:
  //   1. `availableSlots` is non-empty — if every slot is either booked or
  //      on a blocked date, the user has nothing to commit to.
  //   2. The selected `slot` is in `availableSlots` (defends against an
  //      effect race where the picker briefly holds a stale string).
  //   3. At-home mode requires the address to PASS forward-geocode (set
  //      by the submit handler below). `addressInvalid` carries the
  //      reason; we surface it inline so the user can correct the input.
  const canConfirm =
    Boolean(slot)
    && availableSlots.includes(slot)
    && (!needsAddress || (address.trim().length > 3 && !addressInvalid && !verifyingAddress));

  /**
   * At-home address must resolve to a real place — checked at REVIEW time so
   * a partial autofill ("Trident Hotels") can't sail through and then fail
   * at payment. Acceptance, most→least precise:
   *   1. picked from the Places dropdown (precise by construction, no call),
   *   2. free text that forward-geocodes (coarse village/district points OK),
   *   3. tier-3/4 safety net: geocoder missed it but the text names a real
   *      Indian state — allow rather than block a hamlet Google doesn't know.
   * The same rule runs again at pay time, so review-pass == pay-pass.
   */
  const verifyAddressResolves = async (): Promise<boolean> => {
    if (addressPicked) return true;
    try {
      const lookup = await apiRequest<{ result: { lat?: number; lng?: number } | null }>(
        "/api/geocode",
        { method: "POST", headers: getJsonHeaders(), body: JSON.stringify({ address: address.trim() }) },
      );
      if (lookup.success && lookup.data?.result
        && typeof lookup.data.result.lat === "number" && typeof lookup.data.result.lng === "number") {
        return true;
      }
    } catch { /* network hiccup — fall through to the state-name net */ }
    return Boolean(gstStateCodeFromText(address));
  };

  return (
    <>
      <ModalBody>
        <div className="grid gap-2">
          <SectionLabel icon={<Sparkles className="h-3 w-3" />}>{t("rd.modal.serviceMode", { defaultValue: "Service mode" })}</SectionLabel>
          <div className="grid gap-2 sm:grid-cols-3">
            {(["at-home", "visit-provider", "online"] as ServiceMode[])
              .filter((m) => service.mode.includes(m))
              .map((m) => {
              const Icon = m === "at-home" ? Home : m === "visit-provider" ? Store : Globe2;
              const active = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition-all ${
                    active ? "border-foreground bg-foreground text-white" : "border-border bg-white/85 hover:bg-white"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="text-sm font-bold">{m === "at-home" ? t("rd.modal.modeAtHome", { defaultValue: "At home" }) : m === "online" ? t("rd.modal.modeOnline", { defaultValue: "Online" }) : t("rd.modal.modeVisitProvider", { defaultValue: "Visit provider" })}</span>
                </button>
              );
            })}
          </div>
        </div>

        {needsAddress && (
          <div ref={addressRef} className="grid gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <SectionLabel icon={<MapPin className="h-3 w-3" />}>{t("rd.modal.serviceAddress", { defaultValue: "Your address" })}</SectionLabel>
              <UseMyLocationButton onResolved={setAddress} />
            </div>
            <AddressAutocompleteInput
              value={address}
              onChange={(v) => { setAddress(v); setAddressInvalid(null); setAddressPicked(false); }}
              onSelectSuggestion={() => setAddressPicked(true)}
              mode="address"
              placeholder={t("rd.modal.serviceAddressPlaceholder", { defaultValue: "Door no, street, landmark, city" })}
              wrapperClassName={`relative flex items-center gap-2 rounded-xl border bg-white/85 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] ${addressInvalid || (showErrors && address.trim().length <= 3) ? "border-destructive" : "border-border"}`}
              className="w-full bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground"
            />
            {addressInvalid && (
              <p className="text-xs font-semibold text-destructive">{addressInvalid}</p>
            )}
            {showErrors && !addressInvalid && address.trim().length <= 3 && (
              <p className="text-xs font-semibold text-destructive">{t("rd.modal.errEnterAddress", { defaultValue: "Enter your address to continue." })}</p>
            )}
          </div>
        )}
        {mode === "online" && (
          <div className="rounded-2xl border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <p className="font-semibold text-foreground">{t("rd.modal.onlineSession", { defaultValue: "Online session" })}</p>
            {/* Surface the provider's actual delivery instructions when set
                (Phase 1 metadata); fall back to the generic copy for legacy
                rows that don't carry `meetingDetails` yet. */}
            <p className="mt-1">
              {service.meetingDetails || t("rd.modal.onlineSessionFallback", { defaultValue: "Meeting details will be sent to your registered phone and email before the slot." })}
            </p>
          </div>
        )}
        {mode === "visit-provider" && (
          <div className="rounded-2xl border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <p className="font-semibold text-foreground">{t("rd.modal.providerAddress", { defaultValue: "Provider address" })}</p>
            {/* Prefer the structured `visitAddress` written during onboarding;
                fall back to `service.location` so legacy listings still read
                naturally. The address links out to Google Maps so the
                customer can pull up directions in one tap. */}
            <p className="mt-1">
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(service.visitAddress || service.location)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-foreground underline underline-offset-2 transition-colors hover:text-accent"
              >
                {service.visitAddress || service.location}
              </a>
              {" · "}
              {t("rd.modal.arriveEarlyNote", { defaultValue: "please arrive 10 minutes early." })}
            </p>
          </div>
        )}

        {(selectedGroup || catalogAddOns.length > 0) && (
          <div className="grid gap-3">
            <SectionLabel icon={<Sparkles className="h-3 w-3" />}>{t("rd.modal.servicesCatalog", { defaultValue: "Services catalog" })}</SectionLabel>
            {(service.servicesCatalog?.length ?? 0) > 1 && (
              <div role="tablist" className="flex flex-wrap gap-2">
                {service.servicesCatalog!.map((g) => {
                  const active = g.id === (selectedGroup?.id ?? null);
                  return (
                    <button
                      key={g.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => {
                        if (g.id === selectedGroupId) return;
                        setSelectedGroupId(g.id);
                        setAddOns([]);
                      }}
                      className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-bold transition-colors ${
                        active
                          ? "border-foreground bg-foreground text-white"
                          : "border-border bg-white/80 text-foreground hover:border-foreground/40"
                      }`}
                    >
                      {g.name}
                      <span className={`tabular-nums ${active ? "text-white/80" : "text-muted-foreground"}`}>{rupee(g.basePrice)}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="grid gap-2">
              <div
                aria-pressed
                className="flex items-center justify-between gap-3 rounded-xl border border-foreground bg-foreground px-4 py-2.5 text-left text-sm text-white"
              >
                <span className="flex items-center gap-2 font-semibold">
                  <span aria-hidden className="grid h-4 w-4 place-items-center rounded-full border border-white bg-white text-[10px] font-black leading-none text-foreground">✓</span>
                  {selectedGroup?.name ?? service.title}
                </span>
                <span className="font-bold tabular-nums">{rupee(selectedGroup?.basePrice ?? service.price)}</span>
              </div>
              {catalogAddOns.map((opt) => {
                const checked = addOns.includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setAddOns((cur) => checked ? cur.filter((id) => id !== opt.id) : [...cur, opt.id])}
                    aria-pressed={checked}
                    className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-left text-sm transition-all ${
                      checked ? "border-foreground bg-foreground text-white" : "border-border bg-white/85 text-foreground hover:bg-white"
                    }`}
                  >
                    <span className="flex items-center gap-2 font-semibold">
                      <span
                        aria-hidden
                        className={`grid h-4 w-4 place-items-center rounded-full border text-[10px] font-black leading-none transition-colors ${
                          checked ? "border-white bg-white text-foreground" : "border-foreground/30 text-foreground/60"
                        }`}
                      >
                        {checked ? "✓" : "+"}
                      </span>
                      {opt.label}
                    </span>
                    <span className="font-bold tabular-nums">+{rupee(opt.price)}</span>
                  </button>
                );
              })}
            </div>
            {addOns.length > 0 && (
              <p className="rounded-lg bg-foreground/5 px-3 py-1.5 text-[11px] font-semibold text-foreground/80">
                {selectedGroup?.name ?? service.title} {catalogAddOns.filter((a) => addOns.includes(a.id)).map((a) => `+ ${a.label}`).join(" ")}
              </p>
            )}
          </div>
        )}

        <div ref={slotRef} className={`grid gap-1.5 ${showErrors && (!slot || !availableSlots.includes(slot)) && availableSlots.length > 0 ? "rounded-2xl ring-2 ring-destructive/70 ring-offset-4 ring-offset-white/90" : ""}`}>
          <SectionLabel icon={<CalendarDays className="h-3 w-3" />}>{t("rd.modal.pickASlot", { defaultValue: "Pick a slot" })}</SectionLabel>
          <ServiceSlotPicker
            slots={availableSlots}
            selected={slot}
            onSelect={setSlot}
            activeDate={activeServiceDate}
            onActiveDateChange={setActiveServiceDate}
            isSlotBlockedOnDate={isSlotBlockedOnDate}
          />
          {showErrors && (!slot || !availableSlots.includes(slot)) && availableSlots.length > 0 && (
            <p className="text-xs font-semibold text-destructive">{t("rd.modal.errPickSlot", { defaultValue: "Pick a time slot to continue." })}</p>
          )}
          {availableSlots.length === 0 && service.slots.length > 0 && (
            <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs font-semibold text-destructive">
              {t("rd.modal.allSlotsBooked", { defaultValue: "All upcoming slots are booked or blocked by the provider. Check back later or message the provider." })}
            </p>
          )}
        </div>

        <ProtectToggle checked={protectOn} onChange={setProtectOn} price={protectFee || INSURANCE_FLAT_RUPEES} kind="service" />
        <CouponField
          code={couponCode}
          setCode={setCouponCode}
          applied={couponQuote ? { code: couponQuote.code, label: `${rupee(couponQuote.discountAmount)} off` } : null}
          onApply={handleApplyServiceCoupon}
          onClear={handleClearServiceCoupon}
        />
        {couponError && <p className="-mt-2 text-xs font-semibold text-destructive">{couponError}</p>}
        {couponChecking && <p className="-mt-2 text-xs font-semibold text-muted-foreground">{t("rd.modal.checking", { defaultValue: "Checking…" })}</p>}

        <PriceBreakdown
          rows={[
            { label: t("rd.modal.serviceCharge", { defaultValue: "Service charge" }), amount: base },
            ...catalogAddOns.filter((a) => addOns.includes(a.id)).map((a) => ({ label: `+ ${a.label}`, amount: a.price })),
            { label: t("rd.modal.platformFee", { defaultValue: "Platform fee" }), amount: platformFee },
            ...(protectOn ? [{ label: t("rd.modal.protectYourAppointment", { defaultValue: "Protect your appointment" }), amount: protectFee }] : []),
            ...(couponOff > 0 ? [{ label: t("rd.modal.couponRow", { defaultValue: "Coupon ({{code}})", code: couponQuote?.code }), amount: -couponOff }] : []),
            ...gstRows(taxes, gstRate, gstInterState, t),
          ]}
        />
      </ModalBody>
      <FooterTotal
        total={total}
        ctaLabel={t("rd.modal.reviewBooking", { defaultValue: "Review booking" })}
        onConfirm={async () => {
          // Review gate: always clickable — a click with missing fields
          // highlights them and scrolls to the first one (address sits above
          // the slot picker in the form, so it wins the scroll).
          if (!canConfirm) {
            setShowErrors(true);
            const missingAddress = needsAddress && (address.trim().length <= 3 || Boolean(addressInvalid));
            scrollToMissingField(missingAddress ? addressRef.current : slotRef.current);
            return;
          }
          // At-home: the address must resolve NOW, not at payment — see
          // verifyAddressResolves for the acceptance ladder.
          if (needsAddress) {
            if (verifyingAddress) return;
            setVerifyingAddress(true);
            const ok = await verifyAddressResolves();
            setVerifyingAddress(false);
            if (!ok) {
              setAddressInvalid(t("rd.modal.errAddressNotFound", { defaultValue: "We couldn't find that address. Pick a suggestion from the dropdown or add more detail (house, street, area)." }));
              setShowErrors(true);
              scrollToMissingField(addressRef.current);
              return;
            }
            setAddressInvalid(null);
          }
          // Only real backend listings (UUID ids) attach a real submission
          // closure; legacy mock rows with numeric ids fall through to the
          // mock success state — same gating contract as the stay flow.
          const serviceIdForBackend = isLikelyUuid(service.id) ? service.id : null;
          const selectedAddOnObjs = catalogAddOns.filter((a) => addOns.includes(a.id));
          // We DON'T forward an `agreedPrice` claim to createHold for
          // services. The backend's drift check (bookings.service.ts:697-714)
          // compares the claim against `breakdown.totalPaise` (subtotal +
          // 10% platform fee + 18% GST), not the subtotal — so any
          // subtotal-only claim would drift well past the ±₹2 tolerance and
          // the hold would 4xx. Add-ons are frontend-only display state and
          // aren't modelled server-side either; the selected labels still
          // ride along in `notes` so the host dashboard can see them. The
          // legacy `src/components/ServiceBookingModal.tsx:192-197` adopts
          // the same "omit, trust server" pattern for the same reason. We
          // use `holdResult.data.booking.agreedPricePaise` (the
          // server-stored authoritative total) for createOrder downstream.

          const submitToBackend: NonNullable<BookingReceipt["onSubmit"]> = async ({ onHoldCreated }) => {
            if (!serviceIdForBackend) {
              throw new Error(t("rd.modal.errServiceNotBookable", { defaultValue: "This service isn't bookable yet." }));
            }
            const durationMin = parseServiceDurationMin(service.duration);
            // Pass the user-chosen activeDate so weekday-anchored slot
            // labels ("Mon 9:00 AM") resolve to the date the user is
            // actually viewing (e.g. Jun 1), not "the next Monday".
            // Without this, picking Mon Jun 1 in the chip strip would
            // submit a May 25 booking row.
            const schedule = resolveServiceSchedule(slot, durationMin, activeServiceDate ?? undefined);

            // At-home requires a resolvable address. Same acceptance ladder
            // as the review gate (picked place → forward geocode → state-name
            // safety net, see verifyAddressResolves) so an address that
            // passed review can never fail here at pay time.
            if (mode === "at-home") {
              setVerifyingAddress(true);
              try {
                const ok = await verifyAddressResolves();
                if (!ok) {
                  const msg = t("rd.modal.errAddressNotFound", { defaultValue: "We couldn't find that address. Pick a suggestion from the dropdown or add more detail (house, street, area)." });
                  setAddressInvalid(msg);
                  throw new Error(msg);
                }
                setAddressInvalid(null);
              } finally {
                setVerifyingAddress(false);
              }
            }

            // Final guard: slot may have been booked by someone else between
            // initial fetch and submit. If our `availableSlots` filter no
            // longer includes the picked one, refuse and let the user pick
            // again from the refreshed list.
            if (!availableSlots.includes(slot)) {
              throw new Error(t("rd.modal.errSlotTaken", { defaultValue: "That slot was just taken. Pick another time." }));
            }

            // Mode-aware notes payload. Keys per task spec; mode-specific
            // sub-fields (customerAddress / visitAddress / meetingDetails)
            // are stamped conditionally so the host dashboard's notes
            // parser sees only the data that applies to the mode picked.
            // `guestName` is injected by `mergeGuestNameIntoNotes` so host
            // UIs can render a real name even when the user_profiles row
            // still holds the schema default — mirrors the stay flow.
            // Notes assembly moved server-side (bookingService.prepare →
            // buildBookingNotes). Structured fields are sent below.

            // `address` column routing per spec:
            //   at-home        → customer's address (required upstream)
            //   visit-provider → provider's visit address (or fall back to
            //                    listing location so dashboards aren't blank)
            //   online         → leave unset
            const bookingAddress = mode === "at-home"
              ? address.trim()
              : mode === "visit-provider"
                ? (service.visitAddress || service.location || undefined)
                : undefined;

            let heldBookingId: string | null = null;
            let shouldReleaseHoldOnError = false;
            try {
              // Unified prepare: server builds notes, creates the hold +
              // Razorpay order (authoritative pricing), returns the payload.
              const prep = await getBookingService().prepare({
                listingType: "service",
                listingId: String(serviceIdForBackend),
                serviceCategory: service.category,
                scheduledDate: schedule.scheduledDate,
                startTime: schedule.startTime,
                endTime: schedule.endTime,
                serviceMode: mode as "at-home" | "visit-provider" | "online",
                serviceAddress: mode === "at-home" ? address.trim() : undefined,
                visitAddress: mode === "visit-provider" ? (service.visitAddress || service.location || undefined) : undefined,
                meetingDetails: mode === "online" ? (service.meetingDetails || t("rd.modal.meetingLinkFallback", { defaultValue: "Provider will share meeting link before the slot." })) : undefined,
                slot,
                serviceAddOns: selectedAddOnObjs.length > 0
                  ? selectedAddOnObjs.map((a) => ({ id: a.id, label: a.label, price: a.price }))
                  : undefined,
                serviceCatalogId: selectedGroup?.id,
                serviceCatalogName: selectedGroup?.name,
                serviceCatalogBasePrice: selectedGroup?.basePrice,
                insuranceOptIn: protectOn,
                contact: { name: user?.name ?? "", phone: user?.phone ?? "" },
                guestName: user?.name ?? undefined,
                couponCode: couponQuote?.code,
                address: bookingAddress,
                listingTitle: service.title,
                listingName: service.title,
                listingImage: service.image,
                listingLocation: service.location,
                idempotencyKey: generateIdempotencyKey(),
              });
              if (!prep.success || !prep.data) {
                throw new Error(prep.error || t("rd.modal.errHoldService", { defaultValue: "Could not hold this service slot. Please try again." }));
              }
              const b = prep.data;
              heldBookingId = b.bookingId;
              shouldReleaseHoldOnError = true;
              onHoldCreated(heldBookingId);

              type VerifyOutcome =
                | { status: "confirmed"; paymentId?: string }
                | { status: "pending"; paymentId?: string }
                | { status: "hold_preserved" };

              // Non-async executor: the outcome resolves only through the
              // checkout callbacks; a rejected launch (script load / open
              // failure) rejects via the trailing .catch.
              const outcome = await new Promise<VerifyOutcome>((resolve, reject) => {
                launchRazorpayCheckout({
                  keyId: b.keyId,
                  orderId: b.orderId,
                  amountPaise: b.amountPaise,
                  currency: b.currency,
                  bookingId: heldBookingId as string,
                  description: t("rd.modal.razorpayServiceDesc", { defaultValue: "Service: {{title}}", title: service.title }),
                  prefill: { email: user?.email, contact: user?.phone, name: user?.name },
                  analytics: { listingId: String(service.id), listingType: "service" },
                  // Mirror stay flow: dismiss + payment.failed PRESERVE
                  // the hold and bounce back to review so the user can
                  // retry within the TTL window.
                  onDismiss: () => resolve({ status: "hold_preserved" }),
                  onFailure: () => resolve({ status: "hold_preserved" }),
                  onSuccess: async (response) => {
                    const verifyResult = await getPaymentService().verifyPayment({
                      bookingId: heldBookingId as string,
                      razorpay_order_id: response.razorpay_order_id,
                      razorpay_payment_id: response.razorpay_payment_id,
                      razorpay_signature: response.razorpay_signature,
                    });
                    if (!verifyResult.success) {
                      reject(new Error(verifyResult.error || t("rd.modal.errPaymentVerification", { defaultValue: "Payment verification failed." })));
                      return;
                    }
                    if (verifyResult.data?.pending) {
                      resolve({ status: "pending", paymentId: verifyResult.data?.paymentId });
                      return;
                    }
                    resolve({ status: "confirmed", paymentId: verifyResult.data?.paymentId });
                  },
                }).catch(reject);
              });

              if (outcome.status === "hold_preserved") {
                shouldReleaseHoldOnError = false;
                throw new Error(HOLD_PRESERVED_ERROR);
              }

              shouldReleaseHoldOnError = false;
              // Booking confirmed/pending — drop the saved draft so the next
              // visit to this listing starts clean.
              draft.clear();
              return {
                status: outcome.status,
                bookingId: heldBookingId,
                paymentId: outcome.paymentId,
              };
            } catch (error) {
              if (heldBookingId && shouldReleaseHoldOnError) {
                await getBookingService().releaseHold(heldBookingId).catch(() => undefined);
              }
              throw error;
            }
          };

          onReview({
            image: service.image,
            eyebrow: `${service.category} · ${service.duration}`,
            title: service.title,
            subtitle: `${service.provider} · ${service.location}`,
            facts: [
              // Selected service name leads the facts so review + confirmation
              // both make it clear WHICH service was booked (a salon may have
              // Men's / Women's / Kids haircut — the listing title alone
              // doesn't disambiguate). Falls through to nothing for legacy
              // listings without a catalog so old success screens look the same.
              ...(selectedGroup ? [{ label: t("rd.modal.factService", { defaultValue: "Service" }), value: selectedGroup.name }] : []),
              { label: t("rd.modal.serviceMode", { defaultValue: "Service mode" }), value: mode === "at-home" ? t("rd.modal.modeAtHome", { defaultValue: "At home" }) : mode === "online" ? t("rd.modal.modeOnline", { defaultValue: "Online" }) : t("rd.modal.modeVisitProvider", { defaultValue: "Visit provider" }) },
              { label: t("rd.modal.factSlot", { defaultValue: "Slot" }), value: slot },
              ...(mode === "at-home" && address ? [{ label: t("rd.modal.factAddress", { defaultValue: "Address" }), value: address }] : []),
              ...(mode === "visit-provider" ? [{ label: t("rd.modal.factVisitAt", { defaultValue: "Visit at" }), value: service.visitAddress || service.location }] : []),
              ...(mode === "online" && service.meetingDetails ? [{ label: t("rd.modal.factOnlineDelivery", { defaultValue: "Online delivery" }), value: service.meetingDetails }] : []),
              ...(addOns.length > 0 ? [{
                label: t("rd.modal.factServicesAdded", { defaultValue: "Services added" }),
                value: catalogAddOns.filter((a) => addOns.includes(a.id)).map((a) => `+ ${a.label}`).join("  "),
              }] : []),
              ...(protectOn ? [{ label: t("rd.modal.protectYourAppointment", { defaultValue: "Protect your appointment" }), value: t("rd.modal.added", { defaultValue: "Added" }) }] : []),
              ...(couponQuote ? [{ label: t("rd.modal.factCoupon", { defaultValue: "Coupon" }), value: t("rd.modal.couponValue", { defaultValue: "{{code}} ({{amount}} off)", code: couponQuote.code, amount: rupee(couponQuote.discountAmount) }) }] : []),
            ],
            contact: { name: user?.name ?? "", phone: user?.phone ?? "" },
            rows: [
              // Base-row label tracks the selected group name when present
              // ("Men's Haircut" instead of generic "Service charge") so the
              // fare summary reads like the catalog the user just picked from.
              { label: selectedGroup?.name ?? t("rd.modal.serviceCharge", { defaultValue: "Service charge" }), amount: base },
              ...catalogAddOns.filter((a) => addOns.includes(a.id)).map((a) => ({ label: `+ ${a.label}`, amount: a.price })),
              { label: t("rd.modal.platformFee", { defaultValue: "Platform fee" }), amount: platformFee },
              ...(protectOn ? [{ label: t("rd.modal.protectYourAppointment", { defaultValue: "Protect your appointment" }), amount: protectFee }] : []),
              ...(couponOff > 0 ? [{ label: t("rd.modal.couponRow", { defaultValue: "Coupon ({{code}})", code: couponQuote?.code }), amount: -couponOff }] : []),
              ...gstRows(taxes, gstRate, gstInterState, t),
            ],
            total,
            protectOn,
            // Forward the resolved code so createHold (server) re-validates +
            // atomically consumes it inside the hold transaction. Server then
            // stamps the discount snapshot on the booking row, which the
            // confirmation email + invoice both read from. No client-side
            // discount is trusted on the server side.
            couponCode: couponQuote?.code,
            // Real listing paths go through the existing hold → order →
            // verify pipeline; coupon discount in the preview is mock-only
            // and is NOT forwarded to createHold.
            onSubmit: serviceIdForBackend ? submitToBackend : undefined,
          });
        }}
      />
    </>
  );
}

// ---------- transport body --------------------------------------------------

function getBookableTransportModes(item: MarketplaceTransport): TransportMode[] {
  // A mode is bookable when EITHER (a) the driver has a price/package
  // for it, OR (b) the driver explicitly opted into it during onboarding
  // (`metadata.transportModes`). The intent fallback covers listings
  // where the price didn't round-trip through the adapter — e.g.
  // AI-onboarded rows that wrote the rate as free text without
  // persisting `metadata.pricePerHour`/`Day`. Drivers who genuinely
  // want to stop accepting a mode should zero out the price in edit;
  // the modal then computes a 0 total and blocks the booking with a
  // clear "price not set" message instead of silently hiding.
  const intent = new Set<TransportMode>((item.transportModes ?? []).filter(
    (m): m is TransportMode => m === "hourly" || m === "day" || m === "package",
  ));
  const out: TransportMode[] = [];
  if (item.hourly > 0 || intent.has("hourly")) out.push("hourly");
  if (item.day > 0 || intent.has("day")) out.push("day");
  if (item.packageOptions.length > 0 || intent.has("package")) out.push("package");
  return out;
}

function TransportBody({
  request, user, onReview,
}: {
  request: Extract<BookingRequest, { kind: "transport" }>;
  user: ReturnType<typeof useAuth>["user"];
  onReview: (r: BookingReceipt) => void;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const item = request.transport;
  // Server-resolved platform-fee spec (admin fee rules). Legacy flat ₹3
  // until it loads or when the listing is a local demo row.
  const feeSpec = useFeeSpec(isLikelyUuid(String(item.id)) ? String(item.id) : null);
  const bookableModes = useMemo(() => getBookableTransportModes(item), [item]);
  const [mode, setMode] = useState<TransportMode>(
    bookableModes.includes(request.preselectedMode as TransportMode)
      ? (request.preselectedMode as TransportMode)
      : bookableModes[0] ?? "hourly"
  );
  const [packageId, setPackageId] = useState<string>(request.preselectedPackageId ?? item.packageOptions[0]?.id ?? "");
  // Hourly bookings now collect a from/to time range instead of a "how
  // many hours" stepper — billable hours derive from the difference, so
  // pricing + the notes.durationHours payload stay in lockstep with the
  // window the user actually picked.
  const [hourlyStart, setHourlyStart] = useState("09:00");
  const [hourlyEnd, setHourlyEnd] = useState("13:00");
  // Multi-select slot picker state. Each entry is a slot's start
  // ("HH:MM"); the bounding window is min(selected) → max(selected) + 1h
  // and gets mirrored into hourlyStart/hourlyEnd so the rest of the
  // booking flow keeps working unchanged.
  const [selectedSlots, setSelectedSlots] = useState<Set<string>>(new Set());
  // When the user types a start/end on the spinners, derive the slot
  // set from the bounding window so the strip lights up in real time.
  // Re-syncs whenever either spinner changes — the toggle handler also
  // updates the spinners, but writing the same value back here is a
  // no-op (Set identity is preserved when the membership doesn't
  // change).
  useEffect(() => {
    const startMin = parseHHMM(hourlyStart);
    const endMin = parseHHMM(hourlyEnd);
    if (startMin == null || endMin == null || endMin <= startMin) return;
    const next = new Set<string>();
    // Step from startMin directly (no snap-to-whole-hour). The strip emits
    // 60-min cells whose starts cascade off (windowStart) or (bookedEnd +
    // bufferMinutes) — so cells AFTER a booking land at offsets like 14:15,
    // 15:15, … not 14:00, 15:00. The old `Math.floor(startMin/60)*60` snap
    // produced set membership like {"14:00"} when the strip cell was
    // "14:15", so the cell never lit up "selected" and the customer
    // couldn't visually see what they'd picked. Stepping from startMin
    // preserves whatever offset the click chose.
    for (let t = startMin; t + 60 <= endMin; t += 60) {
      const h = Math.floor(t / 60);
      const m = t % 60;
      next.add(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
    setSelectedSlots((prev) => {
      if (prev.size === next.size && Array.from(prev).every((s) => next.has(s))) return prev;
      return next;
    });
  }, [hourlyStart, hourlyEnd]);
  const [date, setDate] = useState("");
  // Review-gate UX: CTA stays clickable; a click with missing fields flips
  // this on, red-highlights them, and scrolls the first one into view. Only
  // one mode branch renders at a time, so a single dateRef serves all three.
  const [showErrors, setShowErrors] = useState(false);
  const dateRef = useRef<HTMLDivElement | null>(null);
  const pickupRef = useRef<HTMLDivElement | null>(null);
  // Multi-day day-rental: optional end date. Empty means a 1-day rental
  // (endDate = date). When set, must be >= date and must NOT cross any
  // blocked date in between — every day in the range becomes a billable
  // rental day. The slot strip is dropped for day mode because a day
  // booking takes the vehicle for the whole working window — picking a
  // start time is meaningless. See dayRangeError below for the validity
  // check + user-facing message.
  const [dayEnd, setDayEnd] = useState("");
  // Per-listing draft persistence — pickup survives modal close + back nav.
  const draft = useBookingDraft<{ pickup: string }>("transport", item.id);
  const [pickup, setPickup] = draft.useField("pickup", "");
  const [passengers, setPassengers] = useState(2);
  const [protectOn, setProtectOn] = useState(false);
  // Pickup-address validation is intentionally OFF for now. The previous
  // forward-geocode gate (Nominatim → reject anything we couldn't pin,
  // OR anything outside the driver's serviceRadiusKm) was rejecting
  // legitimate Hyderabad pickups because Nominatim's coverage on noisy
  // Indian addresses is unreliable. Until we have a better geocoder /
  // smarter heuristic, the only gate is "pickup field is non-empty"
  // (enforced via canConfirm below). Service-area mismatch will surface
  // operationally — the driver can reject the trip if it's truly out of
  // range. Helpers `describePickupRejection` + the submit-time gate
  // below have been removed in lockstep; re-wire here when re-enabling.
  // Real backend-validated coupon flow (same as stays/services). The mock
  // useCoupon() was silently rejecting every real backend code because its
  // MOCK_COUPONS table didn't include host-created codes. Server-side
  // validation also enforces the per-category scope so a stay or service
  // coupon can't quietly knock the price off a transport booking.
  const [couponCode, setCouponCode] = useState("");
  const [couponQuote, setCouponQuote] = useState<CouponQuote | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [couponChecking, setCouponChecking] = useState(false);
  const isBackendTransport = isLikelyUuid(item.id);

  // Phase 3: when the listing exposes multiple transportation types (e.g.
  // sedan + tempo + airport pickup), the customer picks which one they're
  // booking. The choice is recorded in booking.notes so the driver knows
  // which vehicle to bring. Single-type / legacy listings collapse to the
  // one entry and the picker stays hidden.
  const transportationTypes = item.transportationTypes ?? [];
  const [subTypeId, setSubTypeId] = useState<string>(
    transportationTypes[0]?.type ?? "",
  );
  const selectedSubType = transportationTypes.find((t) => t.type === subTypeId) ?? transportationTypes[0];

  const selectedPackage = item.packageOptions.find((p) => p.id === packageId) ?? item.packageOptions[0];
  const isPoint = mode === "point";
  // IGST vs CGST+SGST preview: inter-state only when the pickup names a
  // different state than the driver's area (both must name a state; unknown
  // → intra-state, matching the server's safe default).
  const gstInterState = isInterStateText([item.area, item.city].filter(Boolean).join(", "), pickup);

  useEffect(() => {
    if (bookableModes.length > 0 && !bookableModes.includes(mode)) {
      setMode(bookableModes[0]);
    }
  }, [bookableModes, mode]);

  // Resolve billable hours from the from/to range. End must be strictly
  // greater than start (no overnight wrap on hourly — drivers book a
  // continuous window the same day). When the range is invalid we surface
  // an error on the form and disable Review.
  const { hours, hoursError } = useMemo(() => {
    if (mode !== "hourly") return { hours: 0, hoursError: null as string | null };
    const startMin = parseHHMM(hourlyStart);
    const endMin = parseHHMM(hourlyEnd);
    if (startMin == null || endMin == null) {
      return { hours: 0, hoursError: t("rd.modal.errPickStartEnd", { defaultValue: "Pick a start time and end time." }) };
    }
    if (endMin <= startMin) {
      return { hours: 0, hoursError: t("rd.modal.errEndAfterStart", { defaultValue: "End time must be after start time." }) };
    }
    // Same-day pickups can't start in the past or within the lead-time buffer.
    if (date && date === istTodayIso() && startMin < istNowMinutes() + BOOKING_LEAD_MINUTES) {
      return { hours: 0, hoursError: t("rd.modal.errSlotTooSoon", { defaultValue: "Pick a start time at least 30 minutes from now." }) };
    }
    return { hours: (endMin - startMin) / 60, hoursError: null };
  }, [mode, hourlyStart, hourlyEnd, date, t]);

  // Pre-fetch the driver's active bookings so we can grey out unavailable
  // time slots BEFORE the user submits, instead of relying on createHold's
  // conflict error. Real-backend listings only (mock rows have non-UUID ids
  // and there's nothing to query). Window mirrors the date picker's
  // booking range (today → +90d).
  // Normalize to lowercase so the listingId compares below match even when
  // a caller hands us an upper/mixed-case UUID — Postgres always serializes
  // uuid columns lowercase, so a single uppercase character on the modal
  // side silently dropped the user's own bookings from the busy map and the
  // strip rendered everything as Free.
  const transportListingId = isLikelyUuid(item.id) ? String(item.id).toLowerCase() : null;
  const transportBookingsQuery = useQuery({
    queryKey: ["transport-bookings", transportListingId],
    enabled: Boolean(transportListingId),
    // Always refetch on mount — the previous 30s staleTime left a window
    // right after the user completed a hold where reopening the modal
    // still showed the just-taken slot as Free. Per-modal-mount refresh
    // is one tiny GET; freshness wins.
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      const result = await getListingService().getTransportBookings(transportListingId as string);
      return result.success && result.data ? result.data : [];
    },
  });
  const existingBookings = transportBookingsQuery.data ?? [];

  // Second source: the user's OWN bookings. The public per-listing
  // endpoint can lag (caching, replica delay); the user-bookings cache
  // is invalidated on every successful hold AND polls. Merging both
  // means the hourly strip never offers a window they've already
  // committed to, even if the public endpoint hasn't caught up.
  const { data: myBookings = [], isFetching: myBookingsFetching } = useUserBookings();

  // Force a one-shot refresh of the user's bookings cache when the modal
  // opens for a transport listing. `useUserBookings` has staleTime 15s and
  // no `refetchOnMount: "always"`; if the user just booked this driver and
  // immediately reopens the modal (the exact case where they MUST see their
  // own slot as taken), the cached pre-booking response was being reused and
  // the strip showed the just-taken hours as Free.
  const queryClientForBookings = useQueryClient();
  useEffect(() => {
    if (!transportListingId) return;
    void queryClientForBookings.invalidateQueries({ queryKey: ["bookings"] });
    // Only when the modal binds to a real transport listing — not on every
    // re-render. Listing id changes (e.g. user switches drivers) re-fire it.
  }, [transportListingId, queryClientForBookings]);

  // Either source still in-flight → don't claim "wide open" yet. The
  // availability notice uses this to render "Checking availability…"
  // instead of a green checkmark while data loads.
  const availabilityLoading =
    Boolean(transportListingId) && (transportBookingsQuery.isFetching || myBookingsFetching);

  // Compute the window the user is currently trying to book. Day rentals
  // occupy the full 09:00 → 19:00 window per the createHold contract;
  // packages run 09:00 → 09:00 + packageHours; hourly uses the user's
  // chosen range.
  const proposedWindow = useMemo(() => {
    if (isPoint) return null;
    if (mode === "hourly") {
      if (!date || hoursError) return null;
      return { date, start: hourlyStart, end: hourlyEnd };
    }
    // Day rentals AND packages book the WHOLE day server-side (the hold is
    // widened to the driver's working window) — so the conflict preview must
    // treat ANY existing booking on that date as a clash, or the client says
    // "free" and the server still 409s.
    if (mode === "day" || mode === "package") {
      if (!date) return null;
      return { date, start: "00:00", end: "23:59" };
    }
    return null;
  }, [mode, date, hourlyStart, hourlyEnd, hoursError, isPoint]);

  // Group existing bookings by date for fast lookup. Each entry is a list
  // of [startMin, endMin] tuples — minutes since midnight, what the
  // overlap math actually needs. Two sources merged:
  //   1. Public per-listing endpoint (all customers, may lag).
  //   2. User's own bookings filtered to this listing (always-fresh).
  // De-dup isn't needed — overlapping intervals are idempotent for the
  // overlap math downstream.
  const ACTIVE_TRANSPORT_STATUSES = new Set(["pending", "confirmed", "in_progress"]);
  const bookingsByDate = useMemo(() => {
    const map = new Map<string, Array<{ start: number; end: number }>>();
    const push = (date: string | null | undefined, startStr: string, endStr: string) => {
      if (!date) return;
      const iso = String(date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
      const s = parseHHMM(startStr);
      const e = parseHHMM(endStr);
      if (s == null || e == null || e <= s) return;
      const arr = map.get(iso) ?? [];
      arr.push({ start: s, end: e });
      map.set(iso, arr);
    };
    for (const b of existingBookings) {
      push(b.scheduledDate, b.startTime, b.endTime);
    }
    if (transportListingId) {
      for (const b of myBookings) {
        const bookingListingId = typeof b.listingId === "string" ? b.listingId.toLowerCase() : "";
        if (bookingListingId !== transportListingId) continue;
        if (!ACTIVE_TRANSPORT_STATUSES.has(String(b.status ?? "").toLowerCase())) continue;
        push(b.scheduledDate, b.startTime ?? "", b.endTime ?? "");
      }
    }
    return map;
  }, [existingBookings, myBookings, transportListingId]);

  // Dates that the CURRENT MODE'S fixed window can't use because some
  // existing booking actually overlaps that window. Mode-aware so the
  // notice + the canConfirm gating agree:
  //
  //   - day:     window 09:00–19:00 (the workday)
  //   - package: window 09:00 → 09:00 + packageHours
  //   - hourly:  not applicable (hourly users pick their own window;
  //              they're gated by proposedConflicts on the picked range)
  //
  // Earlier this set was unconditionally "any booking on the day" which
  // disagreed with the actual conflict check — e.g. a 06:00–08:00
  // booking does not overlap a 09:00–19:00 day rental, but the old set
  // marked the date as blocked and the notice/CTA disagreed.
  const fullyBlockedDates = useMemo(() => {
    const out = new Set<string>();
    if (mode !== "day" && mode !== "package") return out;
    const dayStart = 9 * 60;
    const dayEnd = mode === "day"
      ? 19 * 60
      : (9 + Math.min(14, Math.max(1, Math.round(selectedPackage?.hours ?? 8)))) * 60;
    bookingsByDate.forEach((slots, day) => {
      const overlaps = slots.some((s) => s.start < dayEnd && s.end > dayStart);
      if (overlaps) out.add(day);
    });
    return out;
  }, [bookingsByDate, mode, selectedPackage]);

  // Weekdays (0=Sun..6=Sat) the driver actually works. Pulled straight from
  // the listing's onboarded workingHours JSON ({ mon:[..], tue:[..], sun:null }
  // shape). The DateField uses this to grey out off-days entirely so the
  // customer can't pick a weekday with no slots — keeps the picker honest
  // when a driver is "Mon–Fri only" but the OS calendar would otherwise let
  // them tap Sunday. When workingHours is missing (legacy rows) we leave
  // the set empty, which the DateField treats as "every weekday open".
  const enabledWeekdays = useMemo(() => {
    const wh = item.workingHours;
    if (!wh || typeof wh !== "object") return new Set<number>();
    const key: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    // Open weekdays only — no per-mode window-length math. Packages book the
    // WHOLE day (their stated hours are descriptive), so the only calendar
    // rule for every mode is open vs closed. Mirrors the server's hold gate.
    const out = new Set<number>();
    for (const [day, range] of Object.entries(wh)) {
      const dow = key[day.toLowerCase()];
      if (dow == null) continue;
      if (Array.isArray(range) && range.length === 2 && range[0] && range[1]) out.add(dow);
    }
    return out;
  }, [item.workingHours]);

  // Dates the customer's date picker should disable entirely. Union of:
  //   - driver-blocked dates (set from the dashboard schedule view)
  //   - dates fully booked for the current mode (computed above)
  // Past dates are handled by DateField's own isPast check; this set
  // only carries explicit unavailables. Empty when neither signal fires.
  const unavailableDates = useMemo(() => {
    const out = new Set<string>();
    for (const d of fullyBlockedDates) out.add(d);
    if (Array.isArray(item.blockedDates)) {
      for (const d of item.blockedDates) out.add(d);
    }
    return out;
  }, [fullyBlockedDates, item.blockedDates]);

  // If the date the user already picked falls into the unavailable set
  // (e.g. they switched mode and the day's bookings now block the new
  // window, or the driver just blocked the day), clear it so they have
  // to re-pick. Without this the customer would see a date locked in
  // that they can't actually book.
  useEffect(() => {
    if (date && unavailableDates.has(date)) setDate("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unavailableDates]);

  // Same self-correction for weekday-off conflicts: if the picked date lands
  // on a weekday the driver doesn't work, clear it so the user re-picks.
  // Otherwise the modal would show a date that no longer maps to any slot
  // and the booking would fail at hold-time with a confusing error.
  useEffect(() => {
    if (!date || enabledWeekdays.size === 0) return;
    const dow = new Date(`${date}T00:00:00`).getDay();
    if (!enabledWeekdays.has(dow)) setDate("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledWeekdays]);

  // The conflict for the CURRENT picker state, if any. Edge case: the
  // backend allows touching endpoints (a booking ending at 14:00 and one
  // starting at 14:00 don't overlap), so we use strict <  > comparisons —
  // identical to the SQL `start_time < $end AND end_time > $start`.
  const proposedConflicts = useMemo(() => {
    if (!proposedWindow) return [];
    const slots = bookingsByDate.get(proposedWindow.date) ?? [];
    const propStart = parseHHMM(proposedWindow.start);
    const propEnd = parseHHMM(proposedWindow.end);
    if (propStart == null || propEnd == null) return [];
    return slots.filter((s) => s.start < propEnd && s.end > propStart);
  }, [proposedWindow, bookingsByDate]);
  const hasProposedConflict = proposedConflicts.length > 0;

  // The full list of busy windows on the currently picked date — surfaced
  // in the UI as "Already booked: 09:00–13:00, 16:00–18:00" so the user
  // can see exactly what's free.
  const busyOnSelectedDate = useMemo(
    () => date ? (bookingsByDate.get(date) ?? []) : [],
    [bookingsByDate, date],
  );

  // Phase 3: resolve the per-sub-type price for the booked mode with an
  // explicit fallback chain so single-type / legacy listings keep working
  // and multi-type listings honor per-type pricing.
  //
  //   hourly: subtype.perHourPrice  →  subtype.basePrice (when the
  //           subtype's pricingUnit is "per_hour")  →  item.hourly  → 0
  //   day:    subtype.perDayPrice   →  subtype.basePrice (when "per_day")
  //           →  item.day           → 0
  //   package: package row's price is the source of truth; if the
  //            selected subtype is the "tour_package_driver" catalog
  //            entry, fall back to its basePrice when no package is
  //            chosen yet, then to subDay.
  //
  // Pricing fields are stored as numbers in details; treat <=0 as
  // "not set" so a placeholder zero doesn't silently override a real
  // listing-level price.
  const subDetails = selectedSubType?.details;
  const pickPositive = (...vals: Array<number | undefined | null>): number => {
    for (const v of vals) if (typeof v === "number" && v > 0) return v;
    return 0;
  };
  const subUnit = subDetails?.pricingUnit;
  const subBaseAsHourly = subUnit === "per_hour" ? subDetails?.basePrice : undefined;
  const subBaseAsDaily = subUnit === "per_day" ? subDetails?.basePrice : undefined;
  const subBaseAsPackage = subUnit === "per_package" ? subDetails?.basePrice : undefined;
  const subHourly = pickPositive(subDetails?.perHourPrice, subBaseAsHourly, item.hourly);
  const subDay = pickPositive(subDetails?.perDayPrice, subBaseAsDaily, item.day);
  // When the user hasn't yet picked a package row, surface the subtype's
  // own package price (or its day rate as a last resort) so the preview
  // isn't blank.
  const packageBase = selectedPackage?.price
    ?? pickPositive(subBaseAsPackage, subDay);
  // Multi-day rental support: when the user picks an end date, every day
  // in [date, dayEnd] is a billable rental day. Single-day is the default
  // (days = 1 when only `date` is set). Range is inclusive on both ends —
  // a "Wed–Fri" rental = 3 days. Capped at 30 to match the server-side
  // limit in bookings.service.ts (driver-day pricing).
  const dayRangeDays = useMemo<number>(() => {
    if (mode !== "day") return 1;
    if (!date) return 0;
    if (!dayEnd) return 1;
    const start = new Date(`${date}T00:00:00`);
    const end = new Date(`${dayEnd}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
    const diff = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
    return Math.max(1, Math.min(30, diff));
  }, [mode, date, dayEnd]);
  // Validate the chosen range against blocked / fully-booked days. If ANY
  // day in [date, dayEnd] is in the unavailable set, the user has a
  // conflict — surface the dates so they know which days to avoid.
  // `unavailableDates` already unions host-blocked dates + dates with any
  // existing transport booking, so this catches "hourly already booked
  // that day" automatically.
  const dayRangeError = useMemo<string | null>(() => {
    if (mode !== "day" || !date) return null;
    const start = new Date(`${date}T00:00:00`);
    const end = new Date(`${dayEnd || date}T00:00:00`);
    if (end < start) return t("rd.modal.errEndBeforeStart", { defaultValue: "End date is before the start date." });
    const conflicts: string[] = [];
    const toIsoLocal = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${dd}`;
    };
    // Closed weekdays mid-range count as conflicts too — STRICT rule: every
    // day of a multi-day rental must be a working day (same as blocked
    // dates). The pickers grey closed days at the ENDS via enabledWeekdays,
    // but a Mon–Fri range over a closed Wednesday only gets caught here.
    // The server's hold gate enforces the same rule authoritatively.
    const closedMidRange: string[] = [];
    for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400000)) {
      const iso = toIsoLocal(d);
      if (unavailableDates.has(iso)) conflicts.push(iso);
      else if (enabledWeekdays.size > 0 && !enabledWeekdays.has(d.getDay())) closedMidRange.push(iso);
    }
    if (conflicts.length === 0 && closedMidRange.length === 0) return null;
    const fmt = (list: string[]) => {
      const human = list
        .slice(0, 3)
        .map((d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" }))
        .join(", ");
      return list.length > 3 ? t("rd.modal.datesPlusMore", { defaultValue: "{{dates}} + {{count}} more", dates: human, count: list.length - 3 }) : human;
    };
    if (conflicts.length > 0) {
      return t("rd.modal.cantBookConflicts", { defaultValue: "Can't book: {{dates}} — already booked or blocked by the driver.", dates: fmt(conflicts) });
    }
    return t("rd.modal.cantBookClosed", { defaultValue: "Can't book: the driver doesn't work on {{dates}} — pick a range without their off-days.", dates: fmt(closedMidRange) });
  }, [mode, date, dayEnd, unavailableDates, enabledWeekdays]);

  const baseAmount =
    mode === "package" ? packageBase :
    mode === "hourly" ? subHourly * hours :
    mode === "day" ? subDay * dayRangeDays :
    0;
  // Pricing math MUST mirror `applyFees` server-side: coupon comes off
  // FIRST, then platform fee + GST compute against the *discounted*
  // subtotal. The previous order (platform fee on the un-discounted
  // base, coupon subtracted afterwards) overstated the modal total
  // vs. the Razorpay order any time a coupon was applied.
  // Platform fee is a flat charge (PLATFORM_FEE_RUPEES) — must match the
  // server constant or the modal total drifts against the actual charge.
  // Backend quote returns rupees-off; cap so a fixed coupon larger
  // than the cart can't drive the total negative. Point rides never
  // apply coupons (no committed price yet).
  const couponOff = isPoint || !couponQuote ? 0 : Math.min(Math.max(0, couponQuote.discountAmount), baseAmount);
  const discountedSubtotal = isPoint ? 0 : Math.max(0, baseAmount - couponOff);
  // Platform fee from the server-resolved fee spec; point rides have no
  // committed price yet, so no fee until the driver quotes.
  const platformFee = isPoint ? 0 : platformFeeRupees(discountedSubtotal, feeSpec);
  // Flat ₹2 protection — added AFTER tax to mirror the backend's
  // payments.service.ts (it tacks insurance onto the already-taxed
  // agreed_price). Keeping it out of the taxable subtotal means the
  // user sees a clean "Protect your ride ₹2" line and we don't quietly
  // add 5% GST on top of it.
  const protectFee = !isPoint && protectOn ? INSURANCE_FLAT_RUPEES : 0;
  const taxes = (discountedSubtotal + platformFee) * 0.05;
  // Retained for any downstream readers that referenced the pre-tax
  // cart total. `taxableSubtotal` now equals the discount-applied
  // subtotal that fees + tax compute against, matching the service path.
  const taxableSubtotal = discountedSubtotal;
  const subtotal = baseAmount + protectFee;
  const total = isPoint ? 0 : discountedSubtotal + platformFee + taxes + protectFee;

  // Backend-validated coupon apply for transport. Base price is the
  // mode-specific committed amount (hourly subtotal, day rate, or package
  // price) — NOT the post-fee subtotal. The server's `couponsService.quote`
  // computes discount off this base; the modal then re-applies platform fee
  // and GST to (subtotal - discount).
  const handleApplyTransportCoupon = async () => {
    const code = couponCode.trim().toUpperCase();
    if (!code) { setCouponError(t("rd.modal.enterCouponCode", { defaultValue: "Enter a coupon code" })); return; }
    if (!isBackendTransport) {
      setCouponError(t("rd.modal.couponNotOnPreview", { defaultValue: "Coupons aren't available on preview listings." }));
      return;
    }
    if (isPoint) {
      setCouponError(t("rd.modal.couponNoPointRides", { defaultValue: "Point rides don't support coupons yet." }));
      return;
    }
    if (!baseAmount || baseAmount <= 0) {
      setCouponError(t("rd.modal.pickModeDuration", { defaultValue: "Pick a mode + duration first, then apply the coupon." }));
      return;
    }
    setCouponChecking(true);
    setCouponError(null);
    try {
      const res = await getCouponsService().validate({ code, listingId: String(item.id), basePrice: baseAmount });
      if (!res.success || !res.data) {
        setCouponQuote(null);
        setCouponError(res.error || t("rd.modal.couponNotValid", { defaultValue: "Coupon not valid" }));
        return;
      }
      setCouponQuote(res.data);
      toast.success(t("rd.modal.couponAppliedToast", { defaultValue: "Coupon applied — {{amount}} off", amount: rupee(res.data.discountAmount) }));
    } finally {
      setCouponChecking(false);
    }
  };
  const handleClearTransportCoupon = () => {
    setCouponQuote(null);
    setCouponCode("");
    setCouponError(null);
  };

  const canConfirm = !isPoint && Boolean(pickup.trim()) &&
    // Every mode needs a date (package previously skipped this and silently
    // defaulted to isoTomorrow() at submit time, bypassing the availability
    // check). Package additionally needs a packageId.
    Boolean(date) &&
    (mode !== "package" || Boolean(packageId)) &&
    (mode !== "hourly" || (!hoursError && hours > 0)) &&
    !hasProposedConflict &&
    // Day/package modes occupy the full working window; if the chosen date
    // is fully blocked in the selected mode's window, block submit even
    // when the proposed window happens to dodge an outlier early/late
    // booking. The visual notice already says "This date is already
    // booked" — Review now matches.
    !((mode === "day" || mode === "package") && fullyBlockedDates.has(date)) &&
    // Multi-day rentals: every day in the picked range must be available.
    // `dayRangeError` is null when the range is clean OR mode !== "day".
    !(mode === "day" && dayRangeError);

  return (
    <>
      <ModalBody>
        <div className="grid gap-2">
          <SectionLabel icon={<Sparkles className="h-3 w-3" />}>{t("rd.modal.bookingType", { defaultValue: "Booking type" })}</SectionLabel>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {([
              ["package", Sparkles, t("rd.modal.tourPackage", { defaultValue: "Tour package" })],
              ["hourly", Clock3, t("rd.modal.hourly", { defaultValue: "Hourly" })],
              ["day", CalendarDays, t("rd.modal.dayRental", { defaultValue: "Day rental" })],
              ["point", MapPin, t("rd.modal.pointRide", { defaultValue: "Point ride" })],
            ] as Array<[TransportMode, typeof Sparkles, string]>)
              .filter(([m]) => bookableModes.includes(m))
              .map(([m, Icon, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-[12px] font-bold transition-all ${
                  mode === m ? "border-foreground bg-foreground text-white" : "border-border bg-white/85 text-foreground hover:bg-white"
                }`}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
                {m === "point" && <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wide">{t("rd.modal.soon", { defaultValue: "Soon" })}</span>}
              </button>
            ))}
          </div>
        </div>

        {/* Phase 3: vehicle / service sub-type picker — only shown when the
            listing offers more than one transportation type. The chosen
            sub-type is captured in notes so the host dashboard / driver
            knows which vehicle the customer is asking for. */}
        {transportationTypes.length > 1 && (
          <div className="grid gap-2">
            <SectionLabel>{t("rd.modal.whichVehicle", { defaultValue: "Which vehicle or service?" })}</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {transportationTypes.map((tt) => {
                const active = subTypeId === tt.type;
                const details = tt.details || {};
                const subInfo = [
                  details.seatingCapacity ? t("rd.modal.seatsN", { defaultValue: "{{count}} seats", count: details.seatingCapacity }) : null,
                  details.acAvailable === true ? t("rd.modal.ac", { defaultValue: "AC" }) : details.acAvailable === false ? t("rd.modal.nonAc", { defaultValue: "non-AC" }) : null,
                  details.basePrice != null ? t("rd.modal.fromPrice", { defaultValue: "from ₹{{price}}", price: details.basePrice }) : null,
                ].filter(Boolean).join(" · ");
                return (
                  <button
                    key={tt.type}
                    type="button"
                    onClick={() => setSubTypeId(tt.type)}
                    className={`grid rounded-2xl border px-3 py-2 text-left transition-all ${
                      active
                        ? "border-foreground bg-foreground/[0.04]"
                        : "border-border bg-white/85 hover:bg-white"
                    }`}
                  >
                    <span className="text-sm font-bold text-foreground">{tt.displayName}</span>
                    {subInfo && (
                      <span className="text-[11px] font-semibold text-muted-foreground">{subInfo}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {isPoint ? (
          <div className="rounded-2xl border border-yellow-300/50 bg-yellow-50/80 p-4 text-sm">
            <div className="mb-1 flex items-center gap-2 font-bold text-yellow-900">
              <AlertCircle className="h-4 w-4" /> {t("rd.modal.pointComingSoon", { defaultValue: "Point-to-point rides are coming soon" })}
            </div>
            <p className="text-yellow-900/80">
              {t("rd.modal.pointComingSoonBody", { defaultValue: "Package, hourly, and day rental bookings are available today. Point-to-point booking will open once routing and live pricing are ready." })}
            </p>
          </div>
        ) : (
          <>
            {mode === "package" && (
              <div className="grid gap-2">
                <SectionLabel icon={<Sparkles className="h-3 w-3" />}>{t("rd.modal.chooseAPackage", { defaultValue: "Choose a package" })}</SectionLabel>
                <div className="grid gap-2">
                  {item.packageOptions.map((opt) => {
                    const active = opt.id === packageId;
                    const langs = (opt.languages && opt.languages.length > 0) ? opt.languages : item.languages;
                    const kmRange = formatKmRange(opt.distanceKmMin, opt.distanceKmMax);
                    const workingWindow = summarizeWorkingWindow(item.workingHours);
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setPackageId(opt.id)}
                        aria-pressed={active}
                        className={`grid grid-cols-[1fr_auto] items-start gap-2 rounded-2xl border px-4 py-3.5 text-left transition-all ${
                          active ? "border-foreground bg-foreground/[0.04] ring-1 ring-foreground/10" : "border-border bg-white/85 hover:bg-white"
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block text-sm font-bold text-foreground">{opt.label}</span>

                          {/* Big duration + working-hours window — mirrors the
                              detail page so customers see the same headline
                              when they jump from listing → book. */}
                          <span className="mt-1.5 flex items-baseline gap-1.5">
                            <span className="font-display text-xl font-extrabold leading-none text-foreground">{opt.hours}</span>
                            <span className="text-[11px] font-semibold text-muted-foreground">{opt.hours === 1 ? t("rd.modal.hourWord", { defaultValue: "hour" }) : t("rd.modal.hoursWord", { defaultValue: "hours" })}</span>
                          </span>
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            {workingWindow ? t("rd.modal.availableWindow", { defaultValue: "Available {{window}} · driver picks exact start", window: workingWindow }) : t("rd.modal.driverConfirmsStart", { defaultValue: "Driver confirms exact start" })}
                          </span>

                          {(kmRange || (langs && langs.length > 0)) && (
                            <span className="mt-2 flex flex-wrap items-center gap-1">
                              {kmRange && (
                                <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[10px] font-bold text-foreground">
                                  <Navigation className="h-3 w-3" /> {kmRange}
                                </span>
                              )}
                              {langs && langs.length > 0 && (
                                <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-foreground">
                                  <Languages className="h-3 w-3" /> {langs.join(" · ")}
                                </span>
                              )}
                            </span>
                          )}

                          {opt.stops && opt.stops.length > 0 && (
                            <span className="mt-2 block text-[11px] leading-snug text-muted-foreground">
                              <span className="font-bold uppercase tracking-wide text-foreground/70">{t("rd.modal.stops", { defaultValue: "Stops: " })}</span>
                              {opt.stops.map((s, i) => {
                                const dwell = formatDwell(s.dwellMinutes);
                                return `${i > 0 ? " · " : ""}${s.place}${dwell ? ` (${dwell})` : ""}`;
                              }).join("")}
                            </span>
                          )}

                          {opt.description && <span className="mt-2 block text-xs text-muted-foreground">{opt.description}</span>}
                        </span>
                        <span className="shrink-0 rounded-full bg-foreground px-3 py-1 text-xs font-extrabold text-white">{rupee(opt.price)}</span>
                      </button>
                    );
                  })}
                </div>
                {/* Package bookings now require a date too — earlier code left
                    this empty and silently defaulted to tomorrow, which made
                    availability checks meaningless. */}
                <div ref={dateRef} className={showErrors && !date ? "rounded-2xl ring-2 ring-destructive/70" : undefined}>
                  <DateField label={t("rd.modal.tourDate", { defaultValue: "Tour date" })} value={date} onChange={setDate} disabledDates={unavailableDates} disabledWeekdays={enabledWeekdays} disabledHint={t("rd.modal.greyedBlockedBooked", { defaultValue: "Greyed dates are blocked by the driver or already fully booked." })} />
                </div>
                {showErrors && !date && (
                  <p className="-mt-1 text-[11px] font-bold text-destructive">{t("rd.modal.errPickDate", { defaultValue: "Pick a date to continue." })}</p>
                )}
                {/* Day-strip preview so the user can see if their tour
                    window clashes with existing bookings before submitting. */}
                <TransportScheduleStripForDate
                  item={item}
                  date={date}
                  bookingsByDate={bookingsByDate}
                />
              </div>
            )}

            {mode === "hourly" && (
              <div className="grid gap-2">
                <div className="grid gap-2 sm:grid-cols-3">
                  <div ref={dateRef} className={showErrors && !date ? "rounded-2xl ring-2 ring-destructive/70" : undefined}>
                    <DateField label={t("rd.modal.pickupDate", { defaultValue: "Pickup date" })} value={date} onChange={setDate} disabledDates={unavailableDates} disabledWeekdays={enabledWeekdays} disabledHint={t("rd.modal.greyedBlocked", { defaultValue: "Greyed dates are blocked by the driver." })} />
                  </div>
                  <TimeField label={t("rd.modal.startTime", { defaultValue: "Start time" })} value={hourlyStart} onChange={setHourlyStart} />
                  <TimeField label={t("rd.modal.endTime", { defaultValue: "End time" })} value={hourlyEnd} onChange={setHourlyEnd} />
                </div>
                {showErrors && !date && (
                  <p className="-mt-1 text-[11px] font-bold text-destructive">{t("rd.modal.errPickDate", { defaultValue: "Pick a date to continue." })}</p>
                )}
                {/* Click-to-toggle day strip. Tap a free 1-hour slot to
                    add it to your selection; tap a selected slot to drop
                    it. Slots cascade off existing bookings + the driver's
                    buffer, so the visible cells already reflect what's
                    bookable. Customers who'd rather type a window can
                    still use the start/end spinners — the strip and the
                    spinners stay in sync. */}
                <TransportScheduleStripForDate
                  item={item}
                  date={date}
                  bookingsByDate={bookingsByDate}
                  selectedStarts={selectedSlots}
                  onToggleSlot={(hhmm) => {
                    setSelectedSlots((prev) => {
                      const next = new Set(prev);
                      if (next.has(hhmm)) {
                        next.delete(hhmm);
                      } else {
                        // Enforce a contiguous-range model so the
                        // bounding window the booking ends up with is
                        // actually what the customer sees. Non-adjacent
                        // additions clear the prior selection and start
                        // fresh from the new slot.
                        const candidate = parseHHMM(hhmm);
                        if (candidate != null && next.size > 0) {
                          const sorted = Array.from(next)
                            .map((s) => parseHHMM(s) ?? -1)
                            .filter((n) => n >= 0)
                            .sort((a, b) => a - b);
                          const minSel = sorted[0];
                          const maxSel = sorted[sorted.length - 1];
                          const adjacent = candidate === minSel - 60 || candidate === maxSel + 60;
                          const inside = candidate >= minSel && candidate <= maxSel;
                          if (!adjacent && !inside) {
                            next.clear();
                          }
                        }
                        next.add(hhmm);
                      }
                      // Mirror the bounding window into the spinners.
                      if (next.size === 0) {
                        setHourlyStart("09:00");
                        setHourlyEnd("10:00");
                      } else {
                        const mins = Array.from(next)
                          .map((s) => parseHHMM(s) ?? -1)
                          .filter((n) => n >= 0)
                          .sort((a, b) => a - b);
                        const lo = mins[0];
                        const hi = mins[mins.length - 1] + 60;
                        setHourlyStart(`${String(Math.floor(lo / 60)).padStart(2, "0")}:${String(lo % 60).padStart(2, "0")}`);
                        setHourlyEnd(`${String(Math.floor(hi / 60)).padStart(2, "0")}:${String(hi % 60).padStart(2, "0")}`);
                      }
                      return next;
                    });
                  }}
                />
                {hoursError ? (
                  <p className="text-xs font-bold text-destructive">{hoursError}</p>
                ) : hours > 0 ? (
                  <p className="text-[11px] font-semibold text-muted-foreground">
                    {t("rd.modal.hoursBillable", { defaultValue: "{{hours}} {{unit}} billable · {{rate}}/hr", hours: hours.toFixed(hours % 1 === 0 ? 0 : 2), unit: hours === 1 ? t("rd.modal.hourWord", { defaultValue: "hour" }) : t("rd.modal.hoursWord", { defaultValue: "hours" }), rate: rupee(subHourly) })}
                  </p>
                ) : null}
              </div>
            )}

            {mode === "day" && (
              <div className="grid gap-2">
                {/* Day rentals: pick a start date and (optionally) an end date.
                    The vehicle is held for every day in [start, end]. Removed
                    the per-hour slot strip — a day rental takes the whole
                    working window, so picking a start time is meaningless.
                    Both date pickers grey out blocked / fully-booked days so
                    the user can't accidentally cross a busy date in their
                    range; if they do, `dayRangeError` below names the dates
                    so they know what's blocking the booking. */}
                <div className="grid gap-2 sm:grid-cols-2">
                  <div ref={dateRef} className={showErrors && !date ? "rounded-2xl ring-2 ring-destructive/70" : undefined}>
                  <DateField
                    label={t("rd.modal.rentalStart", { defaultValue: "Rental start" })}
                    value={date}
                    onChange={(d) => {
                      setDate(d);
                      // Snap end backward if start moves past it so we never
                      // hold a backwards range.
                      if (dayEnd && d && dayEnd < d) setDayEnd(d);
                    }}
                    disabledDates={unavailableDates}
                    disabledWeekdays={enabledWeekdays}
                    disabledHint={t("rd.modal.greyedBlockedBooked", { defaultValue: "Greyed dates are blocked by the driver or already fully booked." })}
                  />
                  </div>
                  <DateField
                    label={t("rd.modal.rentalEnd", { defaultValue: "Rental end" })}
                    value={dayEnd}
                    onChange={setDayEnd}
                    disabledDates={unavailableDates}
                    disabledWeekdays={enabledWeekdays}
                    disabledHint={t("rd.modal.rentalEndHint", { defaultValue: "Optional — same as start for a 1-day rental." })}
                  />
                </div>
                {showErrors && !date && (
                  <p className="-mt-1 text-[11px] font-bold text-destructive">{t("rd.modal.errPickDate", { defaultValue: "Pick a date to continue." })}</p>
                )}
                {date && dayRangeDays > 0 && !dayRangeError && (
                  <p className="text-[11px] font-semibold text-muted-foreground">
                    {t("rd.modal.daysBillable", { defaultValue: "{{count}} {{unit}} billable · {{rate}}/day = {{total}}", count: dayRangeDays, unit: dayRangeDays === 1 ? t("rd.modal.dayWord", { defaultValue: "day" }) : t("rd.modal.daysWord", { defaultValue: "days" }), rate: rupee(subDay), total: rupee(subDay * dayRangeDays) })}
                  </p>
                )}
                {dayRangeError && (
                  <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs font-semibold text-destructive">
                    {dayRangeError}
                  </p>
                )}
              </div>
            )}

            {/* Availability hint — shows what the driver is already booked for
                on the picked date so users can avoid overlaps before submit.
                Hourly users can still pick around busy windows; day/package
                modes are hard-blocked when ANY existing booking exists for
                that date because they occupy the whole working window. */}
            {transportListingId && date && (
              <TransportAvailabilityNotice
                date={date}
                mode={mode}
                busySlots={busyOnSelectedDate}
                conflicts={proposedConflicts}
                fullyBlocked={fullyBlockedDates.has(date)}
                loading={availabilityLoading}
              />
            )}
            {transportListingId && fullyBlockedDates.size > 0 && (mode === "day" || mode === "package") && (
              <div className="rounded-xl border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
                <p className="font-bold text-foreground">{t("rd.modal.unavailableDates90", { defaultValue: "Unavailable dates (next 90 days):" })}</p>
                <p className="mt-0.5">
                  {Array.from(fullyBlockedDates)
                    .sort()
                    .slice(0, 12)
                    .map((d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" }))
                    .join(" · ")}
                  {fullyBlockedDates.size > 12 ? t("rd.modal.plusMoreSuffix", { defaultValue: " · +{{count}} more", count: fullyBlockedDates.size - 12 }) : ""}
                </p>
              </div>
            )}

            <div className="grid gap-2 sm:grid-cols-2">
              <div ref={pickupRef} className="grid gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <SectionLabel icon={<MapPin className="h-3 w-3" />}>{t("rd.modal.pickupArea", { defaultValue: "Pickup area" })}</SectionLabel>
                  <UseMyLocationButton onResolved={setPickup} />
                </div>
                <AddressAutocompleteInput
                  value={pickup}
                  onChange={setPickup}
                  mode="address"
                  placeholder={t("rd.modal.pickupPlaceholder", { defaultValue: "Hotel, station, house, landmark" })}
                  wrapperClassName={`relative flex items-center gap-2 rounded-xl border bg-white/85 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] ${showErrors && !pickup.trim() ? "border-destructive" : "border-border"}`}
                  className="w-full bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground"
                />
                {showErrors && !pickup.trim() && (
                  <p className="text-xs font-semibold text-destructive">{t("rd.modal.errEnterPickup", { defaultValue: "Enter a pickup point to continue." })}</p>
                )}
                {/* Surface the driver's coverage so customers can sanity-check
                    BEFORE submitting. Falls back to just the area when no
                    radius is set. */}
                <p className="text-[11px] text-muted-foreground">
                  {item.serviceRadiusKm
                    ? t("rd.modal.driverCoversRadius", { defaultValue: "Driver covers up to {{km}} km from {{area}}.", km: item.serviceRadiusKm, area: item.area })
                    : t("rd.modal.driverOperatesIn", { defaultValue: "Driver operates in {{area}}.", area: item.area })}
                </p>
              </div>
              <Stepper label={t("rd.modal.passengers", { defaultValue: "Passengers" })} icon={<Users className="h-4 w-4" />} value={passengers} min={1} max={item.capacity} onChange={setPassengers} />
            </div>

                <ProtectToggle checked={protectOn} onChange={setProtectOn} price={protectFee || INSURANCE_FLAT_RUPEES} kind="transport" />
            <CouponField
              code={couponCode}
              setCode={setCouponCode}
              applied={couponQuote ? { code: couponQuote.code, label: `${rupee(couponQuote.discountAmount)} off` } : null}
              onApply={handleApplyTransportCoupon}
              onClear={handleClearTransportCoupon}
            />
            {couponError && <p className="-mt-2 text-xs font-semibold text-destructive">{couponError}</p>}
            {couponChecking && <p className="-mt-2 text-xs font-semibold text-muted-foreground">{t("rd.modal.checking", { defaultValue: "Checking…" })}</p>}

            <PriceBreakdown
              rows={[
                { label:
                    mode === "package" ? t("rd.modal.packageFare", { defaultValue: "Package fare" }) :
                    mode === "hourly" ? t("rd.modal.hoursTimesRate", { defaultValue: "{{hours}} hours × {{rate}}/hr", hours: hours.toFixed(hours % 1 === 0 ? 0 : 2), rate: rupee(subHourly) }) :
                    (dayRangeDays > 1 ? t("rd.modal.daysTimesRate", { defaultValue: "{{count}} days × {{rate}}/day", count: dayRangeDays, rate: rupee(subDay) }) : t("rd.modal.fullDayRental", { defaultValue: "Full-day rental" })),
                  amount: baseAmount },
                { label: t("rd.modal.platformFee", { defaultValue: "Platform fee" }), amount: platformFee },
                ...(protectOn ? [{ label: t("rd.modal.protectYourRide", { defaultValue: "Protect your ride" }), amount: protectFee }] : []),
                ...(couponOff > 0 ? [{ label: t("rd.modal.couponRow", { defaultValue: "Coupon ({{code}})", code: couponQuote?.code }), amount: -couponOff }] : []),
                ...gstRows(taxes, 0.05, gstInterState, t),
              ]}
            />
          </>
        )}
      </ModalBody>
      <FooterTotal
        total={total}
        disabled={isPoint}
        ctaLabel={isPoint ? t("rd.modal.pointRideUnavailable", { defaultValue: "Point ride unavailable" }) : t("rd.modal.reviewBooking", { defaultValue: "Review booking" })}
        onConfirm={() => {
          // Review gate: always clickable (except unbookable point rides) —
          // a click with missing fields highlights them and scrolls to the
          // first one (the date pickers sit above the pickup input).
          if (!canConfirm) {
            setShowErrors(true);
            scrollToMissingField(!date ? dateRef.current : pickupRef.current);
            return;
          }
          // Real-backend booking is gated on UUID listing id. Non-UUID
          // rows fall through to the existing mock success state,
          // matching the stay / service contract.
          const transportIdForBackend = isLikelyUuid(item.id) ? item.id : null;
          // We DON'T forward an `agreedPrice` claim to createHold for
          // transport. The backend's drift check (bookings.service.ts:697-714)
          // compares the claim against `breakdown.totalPaise` (subtotal +
          // 10% platform fee + 5% GST), not the subtotal. The TransportBody
          // preview uses 8% mock fee / 5% mock taxes / mock coupons — none
          // of which the server recognises — so any claim we compute here
          // would drift well past the ±₹2 tolerance and the hold would 4xx.
          // The legacy `src/components/ServiceBookingModal.tsx:192-197`
          // adopts the same "omit, trust server" pattern for the same
          // reason. We use `holdResult.data.booking.agreedPricePaise` (the
          // server-stored authoritative total) for createOrder downstream.

          // Backend categories per Phase 6A: driver-hourly / driver-day /
          // driver-package. The 5%-GST regex in fees.ts already matches
          // /^driver-/ so these route correctly through `applyFees`.
          const serviceCategory =
            mode === "package" ? "driver-package" :
            mode === "hourly"  ? "driver-hourly" :
            mode === "day"     ? "driver-day" :
            ""; // point — gated, never reaches this closure

          // Vehicle slug for the notes payload. `item.type` is Title-cased
          // by the adapter ("Cab" / "Auto"); the host dashboard greps the
          // notes JSON by the raw slug, so we normalize here.
          const vehicleTypeSlug = String(item.type || "cab").toLowerCase();

          const submitToBackend: NonNullable<BookingReceipt["onSubmit"]> = async ({ onHoldCreated }) => {
            if (!transportIdForBackend || !serviceCategory) {
              throw new Error(t("rd.modal.errTransportNotBookable", { defaultValue: "This transport listing isn't bookable yet." }));
            }
            // `canConfirm` already requires a non-empty `date` for every
            // transport mode, so this closure can't run without one. The
            // earlier `date || isoTomorrow()` fallback predated that
            // guarantee and silently bypassed availability checks for
            // package bookings.
            if (!date) throw new Error(t("rd.modal.errPickDate", { defaultValue: "Pick a date before continuing." }));
            const scheduledDate = date;
            // The transport modal collects pickup time loosely; the booking
            // row needs HH:MM strings. Hourly bookings now use the
            // user-selected from/to range directly. Day defaults to a full
            // 09:00 → 19:00 window. Package times are cosmetic here — the
            // server widens driver-package holds to a full-day window
            // (00:00–23:59) so the tour blocks the driver's whole day.
            const startTime = mode === "hourly" ? hourlyStart : "09:00";
            const endTime = (() => {
              if (mode === "hourly") return hourlyEnd;
              if (mode === "package") {
                const h = Math.min(23, 9 + Math.max(1, Math.round(selectedPackage?.hours ?? 8)));
                return `${String(h).padStart(2, "0")}:00`;
              }
              // day rental — provider keeps the vehicle the whole day.
              return "19:00";
            })();

            // Mode-specific notes payload per the Phase 6A RFC §4 contract.
            // Backend reads:
            //   hourly   → notes.durationHours
            //   day      → notes.days
            //   package  → notes.packageId
            // Everything else is denormalized for the host/transport
            // dashboard and the receipt email.
            // Notes assembly moved server-side (bookingService.prepare →
            // buildBookingNotes). The structured fields below are sent to the
            // unified endpoint, which builds the canonical notes shape.

            // Service-area gate intentionally removed — see the matching
            // comment block where the debounced pre-check used to live.
            // Only requirement now is that the pickup field is non-empty
            // (enforced by canConfirm before the user can reach this code
            // path). Re-wire both gates together when re-enabling.

            let heldBookingId: string | null = null;
            let shouldReleaseHoldOnError = false;
            try {
              if (mode === "package" && !selectedPackage) {
                throw new Error(t("rd.modal.errPickPackage", { defaultValue: "Pick a package before continuing." }));
              }
              // Unified prepare: the server builds the notes, creates the hold
              // + Razorpay order with authoritative pricing, and returns the
              // full payload. Replaces the old client-side notes + createHold +
              // createOrder sequence (same path the chat Confirm & Pay uses).
              const prep = await getBookingService().prepare({
                listingType: "transport",
                listingId: String(transportIdForBackend),
                serviceCategory,
                scheduledDate,
                startTime,
                endTime,
                transportMode: mode as "hourly" | "day" | "package",
                pickupLocation: pickup.trim() || undefined,
                passengerCount: passengers,
                scheduledTime: startTime,
                vehicleType: vehicleTypeSlug,
                transportationType: selectedSubType?.type,
                transportationLabel: selectedSubType?.displayName,
                insuranceOptIn: protectOn,
                contact: { name: user?.name ?? "", phone: user?.phone ?? "" },
                guestName: user?.name ?? undefined,
                couponCode: couponQuote?.code,
                address: pickup.trim() || undefined,
                listingName: item.driver,
                listingImage: item.image,
                idempotencyKey: generateIdempotencyKey(),
                ...(mode === "hourly" ? {
                  transportHours: hours,
                  transportStartTime: hourlyStart,
                  transportEndTime: hourlyEnd,
                  transportSelectedSlots: selectedSlots.size > 0 ? Array.from(selectedSlots) : undefined,
                } : {}),
                ...(mode === "day" ? {
                  transportDays: dayRangeDays,
                  // notes carry the inclusive display end; the hold uses the
                  // EXCLUSIVE end (dayEnd + 1) so the conflict-check scans the
                  // whole range — same convention as the legacy createHold.
                  ...(dayEnd && dayEnd !== date ? {
                    transportEndDate: dayEnd,
                    endDate: new Date(new Date(`${dayEnd}T00:00:00`).getTime() + 86400000).toISOString().slice(0, 10),
                  } : {}),
                } : {}),
                ...(mode === "package" && selectedPackage ? {
                  transportPackageId: selectedPackage.id,
                  transportPackageLabel: selectedPackage.label,
                  transportPackagePrice: selectedPackage.price,
                  transportPackageHours: selectedPackage.hours,
                } : {}),
              });
              if (!prep.success || !prep.data) {
                throw new Error(prep.error || t("rd.modal.errHoldBooking", { defaultValue: "Could not hold this booking. Please try again." }));
              }
              const b = prep.data;
              heldBookingId = b.bookingId;
              shouldReleaseHoldOnError = true;
              onHoldCreated(heldBookingId);

              type VerifyOutcome =
                | { status: "confirmed"; paymentId?: string }
                | { status: "pending"; paymentId?: string }
                | { status: "hold_preserved" };

              // Non-async executor: the outcome resolves only through the
              // checkout callbacks; a rejected launch (script load / open
              // failure) rejects via the trailing .catch.
              const outcome = await new Promise<VerifyOutcome>((resolve, reject) => {
                launchRazorpayCheckout({
                  keyId: b.keyId,
                  orderId: b.orderId,
                  amountPaise: b.amountPaise,
                  currency: b.currency,
                  bookingId: heldBookingId as string,
                  description: t("rd.modal.razorpayTransportDesc", { defaultValue: "Transport · {{driver}}", driver: item.driver }),
                  prefill: { email: user?.email, contact: user?.phone, name: user?.name },
                  analytics: { listingId: String(item.id), listingType: "transport" },
                  // Mirror stay / service flows: dismiss + payment.failed
                  // PRESERVE the hold and bounce back to review so the
                  // user can retry within the TTL window.
                  onDismiss: () => resolve({ status: "hold_preserved" }),
                  onFailure: () => resolve({ status: "hold_preserved" }),
                  onSuccess: async (response) => {
                    const verifyResult = await getPaymentService().verifyPayment({
                      bookingId: heldBookingId as string,
                      razorpay_order_id: response.razorpay_order_id,
                      razorpay_payment_id: response.razorpay_payment_id,
                      razorpay_signature: response.razorpay_signature,
                    });
                    if (!verifyResult.success) {
                      reject(new Error(verifyResult.error || t("rd.modal.errPaymentVerification", { defaultValue: "Payment verification failed." })));
                      return;
                    }
                    if (verifyResult.data?.pending) {
                      resolve({ status: "pending", paymentId: verifyResult.data?.paymentId });
                      return;
                    }
                    resolve({ status: "confirmed", paymentId: verifyResult.data?.paymentId });
                  },
                }).catch(reject);
              });

              if (outcome.status === "hold_preserved") {
                shouldReleaseHoldOnError = false;
                throw new Error(HOLD_PRESERVED_ERROR);
              }

              shouldReleaseHoldOnError = false;
              // Booking confirmed/pending — drop the saved pickup draft so
              // the next visit to this listing starts clean.
              draft.clear();
              return {
                status: outcome.status,
                bookingId: heldBookingId,
                paymentId: outcome.paymentId,
              };
            } catch (error) {
              if (heldBookingId && shouldReleaseHoldOnError) {
                await getBookingService().releaseHold(heldBookingId).catch(() => undefined);
              }
              throw error;
            }
          };

          onReview({
            image: item.image,
            eyebrow: `${item.type} · ${item.vehicle}`,
            title: item.driver,
            subtitle: pickup ? t("rd.modal.fromPickupArea", { defaultValue: "From {{pickup}} · {{area}}", pickup, area: item.area }) : t("rd.modal.areaSeats", { defaultValue: "{{area}} · seats {{capacity}}", area: item.area, capacity: item.capacity }),
            facts: [
              ...(transportationTypes.length > 1 && selectedSubType
                ? [{ label: t("rd.modal.factVehicleService", { defaultValue: "Vehicle / service" }), value: selectedSubType.displayName }]
                : []),
              // Vehicle identity so the rider can spot the exact car. Model is
              // also in the eyebrow; colour + plate only render when the host
              // onboarded them (legacy transport rows leave these blank).
              ...(item.color ? [{ label: t("rd.modal.factVehicleColor", { defaultValue: "Colour" }), value: item.color }] : []),
              ...(item.plate ? [{ label: t("rd.modal.factVehiclePlate", { defaultValue: "Number plate" }), value: item.plate }] : []),
              { label: t("rd.modal.bookingType", { defaultValue: "Booking type" }), value: mode === "package" ? t("rd.modal.tourPackage", { defaultValue: "Tour package" }) : mode === "hourly" ? t("rd.modal.hourly", { defaultValue: "Hourly" }) : mode === "day" ? t("rd.modal.dayRental", { defaultValue: "Day rental" }) : t("rd.modal.pointRide", { defaultValue: "Point ride" }) },
              ...(mode === "package" && selectedPackage ? [
                { label: t("rd.modal.factPackage", { defaultValue: "Package" }), value: selectedPackage.label },
                { label: t("rd.modal.factDuration", { defaultValue: "Duration" }), value: t("rd.modal.nHours", { defaultValue: "{{count}} hours", count: selectedPackage.hours }) },
              ] : []),
              ...(mode === "hourly" ? [
                { label: t("rd.modal.startTime", { defaultValue: "Start time" }), value: formatHHMM(hourlyStart) },
                { label: t("rd.modal.endTime", { defaultValue: "End time" }), value: formatHHMM(hourlyEnd) },
                { label: t("rd.modal.factHours", { defaultValue: "Hours" }), value: `${hours.toFixed(hours % 1 === 0 ? 0 : 2)}` },
              ] : []),
              ...(date
                ? [{
                    label: mode === "day" ? (dayRangeDays > 1 ? t("rd.modal.rentalDates", { defaultValue: "Rental dates" }) : t("rd.modal.rentalDate", { defaultValue: "Rental date" })) : t("rd.modal.pickupDate", { defaultValue: "Pickup date" }),
                    value: mode === "day" && dayEnd && dayEnd !== date
                      ? t("rd.modal.dateRangeDays", { defaultValue: "{{start}} – {{end}} ({{count}} days)", start: labelOf(date), end: labelOf(dayEnd), count: dayRangeDays })
                      : labelOf(date),
                  }]
                : []),
              ...(pickup ? [{ label: t("rd.modal.factPickup", { defaultValue: "Pickup" }), value: pickup }] : []),
              { label: t("rd.modal.passengers", { defaultValue: "Passengers" }), value: `${passengers}` },
              ...(protectOn ? [{ label: t("rd.modal.protectYourRide", { defaultValue: "Protect your ride" }), value: t("rd.modal.added", { defaultValue: "Added" }) }] : []),
              ...(couponQuote ? [{ label: t("rd.modal.factCoupon", { defaultValue: "Coupon" }), value: t("rd.modal.couponValue", { defaultValue: "{{code}} ({{amount}} off)", code: couponQuote.code, amount: rupee(couponQuote.discountAmount) }) }] : []),
            ],
            contact: { name: user?.name ?? "", phone: user?.phone ?? "" },
            rows: [
              { label:
                  mode === "package" ? t("rd.modal.packageFare", { defaultValue: "Package fare" }) :
                  mode === "hourly" ? t("rd.modal.hoursTimesRate", { defaultValue: "{{hours}} hours × {{rate}}/hr", hours: hours.toFixed(hours % 1 === 0 ? 0 : 2), rate: rupee(subHourly) }) :
                  t("rd.modal.fullDayRental", { defaultValue: "Full-day rental" }),
                amount: baseAmount },
              { label: t("rd.modal.platformFee", { defaultValue: "Platform fee" }), amount: platformFee },
              ...(protectOn ? [{ label: t("rd.modal.protectYourRide", { defaultValue: "Protect your ride" }), amount: protectFee }] : []),
              ...(couponOff > 0 ? [{ label: t("rd.modal.couponRow", { defaultValue: "Coupon ({{code}})", code: couponQuote?.code }), amount: -couponOff }] : []),
              ...gstRows(taxes, 0.05, gstInterState, t),
            ],
            total,
            protectOn,
            // Real backend coupon: forward the resolved code so createHold
            // re-validates + atomically consumes inside the hold txn and
            // stamps the discount snapshot on the booking row (read by the
            // confirmation email + invoice).
            couponCode: couponQuote?.code,
            onSubmit: transportIdForBackend ? submitToBackend : undefined,
          });
        }}
      />
    </>
  );
}

// ---------- shared primitives ----------------------------------------------

function PriceBreakdown({ rows }: { rows: Array<{ label: string; amount: number }> }) {
  const { t } = useLanguage();
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <div className="rounded-2xl border border-border/60 bg-muted/40 p-3">
      <SectionLabel>{t("rd.modal.priceBreakdown", { defaultValue: "Price breakdown" })}</SectionLabel>
      <div className="mt-1.5 grid gap-1.5 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between">
            <span className="text-muted-foreground">{row.label}</span>
            <span className={`font-semibold ${row.amount < 0 ? "text-success" : "text-foreground"}`}>{row.amount < 0 ? "-" : ""}{rupee(Math.abs(row.amount))}</span>
          </div>
        ))}
        <div className="mt-1 flex items-center justify-between border-t border-border/60 pt-2">
          <span className="font-bold text-foreground">{t("rd.modal.total", { defaultValue: "Total" })}</span>
          <span className="font-display text-base font-extrabold text-foreground">{rupee(total)}</span>
        </div>
      </div>
    </div>
  );
}

function Stepper({ label, value, min, max, onChange, icon, maxMessage }: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  icon?: React.ReactNode;
  /** Inline message shown for ~3s when the user taps "+" while already at
   *  `max`. The button stays clickable (so the message surfaces) — when
   *  this prop is undefined the "+" stays hard-disabled at max, matching
   *  the original Stepper behaviour. */
  maxMessage?: string | null;
}) {
  const { t } = useLanguage();
  const [capHint, setCapHint] = useState<string | null>(null);
  // Clear the hint as soon as max relaxes (room count up, more inventory
  // freed, etc.) so the user isn't staring at a stale error.
  useEffect(() => { if (value < max) setCapHint(null); }, [value, max]);
  const handleIncrement = () => {
    if (value >= max) {
      if (maxMessage) {
        setCapHint(maxMessage);
        // Auto-clear so the warning doesn't linger forever if the user
        // walks away from the stepper.
        window.setTimeout(() => setCapHint((cur) => (cur === maxMessage ? null : cur)), 3500);
      }
      return;
    }
    onChange(value + 1);
  };
  const incDisabled = value >= max && !maxMessage;
  return (
    <div className="grid gap-1.5">
      <SectionLabel icon={icon as React.ReactNode}>{label}</SectionLabel>
      <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-white/85 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
        <span className="text-sm font-bold text-foreground">{value}</span>
        <span className="inline-flex items-center gap-1">
          <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={t("rd.modal.decreaseAria", { defaultValue: "Decrease {{label}}", label })} className="inline-grid h-7 w-7 place-items-center rounded-full border border-foreground/40 bg-[#8b5e4a]/10 text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-foreground/40 disabled:hover:bg-[#8b5e4a]/10 disabled:hover:text-foreground disabled:hover:shadow-sm disabled:active:scale-100"><Minus className="h-3 w-3" /></button>
          <button type="button" onClick={handleIncrement} disabled={incDisabled} aria-label={t("rd.modal.increaseAria", { defaultValue: "Increase {{label}}", label })} className="inline-grid h-7 w-7 place-items-center rounded-full border border-foreground/40 bg-[#8b5e4a]/10 text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-foreground/40 disabled:hover:bg-[#8b5e4a]/10 disabled:hover:text-foreground disabled:hover:shadow-sm disabled:active:scale-100"><Plus className="h-3 w-3" /></button>
        </span>
      </div>
      {capHint && (
        <p className="text-[11px] font-semibold text-destructive">{capHint}</p>
      )}
    </div>
  );
}

/** Fills an address field from the browser's geolocation + Nominatim
 *  reverse-geocode. Shows a small spinner while the request is in flight
 *  and surfaces denial / failure via a single toast so the user always
 *  gets actionable feedback. When reverse geocode fails we still drop the
 *  raw lat/lng into the field so the booking isn't blocked. */
function UseMyLocationButton({ onResolved }: { onResolved: (address: string) => void }) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const handleClick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const pos = await getCurrentPosition({ enableHighAccuracy: true });
      const text = await reverseGeocode(pos.lat, pos.lng);
      if (text) {
        onResolved(text);
        toast.success(t("rd.modal.locationFilled", { defaultValue: "Location filled from your device" }));
      } else {
        onResolved(`Lat ${pos.lat.toFixed(5)}, Lng ${pos.lng.toFixed(5)}`);
        toast.message(t("rd.modal.usedCoordinates", { defaultValue: "Used your coordinates — couldn't fetch a street address right now." }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t("rd.modal.errGetLocation", { defaultValue: "Couldn't get your location." });
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }, [busy, onResolved, t]);
  // Outline is a RING (box-shadow), not a border — client-redesign.css
  // globally strips borders off buttons (`.client-redesign button{border:0}`),
  // which silently erased every border-based outline attempt here.
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-[11px] font-bold text-foreground shadow-sm ring-2 ring-inset ring-foreground/70 transition-all hover:bg-foreground hover:text-white hover:shadow hover:ring-foreground active:scale-95 disabled:cursor-wait disabled:opacity-60 disabled:hover:bg-white disabled:hover:text-foreground"
    >
      {busy ? (
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground" aria-hidden />
      ) : (
        <Crosshair className="h-3.5 w-3.5" />
      )}
      {busy ? t("rd.modal.locating", { defaultValue: "Locating…" }) : t("rd.modal.useMyLocation", { defaultValue: "Use my current location" })}
    </button>
  );
}

function DateField({
  label, value, onChange, disabledDates, disabledWeekdays, disabledHint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** ISO ("YYYY-MM-DD") strings that are disabled in the popover —
   *  driver-blocked days, fully-booked days, or workingHours-closed
   *  weekdays. The clicker can't select these. */
  disabledDates?: Set<string>;
  /** Optional set of weekday numbers (0=Sun..6=Sat) that the provider has
   *  enabled. When supplied, dates whose weekday is NOT in the set are
   *  greyed out and unselectable. Empty/undefined = every weekday is
   *  selectable (legacy listings without workingHours). */
  disabledWeekdays?: Set<number>;
  /** Optional caption shown under the popover explaining why some dates
   *  are greyed out, e.g. "Driver blocked / fully booked". */
  disabledHint?: string;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const today = useMemo(() => istToday(), []);
  const todayISO = useMemo(() => {
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }, [today]);

  // Month being viewed in the calendar. Defaults to the month of the
  // current value (or today when unset). Stored as 1st-of-month for
  // simpler arithmetic.
  const [view, setView] = useState<Date>(() => {
    const seed = value ? new Date(`${value}T00:00:00`) : today;
    return new Date(seed.getFullYear(), seed.getMonth(), 1);
  });
  useEffect(() => {
    if (!open) return;
    const seed = value ? new Date(`${value}T00:00:00`) : today;
    setView(new Date(seed.getFullYear(), seed.getMonth(), 1));
  }, [open, value, today]);

  const monthLabel = view.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  // Build 6-row grid (Sun-first) for the visible month so the calendar
  // doesn't reflow when months have different leading-day offsets.
  const grid = useMemo(() => {
    const firstOfMonth = new Date(view.getFullYear(), view.getMonth(), 1);
    const leading = firstOfMonth.getDay(); // 0 = Sun
    const startDate = new Date(firstOfMonth);
    startDate.setDate(firstOfMonth.getDate() - leading);
    const cells: Array<{ date: Date; iso: string; inMonth: boolean; isPast: boolean; isSelected: boolean; isToday: boolean; isUnavailable: boolean; isWeekdayOff: boolean }> = [];
    for (let i = 0; i < 42; i += 1) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const iso = `${y}-${m}-${day}`;
      cells.push({
        date: d,
        iso,
        inMonth: d.getMonth() === view.getMonth(),
        isPast: iso < todayISO,
        isSelected: !!value && iso === value,
        isToday: iso === todayISO,
        isUnavailable: !!(disabledDates && disabledDates.has(iso)),
        isWeekdayOff: !!(disabledWeekdays && disabledWeekdays.size > 0 && !disabledWeekdays.has(d.getDay())),
      });
    }
    return cells;
  }, [view, value, todayISO, disabledDates, disabledWeekdays]);

  const displayLabel = value
    ? new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })
    : t("rd.modal.pickADate", { defaultValue: "Pick a date" });

  return (
    <div ref={rootRef} className="relative grid gap-1.5">
      <SectionLabel icon={<CalendarDays className="h-3 w-3" />}>{label}</SectionLabel>
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className={`flex items-center justify-between gap-2 rounded-xl border bg-white/85 px-3 py-2 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-colors ${
          open ? "border-foreground" : "border-border hover:bg-white"
        }`}
      >
        <span className={`text-sm font-semibold ${value ? "text-foreground" : "text-muted-foreground"}`}>{displayLabel}</span>
        <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-[300px] rounded-2xl border border-border bg-white p-3 shadow-[0_22px_60px_rgba(34,31,39,0.18)]">
          <header className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setView((v) => new Date(v.getFullYear(), v.getMonth() - 1, 1))}
              className="inline-grid h-7 w-7 place-items-center rounded-full border border-border bg-white text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-90"
            >
              ‹
            </button>
            <span className="text-sm font-extrabold text-foreground">{monthLabel}</span>
            <button
              type="button"
              onClick={() => setView((v) => new Date(v.getFullYear(), v.getMonth() + 1, 1))}
              className="inline-grid h-7 w-7 place-items-center rounded-full border border-border bg-white text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-90"
            >
              ›
            </button>
          </header>
          <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
            {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
              <span key={`${d}-${i}`} className="py-1">{d}</span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {grid.map((c) => {
              const disabled = c.isPast || c.isUnavailable || c.isWeekdayOff;
              return (
                <button
                  key={c.iso}
                  type="button"
                  onClick={() => { if (!disabled) { onChange(c.iso); setOpen(false); } }}
                  disabled={disabled}
                  title={
                    c.isWeekdayOff
                      ? t("rd.modal.providerClosedWeekday", { defaultValue: "Provider is closed on this weekday" })
                      : c.isUnavailable
                        ? t("rd.modal.dateUnavailable", { defaultValue: "Unavailable — driver blocked or fully booked" })
                        : undefined
                  }
                  className={`h-9 rounded-lg text-xs font-semibold transition-colors ${
                    c.isSelected
                      ? "bg-foreground text-white shadow-sm"
                      : c.isUnavailable
                        ? "bg-destructive/10 text-destructive/60 line-through cursor-not-allowed"
                        : c.isWeekdayOff
                          ? "bg-muted/40 text-muted-foreground/40 cursor-not-allowed"
                          : c.isPast
                            ? "text-muted-foreground/40 cursor-not-allowed"
                            : !c.inMonth
                              ? "text-muted-foreground/60 hover:bg-muted/60"
                              : c.isToday
                                ? "border border-foreground/40 text-foreground hover:bg-muted"
                                : "text-foreground hover:bg-muted"
                  }`}
                >
                  {c.date.getDate()}
                </button>
              );
            })}
          </div>
          {disabledHint && (
            <p className="mt-2 text-[10px] text-muted-foreground">{disabledHint}</p>
          )}
          <footer className="mt-2 flex items-center justify-between text-[11px] font-semibold">
            <button type="button" onClick={() => { onChange(""); setOpen(false); }} className="text-muted-foreground hover:text-foreground">{t("rd.modal.clear", { defaultValue: "Clear" })}</button>
            <button type="button" onClick={() => { onChange(todayISO); setOpen(false); }} className="text-foreground hover:underline">{t("rd.modal.today", { defaultValue: "Today" })}</button>
          </footer>
        </div>
      )}
    </div>
  );
}

/** Surfaces the driver's existing busy windows + any current-selection
 *  conflict in the transport booking modal. Renders three flavours:
 *  - hard conflict (chosen window overlaps): red destructive box.
 *  - day/package mode + date is fully blocked: red destructive box.
 *  - otherwise informational "Already booked" tag list of busy windows. */
function TransportAvailabilityNotice({
  date, mode, busySlots, conflicts, fullyBlocked, loading,
}: {
  date: string;
  mode: TransportMode;
  busySlots: Array<{ start: number; end: number }>;
  conflicts: Array<{ start: number; end: number }>;
  fullyBlocked: boolean;
  loading?: boolean;
}) {
  const { t } = useLanguage();
  const formatMin = (m: number) => {
    const h = Math.floor(m / 60);
    const min = m % 60;
    const period = h >= 12 ? "PM" : "AM";
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}:${String(min).padStart(2, "0")} ${period}`;
  };
  const hardConflict = conflicts.length > 0 || (fullyBlocked && (mode === "day" || mode === "package"));
  if (busySlots.length === 0) {
    // Don't claim "wide open" before the availability queries have settled —
    // otherwise the user sees a green checkmark for a date that's actually
    // taken (their own just-placed booking) until the fetch finishes.
    if (loading) {
      return (
        <p className="text-[11px] font-semibold text-muted-foreground">
          {t("rd.modal.checkingAvailability", { defaultValue: "Checking availability…" })}
        </p>
      );
    }
    return (
      <p className="text-[11px] font-semibold text-success">
        <CheckCircle2 className="mr-1 inline h-3 w-3" /> {t("rd.modal.noBookingsWideOpen", { defaultValue: "No bookings on this date — slot is wide open." })}
      </p>
    );
  }
  return (
    <div className={`rounded-xl border px-3 py-2 text-xs ${
      hardConflict
        ? "border-destructive/40 bg-destructive/5 text-destructive"
        : "border-border bg-muted/40 text-foreground"
    }`}>
      <p className="font-bold">
        {hardConflict
          ? mode === "hourly"
            ? t("rd.modal.timeOverlaps", { defaultValue: "Your selected time overlaps with an existing booking" })
            : t("rd.modal.dateAlreadyBooked", { defaultValue: "This date is already booked" })
          : t("rd.modal.driverBookedAt", { defaultValue: "Driver is already booked at:" })}
      </p>
      <p className="mt-1 flex flex-wrap gap-1.5">
        {busySlots.map((slot, idx) => (
          <span
            key={idx}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${
              hardConflict
                ? "border-destructive/40 bg-destructive/10"
                : "border-border bg-white text-foreground"
            }`}
          >
            {formatMin(slot.start)} – {formatMin(slot.end)}
          </span>
        ))}
      </p>
      {hardConflict && mode === "hourly" && (
        <p className="mt-1 text-[11px] font-semibold">
          {t("rd.modal.pickTimeOutside", { defaultValue: "Pick a time outside these windows. A booking ending at {{time}} and another starting at the same minute is OK.", time: formatMin(busySlots[0].end) })}
        </p>
      )}
    </div>
  );
}

function TimeField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const [hStr, mStr] = (value || "00:00").split(":");
  const hour24 = Number(hStr) || 0;
  const minute = Number(mStr) || 0;
  const period: "AM" | "PM" = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 === 0 ? 12 : hour24 > 12 ? hour24 - 12 : hour24;
  const fmt = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const displayLabel = value
    ? `${hour12}:${String(minute).padStart(2, "0")} ${period}`
    : t("rd.modal.pickATime", { defaultValue: "Pick a time" });

  const apply = (h12: number, p: "AM" | "PM", min = minute) => {
    const h24 = p === "AM" ? (h12 === 12 ? 0 : h12) : (h12 === 12 ? 12 : h12 + 12);
    onChange(fmt(h24, min));
  };
  const setPeriod = (p: "AM" | "PM") => apply(hour12, p);

  // 1..12 hour grid; minute presets (00, 15, 30, 45) so the picker is
  // touch-friendly without needing a spinner. Custom flows already snap
  // to 1-hour blocks on the strip, but this gives the typist precision
  // when needed.
  const hours = useMemo(() => Array.from({ length: 12 }, (_, i) => i + 1), []);
  const minutes = useMemo(() => [0, 15, 30, 45], []);

  return (
    <div ref={rootRef} className="relative grid gap-1.5">
      <SectionLabel icon={<Clock3 className="h-3 w-3" />}>{label}</SectionLabel>
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className={`flex items-center justify-between gap-2 rounded-xl border bg-white/85 px-3 py-2 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-colors ${
          open ? "border-foreground" : "border-border hover:bg-white"
        }`}
      >
        <span className={`text-sm font-semibold ${value ? "text-foreground" : "text-muted-foreground"}`}>{displayLabel}</span>
        <Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-[260px] rounded-2xl border border-border bg-white p-3 shadow-[0_22px_60px_rgba(34,31,39,0.18)]">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.modal.hour", { defaultValue: "Hour" })}</span>
            <div className="flex overflow-hidden rounded-full border border-border text-[11px] font-bold">
              {(["AM", "PM"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPeriod(p)}
                  className={`px-2.5 py-1 transition-colors ${period === p ? "bg-foreground text-white" : "bg-white text-foreground hover:bg-muted"}`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {hours.map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => apply(h, period)}
                className={`h-8 rounded-lg text-xs font-bold transition-colors ${
                  hour12 === h ? "bg-foreground text-white" : "bg-muted/50 text-foreground hover:bg-muted"
                }`}
              >
                {h}
              </button>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.modal.minutes", { defaultValue: "Minutes" })}</span>
            <span className="text-[11px] font-semibold text-muted-foreground">{String(minute).padStart(2, "0")}</span>
          </div>
          <div className="mt-1 grid grid-cols-4 gap-1">
            {minutes.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => apply(hour12, period, m)}
                className={`h-8 rounded-lg text-xs font-bold transition-colors ${
                  minute === m ? "bg-foreground text-white" : "bg-muted/50 text-foreground hover:bg-muted"
                }`}
              >
                :{String(m).padStart(2, "0")}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="mt-3 inline-flex w-full justify-center rounded-full bg-foreground px-3 py-1.5 text-xs font-bold text-white"
          >
            {t("rd.modal.done", { defaultValue: "Done" })}
          </button>
        </div>
      )}
    </div>
  );
}

function labelOf(iso: string) {
  // Append T00:00:00 so the YYYY-MM-DD string parses as local midnight, not
  // UTC midnight. Without this, `new Date("2026-05-27")` is UTC midnight,
  // which renders as "May 26" in any timezone west of UTC (PDT, PST, etc.)
  // — the bug the user hit when they picked May 27 and the review showed
  // "Pickup date: 26 May".
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** Parse a "HH:MM" string to total minutes since midnight, or null when the
 *  input doesn't look like a time. Used by transport hourly bookings to
 *  compute billable hours from a from/to range. */
function parseHHMM(value: string): number | null {
  const m = value?.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Format a "HH:MM" time string in 12-hour form for human-readable output
 *  ("13:30" → "1:30 PM"). Returns the raw value when it doesn't parse. */
function formatHHMM(value: string): string {
  const m = value?.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return value;
  const h = parseInt(m[1], 10);
  const min = m[2];
  if (Number.isNaN(h)) return value;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${min} ${period}`;
}

// ---------- success + login gate -------------------------------------------

function SubmittingBody({ kind }: { kind: BookingRequest["kind"] }) {
  const { t } = useLanguage();
  const label = kind === "stay" ? t("rd.modal.holdingRoom", { defaultValue: "Holding your room" }) : kind === "service" ? t("rd.modal.holdingSlot", { defaultValue: "Holding your slot" }) : t("rd.modal.requestingDriver", { defaultValue: "Requesting driver" });
  return (
    <div className="grid gap-3 px-5 py-12 text-center sm:px-6">
      <div className="mx-auto inline-grid h-16 w-16 place-items-center rounded-full bg-muted text-foreground">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground" aria-hidden />
      </div>
      <h3 className="font-display text-xl font-extrabold text-foreground">{label}…</h3>
      <p className="text-sm text-muted-foreground">
        {kind === "stay"
          ? t("rd.modal.submittingStayBody", { defaultValue: "We are reserving the room and confirming payment. Please don't close the window." })
          : t("rd.modal.submittingBody", { defaultValue: "This usually takes a few seconds. Please don't close the window." })}
      </p>
    </div>
  );
}

function ErrorBody({ message, onRetry, onClose }: { message: string | null; onRetry: () => void; onClose: () => void }) {
  const { t } = useLanguage();
  return (
    <div className="grid gap-3 px-5 py-10 text-center sm:px-6">
      <div className="mx-auto inline-grid h-16 w-16 place-items-center rounded-full bg-destructive/15 text-destructive">
        <AlertCircle className="h-8 w-8" />
      </div>
      <h3 className="font-display text-xl font-extrabold text-foreground">{t("rd.modal.errCouldNotConfirm", { defaultValue: "We couldn't confirm your booking" })}</h3>
      <p className="text-sm text-muted-foreground">{message || t("rd.modal.errSomethingWrong", { defaultValue: "Something went wrong on our side. Please try again." })}</p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <button type="button" onClick={onClose} className="inline-flex h-10 items-center gap-2 rounded-full border border-border bg-white px-4 text-sm font-bold text-foreground hover:bg-muted">
          {t("rd.modal.close", { defaultValue: "Close" })}
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-extrabold text-white shadow-[0_14px_30px_rgba(58,50,71,0.20)]"
          style={{ background: "linear-gradient(135deg, #2b2436, #8b5e4a)" }}
        >
          {t("rd.modal.tryAgain", { defaultValue: "Try again" })}
        </button>
      </div>
    </div>
  );
}

function SuccessBody({
  request,
  onClose,
  bookingId,
  paymentId,
  receipt,
}: {
  request: BookingRequest;
  onClose: () => void;
  bookingId?: string | null;
  paymentId?: string | null;
  receipt?: BookingReceipt | null;
}) {
  const { t } = useLanguage();
  // Post-payment, ask the backend for the true total. The local `receipt`
  // rows were computed before submission and don't always reflect server-
  // side adjustments (e.g. insurance premium minimum, refunded fractional
  // discounts). We refetch and overwrite the "Total paid" line + insert
  // the missing insurance + coupon rows so the modal matches the invoice
  // PDF and confirmation email. Failures fall back to the local receipt.
  const serverBookingQuery = useQuery({
    queryKey: ["booking-receipt", bookingId],
    enabled: Boolean(bookingId),
    staleTime: 60_000,
    queryFn: async () => {
      const res = await getBookingService().getById(String(bookingId));
      if (!res.success || !res.data) throw new Error(res.error || "Failed to load booking");
      return res.data;
    },
  });
  const serverTotalPaise = serverBookingQuery.data?.totalPaidPaise;
  const displayTotal = (() => {
    if (Number.isFinite(serverTotalPaise) && (serverTotalPaise as number) > 0) {
      return (serverTotalPaise as number) / 100;
    }
    return receipt?.total ?? 0;
  })();
  // Tax-invoice download. The previous implementation rendered a raw
  // <a href="/api/bookings/:id/invoice.pdf"> that opened in a new tab —
  // that always 401'd because the route is auth-gated and a plain anchor
  // can't attach a Bearer token. It was also gated to stays only, so
  // service customers never saw a download button at all. Route through
  // the existing authenticated-download helper used by both dashboards so
  // every booking kind gets a working button with the same code path.
  const [invoiceDownloading, setInvoiceDownloading] = useState(false);
  const handleDownloadInvoice = async () => {
    if (!bookingId || invoiceDownloading) return;
    setInvoiceDownloading(true);
    try {
      await downloadBookingTaxInvoice(String(bookingId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("rd.modal.errDownloadInvoice", { defaultValue: "Failed to download invoice" });
      toast.error(msg);
    } finally {
      setInvoiceDownloading(false);
    }
  };
  const title = request.kind === "stay"
    ? request.stay.title
    : request.kind === "service"
      ? request.service.title
      : request.transport.driver;
  const subtitle = receipt?.subtitle
    ?? (request.kind === "stay"
      ? request.stay.location
      : request.kind === "service"
        ? request.service.provider
        : request.transport.vehicle);
  const image = receipt?.image
    ?? (request.kind === "stay"
      ? request.stay.image
      : request.kind === "service"
        ? request.service.image
        : request.transport.image);
  const headerLabel = request.kind === "stay" ? t("rd.modal.headerBookingConfirmed", { defaultValue: "Booking confirmed" }) : t("rd.modal.bookingRequestConfirmed", { defaultValue: "Booking request confirmed" });
  const headerMessage = request.kind === "stay"
    ? t("rd.modal.successStayMessage", { defaultValue: "Your stay is locked in. A confirmation email and tax invoice are on their way." })
    : t("rd.modal.successRequestMessage", { defaultValue: "We've recorded your request and the provider has been notified. You'll see updates in My Bookings." });
  // Selected service name (multi-group catalogs only). We re-read it from the
  // receipt facts the modal already populated rather than threading a new prop
  // — the receipt is the canonical "what the user just booked" payload and
  // SuccessBody is a pure renderer over it. Falls through to null for stays /
  // transport / legacy services without a catalog, so the hero stays unchanged
  // for those.
  const selectedServiceName = request.kind === "service"
    ? receipt?.facts?.find((f) => f.label === t("rd.modal.factService", { defaultValue: "Service" }))?.value ?? null
    : null;

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      {/* Hero band. `shrink-0` is load-bearing: this is a flex child of the
          height-constrained scroll column, and its `overflow-hidden` zeroes
          its automatic flex min-size — without shrink-0 flexbox compresses
          the band below its content and clips the icon + name at the top. */}
      <div className="relative shrink-0 overflow-hidden bg-gradient-to-br from-[#2b2436] via-[#7b5244] to-[#c08a5a] px-5 py-7 text-white sm:px-7">
        <div className="flex items-start gap-4">
          <div className="inline-grid h-14 w-14 shrink-0 place-items-center rounded-full bg-white/20 backdrop-blur">
            <CheckCircle2 className="h-7 w-7" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-extrabold uppercase tracking-[0.18em] text-white/70">{headerLabel}</p>
            <h3 className="font-display text-2xl font-extrabold leading-tight">{title}</h3>
            {selectedServiceName && (
              <span className="mt-1 inline-flex items-center rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white backdrop-blur">
                {selectedServiceName}
              </span>
            )}
            {subtitle && <p className="mt-1 text-sm text-white/85">{subtitle}</p>}
          </div>
        </div>
        <p className="mt-4 max-w-prose text-[13px] leading-relaxed text-white/80">{headerMessage}</p>
      </div>

      {/* Image + key facts */}
      {(image || (receipt?.facts && receipt.facts.length > 0)) && (
        <div className="grid gap-4 px-5 py-5 sm:grid-cols-[120px_1fr] sm:px-7">
          {image && (
            <img
              src={image}
              alt={title}
              className="hidden h-[120px] w-full rounded-2xl object-cover shadow-sm sm:block"
            />
          )}
          {receipt?.facts && receipt.facts.length > 0 && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {receipt.facts.map((f) => (
                <div key={f.label} className="min-w-0">
                  <dt className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{f.label}</dt>
                  <dd className="mt-0.5 truncate text-sm font-semibold text-foreground">{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}

      {/* Getting there (stays/services). The guest is CONFIRMED now, so the
          refetched booking row carries the exact address when the host gave
          one (WS6: browsers only ever saw "City, State"). When the host
          hasn't provided a street-level address, say so upfront instead of
          leaving the guest to discover it at the door. Transport is skipped —
          the pickup point is the customer's own. */}
      {request.kind !== "transport" && serverBookingQuery.data && (
        serverBookingQuery.data.hasExactAddress === false ? (
          <div className="mx-5 mb-3 flex items-start gap-2.5 rounded-2xl border border-border bg-muted/50 px-4 py-3 text-sm sm:mx-7">
            <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-muted-foreground">
              {t("rd.modal.noExactAddress", { defaultValue: "The host hasn't added a full street address yet — message or call your host from My Bookings for exact directions." })}
            </p>
          </div>
        ) : serverBookingQuery.data.address ? (
          <div className="mx-5 mb-3 rounded-2xl border border-border bg-white px-4 py-3 text-sm sm:mx-7">
            <p className="mb-1 text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.modal.gettingThere", { defaultValue: "Getting there" })}</p>
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(serverBookingQuery.data.address)}`}
              target="_blank" rel="noopener noreferrer"
              className="flex items-start gap-2 text-primary hover:underline"
            >
              <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{serverBookingQuery.data.address}</span>
            </a>
          </div>
        ) : null
      )}

      {/* Fare summary. Renders the local rows for line-item context, but
          the "Total paid" footer ALWAYS reflects the server's true charged
          amount (via the LATERAL-joined payment breakdown we expose on the
          booking row). That removes the "₹3.40 displayed, ₹3.47 charged"
          drift that happened when the server's insurance / fractional
          discount math differed from the client-side preview. */}
      {receipt && receipt.rows.length > 0 && (
        <div className="mx-5 mb-3 rounded-2xl border border-border bg-white px-4 py-3 sm:mx-7">
          <p className="mb-2 text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.modal.fareSummary", { defaultValue: "Fare summary" })}</p>
          <dl className="grid gap-1.5 text-sm">
            {receipt.rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between gap-3">
                <dt className="text-foreground/80">{r.label}</dt>
                <dd className={`font-semibold ${r.amount < 0 ? "text-success" : "text-foreground"}`}>
                  {r.amount < 0 ? "−" : ""}{rupee(Math.abs(r.amount))}
                </dd>
              </div>
            ))}
            <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-2">
              <dt className="font-bold text-foreground">{t("rd.modal.totalPaid", { defaultValue: "Total paid" })}</dt>
              <dd className="font-display text-base font-extrabold text-foreground">{rupee(displayTotal)}</dd>
            </div>
          </dl>
        </div>
      )}

      {/* IDs + invoice */}
      {(bookingId || paymentId) && (
        <div className="mx-5 mb-3 rounded-2xl border border-border bg-muted/30 px-4 py-3 sm:mx-7">
          <p className="mb-1 text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.modal.reference", { defaultValue: "Reference" })}</p>
          <dl className="grid gap-1 text-xs">
            {bookingId && (
              <div className="flex items-center justify-between gap-3">
                <dt className="font-semibold text-muted-foreground">{t("rd.modal.bookingId", { defaultValue: "Booking ID" })}</dt>
                <dd className="truncate font-mono text-[11px] text-foreground">{displayRef(bookingId)}</dd>
              </div>
            )}
            {paymentId && (
              <div className="flex items-center justify-between gap-3">
                <dt className="font-semibold text-muted-foreground">{t("rd.modal.paymentId", { defaultValue: "Payment ID" })}</dt>
                <dd className="truncate font-mono text-[11px] text-foreground">{displayRef(paymentId)}</dd>
              </div>
            )}
          </dl>
          {bookingId && (
            <button
              type="button"
              onClick={() => void handleDownloadInvoice()}
              disabled={invoiceDownloading}
              className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-full bg-foreground px-4 text-xs font-bold text-background shadow-sm transition-colors hover:bg-foreground/90 active:bg-foreground/85 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Download className="h-3.5 w-3.5" />
              {invoiceDownloading ? t("rd.modal.preparingPdf", { defaultValue: "Preparing PDF…" }) : t("rd.modal.downloadInvoice", { defaultValue: "Download booking invoice (PDF)" })}
            </button>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-border bg-white/95 px-5 py-3 backdrop-blur sm:px-7">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-10 items-center gap-2 rounded-full border border-border bg-white px-4 text-sm font-bold text-foreground hover:bg-muted"
        >
          {t("rd.modal.close", { defaultValue: "Close" })}
        </button>
        <Link
          to="/bookings"
          className="inline-flex h-10 items-center gap-2 rounded-full px-5 text-sm font-extrabold text-white shadow-[0_14px_30px_rgba(58,50,71,0.20)]"
          style={{ background: "linear-gradient(135deg, #2b2436, #8b5e4a)" }}
        >
          {t("rd.modal.viewInMyBookings", { defaultValue: "View in My Bookings" })}
        </Link>
      </div>
    </div>
  );
}

function PendingBody({ bookingId, onClose }: { bookingId: string | null; onClose: () => void }) {
  const { t } = useLanguage();
  return (
    <div className="grid gap-3 px-5 py-10 text-center sm:px-6">
      <div className="mx-auto inline-grid h-16 w-16 place-items-center rounded-full bg-muted text-foreground">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground" aria-hidden />
      </div>
      <h3 className="font-display text-xl font-extrabold text-foreground">{t("rd.modal.paymentIsProcessing", { defaultValue: "Payment is processing" })}</h3>
      <p className="text-sm text-muted-foreground">
        {t("rd.modal.pendingBody", { defaultValue: "Razorpay accepted your payment but the captured confirmation is still in flight. We'll mark the booking as confirmed automatically once the capture webhook lands — usually within a minute. Your room hold is preserved in the meantime." })}
      </p>
      {bookingId && (
        <p className="text-[11px] font-mono text-muted-foreground">{t("rd.modal.bookingIdInline", { defaultValue: "Booking ID: {{id}}", id: displayRef(bookingId) })}</p>
      )}
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <Link to="/bookings" className="inline-flex h-10 items-center gap-2 rounded-full border border-border bg-white px-4 text-sm font-bold text-foreground hover:bg-muted">
          {t("rd.modal.openMyBookings", { defaultValue: "Open My Bookings" })}
        </Link>
        <button type="button" onClick={onClose} className="inline-flex h-10 items-center gap-2 rounded-full px-5 text-sm font-extrabold text-white shadow-[0_14px_30px_rgba(58,50,71,0.20)]" style={{ background: "linear-gradient(135deg, #2b2436, #8b5e4a)" }}>
          {t("rd.modal.close", { defaultValue: "Close" })}
        </button>
      </div>
    </div>
  );
}

function LoginGate({ request }: { request: BookingRequest }) {
  const { t } = useLanguage();
  const summary =
    request.kind === "stay" ? request.stay.title :
    request.kind === "service" ? request.service.title :
    request.transport.driver;
  return (
    <div className="grid gap-4 px-5 py-8 text-center sm:px-6">
      <div className="mx-auto inline-grid h-14 w-14 place-items-center rounded-2xl bg-muted text-foreground"><Lock className="h-6 w-6" /></div>
      <div>
        <h3 className="font-display text-lg font-bold text-foreground">{t("rd.modal.loginToContinue", { defaultValue: "Log in to continue" })}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t("rd.modal.loginGateBody", { defaultValue: "We use your account to confirm {{summary}}, send updates, and keep your trip history together.", summary })}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Link to="/login" className="inline-flex h-10 items-center gap-2 rounded-full border border-border bg-white px-4 text-sm font-bold text-foreground hover:bg-muted">{t("rd.modal.login", { defaultValue: "Login" })}</Link>
        <Link to="/signup" className="inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-extrabold text-white shadow-[0_14px_30px_rgba(58,50,71,0.20)]" style={{ background: "linear-gradient(135deg, #2b2436, #8b5e4a)" }}>{t("rd.modal.createAccount", { defaultValue: "Create account" })}</Link>
      </div>
    </div>
  );
}

/** Thin adapter that pulls the right weekday's working-hours tuple +
 *  buffer minutes off the transport item, looks up the day's existing
 *  bookings from the prefetched map, and hands everything to the shared
 *  TransportScheduleStrip. Kept in this file because it's stitched to
 *  the modal's local state (bookingsByDate). */
function TransportScheduleStripForDate({
  item, date, bookingsByDate, selectedStarts, onToggleSlot,
}: {
  item: MarketplaceTransport;
  date: string;
  bookingsByDate: Map<string, Array<{ start: number; end: number }>>;
  selectedStarts?: Set<string>;
  onToggleSlot?: (hhmm: string) => void;
}) {
  const { t } = useLanguage();
  if (!date) return null;
  const rawWh = (item.workingHours || {}) as Record<string, [string, string] | null>;
  const hasAnyDay = Object.values(rawWh).some(
    (v) => Array.isArray(v) && v.length === 2 && v[0] && v[1],
  );
  // Listings without a structured weekly schedule default to 9am–9pm
  // every day in the booking modal too — same fallback the host
  // dashboard uses. Without this the customer would see "Closed" on
  // every date and assume the driver isn't bookable.
  const wh: Record<string, [string, string] | null> = hasAnyDay ? rawWh : {
    mon: ["09:00", "21:00"], tue: ["09:00", "21:00"], wed: ["09:00", "21:00"],
    thu: ["09:00", "21:00"], fri: ["09:00", "21:00"], sat: ["09:00", "21:00"],
    sun: ["09:00", "21:00"],
  };
  const parsed = new Date(`${date}T00:00:00`);
  const window = workingHoursForDate(wh, parsed);
  const dayBookings = (bookingsByDate.get(date) ?? []).map<BookingBlock>((b) => ({
    start: `${String(Math.floor(b.start / 60)).padStart(2, "0")}:${String(b.start % 60).padStart(2, "0")}`,
    end: `${String(Math.floor(b.end / 60)).padStart(2, "0")}:${String(b.end % 60).padStart(2, "0")}`,
  }));
  return (
    <TransportScheduleStrip
      windowStart={window.start}
      windowEnd={window.end}
      bookings={dayBookings}
      bufferMinutes={item.bufferMinutes ?? 15}
      selectedStarts={selectedStarts}
      onToggleSlot={onToggleSlot}
      caption={t("rd.modal.driversDay", { defaultValue: "Driver's day" })}
      minStartMinutes={date === istTodayIso() ? istNowMinutes() + BOOKING_LEAD_MINUTES : undefined}
    />
  );
}
