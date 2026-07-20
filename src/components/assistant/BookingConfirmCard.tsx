/**
 * BookingConfirmCard — inline "Confirm & Pay" card rendered in the Ista AI
 * assistant sheet after the agent emits a prepare_booking action.
 *
 * The card shows the listing, the scheduled window, the room (for hotels),
 * trip-protection state if opted in, and the authoritative price the server
 * locked in during hold creation. "Confirm & Pay" opens Razorpay checkout
 * directly; on success we surface the booking and the user is done.
 */
import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, Clock, Shield, BedDouble } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { launchRazorpayCheckout } from "@/lib/razorpay-checkout";
import { useLanguage } from "@/contexts/LanguageContext";
import { getPaymentService } from "@/domains";
import type { PrepareBookingResult } from "@/domains/chat/user-assistant.service";

export type BookingCardState = "ready" | "paying" | "pending" | "success" | "failed" | "expired";

interface Props {
  booking: PrepareBookingResult;
  userEmail?: string;
  userPhone?: string;
  userName?: string;
  onSuccess: (paymentId?: string) => void;
  onFailure: (msg: string) => void;
}

// Paise-exact: amounts with paise render to the hundredth ("₹108.15", never
// "₹108"); whole amounts stay clean ("₹3"). Money must never be truncated.
function fmtAmount(rupees: number, currency: string) {
  const sym = currency === "USD" ? "$" : "₹";
  const hasPaise = Math.round(Math.abs(rupees) * 100) % 100 !== 0;
  return `${sym}${rupees.toLocaleString("en-IN", {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

function fmtDate(iso: string) {
  // iso is YYYY-MM-DD; render as "Sat, Nov 22"
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

function transportModeLabel(mode: NonNullable<PrepareBookingResult["transport"]>["mode"] | undefined) {
  switch (mode) {
    case "hourly": return "Hourly rental";
    case "day": return "Day rental";
    case "package": return "Package";
    default: return "Transport";
  }
}

export function BookingConfirmCard({ booking, userEmail, userPhone, userName, onSuccess, onFailure }: Props) {
  const { t } = useLanguage();
  const [state, setState] = useState<BookingCardState>("ready");
  const [secondsLeft, setSecondsLeft] = useState<number>(() => {
    const expires = new Date(booking.holdExpiresAt).getTime();
    return Math.max(0, Math.floor((expires - Date.now()) / 1000));
  });

  // Countdown timer. If it hits zero before payment, the hold is gone —
  // disable the button and tell the user to ask again. We don't try to
  // silently re-create the hold; that would surprise the user.
  useEffect(() => {
    if (state !== "ready" && state !== "paying") return;
    const tick = () => {
      const expires = new Date(booking.holdExpiresAt).getTime();
      const s = Math.max(0, Math.floor((expires - Date.now()) / 1000));
      setSecondsLeft(s);
      if (s <= 0 && state === "ready") setState("expired");
    };
    const id = setInterval(tick, 1000);
    tick();
    return () => clearInterval(id);
  }, [booking.holdExpiresAt, state]);

  const handleConfirm = async () => {
    setState("paying");
    try {
      await launchRazorpayCheckout({
        keyId: booking.keyId,
        orderId: booking.orderId,
        amountPaise: booking.amountPaise,
        currency: booking.currency,
        bookingId: booking.bookingId,
        description: `${booking.listing.name} — ${fmtDate(booking.schedule.scheduledDate)}`,
        prefill: { email: userEmail, contact: userPhone, name: userName },
        analytics: { listingId: booking.listing.id },
        onSuccess: async (resp) => {
          // Verify signature on the server; the backend transitions the
          // booking to 'confirmed' inside that call.
          const verify = await getPaymentService().verifyPayment({
            bookingId: booking.bookingId,
            razorpay_order_id: resp.razorpay_order_id,
            razorpay_payment_id: resp.razorpay_payment_id,
            razorpay_signature: resp.razorpay_signature,
          });
          if (!verify.success) {
            setState("failed");
            onFailure(verify.error || "Payment verification failed");
            return;
          }
          if (verify.data?.pending) {
            // Razorpay accepted the payment but capture isn't confirmed yet —
            // don't fire onSuccess (which would mark the booking confirmed).
            setState("pending");
            return;
          }
          setState("success");
          onSuccess(verify.data?.paymentId);
        },
        onDismiss: () => {
          // User closed modal without paying. Leave hold active until it expires.
          if (state !== "success") setState("ready");
        },
        onFailure: () => {
          setState("failed");
          onFailure("Payment failed. Try again or pick another listing.");
        },
      });
    } catch (err) {
      setState("failed");
      onFailure(err instanceof Error ? err.message : "Unable to open checkout");
    }
  };

  const mmss = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;
  const disabled = state === "paying" || state === "pending" || state === "success" || state === "expired";

  return (
    <div className="mt-2 rounded-xl border bg-background p-3 text-sm shadow-sm">
      <div className="flex gap-3">
        {booking.listing.image && (
          <img
            src={booking.listing.image}
            alt=""
            className="h-16 w-16 rounded-lg object-cover flex-shrink-0"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{booking.listing.name}</div>
          {booking.listing.location && (
            <div className="text-xs text-muted-foreground truncate">{booking.listing.location}</div>
          )}
          {booking.room?.name && (
            <div className="text-xs text-foreground/80 mt-0.5 flex items-center gap-1 truncate">
              <BedDouble className="h-3 w-3 text-primary/70 flex-shrink-0" />
              <span className="truncate">{booking.room.name}</span>
            </div>
          )}
          {/* Stays: prefer the check-in → check-out + nights line so the user
              sees the same window they confirmed in chat. Falls back to the
              service/transport date+time window when checkOutDate isn't set. */}
          {booking.transport?.mode === "day" ? (
            <div className="text-xs text-muted-foreground mt-1">
              {fmtDate(booking.schedule.scheduledDate)} · Day rental
              {booking.transport.days && booking.transport.days > 1 ? ` · ${booking.transport.days} days` : ""}
            </div>
          ) : booking.schedule.checkOutDate ? (
            <div className="text-xs text-muted-foreground mt-1">
              {fmtDate(booking.schedule.scheduledDate)} → {fmtDate(booking.schedule.checkOutDate)}
              {booking.schedule.nights ? (
                <span className="ml-1.5 text-[10px] font-semibold text-primary bg-primary/5 px-1.5 py-0.5 rounded-full">
                  {booking.schedule.nights} night{booking.schedule.nights === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground mt-1">
              {fmtDate(booking.schedule.scheduledDate)} · {booking.schedule.startTime}–{booking.schedule.endTime}
            </div>
          )}
          {booking.transport && (
            <div className="text-xs text-muted-foreground mt-1">
              {transportModeLabel(booking.transport.mode)}
              {booking.transport.mode === "hourly" && booking.transport.hours ? ` · ${booking.transport.hours} hr` : ""}
              {booking.transport.passengerCount ? ` · ${booking.transport.passengerCount} pax` : ""}
            </div>
          )}
          {booking.insurance?.included && (
            <div className="text-xs text-primary mt-1 flex items-center gap-1">
              <Shield className="h-3 w-3 flex-shrink-0" />
              Protection included
              {booking.insurance.amount > 0 && (
                <span className="text-muted-foreground">· ₹{booking.insurance.amount}</span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between border-t pt-2">
        <div>
          <div className="text-xs text-muted-foreground">{t("bookingCard.total")}</div>
          <div className="text-lg font-semibold">{fmtAmount(booking.amount, booking.currency)}</div>
        </div>
        {(state === "ready" || state === "paying") && (
          <div className={cn(
            "flex items-center gap-1 text-xs",
            secondsLeft < 60 ? "text-red-600" : "text-muted-foreground",
          )}>
            <Clock className="h-3 w-3" /> {t("bookingCard.hold")} {mmss}
          </div>
        )}
      </div>

      <Button
        onClick={handleConfirm}
        disabled={disabled}
        className="mt-3 w-full"
        size="sm"
      >
        {state === "paying" && <><Loader2 className="h-4 w-4 animate-spin mr-1" /> {t("bookingCard.opening")}</>}
        {state === "pending" && <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Processing payment…</>}
        {state === "ready" && <>{t("bookingCard.confirmPay", { amount: fmtAmount(booking.amount, booking.currency) })}</>}
        {state === "success" && <><CheckCircle2 className="h-4 w-4 mr-1" /> {t("bookingCard.booked")}</>}
        {state === "expired" && <>{t("bookingCard.expired")}</>}
        {state === "failed" && <>{t("bookingCard.failed")}</>}
      </Button>

      {state === "pending" && (
        <p className="mt-2 text-xs text-muted-foreground text-center">
          Payment is processing; we’ll confirm once Razorpay capture completes.
        </p>
      )}

      {state === "failed" && (
        <Button onClick={handleConfirm} variant="outline" size="sm" className="mt-1.5 w-full">
          {t("bookingCard.retry")}
        </Button>
      )}
    </div>
  );
}
