import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Check, Copy, Loader2, MessageCircle, QrCode } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { getBookingService, getListingService } from "@/domains";
import type { OnBehalfBookingResult } from "@/domains/bookings/booking.service";
import { mapListingRowToMarketplaceStay } from "@/lib/marketplace-adapters";
import { computeStayBreakdownPaise, foldAvailabilityOverrides } from "@/lib/stay-pricing";
import { useFeeSpec } from "@/hooks/use-fee-spec";
import { getCouponsService, type CouponQuote } from "@/domains/coupons/coupons.service";
import { useLanguage } from "@/contexts/LanguageContext";
import type { MarketplaceStay } from "@/types/marketplace";
import type { Listing } from "@/types/domain";
import { DateRangeCalendar } from "./MarketplaceControls";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_STAY_CHECK_IN_TIME = "14:00";
const DEFAULT_STAY_CHECK_OUT_TIME = "11:00";

type AvailabilityRow = { roomTypeId: string | null; date: string; blocked: boolean; pricePaise: number | null };

function isoTomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Server errors worth showing verbatim are human sentences (slot conflicts,
 *  validation). Anything that smells like a database/internal failure gets
 *  replaced with a generic message so the host never sees raw SQL errors
 *  like `invalid input syntax for type uuid`. Shared with the provider
 *  (services) on-behalf modal. */
export function friendlyError(raw: string | undefined | null, fallback = "Could not create the booking. Please check the details and try again."): string {
  const msg = (raw ?? "").trim();
  if (!msg) return fallback;
  if (/invalid input syntax|syntax error|column|constraint|violates|uuid|sql|internal server error|unexpected/i.test(msg)) {
    return fallback;
  }
  return msg;
}

function nightsBetween(checkIn: string | null, checkOut: string | null): number {
  if (!checkIn || !checkOut) return 0;
  const ms = new Date(`${checkOut}T00:00:00Z`).getTime() - new Date(`${checkIn}T00:00:00Z`).getTime();
  const n = Math.round(ms / 86400000);
  return n > 0 ? n : 0;
}

/**
 * Host-books-on-behalf modal (stays). A host picks one of their stay listings,
 * a room / dates / guests, and a walk-up guest's contact, then creates a
 * booking the guest pays via a Razorpay Payment Link (QR + SMS). The server is
 * authoritative on price — we render the amount it returns, not a client
 * estimate — so there's no drift to reconcile.
 */
