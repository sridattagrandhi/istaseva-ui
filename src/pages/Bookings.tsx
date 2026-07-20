import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Calendar, Car, Home, MapPin, Star, Clock, User, Users, BedDouble, Globe, Wrench, Shield, Package, CheckCircle, MessageCircle, XCircle, IndianRupee, Download, Phone, Palette, Hash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import ReviewModal from "@/components/ReviewModal";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "sonner";
import { useUserBookings } from "@/hooks/use-marketplace-data";
import { useQueryClient } from "@tanstack/react-query";
import { getBookingService } from "@/domains";
import { CANCELLATION_REASONS, type CancellationReason } from "@/domains/bookings/booking.service";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { getAnalyticsEventsService } from "@/domains/analytics/events.service";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { effectiveBookingStatus } from "@/lib/booking-status";
import { displayRef } from "@/lib/reference";
import BackButton from "@/components/BackButton";
import { bookingKindOf } from "@/lib/booking-kind";
import { downloadBookingTaxInvoice } from "@/lib/booking-invoice";
import {
  getServiceBookingDetails,
  getTransportBookingDetails,
  serviceModeLabel,
  transportModeLabel,
} from "@/lib/booking-notes";
import {
  getBookingSellerLabel,
  getBookingSellerName,
  shouldShowProviderByline,
} from "@/lib/booking-display";
import type { Booking } from "@/types/domain";

