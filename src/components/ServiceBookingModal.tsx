import { useState, useEffect, useCallback } from "react";
import { X, Calendar, Clock, MapPin, Shield, CheckCircle, Zap, AlertTriangle, Users, Lock, MessageCircle, Crosshair } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import InsuranceToggle from "@/components/InsuranceToggle";
import SmartSchedulePicker from "@/components/SmartSchedulePicker";
import SafetyCheckModal from "@/components/safety/SafetyCheckModal";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "sonner";
import type { Service } from "@/types/listings";
import { getServiceGuarantee } from "@/utils/serviceGuarantee";
import { useBookingFlow } from "@/hooks/useBookingFlow";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { displayRef } from "@/lib/reference";
import { getCurrentPosition, reverseGeocode } from "@/lib/geo";
import { useBookingDraft } from "@/lib/booking-draft";
import { PLATFORM_FEE_RUPEES } from "@/lib/pricing";
import AddressAutocompleteInput from "@/components/AddressAutocompleteInput";

// Format any rupee amount with exactly two decimals so the booking modal
// shows `₹123.00` / `₹123.45` consistently, never an integer fallback.
function formatRupees(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface ServiceBookingModalProps {
  service: Service;
  isOpen: boolean;
  onClose: () => void;
}

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

function formatTime(t: string) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

const DURATION_OPTIONS = [
  { label: "30 min", value: 30 },
  { label: "1 hour", value: 60 },
  { label: "1.5 hours", value: 90 },
  { label: "2 hours", value: 120 },
  { label: "3 hours", value: 180 },
  { label: "4 hours", value: 240 },
];

const PRICING_UNIT_LABELS: Record<string, string> = {
  per_hour: "/hr",
  per_visit: "/visit",
  per_session: "/session",
  per_day: "/day",
  fixed: " (fixed)",
};

const ServiceBookingModal = ({ service, isOpen, onClose }: ServiceBookingModalProps) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { t } = useLanguage();
  // Translated display label for a duration option (logic still keyed by value).
  const durationLabel = (value: number, fallback: string) =>
    t(`svcBooking.duration_${value}`, { defaultValue: fallback });
  // Translated suffix for a pricing unit (e.g. "/hr"). Keys mirror PRICING_UNIT_LABELS.
  const unitLabel = (unit: string) => {
    const fallback = PRICING_UNIT_LABELS[unit];
    if (!fallback) return "";
    return t(`svcBooking.unit_${unit}`, { defaultValue: fallback });
  };
  const [showSafetyCheck, setShowSafetyCheck] = useState(false);
  // Persist address across modal close + back/forward navigation. Key by
  // service id so each service keeps its own draft.
  const draft = useBookingDraft<{ address: string }>("service", service.id);
  const [address, setAddress] = draft.useField("address", "");
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [insurance, setInsurance] = useState(false);
  const [locating, setLocating] = useState(false);

  const handleUseMyLocation = useCallback(async () => {
    if (locating) return;
    setLocating(true);
    try {
      const pos = await getCurrentPosition({ enableHighAccuracy: true });
      setUserCoords({ lat: pos.lat, lng: pos.lng });
      const text = await reverseGeocode(pos.lat, pos.lng);
      if (text) {
        setAddress(text);
        toast.success(t("svcBooking.locationFilled", { defaultValue: "Location filled from your device" }));
      } else {
        setAddress(`Lat ${pos.lat.toFixed(5)}, Lng ${pos.lng.toFixed(5)}`);
        toast.message(t("svcBooking.usedCoordinates", { defaultValue: "Used your coordinates — couldn't fetch a street address right now." }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t("svcBooking.locationError", { defaultValue: "Couldn't get your location." });
      toast.error(message);
    } finally {
      setLocating(false);
    }
  }, [locating, setAddress, t]);

  // Geocode the typed address (debounced) so smart-schedule can compute real
  // travel-time from the provider's previous job location to THIS job. The
  // job location is the customer's address, not the service's home base.
  useEffect(() => {
    const trimmed = address.trim();
    if (trimmed.length < 8) { setUserCoords(null); return; }
    const handle = setTimeout(async () => {
      try {
        const res = await apiRequest<{ result: { lat: number; lng: number } | null }>(
          "/api/geocode",
          { method: "POST", headers: getJsonHeaders(), body: JSON.stringify({ address: trimmed }) }
        );
        setUserCoords(res.success ? res.data?.result ?? null : null);
      } catch {
        setUserCoords(null);
      }
    }, 600);
    return () => clearTimeout(handle);
  }, [address]);

  // Duration and pricing logic
  const durationMeta = service.metadata?.durationMinutes || { min: 60, max: 60 };
  const pricingUnit = service.metadata?.pricingUnit || "";
  const isHourly = pricingUnit === "per_hour";
  const isFlexibleDuration = durationMeta.min !== durationMeta.max;
  const defaultDuration = isFlexibleDuration ? durationMeta.min : (durationMeta.min || 60);
  const [selectedDuration, setSelectedDuration] = useState(defaultDuration);
  const availableDurations = DURATION_OPTIONS.filter(
    d => d.value >= durationMeta.min && d.value <= Math.max(durationMeta.max, durationMeta.min)
  );
  // If no options fit the range, show a reasonable set
  const durationChoices = availableDurations.length > 0 ? availableDurations :
    DURATION_OPTIONS.filter(d => d.value >= 30 && d.value <= 240);
  const {
    step,
    setStep,
    selectedSlot,
    setSelectedSlot,
    selectedDate,
    setSelectedDate,
    lockCountdown,
    bookingResult,
    queuePosition,
    agreedPrice,
    acquireLock,
    claimSlot,
    reset,
  } = useBookingFlow({
    serviceCategory: service.category,
    isOpen,
  });

  if (!isOpen) return null;

  // Base list price drives every customer-facing line. Demand-based dynamic
  // pricing is intentionally not applied here — the previous "₹2000 → ₹2300
  // (high demand)" treatment confused users and made the listing card price
  // disagree with the booking modal price.
  const basePrice = Number(service.price) || 0;
  // For hourly pricing, multiply by hours selected. Decimals are preserved
  // all the way through to the formatter so a 1.5h booking on a ₹399/hr
  // service shows ₹598.50 instead of being silently rounded.
  const displayPrice = isHourly ? basePrice * (selectedDuration / 60) : basePrice;
  // Once a hold is created, use the locked-in agreed price for all payment calculations
  // to prevent mismatches if dynamic pricing updates between hold and payment
  const effectivePrice = agreedPrice ?? displayPrice;
  const serviceFee = PLATFORM_FEE_RUPEES;
  // Flat trip-protection premium — same ₹2 regardless of cart size so the
  // preview always matches the backend's `insurancePremiumRupees` and the
  // Razorpay order amount.
  const insurancePremium = 2;
  const coverageAmount = Math.round(effectivePrice * 5);
  // GST 18% — applied to the taxable supply (service charge + platform fee).
  // Insurance premium is excluded; premiums in India already have GST baked
  // in via the insurer's invoice, so taxing again would double-charge.
  // Rounded to the nearest paisa, mirroring the server's applyFees (which
  // rounds in integer paise) so the displayed total equals the charge.
  const gst = Math.round((effectivePrice + serviceFee) * 0.18 * 100) / 100;
  const total = effectivePrice + serviceFee + gst + (insurance ? insurancePremium : 0);
  const priceUnitLabel = unitLabel(pricingUnit);
  const guarantee = getServiceGuarantee(service.category);

  const displayDate = selectedDate || t("svcBooking.tomorrow", { defaultValue: "Tomorrow" });
  const displayTime = selectedSlot
    ? `${formatTime(selectedSlot.start_time)} – ${formatTime(selectedSlot.end_time)}`
    : "";
  const displayProvider = selectedSlot ? selectedSlot.provider_name : service.provider.name;

  const canBook = address && !!selectedSlot;

  // Step 1: User clicks "Book Now" → acquire lock first
  const handleBook = async () => {
    if (!canBook || !selectedSlot) return;
    if (!user) { toast.error(t("svcBooking.pleaseLogIn", { defaultValue: "Please log in to book" })); return; }

    await acquireLock({
      providerId: selectedSlot.provider_id || service.providerProfileId || undefined,
      // Always associate the booking with the originating listing so the
      // dashboard can resolve the service name (e.g. "Super Cleanings")
      // instead of falling back to the raw category slug ("cleaning").
      listingId: service.id,
      scheduledDate: selectedDate || new Date(Date.now() + 86400000).toISOString().split("T")[0],
      startTime: selectedSlot.start_time,
      endTime: selectedSlot.end_time,
      // Don't send agreedPrice — backend createHold computes the official
      // total (service price + platform fee + GST) from the listing row
      // and stores it on the booking. acquireLock reads the server-stored
      // agreedPricePaise back and forwards it to the payment order, so
      // sending our base-only `displayPrice` here would trigger the
      // backend's mismatch rejection.
      address,
      lat: userCoords?.lat ?? service.lat ?? undefined,
      lng: userCoords?.lng ?? service.lng ?? undefined,
    });
  };

  const handleConfirm = async () => {
    if (!user) { toast.error(t("svcBooking.pleaseLogInService", { defaultValue: "Please log in to book a service" })); return; }
    if (!selectedSlot) return;
    const result = await claimSlot({
      amount: effectivePrice,
      insurance: insurance ? { premium: insurancePremium, coverage: coverageAmount } : undefined,
    });

    const bookingResult = result as { bookingId?: unknown; booking_id?: unknown } | null | undefined;
    if (bookingResult?.bookingId || bookingResult?.booking_id) {
      toast.success(t("svcBooking.slotSecured", { defaultValue: "Slot secured! Completing safety checks..." }));
      setStep("safety");
      setShowSafetyCheck(true);
    }
  };

  const handleSafetyComplete = () => {
    void queryClient.invalidateQueries({ queryKey: ["bookings"] });
    setShowSafetyCheck(false);
    setStep("success");
    // Booking confirmed — drop the saved address draft so the next booking
    // for this service starts clean.
    draft.clear();
  };

  const handleRetry = () => {
    reset();
  };

  const handleClose = () => {
    // Skip releasing the hold when the booking is already confirmed (success)
    // or when Razorpay accepted the payment but the captured webhook hasn't
    // landed yet (payment_pending) — releasing in either case would invalidate
    // the slot for a guest who already paid.
    const keepHold = step === "success" || step === "payment_pending";
    reset({ releaseHold: !keepHold });
    setInsurance(false);
    onClose();
  };

  const formatCountdown = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/50 backdrop-blur-sm" onClick={handleClose} />
      <div className="relative bg-card rounded-2xl border border-border shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto animate-scale-in">
        <div className="sticky top-0 bg-card border-b border-border p-4 flex items-center justify-between rounded-t-2xl z-10">
          <h3 className="font-display font-bold text-lg">
            {step === "success" ? t("svcBooking.hdrBooked", { defaultValue: "Service Booked!" }) :
             step === "payment_failed" ? t("svcBooking.hdrPaymentFailed", { defaultValue: "Payment Failed" }) :
             step === "rejected" ? t("svcBooking.hdrSlotUnavailable", { defaultValue: "Slot Unavailable" }) :
             step === "slot_lost" ? t("svcBooking.hdrSlotNoLonger", { defaultValue: "Slot No Longer Available" }) :
             step === "claiming" ? t("svcBooking.hdrSecuringSlot", { defaultValue: "Securing Slot..." }) :
             step === "locking" ? t("svcBooking.hdrReservingSlot", { defaultValue: "Reserving Slot..." }) :
             step === "confirm" ? t("svcBooking.hdrConfirmBooking", { defaultValue: "Confirm Booking" }) : t("svcBooking.hdrBookService", { defaultValue: "Book Service" })}
          </h3>
          <button onClick={handleClose} className="p-1 hover:bg-muted rounded-lg"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-6">
          {/* LOCKING — acquiring temporary lock */}
          {step === "locking" && (
            <div className="text-center py-10 space-y-4">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto animate-pulse">
                <Lock className="w-8 h-8 text-primary" />
              </div>
              <h4 className="font-display text-lg font-bold">{t("svcBooking.reservingYourSlot", { defaultValue: "Reserving your slot..." })}</h4>
              <p className="text-sm text-muted-foreground">{t("svcBooking.temporarilyLocking", { defaultValue: "Temporarily locking this time slot for you." })}</p>
              <div className="flex items-center justify-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          )}

          {/* SLOT LOST — lock expired or taken by another */}
          {step === "slot_lost" && (
            <div className="text-center py-6 space-y-4">
              <div className="w-20 h-20 rounded-full bg-warning/10 flex items-center justify-center mx-auto">
                <Lock className="w-10 h-10 text-warning" />
              </div>
              <h4 className="font-display text-xl font-bold">{t("svcBooking.slotNoLongerTitle", { defaultValue: "This slot is no longer available" })}</h4>
              <p className="text-sm text-muted-foreground">
                {t("svcBooking.slotNoLongerBody", { defaultValue: "Another user is currently booking this slot, or your reservation time has expired." })}
              </p>
              <div className="bg-muted/50 border border-border rounded-xl p-4 text-sm text-left space-y-2">
                <div className="flex items-start gap-2">
                  <Clock className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">
                    {t("svcBooking.slotLockedNote", { defaultValue: "Slots are temporarily locked for 5 minutes while a user completes payment. Try again or pick a different time." })}
                  </span>
                </div>
              </div>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1 rounded-xl" onClick={handleClose}>{t("svcBooking.cancel", { defaultValue: "Cancel" })}</Button>
                <Button className="flex-1 rounded-xl font-semibold" onClick={handleRetry}>
                  {t("svcBooking.chooseAnotherSlot", { defaultValue: "Choose Another Slot" })}
                </Button>
              </div>
            </div>
          )}

          {/* CLAIMING — loading state */}
          {step === "claiming" && (
            <div className="text-center py-10 space-y-4">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto animate-pulse">
                <Users className="w-8 h-8 text-primary" />
              </div>
              <h4 className="font-display text-lg font-bold">{t("svcBooking.securingYourSlot", { defaultValue: "Securing your slot..." })}</h4>
              <p className="text-sm text-muted-foreground">{t("svcBooking.checkingAvailability", { defaultValue: "Checking availability in real-time. This takes just a moment." })}</p>
              <div className="flex items-center justify-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          )}

          {/* REJECTED — slot taken */}
          {step === "rejected" && (
            <div className="text-center py-6 space-y-4">
              <div className="w-20 h-20 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
                <AlertTriangle className="w-10 h-10 text-destructive" />
              </div>
              <h4 className="font-display text-xl font-bold">{t("svcBooking.slotAlreadyTaken", { defaultValue: "Slot Already Taken" })}</h4>
              <p className="text-sm text-muted-foreground">
                {t("svcBooking.slotTakenBodyPre", { defaultValue: "Another user booked this slot just before you. You were" })} <strong>#{queuePosition}</strong> {t("svcBooking.slotTakenBodyPost", { defaultValue: "in the queue." })}
              </p>
              <div className="bg-destructive/5 border border-destructive/20 rounded-xl p-4 text-sm text-left space-y-2">
                <div className="flex items-start gap-2">
                  <Clock className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">
                    {t("svcBooking.queueNote", { defaultValue: "Our queue system uses millisecond-precision timestamps. The first request to reach the server wins the slot." })}
                  </span>
                </div>
                {bookingResult?.message && (
                  <p className="text-xs text-destructive font-medium">{bookingResult.message}</p>
                )}
              </div>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1 rounded-xl" onClick={handleClose}>{t("svcBooking.cancel", { defaultValue: "Cancel" })}</Button>
                <Button className="flex-1 rounded-xl font-semibold" onClick={handleRetry}>
                  {t("svcBooking.chooseAnotherSlot", { defaultValue: "Choose Another Slot" })}
                </Button>
              </div>
            </div>
          )}

          {step === "payment_failed" && (
            <div className="text-center py-6 space-y-4">
              <div className="w-20 h-20 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
                <AlertTriangle className="w-10 h-10 text-destructive" />
              </div>
              <h4 className="font-display text-xl font-bold">{t("svcBooking.paymentNotCompleted", { defaultValue: "Payment could not be completed" })}</h4>
              <p className="text-sm text-muted-foreground">
                {t("svcBooking.paymentFailedBody", { defaultValue: "Your slot hold is still active until the timer expires, so you can retry without reselecting the slot." })}
              </p>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1 rounded-xl" onClick={handleClose}>{t("svcBooking.cancel", { defaultValue: "Cancel" })}</Button>
                <Button className="flex-1 rounded-xl font-semibold" onClick={() => setStep("confirm")}>
                  {t("svcBooking.retryPayment", { defaultValue: "Retry Payment" })}
                </Button>
              </div>
            </div>
          )}

          {/* SUCCESS */}
          {step === "success" && (
            <div className="text-center py-6 space-y-4">
              <div className="w-20 h-20 rounded-full bg-success/10 flex items-center justify-center mx-auto">
                <CheckCircle className="w-10 h-10 text-success" />
              </div>
              <h4 className="font-display text-xl font-bold">{t("svcBooking.hdrBooked", { defaultValue: "Service Booked!" })}</h4>
              <p className="text-muted-foreground"><strong>{displayProvider}</strong> {t("svcBooking.willArrive", { defaultValue: "will arrive at your location." })}</p>
              <div className="bg-muted/50 rounded-xl p-4 text-sm space-y-2 text-left">
                <div className="flex justify-between"><span className="text-muted-foreground">{t("svcBooking.bookingId", { defaultValue: "Booking ID" })}</span><span className="font-mono font-medium">{displayRef(bookingResult?.booking_id || bookingResult?.bookingId) || `SV-${Date.now().toString().slice(-6)}`}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("svcBooking.service", { defaultValue: "Service" })}</span><span className="font-medium">{service.title}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("svcBooking.provider", { defaultValue: "Provider" })}</span><span className="font-medium">{displayProvider}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("svcBooking.date", { defaultValue: "Date" })}</span><span className="font-medium">{displayDate}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("svcBooking.time", { defaultValue: "Time" })}</span><span className="font-medium">{displayTime}</span></div>
                {bookingResult?.queue_position && (
                  <div className="flex justify-between text-primary"><span className="flex items-center gap-1"><Users className="w-3 h-3" /> {t("svcBooking.queuePosition", { defaultValue: "Queue Position" })}</span><span className="font-medium">{t("svcBooking.queuePositionValue", { defaultValue: "#{{pos}} (First!)", pos: bookingResult.queue_position })}</span></div>
                )}
                {selectedSlot?.is_zone_optimized && (
                  <div className="flex justify-between text-success"><span className="flex items-center gap-1"><Zap className="w-3 h-3" /> {t("svcBooking.zoneOptimized", { defaultValue: "Zone-optimized" })}</span><span className="font-medium">{t("svcBooking.yes", { defaultValue: "Yes" })}</span></div>
                )}
                {insurance && (
                  <div className="flex justify-between text-primary"><span>🛡️ {t("svcBooking.protection", { defaultValue: "Protection" })}</span><span className="font-medium">{t("svcBooking.active", { defaultValue: "Active" })}</span></div>
                )}
                <div className="flex justify-between font-bold pt-2 border-t border-border"><span>{t("svcBooking.total", { defaultValue: "Total" })}</span><span>₹{formatRupees(total)}</span></div>
              </div>
              <div className="flex items-center gap-2 justify-center text-xs text-success"><Shield className="w-3.5 h-3.5" />{t("svcBooking.fullRefund", { defaultValue: "Full refund on cancellation" })}</div>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1 rounded-xl h-11 font-semibold" onClick={() => { handleClose(); navigate("/messages"); }}>
                  <MessageCircle className="w-4 h-4 mr-2" />{t("svcBooking.messageProvider", { defaultValue: "Message Provider" })}
                </Button>
                <Button onClick={handleClose} className="flex-1 rounded-xl h-11 font-semibold">{t("svcBooking.done", { defaultValue: "Done" })}</Button>
              </div>
            </div>
          )}

          {/* CONFIRM */}
          {step === "confirm" && (
            <div className="space-y-5">
              <div className="p-4 bg-muted/50 rounded-xl">
                <h4 className="font-semibold text-sm">{service.title}</h4>
                <p className="text-xs text-muted-foreground">{displayProvider} • {service.duration}</p>
                {selectedSlot?.is_zone_optimized && (
                  <p className="text-[10px] text-success font-medium mt-1 flex items-center gap-1"><Zap className="w-3 h-3" /> {t("svcBooking.zoneOptimizedFaster", { defaultValue: "Zone-optimized — faster arrival" })}</p>
                )}
              </div>

              {/* Lock countdown timer */}
              {lockCountdown > 0 && (
                <div className={`flex items-center justify-between p-3 rounded-xl border text-xs font-medium ${
                  lockCountdown <= 60 ? "bg-destructive/5 border-destructive/20 text-destructive" : "bg-primary/5 border-primary/20 text-primary"
                }`}>
                  <div className="flex items-center gap-2">
                    <Lock className="w-4 h-4 shrink-0" />
                    <span>{t("svcBooking.slotReservedForYou", { defaultValue: "Slot reserved for you" })}</span>
                  </div>
                  <span className="font-mono font-bold text-sm">{formatCountdown(lockCountdown)}</span>
                </div>
              )}

              {/* Queue notice */}
              <div className="flex items-start gap-2 p-3 bg-muted/50 border border-border rounded-xl text-xs text-muted-foreground">
                <Shield className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{t("svcBooking.slotLockedWhilePaying", { defaultValue: "This slot is temporarily locked while you complete payment. No one else can book it." })}</span>
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">{t("svcBooking.serviceCharge", { defaultValue: "Service charge" })}</span><span>₹{formatRupees(effectivePrice)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("svcBooking.platformFee", { defaultValue: "Platform fee" })}</span><span>₹{formatRupees(serviceFee)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("svcBooking.gst", { defaultValue: "GST (18%)" })}</span><span>₹{formatRupees(gst)}</span></div>
                {insurance && (
                  <div className="flex justify-between text-primary"><span>🛡️ {t("svcBooking.protection", { defaultValue: "Protection" })}</span><span>₹{formatRupees(insurancePremium)}</span></div>
                )}
                <div className="flex justify-between font-bold text-base pt-3 border-t border-border"><span>{t("svcBooking.total", { defaultValue: "Total" })}</span><span>₹{formatRupees(total)}</span></div>
              </div>
              <div className="text-sm space-y-1">
                <div className="flex items-center gap-2"><Calendar className="w-3.5 h-3.5 text-muted-foreground" />{displayDate}</div>
                <div className="flex items-center gap-2"><Clock className="w-3.5 h-3.5 text-muted-foreground" />{displayTime}</div>
                <div className="flex items-center gap-2"><MapPin className="w-3.5 h-3.5 text-muted-foreground" />{address}</div>
                {selectedSlot && (
                  <div className="flex items-center gap-2 text-muted-foreground text-xs">
                    {t("svcBooking.estTravel", { defaultValue: "Est. travel: ~{{min}} min ({{km}} km)", min: selectedSlot.estimated_travel_minutes, km: selectedSlot.distance_km })}
                  </div>
                )}
              </div>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1 rounded-xl" onClick={() => setStep("details")}>{t("svcBooking.back", { defaultValue: "Back" })}</Button>
                <Button className="flex-1 rounded-xl font-semibold" onClick={handleConfirm}>
                  {user ? t("svcBooking.confirmAndPay", { defaultValue: "Confirm & Pay" }) : t("svcBooking.loginToBook", { defaultValue: "Login to Book" })}
                </Button>
              </div>
            </div>
          )}

          {/* DETAILS */}
          {step === "details" && (
            <div className="space-y-5">
              <div className="p-4 bg-muted/50 rounded-xl">
                <h4 className="font-semibold text-sm">{service.title}</h4>
                <p className="text-xs text-muted-foreground">{service.provider.name} • ⭐ {service.rating} {t("svcBooking.reviewsCount", { defaultValue: "({{count}} reviews)", count: service.reviews })}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-sm font-bold">₹{formatRupees(basePrice)}<span className="text-xs font-normal text-muted-foreground">{priceUnitLabel || t("svcBooking.onwards", { defaultValue: " onwards" })}</span></span>
                </div>
              </div>

              {/* Service Guarantee Badge */}
              {guarantee && (
                <div className="flex items-start gap-3 p-3 bg-success/5 border border-success/20 rounded-xl">
                  <Shield className="w-5 h-5 text-success shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-success">{guarantee.label}</p>
                    <p className="text-xs text-muted-foreground">{guarantee.description}</p>
                  </div>
                </div>
              )}

              <div>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><MapPin className="w-3 h-3" />{t("svcBooking.yourAddress", { defaultValue: "Your Address" })}</label>
                  <button
                    type="button"
                    onClick={handleUseMyLocation}
                    disabled={locating}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-bold text-foreground hover:bg-muted disabled:cursor-wait disabled:opacity-60"
                  >
                    {locating ? (
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground" aria-hidden />
                    ) : (
                      <Crosshair className="w-3 h-3" />
                    )}
                    {locating ? t("svcBooking.locating", { defaultValue: "Locating…" }) : t("svcBooking.useMyLocation", { defaultValue: "Use my current location" })}
                  </button>
                </div>
                <AddressAutocompleteInput
                  value={address}
                  onChange={setAddress}
                  mode="address"
                  placeholder={t("svcBooking.addressPlaceholder", { defaultValue: "Enter your full address..." })}
                  wrapperClassName="relative"
                  className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background focus:ring-2 focus:ring-primary/20 outline-none"
                />
              </div>

              {/* Duration selector for flexible/hourly services */}
              {(isFlexibleDuration || isHourly) && (
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1.5 flex items-center gap-1">
                    <Clock className="w-3 h-3" />{t("svcBooking.duration", { defaultValue: "Duration" })}
                    {isHourly && <span className="text-[10px] text-primary ml-1">(₹{formatRupees(basePrice)}{priceUnitLabel})</span>}
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {durationChoices.map(opt => (
                      <button key={opt.value} onClick={() => { setSelectedDuration(opt.value); setSelectedSlot(null); }}
                        className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${
                          selectedDuration === opt.value
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-card border-border text-muted-foreground hover:border-primary/50"
                        }`}>
                        {durationLabel(opt.value, opt.label)}
                        {isHourly && <span className="ml-1 opacity-70">₹{formatRupees(basePrice * (opt.value / 60))}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <SmartSchedulePicker
                serviceCategory={service.category}
                lat={userCoords?.lat ?? service.lat}
                lng={userCoords?.lng ?? service.lng}
                durationMinutes={selectedDuration}
                onSlotSelect={(slot, date) => { setSelectedSlot(slot); setSelectedDate(date); }}
                selectedSlot={selectedSlot}
              />

              <InsuranceToggle enabled={insurance} onToggle={setInsurance} premium={insurancePremium} label={t("svcBooking.protectThisService", { defaultValue: "Protect this service (₹{{coverage}} coverage)", coverage: coverageAmount })} />
              <div className="space-y-2 text-sm border-t border-border pt-4">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {t("svcBooking.serviceCharge", { defaultValue: "Service charge" })}
                    {isHourly && <span className="text-[10px] ml-1">{t("svcBooking.hourlyBreakdown", { defaultValue: "(₹{{rate}}/hr × {{hours}}hr{{plural}})", rate: formatRupees(basePrice), hours: selectedDuration / 60, plural: selectedDuration > 60 ? "s" : "" })}</span>}
                  </span>
                  <span>₹{formatRupees(displayPrice)}</span>
                </div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("svcBooking.platformFee", { defaultValue: "Platform fee" })}</span><span>₹{formatRupees(serviceFee)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("svcBooking.gst", { defaultValue: "GST (18%)" })}</span><span>₹{formatRupees(gst)}</span></div>
                {insurance && (
                  <div className="flex justify-between text-primary"><span>🛡️ {t("svcBooking.protectionWithCover", { defaultValue: "Protection (₹{{cover}} cover)", cover: formatRupees(coverageAmount) })}</span><span>₹{formatRupees(insurancePremium)}</span></div>
                )}
                {guarantee && (
                  <div className="flex justify-between text-success"><span>✅ {guarantee.label}</span><span>{t("svcBooking.included", { defaultValue: "Included" })}</span></div>
                )}
                <div className="flex justify-between font-bold pt-2 border-t border-border"><span>{t("svcBooking.total", { defaultValue: "Total" })}</span><span>₹{formatRupees(total)}</span></div>
              </div>
              <Button className="w-full h-12 rounded-xl text-base font-semibold" onClick={handleBook} disabled={!canBook}>
                {!address ? t("svcBooking.enterAddressToContinue", { defaultValue: "Enter address to continue" }) : !selectedSlot ? t("svcBooking.selectTimeSlot", { defaultValue: "Select a time slot" }) : t("svcBooking.bookNow", { defaultValue: "Book Now" })}
              </Button>
              <p className="text-center text-xs text-muted-foreground">{t("svcBooking.fullRefund", { defaultValue: "Full refund on cancellation" })}</p>
            </div>
          )}
        </div>
      </div>

      {/* Safety Check Modal */}
      <SafetyCheckModal
        isOpen={showSafetyCheck}
        onClose={() => { setShowSafetyCheck(false); setStep("success"); }}
        onComplete={handleSafetyComplete}
        serviceCategory={service.category}
        isProvider={false}
      />
    </div>
  );
};

export default ServiceBookingModal;
