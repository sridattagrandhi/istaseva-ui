import { useEffect, useMemo, useState } from "react";
import { Loader2, QrCode } from "lucide-react";
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
import { mapListingRowToMarketplaceTransport } from "@/lib/marketplace-adapters";
import { computeBookingFees } from "@/lib/pricing";
import { useFeeSpec } from "@/hooks/use-fee-spec";
import { getCouponsService, type CouponQuote } from "@/domains/coupons/coupons.service";
import type { MarketplaceTransport } from "@/types/marketplace";
import type { Listing } from "@/types/domain";
import { DateRangeCalendar } from "./MarketplaceControls";
import { friendlyError, OnBehalfSuccessView, Stepper } from "./HostOnBehalfBookingModal";
import { useLanguage } from "@/contexts/LanguageContext";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type TrMode = "hourly" | "day" | "package";
const MODE_LABEL: Record<TrMode, string> = { hourly: "Hourly", day: "Day rental", package: "Package" };
const WD_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function isoTomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
const toMin = (t: string) => { const [h, m] = (t || "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const fmtMin = (m: number) => { const h = Math.floor(m / 60), mm = m % 60, p = h >= 12 ? "PM" : "AM", h12 = ((h + 11) % 12) + 1; return `${h12}:${String(mm).padStart(2, "0")} ${p}`; };
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const addDaysIso = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** Driver's working window for an ISO date, mirroring the server's
 *  transportWindowForDate: {open, close} minutes | "closed" | null (no data). */
function windowForDate(wh: MarketplaceTransport["workingHours"], iso: string): { open: number; close: number } | "closed" | null {
  if (!wh || !Object.values(wh).some((s) => Array.isArray(s) && s.length === 2)) return null;
  const slot = wh[WD_KEYS[new Date(`${iso}T00:00:00`).getDay()]];
  if (!Array.isArray(slot) || slot.length !== 2) return "closed";
  const open = toMin(slot[0]), close = toMin(slot[1]);
  return close > open ? { open, close } : null;
}

/**
 * Driver-books-on-behalf modal (transport). Mirrors the stays/services
 * on-behalf modals: pick a vehicle, a mode (hourly / day rental / package),
 * schedule + pickup + passengers, coupon, and the walk-up customer's contact —
 * the server creates a payment-link hold the customer pays via QR/SMS/email.
 * serviceCategory is driver-{mode} so server pricing takes the transport
 * branch (hourly × hours / day × days / packageId match) exactly like the
 * customer flow.
 */
export function TransportOnBehalfBookingModal({
  open,
  onOpenChange,
  transportListings,
  onCreated,
  asAdmin = false,
  initialListingId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transportListings: Listing[];
  onCreated?: () => void;
  /** Ops console: hit the admin endpoint (any listing, action audited). */
  asAdmin?: boolean;
  /** Preselect a vehicle (e.g. the ops console picked it in a prior step). */
  initialListingId?: string;
}) {
  const { t } = useLanguage();
  const [listingId, setListingId] = useState<string>("");
  const [tr, setTr] = useState<MarketplaceTransport | null>(null);
  // Server-resolved platform-fee spec (admin fee rules); legacy ₹3 fallback.
  const feeSpec = useFeeSpec(listingId || null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<TrMode | "">("");
  const [date, setDate] = useState<string | null>(null);      // hourly + package + day-start
  const [dayEnd, setDayEnd] = useState<string | null>(null);  // day rental inclusive end
  const [slot, setSlot] = useState("");                        // hourly start (HH:MM 24h)
  const [hours, setHours] = useState(2);
  const [packageId, setPackageId] = useState<string>("");
  const [pickup, setPickup] = useState("");
  const [passengers, setPassengers] = useState(1);
  const [couponInput, setCouponInput] = useState("");
  const [couponQuote, setCouponQuote] = useState<CouponQuote | null>(null);
  const [couponMsg, setCouponMsg] = useState("");
  const [couponBusy, setCouponBusy] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [guestPhoneCode, setGuestPhoneCode] = useState("+91");
  const [guestPhone, setGuestPhone] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<OnBehalfBookingResult | null>(null);
  const [bookedRows, setBookedRows] = useState<Array<{ scheduledDate: string; startTime: string; endTime: string; status: string }>>([]);

  // Jump straight to the picked vehicle when the opener already chose one
  // (admin ops console listing picker) — skips the manual Select step.
  useEffect(() => {
    if (open && initialListingId) setListingId(initialListingId);
  }, [open, initialListingId]);

  useEffect(() => {
    if (!open) {
      setListingId(""); setTr(null); setMode(""); setDate(null); setDayEnd(null);
      setSlot(""); setHours(2); setPackageId(""); setPickup(""); setPassengers(1);
      setCouponInput(""); setCouponQuote(null); setCouponMsg("");
      setGuestName(""); setGuestPhoneCode("+91"); setGuestPhone(""); setGuestEmail("");
      setResult(null); setSubmitting(false); setBookedRows([]);
    }
  }, [open]);

  // Load the vehicle (rates, packages, working hours) on pick.
  useEffect(() => {
    if (!listingId) { setTr(null); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const res = await apiRequest<{ data: Parameters<typeof mapListingRowToMarketplaceTransport>[0] }>(
        `/api/listings/${listingId}`,
        { headers: getJsonHeaders(false) },
      );
      if (cancelled) return;
      if (res.success && res.data?.data) {
        const mapped = mapListingRowToMarketplaceTransport(res.data.data);
        setTr(mapped);
      } else {
        setTr(null);
        toast.error(res.error || t("rd.onbehalf.errLoadVehicle", { defaultValue: "Could not load that vehicle." }));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [listingId]);

  // Existing bookings — whole-day greying for day/package, per-slot for hourly —
  // plus the driver's own blocked dates (shown struck-through but SELECTABLE:
  // they own the block, and the server's on-behalf path skips the block gate).
  const [driverBlocked, setDriverBlocked] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!listingId) { setBookedRows([]); setDriverBlocked(new Set()); return; }
    let cancelled = false;
    (async () => {
      const today = new Date();
      const to = new Date(today.getTime() + 365 * 86400000);
      const [res, avail] = await Promise.all([
        getListingService().getTransportBookings(listingId),
        getListingService().getAvailability(listingId, {
          from: today.toISOString().slice(0, 10),
          to: to.toISOString().slice(0, 10),
        }),
      ]);
      if (cancelled) return;
      setBookedRows(res.success && res.data
        ? res.data.filter((b) => ["pending", "confirmed", "in_progress"].includes(b.status))
        : []);
      const blocked = new Set<string>();
      if (avail.success && avail.data) {
        avail.data.forEach((a) => { if (a.roomTypeId == null && a.blocked) blocked.add(a.date); });
      }
      setDriverBlocked(blocked);
    })();
    return () => { cancelled = true; };
  }, [listingId]);

  // Modes this vehicle actually offers — same inference as the customer flow.
  const modes = useMemo((): TrMode[] => {
    if (!tr) return [];
    const out: TrMode[] = [];
    if (tr.packageOptions?.length) out.push("package");
    if (tr.hourly > 0) out.push("hourly");
    if (tr.day > 0) out.push("day");
    return out;
  }, [tr]);
  const effMode: TrMode | "" = mode || modes[0] || "";
  const pkg = tr?.packageOptions?.find((p) => p.id === packageId) ?? tr?.packageOptions?.[0] ?? null;

  const bookedDatesSet = useMemo(
    () => new Set(bookedRows.map((b) => String(b.scheduledDate).slice(0, 10))),
    [bookedRows],
  );
  const occByDate = useMemo(() => {
    const map = new Map<string, Array<{ s: number; e: number }>>();
    for (const b of bookedRows) {
      const iso = String(b.scheduledDate).slice(0, 10);
      const arr = map.get(iso) ?? [];
      arr.push({ s: toMin(b.startTime), e: toMin(b.endTime) });
      map.set(iso, arr);
    }
    return map;
  }, [bookedRows]);

  // Hourly start slots for the picked date, from working hours (1h steps).
  const hourSlots = useMemo(() => {
    if (!tr || !date) return [];
    const win = windowForDate(tr.workingHours, date);
    if (win === "closed") return [];
    const open = win ? win.open : 9 * 60, close = win ? win.close : 18 * 60;
    const out: Array<{ t24: string; label: string; taken: boolean }> = [];
    for (let m = Math.ceil(open / 60) * 60; m + 60 <= close; m += 60) {
      const taken = (occByDate.get(date) ?? []).some((o) => m < o.e && m + 60 > o.s);
      out.push({ t24: hhmm(m), label: fmtMin(m), taken });
    }
    return out;
  }, [tr, date, occByDate]);
  // Cap hours so the rental ends inside the day's window (customer parity).
  const hoursMax = useMemo(() => {
    if (!tr || !date || !slot) return 12;
    const win = windowForDate(tr.workingHours, date);
    if (!win || win === "closed") return 12;
    return Math.max(1, Math.min(12, Math.floor((win.close - toMin(slot)) / 60)));
  }, [tr, date, slot]);
  const hoursEff = Math.min(hours, hoursMax);

  // Calendar blocking: booked dates + closed weekdays are HARD-disabled;
  // the driver's own blocked dates render distinct but stay selectable
  // (allowBlocked on the calendar), matching the stays modal semantics.
  const disabledDates = useMemo(() => {
    const set = new Set<string>(bookedDatesSet);
    if (tr?.workingHours) {
      let cur = isoTomorrow();
      for (let i = 0; i < 120; i += 1) {
        if (windowForDate(tr.workingHours, cur) === "closed") set.add(cur);
        cur = addDaysIso(cur, 1);
      }
    }
    return set;
  }, [bookedDatesSet, tr]);

  const days = effMode === "day" && date && dayEnd
    ? Math.max(1, Math.min(30, Math.round((new Date(`${dayEnd}T00:00:00`).getTime() - new Date(`${date}T00:00:00`).getTime()) / 86400000) + 1))
    : 1;

  // Same preview math as the customer transport flow — driver-* categories
  // hit the transport pricing branch, so total equals the payment link.
  const subtotalRupees = useMemo(() => {
    if (!tr || !effMode) return 0;
    if (effMode === "hourly") return tr.hourly * hoursEff;
    if (effMode === "day") return tr.day * days;
    return pkg?.price ?? 0;
  }, [tr, effMode, hoursEff, days, pkg]);

  const fees = useMemo(() => {
    if (!tr || subtotalRupees <= 0) return null;
    return computeBookingFees({
      subtotal: subtotalRupees,
      category: `driver-${effMode}`,
      discount: couponQuote ? Math.max(0, couponQuote.discountAmount) : 0,
      feeSpec,
    });
  }, [tr, subtotalRupees, effMode, couponQuote, feeSpec]);

  async function applyCoupon() {
    const code = couponInput.trim();
    if (!code || !tr) return;
    setCouponBusy(true);
    setCouponMsg("");
    try {
      const res = await getCouponsService().validate({ code, listingId: String(tr.id), basePrice: subtotalRupees });
      if (res.success && res.data) setCouponQuote(res.data);
      else { setCouponQuote(null); setCouponMsg(res.error || t("rd.onbehalf.couponInvalid", { defaultValue: "That coupon can't be applied here." })); }
    } finally {
      setCouponBusy(false);
    }
  }

  const emailValid = EMAIL_REGEX.test(guestEmail.trim());
  const scheduleReady = effMode === "hourly" ? (!!date && !!slot)
    : effMode === "day" ? (!!date && !!dayEnd)
    : (!!date && !!pkg?.id);
  const canSubmit =
    !!tr && !!effMode && scheduleReady && pickup.trim().length > 2 &&
    guestName.trim().length > 0 && guestPhone.trim().length >= 6 && emailValid && !submitting;

  async function handleSubmit() {
    if (!tr || !effMode || !date) return;
    setSubmitting(true);
    try {
      const typedPhone = guestPhone.trim();
      const fullPhone = typedPhone.startsWith("+") ? typedPhone : `${guestPhoneCode}${typedPhone.replace(/\D/g, "")}`;
      // Times mirror the customer flow: hourly = the picked slot window;
      // day/package = nominal 09:00 starts the server widens to the working
      // window (driver-day / driver-package branch in createHold).
      const startTime = effMode === "hourly" ? slot : "09:00";
      const endMin = effMode === "hourly" ? toMin(slot) + hoursEff * 60 : effMode === "day" ? 17 * 60 : 13 * 60;
      const endTime = hhmm(Math.min(23 * 60 + 59, endMin));

      const res = await getBookingService().prepareOnBehalf(
        {
          listingType: "transport",
          listingId: String(tr.id),
          serviceCategory: `driver-${effMode}`,
          scheduledDate: date,
          startTime,
          endTime,
          // Day rentals: the hold's conflict end is EXCLUSIVE (last day + 1);
          // transportEndDate carries the inclusive display end for notes.
          endDate: effMode === "day" && dayEnd ? addDaysIso(dayEnd, 1) : undefined,
          transportMode: effMode,
          transportHours: effMode === "hourly" ? hoursEff : undefined,
          transportDays: effMode === "day" ? days : undefined,
          transportEndDate: effMode === "day" && dayEnd ? dayEnd : undefined,
          transportPackageId: effMode === "package" ? pkg!.id : undefined,
          pickupLocation: pickup.trim(),
          passengerCount: passengers,
          couponCode: couponQuote?.code,
          guestName: guestName.trim(),
          contact: { name: guestName.trim(), phone: fullPhone },
          address: pickup.trim(),
          listingTitle: `${tr.vehicle} · ${tr.driver}`,
          listingName: `${tr.vehicle} · ${tr.driver}`,
        },
        { name: guestName.trim(), phone: fullPhone, email: guestEmail.trim() },
        { admin: asAdmin },
      );

      if (!res.success || !res.data) {
        toast.error(friendlyError(res.error, t("rd.onbehalf.errGeneric", { defaultValue: "Could not create the booking. Please check the details and try again." })));
        return;
      }
      setResult(res.data);
      onCreated?.();
      toast.success(t("rd.onbehalf.createdToastCustomer", { defaultValue: "Payment link created — an SMS was sent to the customer." }));
    } catch (err) {
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
          <>
            <DialogHeader>
              <DialogTitle>{t("rd.onbehalf.titleCustomer", { defaultValue: "Book for a customer" })}</DialogTitle>
              <DialogDescription>{t("rd.onbehalf.subRide", { defaultValue: "Create a ride on a customer's behalf. They'll get a QR / link to pay — no account needed." })}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-1">
              {/* Vehicle */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t("rd.onbehalf.vehicle", { defaultValue: "Vehicle" })}</label>
                <Select value={listingId} onValueChange={(v) => { setListingId(v); setMode(""); setDate(null); setDayEnd(null); setSlot(""); setPackageId(""); setCouponQuote(null); setCouponInput(""); }}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("rd.onbehalf.selectVehicle", { defaultValue: "Select a vehicle…" })} />
                  </SelectTrigger>
                  <SelectContent>
                    {transportListings.map((l) => (
                      <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {loading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> {t("rd.onbehalf.loadingVehicle", { defaultValue: "Loading vehicle…" })}
                </div>
              )}

              {tr && (
                <>
                  {/* Mode */}
                  {modes.length > 0 && (
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">{t("rd.onbehalf.bookingType", { defaultValue: "Booking type" })}</label>
                      <div className="flex gap-2">
                        {modes.map((m) => (
                          <Button
                            key={m}
                            type="button"
                            size="sm"
                            variant={m === effMode ? "default" : "outline"}
                            className="rounded-full"
                            onClick={() => { setMode(m); setSlot(""); setDayEnd(null); }}
                          >
                            {t(`rd.onbehalf.trMode_${m}`, { defaultValue: MODE_LABEL[m] })}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Package pick */}
                  {effMode === "package" && tr.packageOptions?.length > 0 && (
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">{t("rd.onbehalf.package", { defaultValue: "Package" })}</label>
                      <Select value={pkg?.id ?? ""} onValueChange={setPackageId}>
                        <SelectTrigger>
                          <SelectValue placeholder={t("rd.onbehalf.selectPackage", { defaultValue: "Select a package…" })} />
                        </SelectTrigger>
                        <SelectContent>
                          {tr.packageOptions.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.label} · ₹{p.price.toLocaleString("en-IN")}{p.hours ? ` · ${p.hours} hr` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* Dates */}
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">{effMode === "day" ? t("rd.onbehalf.rentalDates", { defaultValue: "Rental dates" }) : t("rd.onbehalf.date", { defaultValue: "Date" })}</label>
                    <DateRangeCalendar
                      start={date}
                      end={effMode === "day" ? dayEnd : null}
                      onChange={({ start, end }) => {
                        if (effMode === "day") { setDate(start); setDayEnd(end); }
                        else { setDate(start); setDayEnd(null); setSlot(""); }
                      }}
                      minDate={isoTomorrow()}
                      monthsVisible={1}
                      compact
                      disabledDates={disabledDates}
                      blockedDates={driverBlocked}
                      allowBlocked
                      onInvalidRange={() => toast.error(t("rd.onbehalf.rangeBookedClosed", { defaultValue: "Your selection crosses a booked or closed day." }))}
                    />
                  </div>

                  {/* Hourly: slot + hours */}
                  {effMode === "hourly" && date && (
                    <>
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">{t("rd.onbehalf.startTime", { defaultValue: "Start time" })}</label>
                        {hourSlots.length === 0 && <p className="text-xs text-muted-foreground">{t("rd.onbehalf.driverClosed", { defaultValue: "Driver is closed on this day." })}</p>}
                        <div className="flex flex-wrap gap-2">
                          {hourSlots.map((sl) => (
                            <Button
                              key={sl.t24}
                              type="button"
                              size="sm"
                              disabled={sl.taken}
                              variant={slot === sl.t24 ? "default" : "outline"}
                              className={`rounded-full ${sl.taken ? "line-through opacity-40" : ""}`}
                              onClick={() => setSlot(sl.t24)}
                            >
                              {sl.label}
                            </Button>
                          ))}
                        </div>
                      </div>
                      {slot && <Stepper label={t("rd.onbehalf.hoursMax", { defaultValue: "Hours (max {{max}})", max: hoursMax })} value={hoursEff} min={1} max={hoursMax} onChange={setHours} />}
                    </>
                  )}

                  {/* Pickup + passengers */}
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">{t("rd.onbehalf.pickup", { defaultValue: "Pickup location" })}</label>
                    <Input placeholder={t("rd.onbehalf.pickupPh", { defaultValue: "Where should the driver pick them up?" })} value={pickup} onChange={(e) => setPickup(e.target.value)} required />
                  </div>
                  <Stepper label={t("rd.onbehalf.passengers", { defaultValue: "Passengers" })} value={passengers} min={1} max={Math.max(1, tr.capacity || 6)} onChange={setPassengers} />

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
                        <Input placeholder={t("rd.onbehalf.couponOptional", { defaultValue: "Optional" })} value={couponInput} onChange={(e) => { setCouponInput(e.target.value.toUpperCase()); setCouponMsg(""); }} />
                        <Button variant="outline" className="shrink-0" disabled={!couponInput.trim() || couponBusy || subtotalRupees <= 0} onClick={applyCoupon}>
                          {couponBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("rd.onbehalf.apply", { defaultValue: "Apply" })}
                        </Button>
                      </div>
                    )}
                    {couponMsg && <p className="text-xs text-rose-500">{couponMsg}</p>}
                  </div>

                  {/* Price breakdown — same math as the customer flow. */}
                  {fees && (
                    <div className="space-y-1 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">
                          {effMode === "hourly" ? t("rd.onbehalf.lineHours", { defaultValue: "₹{{rate}} × {{n}} hr", rate: tr.hourly.toLocaleString("en-IN"), n: hoursEff })
                            : effMode === "day" ? t("rd.onbehalf.lineDays", { defaultValue: "₹{{rate}} × {{n}} day{{plural}}", rate: tr.day.toLocaleString("en-IN"), n: days, plural: days === 1 ? "" : "s" })
                            : pkg?.label ?? t("rd.onbehalf.package", { defaultValue: "Package" })}
                        </span>
                        <span>₹{fees.subtotal.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                      </div>
                      {fees.discount > 0 && (
                        <div className="flex justify-between text-emerald-700">
                          <span>{t("rd.onbehalf.couponRow", { defaultValue: "Coupon" })}{couponQuote ? ` (${couponQuote.code})` : ""}</span>
                          <span>−₹{fees.discount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t("rd.onbehalf.platformFee", { defaultValue: "Platform fee" })}</span>
                        <span>₹{fees.platformFee.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t("rd.onbehalf.gst", { defaultValue: "GST ({{rate}}%)", rate: Math.round(fees.gstRate * 100) })}</span>
                        <span>₹{fees.taxes.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                      </div>
                      <div className="flex justify-between border-t pt-1 font-semibold">
                        <span>{t("rd.onbehalf.totalCustomer", { defaultValue: "Total the customer pays" })}</span>
                        <span>₹{fees.total.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                      </div>
                    </div>
                  )}

                  {/* Customer details — all required */}
                  <div className="space-y-2 border-t pt-3">
                    <label className="text-sm font-medium">{t("rd.onbehalf.customerDetails", { defaultValue: "Customer details" })}</label>
                    <Input placeholder={t("rd.onbehalf.customerName", { defaultValue: "Customer name" })} value={guestName} onChange={(e) => setGuestName(e.target.value)} required />
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
                      <Input placeholder={t("rd.onbehalf.phonePh", { defaultValue: "Phone (for the payment link SMS)" })} value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} inputMode="tel" required />
                    </div>
                    <Input placeholder={t("rd.onbehalf.email", { defaultValue: "Email" })} value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} inputMode="email" required />
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
