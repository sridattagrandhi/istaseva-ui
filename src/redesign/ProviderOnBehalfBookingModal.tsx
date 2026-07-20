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
import { mapListingRowToMarketplaceService } from "@/lib/marketplace-adapters";
import { computeBookingFees } from "@/lib/pricing";
import { useFeeSpec } from "@/hooks/use-fee-spec";
import { getCouponsService, type CouponQuote } from "@/domains/coupons/coupons.service";
import { useLanguage } from "@/contexts/LanguageContext";
import type { MarketplaceService, ServiceMode } from "@/types/marketplace";
import type { Listing } from "@/types/domain";
import { ServiceSlotPicker } from "./MarketplaceControls";
import { friendlyError, OnBehalfSuccessView } from "./HostOnBehalfBookingModal";
import { parseServiceDurationMin, resolveServiceSchedule } from "./MarketplaceBookingModal";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MODE_LABEL: Record<ServiceMode, string> = {
  "at-home": "At customer's home",
  "visit-provider": "At your location",
  online: "Online",
};

/**
 * Provider-books-on-behalf modal (services). Mirrors HostOnBehalfBookingModal
 * for stays: the provider picks one of their service listings, a catalog
 * variant + add-ons, a date + time slot, and a walk-up customer's contact —
 * the server creates a payment-link hold the customer pays via QR/SMS/email.
 * Slot/duration resolution reuses the exact customer-flow helpers so holds
 * land on identical windows.
 */