export function HostOnBehalfBookingModal({
  open,
  onOpenChange,
  stayListings,
  onCreated,
  asAdmin = false,
  initialListingId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The host's own stay listings (raw domain Listing rows). */
  stayListings: Listing[];
  /** Called after a booking+link is created so the dashboard can refetch. */
  onCreated?: () => void;
  /** Ops console: hit the admin endpoint (any listing, action audited). */
  asAdmin?: boolean;
  /** Preselect a property (e.g. the ops console picked it in a prior step). */
  initialListingId?: string;
}) {
  const { t } = useLanguage();
  const [listingId, setListingId] = useState<string>("");
  const [stay, setStay] = useState<MarketplaceStay | null>(null);
  // Server-resolved platform-fee spec (admin fee rules); legacy ₹3 fallback.
  const feeSpec = useFeeSpec(listingId || null);
  const [loadingStay, setLoadingStay] = useState(false);
  const [roomId, setRoomId] = useState<string>("");
  const [checkIn, setCheckIn] = useState<string | null>(null);
  const [checkOut, setCheckOut] = useState<string | null>(null);
  const [guests, setGuests] = useState(1);
  const [rooms, setRooms] = useState(1);
  const [guestName, setGuestName] = useState("");
  const [guestPhoneCode, setGuestPhoneCode] = useState("+91");
  const [guestPhone, setGuestPhone] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<OnBehalfBookingResult | null>(null);
  const [couponInput, setCouponInput] = useState("");
  const [couponQuote, setCouponQuote] = useState<CouponQuote | null>(null);
  const [couponMsg, setCouponMsg] = useState("");
  const [couponBusy, setCouponBusy] = useState(false);
  const [bookedDates, setBookedDates] = useState<Set<string>>(() => new Set());
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);

  // Jump straight to the picked property when the opener already chose one
  // (admin ops console listing picker) — skips the manual Select step.
  useEffect(() => {
    if (open && initialListingId) setListingId(initialListingId);
  }, [open, initialListingId]);

  // Reset everything when the dialog closes.
  useEffect(() => {
    if (!open) {
      setListingId("");
      setStay(null);
      setRoomId("");
      setCheckIn(null);
      setCheckOut(null);
      setGuests(1);
      setRooms(1);
      setGuestName("");
      setGuestPhoneCode("+91");
      setGuestPhone("");
      setGuestEmail("");
      setResult(null);
      setSubmitting(false);
      setCouponInput("");
      setCouponQuote(null);
      setCouponMsg("");
      setBookedDates(new Set());
      setAvailability([]);
    }
  }, [open]);

  // Fetch the full listing (with room types) when a listing is selected.
  useEffect(() => {
    if (!listingId) {
      setStay(null);
      return;
    }
    let cancelled = false;
    setLoadingStay(true);
    (async () => {
      const res = await apiRequest<{ data: Parameters<typeof mapListingRowToMarketplaceStay>[0] }>(
        `/api/listings/${listingId}`,
        { headers: getJsonHeaders(false) },
      );
      if (cancelled) return;
      if (res.success && res.data?.data) {
        const mapped = mapListingRowToMarketplaceStay(res.data.data);
        setStay(mapped);
        setRoomId(mapped.roomTypes?.[0]?.id ?? "");
      } else {
        setStay(null);
        toast.error(res.error || t("rd.onbehalf.errLoadListing", { defaultValue: "Could not load that listing." }));
      }
      setLoadingStay(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [listingId]);

  const selectedRoom = useMemo(
    () => stay?.roomTypes?.find((r) => r.id === roomId) ?? null,
    [stay, roomId],
  );
  const selectedRoomIsUuid = selectedRoom ? UUID_REGEX.test(selectedRoom.id) : false;
  const nights = nightsBetween(checkIn, checkOut);

  // Booked nights (real conflicts — hard-disabled) for the selected room.
  useEffect(() => {
    if (!stay) {
      setBookedDates(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      const res = await getListingService().getBookedDates(
        stay.id,
        selectedRoomIsUuid ? selectedRoom!.id : undefined,
      );
      if (cancelled) return;
      setBookedDates(res.success && res.data ? new Set(res.data) : new Set());
    })();
    return () => {
      cancelled = true;
    };
  }, [stay, selectedRoomIsUuid, selectedRoom?.id]);

  // Host availability overrides → blocked nights (shown, but the host can book
  // over them, so they're passed as bypassable to the calendar).
  useEffect(() => {
    if (!stay) {
      setAvailability([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const today = new Date();
      const to = new Date(today.getTime() + 365 * 86400000);
      const res = await getListingService().getAvailability(stay.id, {
        from: today.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
      });
      if (cancelled) return;
      setAvailability(res.success && res.data ? res.data : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [stay?.id]);

  const { blockedSet, priceByDate } = useMemo(
    () => foldAvailabilityOverrides(availability, selectedRoomIsUuid ? selectedRoom!.id : null),
    [availability, selectedRoomIsUuid, selectedRoom?.id],
  );

  // Same preview math as the customer stay modal (computeStayBreakdownPaise
  // mirrors the server's subtotal + applyFees byte-for-byte), so the total
  // shown here equals the payment-link amount the guest is charged.
  const breakdown = useMemo(() => {
    if (!stay || nights <= 0 || !checkIn) return null;
    return computeStayBreakdownPaise({
      nightlyRateRupees: selectedRoom?.price ?? stay.price,
      nights,
      hostDiscountPercent: stay.discountPercent ?? 0,
      couponRupeesOff: couponQuote ? Math.max(0, couponQuote.discountAmount) : 0,
      checkIn,
      nightlyPaiseByDate: priceByDate,
      roomCount: rooms,
      feeSpec,
    });
  }, [stay, nights, checkIn, selectedRoom?.price, couponQuote, priceByDate, rooms, feeSpec]);

  async function applyCoupon() {
    const code = couponInput.trim();
    if (!code || !stay || !breakdown) return;
    setCouponBusy(true);
    setCouponMsg("");
    try {
      const res = await getCouponsService().validate({
        code,
        listingId: stay.id,
        basePrice: breakdown.subtotalPaise / 100,
      });
      if (res.success && res.data) {
        setCouponQuote(res.data);
      } else {
        setCouponQuote(null);
        setCouponMsg(res.error || t("rd.onbehalf.couponInvalid", { defaultValue: "That coupon can't be applied here." }));
      }
    } finally {
      setCouponBusy(false);
    }
  }

  const emailValid = EMAIL_REGEX.test(guestEmail.trim());
  const canSubmit =
    !!stay &&
    !!checkIn &&
    !!checkOut &&
    nights > 0 &&
    guestName.trim().length > 0 &&
    guestPhone.trim().length >= 6 &&
    emailValid &&
    !submitting;

  async function handleSubmit() {
    if (!stay || !checkIn || !checkOut) return;
    setSubmitting(true);
    try {
      // Prefix the selected country code; if the host typed a full "+…" number
      // themselves, respect it instead of double-prefixing.
      const typedPhone = guestPhone.trim();
      const fullPhone = typedPhone.startsWith("+")
        ? typedPhone
        : `${guestPhoneCode}${typedPhone.replace(/\D/g, "")}`;
      const lowerType = String(stay.type || "stay").toLowerCase();
      const serviceCategory = lowerType.startsWith("stay") ? lowerType : `stay:${lowerType}`;

      const res = await getBookingService().prepareOnBehalf(
        {
          listingType: "stay",
          listingId: stay.id,
          serviceCategory,
          scheduledDate: checkIn,
          checkOutDate: checkOut,
          startTime: stay.checkInTime || DEFAULT_STAY_CHECK_IN_TIME,
          endTime: stay.checkOutTime || DEFAULT_STAY_CHECK_OUT_TIME,
          roomTypeId: selectedRoomIsUuid ? selectedRoom!.id : undefined,
          roomName: selectedRoom?.name,
          numberOfRooms: rooms > 1 ? rooms : undefined,
          guestCount: guests,
          couponCode: couponQuote?.code,
          guestName: guestName.trim(),
          contact: { name: guestName.trim(), phone: fullPhone },
          listingTitle: stay.title,
          listingName: stay.title,
          listingImage: stay.image,
          listingLocation: stay.location,
        },
        {
          name: guestName.trim(),
          phone: fullPhone,
          email: guestEmail.trim(),
        },
        { admin: asAdmin },
      );

      if (!res.success || !res.data) {
        toast.error(friendlyError(res.error, t("rd.onbehalf.errGeneric", { defaultValue: "Could not create the booking. Please check the details and try again." })));
        return;
      }
      setResult(res.data);
      onCreated?.();
      toast.success(t("rd.onbehalf.createdToastGuest", { defaultValue: "Payment link created — an SMS was sent to the guest." }));
    } catch (err) {
      // prepareOnBehalf normally returns a ServiceResult, but a network drop
      // or JSON parse failure can still throw — never leave the host with a
      // silent dead button.
      toast.error(friendlyError(err instanceof Error ? err.message : null, t("rd.onbehalf.errGeneric", { defaultValue: "Could not create the booking. Please check the details and try again." })));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        {result ? (
          <OnBehalfSuccessView result={result} onBookAnother={() => setResult(null)} />
        ) : (
          // ─── Form ───
          <>
            <DialogHeader>
              <DialogTitle>{t("rd.onbehalf.titleGuest", { defaultValue: "Book for a guest" })}</DialogTitle>
              <DialogDescription>{t("rd.onbehalf.subGuest", { defaultValue: "Create a booking on a guest's behalf. They'll get a QR / link to pay — no account needed." })}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-1">
              {/* Listing */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t("rd.onbehalf.property", { defaultValue: "Property" })}</label>
                <Select value={listingId} onValueChange={setListingId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("rd.onbehalf.selectProperty", { defaultValue: "Select a property…" })} />
                  </SelectTrigger>
                  <SelectContent>
                    {stayListings.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {loadingStay && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> {t("rd.onbehalf.loadingProperty", { defaultValue: "Loading property…" })}
                </div>
              )}

              {stay && (
                <>
                  {/* Room type */}
                  {stay.roomTypes && stay.roomTypes.length > 0 && (
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">{t("rd.onbehalf.roomType", { defaultValue: "Room type" })}</label>
                      <Select value={roomId} onValueChange={setRoomId}>
                        <SelectTrigger>
                          <SelectValue placeholder={t("rd.onbehalf.selectRoomType", { defaultValue: "Select a room type…" })} />
                        </SelectTrigger>
                        <SelectContent>
                          {stay.roomTypes.map((r) => (
                            <SelectItem key={r.id} value={r.id}>
                              {r.name} · ₹{r.price.toLocaleString("en-IN")}/night
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* Dates */}
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">{t("rd.onbehalf.dates", { defaultValue: "Dates" })}</label>
                    <DateRangeCalendar
                      start={checkIn}
                      end={checkOut}
                      onChange={({ start, end }) => {
                        setCheckIn(start);
                        setCheckOut(end);
                      }}
                      minDate={isoTomorrow()}
                      monthsVisible={1}
                      compact
                      disabledDates={bookedDates}
                      blockedDates={blockedSet}
                      allowBlocked
                      onInvalidRange={() =>
                        toast.error(t("rd.onbehalf.rangeBooked", { defaultValue: "Your selection crosses a booked night. Pick different dates." }))
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      {nights > 0 ? `${t("rd.onbehalf.nightsCount", { defaultValue: "{{n}} night{{plural}}", n: nights, plural: nights === 1 ? "" : "s" })} · ` : ""}
                      {t("rd.onbehalf.calNote", { defaultValue: "Struck-through dates are blocked, but you can book over your own blocks." })}
                    </p>
                  </div>

                  {/* Guests + rooms */}
                  <div className="grid grid-cols-2 gap-3">
                    <Stepper label={t("rd.onbehalf.guests", { defaultValue: "Guests" })} value={guests} min={1} max={stay.guests || 20} onChange={setGuests} />
                    <Stepper
                      label={t("rd.onbehalf.rooms", { defaultValue: "Rooms" })}
                      value={rooms}
                      min={1}
                      max={Math.max(1, selectedRoom?.quantity ?? 1)}
                      onChange={setRooms}
                    />
                  </div>

                  {/* Coupon */}
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">{t("rd.onbehalf.couponCode", { defaultValue: "Coupon code" })}</label>
                    {couponQuote ? (
                      <div className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm">
                        <span className="font-medium text-emerald-800">
                          {t("rd.onbehalf.couponOff", { defaultValue: "{{code}} · ₹{{amount}} off", code: couponQuote.code, amount: couponQuote.discountAmount.toLocaleString("en-IN") })}
                        </span>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-emerald-800" onClick={() => { setCouponQuote(null); setCouponInput(""); }}>
                          {t("rd.onbehalf.remove", { defaultValue: "Remove" })}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <Input
                          placeholder={t("rd.onbehalf.couponOptional", { defaultValue: "Optional" })}
                          value={couponInput}
                          onChange={(e) => { setCouponInput(e.target.value.toUpperCase()); setCouponMsg(""); }}
                        />
                        <Button variant="outline" className="shrink-0" disabled={!couponInput.trim() || !breakdown || couponBusy} onClick={applyCoupon}>
                          {couponBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("rd.onbehalf.apply", { defaultValue: "Apply" })}
                        </Button>
                      </div>
                    )}
                    {couponMsg && <p className="text-xs text-rose-500">{couponMsg}</p>}
                  </div>

                  {/* Price breakdown — same math as the customer modal, so this
                      total equals the payment-link amount. */}
                  {breakdown && (
                    <div className="space-y-1 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">
                          {t("rd.onbehalf.lineNights", { defaultValue: "₹{{rate}} × {{n}} night{{plural}}{{rooms}}", rate: Math.round(breakdown.subtotalPaise / nights / rooms / 100).toLocaleString("en-IN"), n: nights, plural: nights === 1 ? "" : "s", rooms: rooms > 1 ? ` × ${rooms} ${t("rd.onbehalf.roomsWord", { defaultValue: "rooms" })}` : "" })}
                        </span>
                        <span>₹{(breakdown.subtotalPaise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                      </div>
                      {breakdown.discountPaise > 0 && (
                        <div className="flex justify-between text-emerald-700">
                          <span>{t("rd.onbehalf.couponRow", { defaultValue: "Coupon" })}{couponQuote ? ` (${couponQuote.code})` : ""}</span>
                          <span>−₹{(breakdown.discountPaise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t("rd.onbehalf.platformFee", { defaultValue: "Platform fee" })}</span>
                        <span>₹{(breakdown.platformFeePaise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t("rd.onbehalf.gst", { defaultValue: "GST ({{rate}}%)", rate: Math.round(breakdown.gstRate * 100) })}</span>
                        <span>₹{(breakdown.taxesPaise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                      </div>
                      <div className="flex justify-between border-t pt-1 font-semibold">
                        <span>{t("rd.onbehalf.totalGuest", { defaultValue: "Total the guest pays" })}</span>
                        <span>₹{(breakdown.totalPaise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                      </div>
                    </div>
                  )}

                  {/* Guest contact — all required */}
                  <div className="space-y-2 border-t pt-3">
                    <label className="text-sm font-medium">{t("rd.onbehalf.guestDetails", { defaultValue: "Guest details" })}</label>
                    <Input
                      placeholder={t("rd.onbehalf.guestName", { defaultValue: "Guest name" })}
                      value={guestName}
                      onChange={(e) => setGuestName(e.target.value)}
                      required
                    />
                    <div className="flex gap-2">
                      <Select value={guestPhoneCode} onValueChange={setGuestPhoneCode}>
                        <SelectTrigger className="w-[104px] shrink-0" aria-label="Country code">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="+91">🇮🇳 +91</SelectItem>
                          <SelectItem value="+1">🇺🇸 +1</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        placeholder={t("rd.onbehalf.phonePh", { defaultValue: "Phone (for the payment link SMS)" })}
                        value={guestPhone}
                        onChange={(e) => setGuestPhone(e.target.value)}
                        inputMode="tel"
                        required
                      />
                    </div>
                    <Input
                      placeholder={t("rd.onbehalf.email", { defaultValue: "Email" })}
                      value={guestEmail}
                      onChange={(e) => setGuestEmail(e.target.value)}
                      inputMode="email"
                      required
                    />
                    {guestEmail.trim().length > 0 && !emailValid && (
                      <p className="text-xs text-rose-500">{t("rd.onbehalf.badEmail", { defaultValue: "Enter a valid email address." })}</p>
                    )}
                  </div>
                </>
              )}

              <Button className="w-full" disabled={!canSubmit} onClick={handleSubmit}>
                {submitting ? (
                  <>
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" /> {t("rd.onbehalf.creating", { defaultValue: "Creating…" })}
                  </>
                ) : (
                  <>
                    <QrCode className="mr-1 h-4 w-4" /> {t("rd.onbehalf.create", { defaultValue: "Create booking & payment link" })}
                  </>
                )}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Post-create screen: QR + short link + WhatsApp/Book-another. Shared by the
 *  stays (host) and services (provider) on-behalf modals — the payment-link
 *  hand-off is identical regardless of what was booked. */
export function OnBehalfSuccessView({ result, onBookAnother }: {
  result: OnBehalfBookingResult;
  onBookAnother: () => void;
}) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);
  const shortUrl = result.paymentLink.shortUrl;
  const whatsappHref = useMemo(() => {
    const msg =
      `Here's your booking at ${result.listing.name}. ` +
      `Tap to pay securely: ${result.paymentLink.shortUrl}`;
    return `https://wa.me/${result.guest.phone.replace(/\D/g, "")}?text=${encodeURIComponent(msg)}`;
  }, [result]);

  function copyLink() {
    if (!shortUrl) return;
    navigator.clipboard.writeText(shortUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("rd.onbehalf.successTitle", { defaultValue: "Booking created — awaiting payment" })}</DialogTitle>
        <DialogDescription>
          {result.guest.name ? `${result.guest.name} · ` : ""}
          {result.guest.phone} · ₹{result.amount.toLocaleString("en-IN")}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col items-center gap-4 py-2">
        <div className="rounded-xl border bg-white p-4">
          <QRCodeSVG value={shortUrl} size={196} includeMargin />
        </div>
        <p className="text-sm text-muted-foreground text-center">
          {t("rd.onbehalf.qrHint", { defaultValue: "The guest can scan this QR or tap the link to pay. We texted the link to {{phone}}.", phone: result.guest.phone })}
        </p>
        <div className="flex w-full items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <span className="truncate text-sm">{shortUrl}</span>
          <Button size="sm" variant="ghost" className="ml-auto shrink-0" onClick={copyLink}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
        <div className="flex w-full gap-2">
          <Button asChild variant="outline" className="flex-1">
            <a href={whatsappHref} target="_blank" rel="noreferrer">
              <MessageCircle className="mr-1 h-4 w-4" /> {t("rd.onbehalf.whatsapp", { defaultValue: "WhatsApp" })}
            </a>
          </Button>
          <Button className="flex-1" onClick={onBookAnother}>
            {t("rd.onbehalf.bookAnother", { defaultValue: "Book another" })}
          </Button>
        </div>
      </div>
    </>
  );
}

export function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-9 w-9"
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - 1))}
        >
          −
        </Button>
        <span className="min-w-8 text-center text-sm">{value}</span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-9 w-9"
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + 1))}
        >
          +
        </Button>
      </div>
    </div>
  );
}