function formatTime(time: string) {
  if (!time) return "";
  const [h, m] = time.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${(m || 0).toString().padStart(2, "0")} ${ampm}`;
}

function statusBadge(status: string) {
  switch (status) {
    case "confirmed": return "bg-success/10 text-success border border-success/20";
    case "pending": return "bg-primary/10 text-primary border border-primary/20";
    case "in_progress": return "bg-warning/10 text-warning border border-warning/20";
    case "completed": return "bg-muted text-foreground border border-border";
    case "cancelled": case "expired": return "bg-destructive/10 text-destructive border border-destructive/20";
    default: return "bg-muted text-muted-foreground";
  }
}

function formatPrice(paise?: number) {
  if (!paise || paise <= 0) return null;
  return `₹${(paise / 100).toLocaleString("en-IN")}`;
}

function formatDate(dateStr: string) {
  if (!dateStr) return "";
  try {
    // Handle both "YYYY-MM-DD" and full ISO timestamps like "2026-04-13T00:00:00.000Z"
    const dateOnly = dateStr.includes("T") ? dateStr.split("T")[0] : dateStr;
    const d = new Date(dateOnly + "T00:00:00");
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  } catch { return dateStr; }
}

// Server-computed cancellation refund (GET /api/bookings/:id/cancel-preview).
// Mirrors the shape mobile + the assistant card consume.
interface CancelRefundPreview {
  cancellable: boolean;
  refundPaise: number;
  platformKeepsPaise: number;
  policy: "flexible" | "moderate" | "strict";
  insuranceVoided: boolean;
  reason: string;
  chargedPaise?: number;
}

// Standalone My Bookings page. Extracted from the old GuestDashboard's
// "bookings" tab when the guest dashboard was dissolved into dedicated
// pages (/bookings, /wishlist, /notifications) — the card markup, modals,
// and deep-link behaviour are unchanged.
const Bookings = () => {
  const { t } = useLanguage();
  const { data: bookings, error } = useUserBookings();
  const [searchParams, setSearchParams] = useSearchParams();
  const [bookingStatusTab, setBookingStatusTab] = useState<"upcoming" | "completed" | "cancelled">("upcoming");
  const [cancelTarget, setCancelTarget] = useState<Booking | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<Booking | null>(null);
  const [reviewTarget, setReviewTarget] = useState<Booking | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // Required pick before confirm — no preselection, so the recorded reason is
  // a deliberate choice rather than whatever was first in the list.
  const [cancelReason, setCancelReason] = useState<CancellationReason | null>(null);
  // Server-computed refund preview for the cancel dialog (PUX-007). Fetched
  // when the dialog opens so the guest sees the exact refund BEFORE they
  // confirm — the same /cancel-preview endpoint mobile + the assistant use.
  const [cancelPreview, setCancelPreview] = useState<CancelRefundPreview | null>(null);
  const [cancelPreviewLoading, setCancelPreviewLoading] = useState(false);
  useEffect(() => {
    if (!cancelTarget) { setCancelPreview(null); setCancelPreviewLoading(false); return; }
    let ignore = false;
    setCancelPreview(null);
    setCancelPreviewLoading(true);
    (async () => {
      const res = await apiRequest<{ data: CancelRefundPreview }>(
        `/api/bookings/${encodeURIComponent(cancelTarget.id)}/cancel-preview`,
        { method: "GET", headers: getJsonHeaders(false) },
      );
      if (ignore) return;
      if (res.success && res.data?.data) setCancelPreview(res.data.data);
      setCancelPreviewLoading(false);
    })();
    return () => { ignore = true; };
  }, [cancelTarget]);
  const cancelReasonLabel = (reason: CancellationReason) =>
    t(`guest.bookings.cancelReason.${reason}`, {
      defaultValue: {
        plans_changed: "My plans changed",
        found_alternative: "I found a better option",
        price_too_high: "It was too expensive",
        booked_by_mistake: "I booked by mistake",
        host_asked_offline: "The host asked me to cancel / pay offline",
        property_issue: "Problem with the listing",
        other: "Other",
      }[reason],
    });
  const queryClient = useQueryClient();

  // Notification deep-link: /bookings?booking=<id> jumps to the right status
  // tab and pops the details modal once the bookings list arrives.
  useEffect(() => {
    const targetId = searchParams.get("booking");
    if (!targetId || !bookings?.length) return;
    const match = bookings.find((b) => b.id === targetId);
    if (!match) return;
    const s = effectiveBookingStatus(match);
    if (s === "completed") setBookingStatusTab("completed");
    else if (s === "cancelled") setBookingStatusTab("cancelled");
    else setBookingStatusTab("upcoming");
    setDetailsTarget(match);
    // Strip the param so a refresh / nav-back doesn't re-open the modal.
    const next = new URLSearchParams(searchParams);
    next.delete("booking");
    setSearchParams(next, { replace: true });
  }, [searchParams, bookings]);

  const confirmCancelBooking = async () => {
    if (!cancelTarget || !cancelReason) return;
    setCancelling(true);
    const result = await getBookingService().updateBookingStatus(cancelTarget.id, "cancelled", "guest", cancelReason);
    setCancelling(false);
    if (result.success) {
      toast.success(t("guest.toast.cancelled"));
      await queryClient.invalidateQueries({ queryKey: ["bookings"] });
      setCancelTarget(null);
      setCancelReason(null);
    } else {
      toast.error(result.error || t("guest.toast.cancelFailed"));
    }
  };

  const tStatus = (s: string) => t(`guest.status.${s}`, { defaultValue: s });

  // Expired bookings are inconsequential to the guest — hide them entirely.
  // Hide both expired AND pending bookings from this page.
  //
  // - 'pending' means the agent (or the booking modal) prepared a slot hold +
  //   Razorpay order but the user has NOT yet tapped Confirm & Pay. From the
  //   user's perspective, that's not a real booking yet — it's an in-flight
  //   intent. Showing it makes it look as if money moved and the property is
  //   reserved, which neither is true. Once payment completes, the row
  //   transitions to 'confirmed' and shows here.
  // - 'expired' has always been hidden — same reasoning, the hold lapsed
  //   without payment.
  const visibleBookings = bookings.filter((b) => {
    const eff = effectiveBookingStatus(b);
    return eff !== "expired" && eff !== "pending";
  });
  const filteredBookings = visibleBookings.filter((booking) => {
    const s = effectiveBookingStatus(booking);
    // "in_progress" stays surface under Upcoming so a guest mid-stay still sees the card.
    if (bookingStatusTab === "upcoming") return ["confirmed", "pending", "in_progress"].includes(s);
    if (bookingStatusTab === "completed") return s === "completed";
    return s === "cancelled";
  });

  return (
    <div className="min-h-screen">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        <BackButton className="mb-3" label={t("common.back", { defaultValue: "Back" })} />
        {/* Page header — glassy redesign tile, same surface language as the
            dashboards, slimmed to a title band. */}
        <div className="mb-6 rounded-[18px] border border-white/70 bg-white/64 p-5 sm:p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] backdrop-blur-xl">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div
                className="inline-grid h-11 w-11 place-items-center rounded-2xl text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_12px_26px_rgba(58,50,71,0.18)]"
                style={{ background: "linear-gradient(135deg, #2b2436 0%, #7b5244 60%, #c08a5a 100%)" }}
              >
                <Calendar className="h-5 w-5" />
              </div>
              <div>
                <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight">{t("guest.bookings.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("guest.bookings.count", { count: filteredBookings.length })}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {error && (
            <div className="rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground">
              {t("guest.bookings.error")}
            </div>
          )}
          <div className="flex gap-2 overflow-x-auto pb-2">
            {[
              { id: "upcoming", label: tStatus("upcoming") },
              { id: "completed", label: tStatus("completed") },
              { id: "cancelled", label: tStatus("cancelled") },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setBookingStatusTab(tab.id as typeof bookingStatusTab)}
                className={`px-4 py-2 rounded-xl text-sm whitespace-nowrap ${bookingStatusTab === tab.id ? "bg-primary text-primary-foreground" : "bg-card border border-border text-muted-foreground"}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {filteredBookings.length > 0 ? (
            <div className="space-y-3">
              {filteredBookings.map((booking: Booking) => {
                const isStay = bookingKindOf(booking.serviceCategory) === "stay";
                const categoryIcon = isStay ? "🏠" : "🔧";
                const effStatus = effectiveBookingStatus(booking);
                // Prefer the true total paid (base + platform + GST + insurance
                // − discount) when the backend has resolved the completed-
                // payment breakdown. Falls back to the host's agreed price
                // for legacy / unpaid bookings so we never render a blank.
                const priceLabel = formatPrice(booking.totalPaidPaise ?? booking.agreedPricePaise);

                return (
                  <div key={booking.id} className="bg-card rounded-2xl border border-border p-4 sm:p-5 hover:shadow-md transition-all">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <div className="w-11 h-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center text-lg shrink-0">
                          {categoryIcon}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="font-semibold text-sm truncate">
                              {booking.listingName || booking.serviceCategory?.replace(/-/g, " ") || t("guest.bookings.bookingDefault")}
                            </h4>
                            {effStatus === "confirmed" && <CheckCircle className="w-3.5 h-3.5 text-success shrink-0" />}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5 capitalize">
                            {booking.listingName ? booking.serviceCategory?.replace(/-/g, " ") : null}
                            {booking.listingName ? " · " : ""}{t("guest.bookings.bookingNumPrefix")}{displayRef(booking.id)}
                          </p>
                        </div>
                      </div>
                      <span className={`px-3 py-1 rounded-full text-[11px] font-semibold shrink-0 capitalize ${statusBadge(effStatus)}`}>
                        {tStatus(effStatus)}
                      </span>
                    </div>

                    {isStay ? (
                      (() => {
                        let checkOutDate = "";
                        try {
                          const parsed = booking.notes ? JSON.parse(booking.notes) : null;
                          if (parsed?.checkOut) checkOutDate = parsed.checkOut;
                        } catch { /* notes may not be JSON */ }
                        const checkInDay = booking.scheduledDate
                          ? new Date((booking.scheduledDate.includes("T") ? booking.scheduledDate.split("T")[0] : booking.scheduledDate) + "T00:00:00").getDate()
                          : null;
                        const checkOutDay = checkOutDate
                          ? new Date(checkOutDate + "T00:00:00").getDate()
                          : null;
                        const rangeMonth = checkOutDate
                          ? new Date(checkOutDate + "T00:00:00").toLocaleDateString("en-IN", { month: "short" })
                          : null;
                        return (
                          <div className="mt-3 space-y-2 text-xs">
                            {checkInDay && checkOutDay && (
                              <p className="text-muted-foreground flex items-center gap-1">
                                <Calendar className="w-3.5 h-3.5 shrink-0" />
                                {checkInDay} – {checkOutDay} {rangeMonth}
                              </p>
                            )}
                            {booking.roomTypeName && (
                              <p className="text-muted-foreground flex items-center gap-1">
                                <Home className="w-3.5 h-3.5 shrink-0" />
                                {booking.roomTypeName}
                                {booking.roomCount && booking.roomCount > 1
                                  ? ` × ${t("guest.bookings.roomsCount", { count: booking.roomCount, defaultValue: "{{count}} rooms" })}`
                                  : ''}
                              </p>
                            )}
                            <div className="grid grid-cols-2 gap-3">
                              <div className="bg-muted/40 rounded-lg p-2.5">
                                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-0.5">{t("guest.bookings.checkIn")}</p>
                                <p className="font-medium text-foreground flex items-center gap-1">
                                  <Calendar className="w-3 h-3 shrink-0" />
                                  {formatDate(booking.scheduledDate)}
                                </p>
                                {booking.startTime && (
                                  <p className="text-muted-foreground flex items-center gap-1 mt-0.5">
                                    <Clock className="w-3 h-3 shrink-0" />
                                    {formatTime(booking.startTime)}
                                  </p>
                                )}
                              </div>
                              <div className="bg-muted/40 rounded-lg p-2.5">
                                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-0.5">{t("guest.bookings.checkOut")}</p>
                                <p className="font-medium text-foreground flex items-center gap-1">
                                  <Calendar className="w-3 h-3 shrink-0" />
                                  {checkOutDate ? formatDate(checkOutDate) : "—"}
                                </p>
                                {booking.endTime && (
                                  <p className="text-muted-foreground flex items-center gap-1 mt-0.5">
                                    <Clock className="w-3 h-3 shrink-0" />
                                    {formatTime(booking.endTime)}
                                  </p>
                                )}
                              </div>
                            </div>
                            {booking.address && (
                              <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(booking.address)}`}
                                 target="_blank" rel="noopener noreferrer"
                                 className="flex items-center gap-1 truncate text-primary hover:underline">
                                <MapPin className="w-3.5 h-3.5 shrink-0" />
                                {booking.address}
                              </a>
                            )}
                            {booking.hasExactAddress === false && (
                              <span className="flex items-center gap-1 text-muted-foreground italic">
                                <MessageCircle className="w-3.5 h-3.5 shrink-0" />
                                {t("guest.bookings.noExactAddress", { defaultValue: "Message or call your host for exact directions" })}
                              </span>
                            )}
                            {priceLabel && (
                              <span className="flex items-center gap-1 font-semibold text-foreground">
                                <IndianRupee className="w-3.5 h-3.5 shrink-0" />
                                {priceLabel.replace("₹", "")}
                              </span>
                            )}
                          </div>
                        );
                      })()
                    ) : (() => {
                      const svc = getServiceBookingDetails(booking.notes);
                      const trn = getTransportBookingDetails(booking.notes);
                      const modePill = svc?.serviceMode
                        ? serviceModeLabel(svc.serviceMode)
                        : trn?.mode
                          ? transportModeLabel(trn.mode)
                          : null;
                      const detailBits: string[] = [];
                      if (trn) {
                        if (trn.pickup) detailBits.push(t("guest.bookings.pickupBit", { location: trn.pickup, defaultValue: "Pickup: {{location}}" }));
                        if (trn.mode === "hourly" && typeof trn.durationHours === "number") detailBits.push(t("guest.details.hr", { count: trn.durationHours, defaultValue: "{{count}} hr" }));
                        if (trn.mode === "day" && typeof trn.days === "number") detailBits.push(t("guest.bookings.daysBit", { count: trn.days, defaultValue: "{{count}} days" }));
                        if (trn.mode === "package" && trn.packageLabel) detailBits.push(trn.packageLabel);
                        if (typeof trn.passengers === "number") detailBits.push(t("guest.bookings.paxBit", { count: trn.passengers, defaultValue: "{{count}} pax" }));
                      } else if (svc) {
                        // Lead with the selected services-catalog group so
                        // the customer's bookings list shows "Women's
                        // Haircut · Jubilee Hills" instead of just the
                        // logistics — useful when they have multiple
                        // bookings under the same listing.
                        if (svc.selectedServiceName) detailBits.push(svc.selectedServiceName);
                        if (svc.serviceMode === "at-home" && svc.customerAddress) detailBits.push(svc.customerAddress);
                        if (svc.serviceMode === "visit-provider" && svc.visitAddress) detailBits.push(svc.visitAddress);
                        if (svc.serviceMode === "online" && svc.meetingDetails) detailBits.push(svc.meetingDetails);
                      }
                      return (
                        <>
                          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Calendar className="w-3.5 h-3.5" />
                              {formatDate(booking.scheduledDate)}
                            </span>
                            {/* Package/day holds span the driver's working
                                window for that date — show "Full-day tour ·
                                9:00 AM – 5:00 PM". Pre-widening bookings
                                carry a 00:00–23:59 artifact → label only. */}
                            {["driver-package", "driver-day"].includes(booking.serviceCategory?.toLowerCase() ?? "") ? (
                              <span className="flex items-center gap-1">
                                <Clock className="w-3.5 h-3.5" />
                                {booking.serviceCategory?.toLowerCase() === "driver-package" ? t("guest.bookings.fullDayTour", { defaultValue: "Full-day tour" }) : t("guest.bookings.fullDay", { defaultValue: "Full day" })}
                                {booking.startTime && booking.endTime && !(booking.startTime.startsWith("00:00") && booking.endTime.startsWith("23:59"))
                                  ? ` · ${formatTime(booking.startTime)} – ${formatTime(booking.endTime)}`
                                  : ""}
                              </span>
                            ) : booking.startTime && booking.endTime && (
                              <span className="flex items-center gap-1">
                                <Clock className="w-3.5 h-3.5" />
                                {formatTime(booking.startTime)} – {formatTime(booking.endTime)}
                              </span>
                            )}
                            {modePill && (
                              <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-semibold uppercase tracking-wider">
                                {modePill}
                              </span>
                            )}
                            {/* Suppress the address chip for online
                                services — the customer never physically
                                meets the provider, so showing their
                                saved profile address (or the listing's
                                fallback) is noise. The meeting link
                                surfaces in detailBits below. */}
                            {booking.address && svc?.serviceMode !== "online" && (
                              <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(booking.address)}`}
                                 target="_blank" rel="noopener noreferrer"
                                 className="flex items-center gap-1 truncate max-w-[200px] text-primary hover:underline">
                                <MapPin className="w-3.5 h-3.5 shrink-0" />
                                {booking.address}
                              </a>
                            )}
                            {priceLabel && (
                              <span className="flex items-center gap-1 font-semibold text-foreground">
                                <IndianRupee className="w-3.5 h-3.5 shrink-0" />
                                {priceLabel.replace("₹", "")}
                              </span>
                            )}
                          </div>
                          {detailBits.length > 0 && (
                            <p className="mt-1.5 text-xs text-muted-foreground truncate">
                              {detailBits.join(" · ")}
                            </p>
                          )}
                          {svc?.addOns && svc.addOns.length > 0 && (
                            <p className="mt-1 text-xs text-muted-foreground truncate">
                              {t("guest.bookings.addOnsLabel", { defaultValue: "Add-ons:" })} {svc.addOns.map((a) => a.label || a.id).filter(Boolean).join(", ")}
                            </p>
                          )}
                        </>
                      );
                    })()}

                    {/* "by <provider>" byline — only meaningful for
                        services/transport. For stays we suppress it
                        entirely; the property name above already names
                        the seller, and the provider_profile underneath
                        can carry a label unrelated to the property
                        (e.g. seed data linking a hotel to a generic
                        "Super Cleanings" provider). See booking-display
                        helper for the single source of this rule.
                        ALSO suppressed for online services — same
                        cross-listing branding leak as transport: a host
                        who runs both an online math tutor AND a salon
                        shows up as "by Truefitt & Hill" under the tutor
                        booking, which is misleading. The listing title
                        above already names the seller of the online
                        session. */}
                    {shouldShowProviderByline(booking)
                      && getServiceBookingDetails(booking.notes)?.serviceMode !== "online"
                      && (
                      <p className="mt-2 text-xs text-muted-foreground flex items-center gap-1">
                        <User className="w-3 h-3 shrink-0" />
                        {t("guest.bookings.by", { name: booking.providerName, defaultValue: "by {{name}}" })}
                      </p>
                    )}

                    {(effStatus === "confirmed" || effStatus === "pending") && (
                      <div className="mt-3 pt-3 border-t border-border/50 flex items-center justify-between">
                        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <Shield className="w-3 h-3" /> {t("guest.bookings.freeCancel")}
                        </p>
                        <div className="flex items-center gap-3">
                          {effStatus === "confirmed" && booking.providerUserId && (
                            <Link
                              to={`/messages?user=${booking.providerUserId}`}
                              onClick={() => getAnalyticsEventsService().track("message_provider_clicked", { source: "guest_dashboard" })}
                              className="text-xs text-primary font-medium hover:underline flex items-center gap-1"
                            >
                              <MessageCircle className="w-3.5 h-3.5" /> {t("guest.bookings.message")}
                            </Link>
                          )}
                          {effStatus === "confirmed" && (
                            <button
                              onClick={async () => {
                                try {
                                  await downloadBookingTaxInvoice(booking.id);
                                } catch (err) {
                                  toast.error(err instanceof Error ? err.message : t("guest.bookings.invoiceFailed", { defaultValue: "Failed to download invoice" }));
                                }
                              }}
                              className="text-xs text-muted-foreground font-medium hover:underline flex items-center gap-1"
                            >
                              <Download className="w-3.5 h-3.5" /> {t("guest.bookings.downloadInvoice", { defaultValue: "Download invoice" })}
                            </button>
                          )}
                          <button
                            onClick={() => setDetailsTarget(booking)}
                            className="text-xs text-primary font-medium hover:underline"
                          >
                            {t("guest.bookings.viewDetails")}
                          </button>
                          <button
                            onClick={() => setCancelTarget(booking)}
                            className="text-xs text-destructive font-medium hover:underline flex items-center gap-1"
                          >
                            <XCircle className="w-3.5 h-3.5" /> {t("guest.bookings.cancel")}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Completed bookings get a "Write a review" shortcut that opens the
                        listing page with its review form pre-expanded. The ?write_review=1
                        flag is read by ReviewsSection on the detail page. */}
                    {effStatus === "completed" && (
                      <div className="mt-3 pt-3 border-t border-border/50 flex items-center justify-between">
                        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <Star className="w-3 h-3" /> {isStay ? t("guest.bookings.howStay") : t("guest.bookings.howService")}
                        </p>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={async () => {
                              try {
                                await downloadBookingTaxInvoice(booking.id);
                              } catch (err) {
                                toast.error(err instanceof Error ? err.message : t("guest.bookings.invoiceFailed", { defaultValue: "Failed to download invoice" }));
                              }
                            }}
                            className="text-xs text-muted-foreground font-medium hover:underline flex items-center gap-1"
                          >
                            <Download className="w-3.5 h-3.5" /> {t("guest.bookings.downloadInvoice", { defaultValue: "Download invoice" })}
                          </button>
                          <button
                            onClick={() => setReviewTarget(booking)}
                            className="text-xs text-primary font-medium hover:underline flex items-center gap-1"
                          >
                            <Star className="w-3.5 h-3.5" /> {t("guest.bookings.writeReview")}
                          </button>
                          <button
                            onClick={() => setDetailsTarget(booking)}
                            className="text-xs text-muted-foreground font-medium hover:underline"
                          >
                            {t("guest.bookings.viewDetails")}
                          </button>
                        </div>
                      </div>
                    )}

                    {(effStatus === "cancelled" || effStatus === "in_progress") && (
                      <div className="mt-3 pt-3 border-t border-border/50 flex items-center justify-end">
                        <button
                          onClick={() => setDetailsTarget(booking)}
                          className="text-xs text-primary font-medium hover:underline"
                        >
                          {t("guest.bookings.viewDetails")}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-20 bg-card rounded-2xl border border-border">
              <Calendar className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
              <h3 className="font-display font-semibold text-lg mb-1">{t(`guest.empty.${bookingStatusTab}.title`)}</h3>
              <p className="text-sm text-muted-foreground mb-4">
                {t(`guest.empty.${bookingStatusTab}.desc`)}
              </p>
              <div className="flex justify-center gap-3">
                <Button variant="outline" className="rounded-xl" asChild><Link to="/explore">{t("guest.browseStays")}</Link></Button>
                <Button variant="outline" className="rounded-xl" asChild><Link to="/services">{t("guest.browseServices")}</Link></Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={!!cancelTarget} onOpenChange={(open) => { if (!open && !cancelling) { setCancelTarget(null); setCancelReason(null); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("guest.bookings.cancelTitle", { defaultValue: "Cancel this booking?" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("guest.bookings.cancelBodyShort", { defaultValue: "This can't be undone. Any eligible refund is returned to your original payment method." })}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* Server-computed refund preview (PUX-007): show the exact amount
              the guest gets back BEFORE they confirm. */}
          <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
            {cancelPreviewLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-transparent" />
                {t("guest.bookings.refundCalculating", { defaultValue: "Calculating your refund…" })}
              </div>
            ) : cancelPreview ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t("guest.bookings.refundLabel", { defaultValue: "You'll get back" })}</span>
                  <span className="text-base font-bold text-foreground">₹{(cancelPreview.refundPaise / 100).toLocaleString("en-IN")}</span>
                </div>
                {cancelPreview.platformKeepsPaise > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">{t("guest.bookings.refundRetained", { defaultValue: "Non-refundable" })}</span>
                    <span className="text-xs font-medium text-muted-foreground">₹{(cancelPreview.platformKeepsPaise / 100).toLocaleString("en-IN")}</span>
                  </div>
                )}
                {cancelPreview.insuranceVoided && (
                  <p className="text-xs text-muted-foreground">{t("guest.bookings.refundInsuranceVoided", { defaultValue: "Trip protection will be voided." })}</p>
                )}
                <p className="text-xs text-muted-foreground">{t("guest.bookings.refundTiming", { defaultValue: "Refunds typically arrive in 5–7 business days." })}</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("guest.bookings.refundUnavailable", { defaultValue: "If a payment was completed, any eligible refund is processed automatically after you cancel." })}</p>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{t("guest.bookings.cancelReasonTitle", { defaultValue: "Why are you cancelling?" })}</p>
            <RadioGroup value={cancelReason ?? ""} onValueChange={(v) => setCancelReason(v as CancellationReason)}>
              {CANCELLATION_REASONS.map((reason) => (
                <div key={reason} className="flex items-center space-x-2">
                  <RadioGroupItem value={reason} id={`cancel-reason-${reason}`} />
                  <Label htmlFor={`cancel-reason-${reason}`} className="font-normal cursor-pointer">
                    {cancelReasonLabel(reason)}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelling}>{t("guest.bookings.keep", { defaultValue: "Keep booking" })}</AlertDialogCancel>
            <AlertDialogAction
              disabled={cancelling || !cancelReason}
              onClick={(e) => { e.preventDefault(); confirmCancelBooking(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancelling ? t("guest.bookings.cancelling", { defaultValue: "Cancelling…" }) : t("guest.bookings.cancel")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!detailsTarget} onOpenChange={(open) => !open && setDetailsTarget(null)}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          {detailsTarget && (() => {
            const isStay = bookingKindOf(detailsTarget.serviceCategory) === "stay";
            // Pull both `checkOut` and `guests` out of the notes JSON in one
            // pass — guests was implicit before (the booking modal stores the
            // total head-count in notes.guests), now we surface it explicitly.
            let checkOutDate = "";
            let guestsFromNotes: number | null = null;
            try {
              const parsed = detailsTarget.notes ? JSON.parse(detailsTarget.notes) : null;
              if (parsed?.checkOut) checkOutDate = parsed.checkOut;
              const g = Number(parsed?.guests ?? parsed?.guestCount ?? parsed?.adults);
              if (Number.isFinite(g) && g > 0) guestsFromNotes = Math.round(g);
            } catch { /* notes may not be JSON */ }
            const eff = effectiveBookingStatus(detailsTarget);
            const price = formatPrice(detailsTarget.totalPaidPaise ?? detailsTarget.agreedPricePaise);
            const svc = isStay ? null : getServiceBookingDetails(detailsTarget.notes);
            const trn = isStay ? null : getTransportBookingDetails(detailsTarget.notes);
            const roomCount = (detailsTarget as { roomCount?: number }).roomCount ?? 1;
            const sellerLabel = getBookingSellerLabel(detailsTarget) === "Property"
              ? t("guest.bookings.propertyLabel", { defaultValue: "Property" })
              : t("guest.bookings.providerLabel", { defaultValue: "Provider" });
            // Booking ID prettified: monospace, uppercase, leading "#" — reads
            // as a real reference number ("F154275E") instead of a stray hex
            // blob.
            const bookingShortId = displayRef(detailsTarget.id);
            // Status pill color picked from the canonical status set. Falls
            // back to muted for unknown / legacy values rather than crashing.
            const statusPill = (() => {
              switch (eff) {
                case "confirmed":
                case "in_progress":
                  return "bg-green-100 text-green-800 border-green-200";
                case "completed":
                  return "bg-blue-100 text-blue-800 border-blue-200";
                case "pending":
                  return "bg-yellow-100 text-yellow-800 border-yellow-200";
                case "cancelled":
                case "expired":
                  return "bg-rose-100 text-rose-800 border-rose-200";
                default:
                  return "bg-muted text-foreground border-border";
              }
            })();
            // Group rows into 3 visual sections so the modal reads top-down:
            // Reservation -> Property/Provider -> Pricing. Each section
            // renders inside its own muted card so the eye can land on the
            // block it cares about without scanning a flat 12-row table.
            type Row = [string, string | null | undefined, React.ReactNode?];
            const reservationRows: Row[] = [
              [isStay ? t("guest.bookings.checkIn") : t("guest.bookings.dateLabel", { defaultValue: "Date" }), formatDate(detailsTarget.scheduledDate), <Calendar className="w-3.5 h-3.5" />],
              ...(isStay && checkOutDate ? [[t("guest.bookings.checkOut"), formatDate(checkOutDate), <Calendar className="w-3.5 h-3.5" />] as Row] : []),
              // Package/day holds span the driver's working window for that
              // date — show "Full-day tour · 9:00 AM – 5:00 PM". Pre-widening
              // bookings carry a 00:00–23:59 artifact → label only.
              ...(["driver-package", "driver-day"].includes(detailsTarget.serviceCategory?.toLowerCase() ?? "")
                ? [[
                    t("guest.bookings.timeLabel", { defaultValue: "Time" }),
                    `${detailsTarget.serviceCategory?.toLowerCase() === "driver-package" ? t("guest.bookings.fullDayTour", { defaultValue: "Full-day tour" }) : t("guest.bookings.fullDay", { defaultValue: "Full day" })}${
                      detailsTarget.startTime && detailsTarget.endTime && !(detailsTarget.startTime.startsWith("00:00") && detailsTarget.endTime.startsWith("23:59"))
                        ? ` · ${formatTime(detailsTarget.startTime)} – ${formatTime(detailsTarget.endTime)}`
                        : ""
                    }`,
                    <Clock className="w-3.5 h-3.5" />,
                  ] as Row]
                : detailsTarget.startTime && detailsTarget.endTime
                  ? [[t("guest.bookings.timeLabel", { defaultValue: "Time" }), `${formatTime(detailsTarget.startTime)} – ${formatTime(detailsTarget.endTime)}`, <Clock className="w-3.5 h-3.5" />] as Row]
                  : []),
              ...(isStay && roomCount > 0 ? [[t("guest.details.rooms", { defaultValue: "Rooms" }), t("guest.details.roomsValue", { count: roomCount, defaultValue: "{{count}} rooms" }), <BedDouble className="w-3.5 h-3.5" />] as Row] : []),
              ...(guestsFromNotes ? [[t("guest.details.guests", { defaultValue: "Guests" }), t("guest.details.guestsValue", { count: guestsFromNotes, defaultValue: "{{count}} guests" }), <Users className="w-3.5 h-3.5" />] as Row] : []),
              ...(detailsTarget.roomTypeName ? [[t("guest.details.roomType", { defaultValue: "Room type" }), detailsTarget.roomTypeName, <Home className="w-3.5 h-3.5" />] as Row] : []),
            ];
            const providerRows: Row[] = [
              [sellerLabel, getBookingSellerName(detailsTarget), <Home className="w-3.5 h-3.5" />],
              // "Service" row appears just under the provider name so the
              // customer sees what specific offering they booked alongside
              // who they booked it from. Hidden for legacy/no-catalog
              // listings; the existing serviceTitle fallback below covers them.
              ...(svc?.selectedServiceName ? [[t("guest.details.service", { defaultValue: "Service" }), svc.selectedServiceName, <Wrench className="w-3.5 h-3.5" />] as Row] : []),
              ...(svc?.serviceMode ? [[t("guest.details.serviceMode", { defaultValue: "Service mode" }), serviceModeLabel(svc.serviceMode), <Wrench className="w-3.5 h-3.5" />] as Row] : []),
              ...(svc?.customerAddress ? [[t("guest.details.customerAddress", { defaultValue: "Customer address" }), svc.customerAddress, <MapPin className="w-3.5 h-3.5" />] as Row] : []),
              ...(svc?.visitAddress ? [[t("guest.details.visitAddress", { defaultValue: "Visit address" }), svc.visitAddress, <MapPin className="w-3.5 h-3.5" />] as Row] : []),
              ...(svc?.meetingDetails ? [[t("guest.details.meetingDetails", { defaultValue: "Meeting details" }), svc.meetingDetails, <Globe className="w-3.5 h-3.5" />] as Row] : []),
              ...(trn?.mode ? [[t("guest.details.transportMode", { defaultValue: "Transport mode" }), transportModeLabel(trn.mode), <Car className="w-3.5 h-3.5" />] as Row] : []),
              ...(trn?.pickup ? [[t("guest.details.pickup", { defaultValue: "Pickup" }), trn.pickup, <MapPin className="w-3.5 h-3.5" />] as Row] : []),
              ...(trn?.mode === "hourly" && typeof trn.durationHours === "number" ? [[t("guest.details.duration", { defaultValue: "Duration" }), t("guest.details.hr", { count: trn.durationHours, defaultValue: "{{count}} hr" }), <Clock className="w-3.5 h-3.5" />] as Row] : []),
              ...(trn?.mode === "day" && typeof trn.days === "number" ? [[t("guest.details.days", { defaultValue: "Days" }), String(trn.days), <Calendar className="w-3.5 h-3.5" />] as Row] : []),
              ...(trn?.mode === "package" && trn.packageLabel
                ? [[t("guest.details.package", { defaultValue: "Package" }), typeof trn.packageHours === "number" ? `${trn.packageLabel} · ${t("guest.details.hr", { count: trn.packageHours, defaultValue: "{{count}} hr" })}` : trn.packageLabel, <Package className="w-3.5 h-3.5" />] as Row]
                : []),
              ...(typeof trn?.passengers === "number" ? [[t("guest.details.passengers", { defaultValue: "Passengers" }), String(trn.passengers), <Users className="w-3.5 h-3.5" />] as Row] : []),
              // Vehicle identity. Prefer the booking-time snapshot (the exact
              // car booked) — it supersedes the looser notes-based vehicleType
              // ("Sedan") when present so we don't show two "Vehicle" rows.
              ...(detailsTarget.vehicleModel
                ? [[t("guest.details.vehicle", { defaultValue: "Vehicle" }), detailsTarget.vehicleModel, <Car className="w-3.5 h-3.5" />] as Row]
                : trn?.vehicleType
                  ? [[t("guest.details.vehicle", { defaultValue: "Vehicle" }), trn.vehicleType, <Car className="w-3.5 h-3.5" />] as Row]
                  : []),
              ...(detailsTarget.vehicleColor ? [[t("guest.details.vehicleColor", { defaultValue: "Colour" }), detailsTarget.vehicleColor, <Palette className="w-3.5 h-3.5" />] as Row] : []),
              ...(detailsTarget.vehiclePlate ? [[t("guest.details.vehiclePlate", { defaultValue: "Number plate" }), detailsTarget.vehiclePlate, <Hash className="w-3.5 h-3.5" />] as Row] : []),
              ...(detailsTarget.driverPhone ? [[t("guest.details.driverPhone", { defaultValue: "Driver phone" }), detailsTarget.driverPhone, <Phone className="w-3.5 h-3.5" />] as Row] : []),
            ];
            const mapsUrl = detailsTarget.address
              ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(detailsTarget.address)}`
              : null;
            const renderSection = (label: string, rows: Row[]) => {
              if (rows.every(([, v]) => !v)) return null;
              return (
                <section className="rounded-2xl border border-border bg-muted/40 px-4 py-3">
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
                  <dl className="space-y-2">
                    {rows.map(([rowLabel, value, icon]) => value ? (
                      <div key={rowLabel} className="flex items-start justify-between gap-4 text-sm">
                        <dt className="inline-flex items-center gap-1.5 text-muted-foreground shrink-0">
                          {icon}
                          {rowLabel}
                        </dt>
                        <dd className="font-semibold text-right text-foreground break-words">{value}</dd>
                      </div>
                    ) : null)}
                  </dl>
                </section>
              );
            };
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="truncate text-lg font-bold">
                    {detailsTarget.listingName || detailsTarget.serviceCategory?.replace(/-/g, " ") || t("guest.bookings.bookingDefault")}
                  </DialogTitle>
                  <DialogDescription className="capitalize text-xs">
                    {detailsTarget.serviceCategory?.replace(/-/g, " ")}
                  </DialogDescription>
                </DialogHeader>
                {/* Header strip — booking reference + status pill at the
                    top. Replaces the row-by-row "Booking: f154275e / Status:
                    Confirmed" layout with a single scannable summary band. */}
                <div className="mt-3 flex items-center justify-between gap-3 rounded-2xl border border-border bg-muted/60 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{t("guest.details.bookingId", { defaultValue: "Booking ID" })}</p>
                    <p className="font-mono text-sm font-extrabold text-foreground tracking-wide">#{bookingShortId}</p>
                  </div>
                  <span className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-wide ${statusPill}`}>
                    {tStatus(eff)}
                  </span>
                </div>
                <div className="mt-3 space-y-3">
                  {renderSection(isStay ? t("guest.details.reservation", { defaultValue: "Reservation" }) : t("guest.details.booking", { defaultValue: "Booking" }), reservationRows)}
                  {renderSection(sellerLabel, providerRows)}
                  {(mapsUrl || detailsTarget.address) && (
                    <section className="rounded-2xl border border-border bg-muted/40 px-4 py-3">
                      <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{t("guest.bookings.addressLabel", { defaultValue: "Address" })}</p>
                      {mapsUrl ? (
                        <a
                          href={mapsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-start gap-1.5 text-sm font-semibold text-primary hover:underline"
                        >
                          <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                          <span className="break-words">{detailsTarget.address}</span>
                        </a>
                      ) : (
                        <p className="text-sm font-semibold text-foreground break-words">{detailsTarget.address}</p>
                      )}
                    </section>
                  )}
                  <section className="rounded-2xl border border-border bg-muted/40 px-4 py-3">
                    <div className="flex items-center justify-between gap-4">
                      <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        <IndianRupee className="w-3.5 h-3.5" />
                        {t("guest.bookings.priceLabel", { defaultValue: "Total paid" })}
                      </span>
                      <span className="font-display text-lg font-extrabold text-foreground tabular-nums">{price}</span>
                    </div>
                    {svc?.addOns && svc.addOns.length > 0 && (
                      <ul className="mt-3 space-y-1 border-t border-border/60 pt-2 text-sm">
                        {svc.addOns.map((a, i) => (
                          <li key={a.id || `${a.label}-${i}`} className="flex items-center justify-between gap-2">
                            <span className="text-muted-foreground">+ {a.label || a.id || t("guest.details.addOn", { defaultValue: "Add-on" })}</span>
                            {typeof a.price === "number" && <span className="text-foreground tabular-nums">+₹{a.price}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                    {(svc?.protection || trn?.protection) && (
                      <p className="mt-2 text-xs text-muted-foreground">{t("guest.details.protectionAdded", { defaultValue: "Protection plan added" })}</p>
                    )}
                  </section>
                  {detailsTarget.notes && !detailsTarget.notes.trim().startsWith("{") && (
                    <section className="rounded-2xl border border-border bg-muted/40 px-4 py-3">
                      <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{t("guest.bookings.notesLabel", { defaultValue: "Notes" })}</p>
                      <p className="text-sm text-foreground">{detailsTarget.notes}</p>
                    </section>
                  )}
                  {/* Invoice download — fetches the GST-compliant PDF
                      generated by the server so the breakdown matches the
                      booking-confirmation email exactly. Promoted to a full-
                      width primary-style action so it doesn't read as the
                      previous flat outlined chip. */}
                  <Button
                    variant="outline"
                    className="w-full rounded-2xl h-11 font-bold border-foreground/40 bg-muted hover:bg-foreground hover:text-white hover:border-foreground transition-all"
                    onClick={async () => {
                      try {
                        await downloadBookingTaxInvoice(detailsTarget!.id);
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : t("guest.bookings.invoiceFailed", { defaultValue: "Failed to download invoice" }));
                      }
                    }}
                  >
                    <Download className="w-4 h-4 mr-2" />
                    {t("guest.bookings.downloadInvoice", { defaultValue: "Download invoice" })}
                  </Button>
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {reviewTarget && (reviewTarget.listingId || reviewTarget.providerId) && (
        <ReviewModal
          listingId={reviewTarget.listingId || reviewTarget.providerId}
          listingName={reviewTarget.listingName || reviewTarget.serviceCategory?.replace(/-/g, " ") || t("guest.details.listing", { defaultValue: "Listing" })}
          bookingId={reviewTarget.id}
          onClose={() => setReviewTarget(null)}
          onSubmitted={() => queryClient.invalidateQueries({ queryKey: ["bookings"] })}
        />
      )}
    </div>
  );
};

export default Bookings;