export function ProviderOnBehalfBookingModal({
  open,
  onOpenChange,
  serviceListings,
  onCreated,
  asAdmin = false,
  initialListingId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The provider's own service listings (raw domain Listing rows). */
  serviceListings: Listing[];
  onCreated?: () => void;
  /** Ops console: hit the admin endpoint (any listing, action audited). */
  asAdmin?: boolean;
  /** Preselect a service (e.g. the ops console picked it in a prior step). */
  initialListingId?: string;
}) {
  const { t } = useLanguage();
  const [listingId, setListingId] = useState<string>("");
  const [service, setService] = useState<MarketplaceService | null>(null);
  // Server-resolved platform-fee spec (admin fee rules); legacy ₹3 fallback.
  const feeSpec = useFeeSpec(listingId || null);
  const [loading, setLoading] = useState(false);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [addOnIds, setAddOnIds] = useState<string[]>([]);
  const [mode, setMode] = useState<ServiceMode | "">("");
  const [address, setAddress] = useState("");
  const [slot, setSlot] = useState("");
  const [activeDate, setActiveDate] = useState<string | null>(null);
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
  const [bookedRows, setBookedRows] = useState<Array<{ scheduledDate: string; startTime: string; endTime: string; status: string }>>([]);
  const [blockedDates, setBlockedDates] = useState<Set<string>>(() => new Set());

  // Jump straight to the picked service when the opener already chose one
  // (admin ops console listing picker) — skips the manual Select step.
  useEffect(() => {
    if (open && initialListingId) setListingId(initialListingId);
  }, [open, initialListingId]);

  // Reset when closed.
  useEffect(() => {
    if (!open) {
      setListingId(""); setService(null); setGroupId(null); setAddOnIds([]);
      setMode(""); setAddress(""); setSlot(""); setActiveDate(null);
      setGuestName(""); setGuestPhoneCode("+91"); setGuestPhone(""); setGuestEmail("");
      setResult(null); setSubmitting(false);
      setCouponInput(""); setCouponQuote(null); setCouponMsg("");
      setBookedRows([]); setBlockedDates(new Set());
    }
  }, [open]);

  // Load the full listing (catalog, slots, modes) on pick.
  useEffect(() => {
    if (!listingId) { setService(null); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const res = await apiRequest<{ data: Parameters<typeof mapListingRowToMarketplaceService>[0] }>(
        `/api/listings/${listingId}`,
        { headers: getJsonHeaders(false) },
      );
      if (cancelled) return;
      if (res.success && res.data?.data) {
        const mapped = mapListingRowToMarketplaceService(res.data.data);
        setService(mapped);
        setGroupId(mapped.servicesCatalog?.[0]?.id ?? null);
        setMode(mapped.mode?.[0] ?? "visit-provider");
        setSlot("");
        setAddOnIds([]);
      } else {
        setService(null);
        toast.error(res.error || t("rd.onbehalf.errLoadListing", { defaultValue: "Could not load that listing." }));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [listingId]);

  // Existing bookings (per-slot greying) + host blocks — same sources the
  // customer modal reads, so both calendars agree on availability.
  useEffect(() => {
    if (!listingId) { setBookedRows([]); setBlockedDates(new Set()); return; }
    let cancelled = false;
    (async () => {
      const today = new Date();
      const to = new Date(today.getTime() + 365 * 86400000);
      const [bookings, avail] = await Promise.all([
        getListingService().getServiceBookings(listingId),
        getListingService().getAvailability(listingId, {
          from: today.toISOString().slice(0, 10),
          to: to.toISOString().slice(0, 10),
        }),
      ]);
      if (cancelled) return;
      setBookedRows(bookings.success && bookings.data
        ? bookings.data.filter((b) => ["pending", "confirmed", "in_progress"].includes(b.status))
        : []);
      const blocked = new Set<string>();
      if (avail.success && avail.data) {
        avail.data.forEach((a) => { if (a.roomTypeId == null && a.blocked) blocked.add(a.date); });
      }
      setBlockedDates(blocked);
    })();
    return () => { cancelled = true; };
  }, [listingId]);

  const group = useMemo(
    () => service?.servicesCatalog?.find((g) => g.id === groupId) ?? service?.servicesCatalog?.[0] ?? null,
    [service, groupId],
  );
  const catalogAddOns = group?.addOns ?? service?.addOns ?? [];
  const durationMin = useMemo(
    () => parseServiceDurationMin(service?.duration || ""),
    [service?.duration],
  );

  // Bookings folded to per-date minute intervals for slot-overlap checks.
  const bookingsByDate = useMemo(() => {
    const toMin = (t: string) => { const [h, m] = (t || "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
    const map = new Map<string, Array<{ s: number; e: number }>>();
    for (const b of bookedRows) {
      const iso = String(b.scheduledDate).slice(0, 10);
      const arr = map.get(iso) ?? [];
      arr.push({ s: toMin(b.startTime), e: toMin(b.endTime) });
      map.set(iso, arr);
    }
    return map;
  }, [bookedRows]);

  const isSlotBlockedOnDate = useMemo(() => {
    return (slotText: string, iso: string) => {
      if (blockedDates.has(iso)) return true;
      const { startTime } = resolveServiceSchedule(slotText, durationMin, iso);
      const [h, m] = startTime.split(":").map(Number);
      const start = (h || 0) * 60 + (m || 0);
      const end = start + durationMin;
      return (bookingsByDate.get(iso) ?? []).some((o) => start < o.e && end > o.s);
    };
  }, [blockedDates, bookingsByDate, durationMin]);

  // Same preview math as the customer service flow: base variant + selected
  // add-ons through computeBookingFees (the server's applyFees mirror), so
  // the total shown equals the payment-link amount.
  const subtotalRupees = useMemo(() => {
    if (!service) return 0;
    const base = group?.basePrice ?? service.price;
    const addOnsSum = catalogAddOns
      .filter((a) => addOnIds.includes(a.id ?? a.label))
      .reduce((t, a) => t + (a.price || 0), 0);
    return base + addOnsSum;
  }, [service, group, catalogAddOns, addOnIds]);

  const fees = useMemo(() => {
    if (!service || subtotalRupees <= 0) return null;
    return computeBookingFees({
      subtotal: subtotalRupees,
      category: service.category,
      discount: couponQuote ? Math.max(0, couponQuote.discountAmount) : 0,
      feeSpec,
    });
  }, [service, subtotalRupees, couponQuote, feeSpec]);

  async function applyCoupon() {
    const code = couponInput.trim();
    if (!code || !service) return;
    setCouponBusy(true);
    setCouponMsg("");
    try {
      const res = await getCouponsService().validate({
        code,
        listingId: service.id,
        basePrice: subtotalRupees,
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
  const needsAddress = mode === "at-home";
  const canSubmit =
    !!service && !!slot && !!mode &&
    (!needsAddress || address.trim().length > 3) &&
    guestName.trim().length > 0 &&
    guestPhone.trim().length >= 6 &&
    emailValid &&
    !submitting;

  async function handleSubmit() {
    if (!service || !slot || !mode) return;
    setSubmitting(true);
    try {
      const typedPhone = guestPhone.trim();
      const fullPhone = typedPhone.startsWith("+")
        ? typedPhone
        : `${guestPhoneCode}${typedPhone.replace(/\D/g, "")}`;
      // Same schedule resolution as the customer flow (weekday-anchored slot
      // + the picked date chip), so the hold's window matches exactly.
      const schedule = resolveServiceSchedule(slot, durationMin, activeDate ?? undefined);
      const selectedAddOns = catalogAddOns
        .filter((a) => a.id && addOnIds.includes(a.id))
        .map((a) => ({ id: a.id, label: a.label, price: a.price }));

      const res = await getBookingService().prepareOnBehalf(
        {
          listingType: "service",
          listingId: service.id,
          serviceCategory: service.category,
          scheduledDate: schedule.scheduledDate,
          startTime: schedule.startTime,
          endTime: schedule.endTime,
          serviceMode: mode as ServiceMode,
          serviceAddress: mode === "at-home" ? address.trim() : undefined,
          visitAddress: mode === "visit-provider" ? (service.visitAddress || service.location || undefined) : undefined,
          meetingDetails: mode === "online" ? (service.meetingDetails || t("rd.onbehalf.meetingFallback", { defaultValue: "Provider will share the meeting link before the slot." })) : undefined,
          slot,
          serviceAddOns: selectedAddOns.length ? selectedAddOns : undefined,
          ...(group ? {
            serviceCatalogId: group.id,
            serviceCatalogName: group.name,
            serviceCatalogBasePrice: group.basePrice,
          } : {}),
          guestName: guestName.trim(),
          contact: { name: guestName.trim(), phone: fullPhone },
          couponCode: couponQuote?.code,
          address: mode === "at-home" ? address.trim() : undefined,
          listingTitle: service.title,
          listingName: service.title,
          listingImage: service.image,
          listingLocation: service.location,
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
              <DialogDescription>{t("rd.onbehalf.subCustomer", { defaultValue: "Create a booking on a customer's behalf. They'll get a QR / link to pay — no account needed." })}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-1">
              {/* Listing */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t("rd.onbehalf.service", { defaultValue: "Service" })}</label>
                <Select value={listingId} onValueChange={setListingId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("rd.onbehalf.selectService", { defaultValue: "Select a service…" })} />
                  </SelectTrigger>
                  <SelectContent>
                    {serviceListings.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {loading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> {t("rd.onbehalf.loadingService", { defaultValue: "Loading service…" })}
                </div>
              )}

              {service && (
                <>
                  {/* Catalog variant */}
                  {service.servicesCatalog && service.servicesCatalog.length > 0 && (
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">{t("rd.onbehalf.serviceOption", { defaultValue: "Service option" })}</label>
                      <Select
                        value={groupId ?? ""}
                        onValueChange={(v) => { setGroupId(v); setAddOnIds([]); }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t("rd.onbehalf.selectOption", { defaultValue: "Select an option…" })} />
                        </SelectTrigger>
                        <SelectContent>
                          {service.servicesCatalog.map((g) => (
                            <SelectItem key={g.id} value={g.id}>
                              {g.name} · ₹{g.basePrice.toLocaleString("en-IN")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* Add-ons */}
                  {catalogAddOns.length > 0 && (
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">{t("rd.onbehalf.addOns", { defaultValue: "Add-ons" })}</label>
                      <div className="space-y-1">
                        {catalogAddOns.map((a) => {
                          const id = a.id ?? a.label;
                          const checked = addOnIds.includes(id);
                          return (
                            <label key={id} className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() =>
                                  setAddOnIds((p) => (checked ? p.filter((x) => x !== id) : [...p, id]))
                                }
                              />
                              <span className="flex-1">{a.label}</span>
                              <span className="text-muted-foreground">+₹{a.price}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Mode */}
                  {service.mode && service.mode.length > 0 && (
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">{t("rd.onbehalf.serviceMode", { defaultValue: "Service mode" })}</label>
                      <Select value={mode} onValueChange={(v) => setMode(v as ServiceMode)}>
                        <SelectTrigger>
                          <SelectValue placeholder={t("rd.onbehalf.selectMode", { defaultValue: "Select mode…" })} />
                        </SelectTrigger>
                        <SelectContent>
                          {service.mode.map((m) => (
                            <SelectItem key={m} value={m}>
                              {t(`rd.onbehalf.mode_${m}`, { defaultValue: MODE_LABEL[m] ?? m })}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {needsAddress && (
                        <Input
                          placeholder={t("rd.onbehalf.customerAddress", { defaultValue: "Customer's address" })}
                          value={address}
                          onChange={(e) => setAddress(e.target.value)}
                          required
                        />
                      )}
                    </div>
                  )}

                  {/* Date + slot */}
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">{t("rd.onbehalf.dateTime", { defaultValue: "Date & time" })}</label>
                    <ServiceSlotPicker
                      slots={service.slots}
                      selected={slot}
                      onSelect={setSlot}
                      activeDate={activeDate}
                      onActiveDateChange={setActiveDate}
                      isSlotBlockedOnDate={isSlotBlockedOnDate}
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
                        <Button variant="outline" className="shrink-0" disabled={!couponInput.trim() || couponBusy} onClick={applyCoupon}>
                          {couponBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("rd.onbehalf.apply", { defaultValue: "Apply" })}
                        </Button>
                      </div>
                    )}
                    {couponMsg && <p className="text-xs text-rose-500">{couponMsg}</p>}
                  </div>

                  {/* Price breakdown — same math as the customer flow, so this
                      total equals the payment-link amount. */}
                  {fees && (
                    <div className="space-y-1 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">
                          {group?.name ?? service.title}
                          {addOnIds.length > 0 ? ` + ${t("rd.onbehalf.addOnCount", { defaultValue: "{{n}} add-on{{plural}}", n: addOnIds.length, plural: addOnIds.length === 1 ? "" : "s" })}` : ""}
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
                    <Input
                      placeholder={t("rd.onbehalf.customerName", { defaultValue: "Customer name" })}
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
