// dash/BookForGuest.tsx — host/provider books on a walk-up guest's behalf.
// Mirrors the web on-behalf modals: pick a listing → (stay: room + date range |
// service: variant + mode + date + slot) → guest name / phone (+country code) /
// email (all mandatory) → the server creates a long-TTL hold + Razorpay Payment
// Link → show a QR + share row. The guest pays the link (SMS + email are sent
// server-side); the booking confirms via the payment_link.paid webhook.
// Overlay pattern + form styling follow CreateCoupon.
import React, { useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet, Modal, Linking, ActivityIndicator, Share } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import QRCode from "react-native-qrcode-svg";
import { Icon } from "../../Icon";
import { IconBtn, Counter, PrimaryButton } from "../../primitives";
import { T, font, noOutline } from "../../theme";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "@/lib/toast";
import { fetchListing } from "../../api/listings";
import { fetchAvailability, fetchBookedDates, fetchServiceBookings, fetchTransportBookings } from "../../api/dash";
import { prepareOnBehalf, ymd, to24h, addHour, type OnBehalfResult } from "../../api/bookings";
import { computeBookingFees } from "../../pricing";
import { useFeeSpec } from "../../api/hooks";
import { validateCoupon } from "../../api/coupons";
import { MonthCalendar } from "../BookingScreen";
import type { Stay, Service, Transport } from "../../types";

const COUNTRIES = [
  { flag: "🇮🇳", code: "+91", name: "India", len: 10 },
  { flag: "🇺🇸", code: "+1", name: "United States", len: 10 },
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TODAY = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const MODE_LBL: Record<string, string> = { "at-home": "At customer's home", "visit-provider": "At your location", online: "Online" };

/** Server errors worth showing verbatim are human sentences (slot conflicts,
 *  validation). Anything that smells like a DB/internal failure gets the
 *  generic message — mirrors the web modal's friendlyError. */
function friendlyError(raw: unknown, fallback = "Could not create the booking. Please check the details and try again."): string {
  const msg = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
  if (!msg.trim()) return fallback;
  if (/invalid input syntax|syntax error|column|constraint|violates|uuid|sql|internal server error|unexpected/i.test(msg)) return fallback;
  return msg;
}

export function BookForGuest({ entryType = "stay", listings, onClose, onCreated, asAdmin = false, initialListingId }: {
  /** "stay" (host), "service" (provider), or "transport" (driver) dashboard. */
  entryType?: "stay" | "service" | "transport";
  /** The signed-in partner's listings for this role — apiId + name. */
  listings: Array<{ apiId?: string; name: string }>;
  onClose: () => void;
  /** Fires after a booking+link is created so the dashboard can refetch. */
  onCreated?: () => void;
  /** Admin ops console: book against ANY listing via the admin endpoint. */
  asAdmin?: boolean;
  /** Preselect a listing (admin picked it in a prior step). */
  initialListingId?: string;
}) {
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const isService = entryType === "service";
  const isTransport = entryType === "transport";
  const [listingId, setListingId] = useState<string | null>(initialListingId ?? null);
  // Server-resolved platform-fee spec (admin fee rules); legacy ₹3 fallback.
  const feeSpec = useFeeSpec(listingId);
  const [dropOpen, setDropOpen] = useState(false);
  // Stay state
  const [roomId, setRoomId] = useState<string | null>(null);
  const [range, setRange] = useState<{ start: Date | null; end: Date | null }>({ start: null, end: null });
  const [guests, setGuests] = useState(1);
  const [rooms, setRooms] = useState(1);
  // Service state
  const [variantSel, setVariantSel] = useState(0);
  const [addons, setAddons] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<string>("");
  const [svcAddress, setSvcAddress] = useState("");
  const [pickDate, setPickDate] = useState<Date | null>(null);
  const [slot, setSlot] = useState<string>("");
  // Transport state — day rentals reuse `range` (INCLUSIVE end, unlike stays'
  // exclusive checkout); hourly/package reuse `pickDate` + `slot`.
  const [trMode, setTrMode] = useState<string>("");
  const [trHours, setTrHours] = useState(2);
  const [pkgSel, setPkgSel] = useState(0);
  const [pickup, setPickup] = useState("");
  const [passengers, setPassengers] = useState(1);
  // Guest contact
  const [name, setName] = useState("");
  const [cc, setCc] = useState(COUNTRIES[0]);
  const [ccOpen, setCcOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<OnBehalfResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [couponInput, setCouponInput] = useState("");
  const [couponQuote, setCouponQuote] = useState<{ code: string; discountAmount: number } | null>(null);
  const [couponMsg, setCouponMsg] = useState("");
  const [couponBusy, setCouponBusy] = useState(false);

  const real = listings.filter((l) => l.apiId);
  const picked = real.find((l) => l.apiId === listingId) ?? null;

  // Full listing (room types / catalog variants) once picked.
  const listingQ = useQuery({
    queryKey: ["bfg-listing", entryType, listingId],
    queryFn: async () => fetchListing(listingId!, entryType),
    enabled: !!listingId,
    staleTime: 60_000,
  });
  const stay = entryType === "stay" ? ((listingQ.data as Stay | undefined) ?? null) : null;
  const svc = isService ? ((listingQ.data as Service | undefined) ?? null) : null;
  const tr = isTransport ? ((listingQ.data as Transport | undefined) ?? null) : null;
  const roomTypes = stay?.roomTypes?.length ? stay.roomTypes : null;
  const selectedRoom = roomTypes?.find((r) => r.id === roomId) ?? roomTypes?.[0] ?? null;
  const selRoomId = selectedRoom?.id ?? null;
  const variants = svc?.variants?.length ? svc.variants : null;
  const baseItem = variants ? variants[Math.min(variantSel, variants.length - 1)] : svc ? { id: undefined as string | undefined, name: svc.title, price: svc.price, addOns: svc.addOns ?? [] } : null;
  const svcAddOns = variants ? (variants[Math.min(variantSel, variants.length - 1)]?.addOns ?? []) : (svc?.addOns ?? []);
  // Default the mode once the service loads.
  const effMode = mode || svc?.mode?.[0] || "";

  // Booked nights/days (hard-blocked) — stays + transport whole-day modes.
  const bookedQ = useQuery({
    queryKey: ["bfg-booked", listingId, selRoomId],
    queryFn: () => fetchBookedDates(listingId!, selRoomId ?? undefined),
    enabled: !!listingId && !isService,
    staleTime: 30_000,
  });
  // Per-slot transport occupancy — hourly rides only grey their own hours.
  const trBookQ = useQuery({
    queryKey: ["bfg-transport-bookings", listingId],
    queryFn: () => fetchTransportBookings(listingId!),
    enabled: !!listingId && isTransport,
    staleTime: 0,
  });
  // Host availability blocks (stays: flagged+bookable; services: hard-blocked
  // dates, matching the customer flow which won't offer slots on them).
  const availQ = useQuery({
    queryKey: ["bfg-avail", listingId],
    queryFn: () => fetchAvailability(listingId!),
    enabled: !!listingId,
    staleTime: 30_000,
  });
  // Per-slot occupancy — services only (a 10–11 booking must grey only that slot).
  const svcBookQ = useQuery({
    queryKey: ["bfg-service-bookings", listingId],
    queryFn: () => fetchServiceBookings(listingId!),
    enabled: !!listingId && isService,
    staleTime: 0,
  });

  const bookedSet = useMemo(() => new Set(bookedQ.data ?? []), [bookedQ.data]);
  const hostBlockedSet = useMemo(() => {
    const set = new Set<string>();
    (availQ.data ?? []).forEach((a) => { if (a.roomTypeId == null && a.blocked) set.add(a.date); });
    if (!isService && selRoomId) (availQ.data ?? []).forEach((a) => { if (a.roomTypeId === selRoomId && a.blocked) set.add(a.date); });
    return set;
  }, [availQ.data, selRoomId, isService]);

  // Service/transport slot occupancy: date → [{s,e}] minute intervals.
  const occByDate = useMemo(() => {
    const toMin = (x: string) => { const [h, m] = (x || "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
    const map = new Map<string, { s: number; e: number }[]>();
    [...(svcBookQ.data ?? []), ...(trBookQ.data ?? [])].forEach((b) => {
      const arr = map.get(b.date) ?? [];
      arr.push({ s: toMin(b.start), e: toMin(b.end) });
      map.set(b.date, arr);
    });
    return map;
  }, [svcBookQ.data, trBookQ.data]);

  // Driver working-hours window for a date — mirrors BookingScreen/server.
  const trWindowFor = (d: Date): { open: number; close: number } | "closed" | null => {
    const wh = tr?.workingHours;
    if (!wh || !Object.values(wh).some((s2) => Array.isArray(s2) && s2.length === 2)) return null;
    const win = wh[["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d.getDay()]];
    if (!Array.isArray(win) || win.length !== 2) return "closed";
    const toMin = (x: string) => { const [h, m] = (x || "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
    const open = toMin(win[0]), close = toMin(win[1]);
    return close > open ? { open, close } : null;
  };
  const fmtMin = (m: number) => { const h = Math.floor(m / 60), mm = m % 60, p = h >= 12 ? "PM" : "AM", h12 = ((h + 11) % 12) + 1; return `${h12}:${String(mm).padStart(2, "0")} ${p}`; };
  const trSlotsFor = (d: Date): string[] => {
    if (!tr) return [];
    const win = trWindowFor(d);
    if (win === "closed") return [];
    const open = win ? win.open : 9 * 60, close = win ? win.close : 18 * 60;
    const out: string[] = [];
    for (let m = Math.ceil(open / 60) * 60; m + 60 <= close; m += 60) out.push(fmtMin(m));
    return out;
  };
  const slotOccupied = (label: string, d: Date) => {
    const arr = occByDate.get(ymd(d));
    if (!arr || !arr.length) return false;
    const [h, m] = to24h(label).split(":").map(Number);
    const st = (h || 0) * 60 + (m || 0);
    return arr.some((o) => st < o.e && st + 60 > o.s);
  };

  // STAYS: only REAL conflicts (past + booked) block; host blocks are flagged
  // but selectable. SERVICES: host blocks hard-block the date (same as the
  // customer flow — no slots are offered on a blocked day). TRANSPORT: past,
  // closed weekdays, and whole-day booked dates block (hourly slots grey
  // individually via occByDate instead).
  const blockedOf = (d: Date) => {
    if (d < TODAY) return true;
    if (isService) return hostBlockedSet.has(ymd(d));
    if (isTransport) return trWindowFor(d) === "closed" || bookedSet.has(ymd(d));
    return bookedSet.has(ymd(d));
  };
  // Stays + transport: the partner's own blocked dates render struck-through
  // but stay SELECTABLE (they own the block; the server's on-behalf path skips
  // the block gate). Services keep hard-blocking (slot-based; matches the
  // customer flow's "no slots offered on a blocked day").
  const flaggedOf = (d: Date) => (!isService && hostBlockedSet.has(ymd(d)));
  const pickRange = (d: Date) => {
    if (!range.start || (range.start && range.end)) { setRange({ start: d, end: null }); return; }
    if (d <= range.start) { setRange({ start: d, end: null }); return; }
    // Stays occupy [start, d) (checkout-exclusive); transport day rentals
    // occupy the END day too, so include it in the walk.
    const stop = isTransport ? addDays(d, 1) : d;
    for (let cur = range.start; cur < stop; cur = addDays(cur, 1)) {
      if (blockedOf(cur)) {
        toast.error(t("m.bfg.rangeBooked", { defaultValue: "Your selection crosses a booked day. Pick different dates." }));
        return;
      }
    }
    setRange({ start: range.start, end: d });
  };

  // Transport mode/package derivation — same inference as the customer flow.
  const trModes = tr?.modes ?? [];
  const effTrMode = trMode || trModes[0] || "";
  const pkg = tr?.tours?.length ? tr.tours[Math.min(pkgSel, tr.tours.length - 1)] : null;
  const trSlots = isTransport && pickDate ? trSlotsFor(pickDate) : [];
  const trHoursMax = (() => {
    if (!isTransport || !pickDate || !slot) return 12;
    const win = trWindowFor(pickDate);
    if (!win || win === "closed") return 12;
    const toMin = (x: string) => { const [h, m] = (x || "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
    return Math.max(1, Math.min(12, Math.floor((win.close - toMin(to24h(slot))) / 60)));
  })();
  const trHoursEff = Math.min(trHours, trHoursMax);
  const trDays = isTransport && effTrMode === "day" && range.start && range.end
    ? Math.max(1, Math.min(30, Math.round((range.end.getTime() - range.start.getTime()) / 86400000) + 1))
    : 1;

  const nights = range.start && range.end ? Math.round((range.end.getTime() - range.start.getTime()) / 86400000) : 0;

  // Per-date price overrides (rupees) — listing-level, shadowed by the
  // selected room's own rows. Mirrors BookingScreen's priceMap fold so the
  // stay subtotal here matches the customer preview night-for-night.
  const priceMap = useMemo(() => {
    const m = new Map<string, number>();
    (availQ.data ?? []).forEach((a) => { if (a.roomTypeId == null && !a.blocked && a.price != null) m.set(a.date, a.price); });
    if (!isService && selRoomId) (availQ.data ?? []).forEach((a) => { if (a.roomTypeId === selRoomId && !a.blocked && a.price != null) m.set(a.date, a.price); });
    return m;
  }, [availQ.data, selRoomId, isService]);

  // Subtotal (rupees) — same math the customer BookingScreen uses per kind.
  const subtotal = useMemo(() => {
    if (isService) {
      if (!svc || !baseItem) return 0;
      const addOnsSum = [...addons].reduce((t2, i) => t2 + (svcAddOns[i]?.price ?? 0), 0);
      return baseItem.price + addOnsSum;
    }
    if (isTransport) {
      if (!tr || !effTrMode) return 0;
      if (effTrMode === "hourly") return tr.hourly * trHoursEff;
      if (effTrMode === "day") return tr.day * trDays;
      return pkg?.price ?? 0;
    }
    if (!stay || !range.start || !range.end) return 0;
    const rate = selectedRoom?.price ?? stay.price;
    // Host discount applies per night pre-round, mirroring the server's
    // subtotalForStayPaise — without it the QR/payment-link preview
    // overstates what the guest is actually charged.
    const pct = Math.max(0, Math.min(90, stay.discountPercent ?? 0));
    let sum = 0;
    for (let cur = range.start; cur < range.end; cur = addDays(cur, 1)) {
      const listRupees = priceMap.get(ymd(cur)) ?? rate;
      sum += Math.round(listRupees * 100 * (1 - pct / 100)) / 100;
    }
    return sum * Math.max(1, rooms);
  }, [isService, svc, baseItem, addons, svcAddOns, isTransport, tr, effTrMode, trHoursEff, trDays, pkg, stay, range.start, range.end, selectedRoom?.price, priceMap, rooms]);

  // Server-mirrored fee/GST preview — total equals the payment-link amount.
  const fees = useMemo(() => {
    if (subtotal <= 0) return null;
    return computeBookingFees({
      subtotal,
      category: isService ? (svc?.category ?? "service")
        : isTransport ? `driver-${effTrMode || "hourly"}`
        : (stay?.type || "stay"),
      nightlyPaise: entryType === "stay" && stay ? Math.round((selectedRoom?.price ?? stay.price) * 100) : null,
      discount: couponQuote ? Math.max(0, couponQuote.discountAmount) : 0,
      feeSpec,
    });
  }, [subtotal, isService, isTransport, effTrMode, svc?.category, stay, entryType, selectedRoom?.price, couponQuote, feeSpec]);

  const applyCoupon = async () => {
    const code = couponInput.trim();
    if (!code || !listingId || subtotal <= 0) return;
    setCouponBusy(true);
    setCouponMsg("");
    try {
      const q = await validateCoupon({ code, listingId, basePrice: subtotal });
      // Exact server discount — whole-rupee rounding drifted the preview
      // from the payment-link amount on fractional (percent) coupons.
      setCouponQuote({ code: q.code, discountAmount: Math.max(0, q.discountAmount) });
    } catch (e) {
      setCouponQuote(null);
      setCouponMsg((e as { message?: string } | undefined)?.message || t("m.bfg.badCoupon", { defaultValue: "That coupon can't be applied here." }));
    } finally {
      setCouponBusy(false);
    }
  };

  const digits = phone.replace(/\D/g, "");
  const emailOk = EMAIL_RE.test(email.trim());
  const contactReady = name.trim().length > 0 && digits.length >= 6 && emailOk && !submitting;
  const trScheduleReady = effTrMode === "hourly" ? (!!pickDate && !!slot)
    : effTrMode === "day" ? (!!range.start && !!range.end)
    : (!!pickDate && !!pkg?.id);
  const ready = isService
    ? !!svc && !!pickDate && !!slot && !!effMode && (effMode !== "at-home" || svcAddress.trim().length > 3) && contactReady
    : isTransport
    ? !!tr && !!effTrMode && trScheduleReady && pickup.trim().length > 2 && contactReady
    : !!stay && !!range.start && !!range.end && nights > 0 && contactReady;

  const submit = async () => {
    setSubmitting(true);
    try {
      const fullPhone = `${cc.code}${digits}`;
      const guest = { name: name.trim(), phone: fullPhone, email: email.trim() };
      let res: OnBehalfResult;
      if (isTransport) {
        if (!tr || !listingId || !effTrMode) return;
        const isHourly = effTrMode === "hourly";
        const isDay = effTrMode === "day";
        const rideDate = isDay ? range.start : pickDate;
        if (!rideDate) return;
        // Times mirror the customer flow: hourly = picked slot window;
        // day/package = nominal 09:00 the server widens to the working window.
        const startT = isHourly ? to24h(slot) : "09:00";
        res = await prepareOnBehalf(
          {
            listingType: "transport",
            listingId,
            serviceCategory: `driver-${effTrMode}`,
            scheduledDate: ymd(rideDate),
            startTime: startT,
            endTime: addHour(startT, isDay ? 8 : isHourly ? trHoursEff : 4),
            // Day rentals: EXCLUSIVE conflict end (last day + 1); the
            // inclusive display end travels as transportEndDate.
            endDate: isDay && range.end ? ymd(addDays(range.end, 1)) : undefined,
            transportMode: effTrMode as "hourly" | "day" | "package",
            transportHours: isHourly ? trHoursEff : undefined,
            transportDays: isDay ? trDays : undefined,
            transportEndDate: isDay && range.end ? ymd(range.end) : undefined,
            transportPackageId: effTrMode === "package" ? pkg!.id : undefined,
            pickupLocation: pickup.trim(),
            passengerCount: passengers,
            address: pickup.trim(),
            listingTitle: `${tr.vehicle} · ${tr.driver}`,
            couponCode: couponQuote?.code,
          },
          guest,
          { admin: asAdmin },
        );
      } else if (isService) {
        if (!svc || !listingId || !pickDate || !slot) return;
        const startT = to24h(slot);
        res = await prepareOnBehalf(
          {
            listingType: "service",
            listingId,
            serviceCategory: svc.category,
            scheduledDate: ymd(pickDate),
            // Same 1-hour service window the customer BookingScreen sends.
            startTime: startT,
            endTime: addHour(startT, 1),
            serviceMode: effMode,
            serviceAddress: effMode === "at-home" ? svcAddress.trim() : undefined,
            visitAddress: effMode === "visit-provider" ? (svc.address || svc.location || undefined) : undefined,
            meetingDetails: effMode === "online" ? (svc.onlineNote || "Provider will share the meeting link before the slot.") : undefined,
            slot,
            address: effMode === "at-home" ? svcAddress.trim() : undefined,
            serviceAddOns: [...addons].map((i) => svcAddOns[i]).filter(Boolean).map((a) => ({ id: a.id, label: a.name, price: a.price })),
            ...(variants && baseItem?.id ? {
              serviceCatalogId: baseItem.id,
              serviceCatalogName: baseItem.name,
              serviceCatalogBasePrice: baseItem.price,
            } : {}),
            listingTitle: svc.title,
            couponCode: couponQuote?.code,
          },
          guest,
          { admin: asAdmin },
        );
      } else {
        if (!stay || !listingId || !range.start || !range.end) return;
        res = await prepareOnBehalf(
          {
            listingId,
            serviceCategory: stay.type || "stay",
            scheduledDate: ymd(range.start),
            checkOutDate: ymd(range.end),
            startTime: "12:00",
            endTime: "11:00",
            roomTypeId: selectedRoom?.id,
            roomName: selectedRoom?.name,
            numberOfRooms: rooms > 1 ? rooms : undefined,
            guestCount: guests,
            listingTitle: stay.title,
            couponCode: couponQuote?.code,
          },
          guest,
          { admin: asAdmin },
        );
      }
      setResult(res);
      onCreated?.();
      toast.success(t("m.bfg.created", { defaultValue: "Payment link created — SMS + email sent to the guest." }));
    } catch (e) {
      toast.error(friendlyError(e, t("m.bfg.errGeneric", { defaultValue: "Could not create the booking. Please check the details and try again." })));
    } finally {
      setSubmitting(false);
    }
  };

  // Native share sheet instead of expo-clipboard: the OS sheet has "Copy"
  // built in on both platforms, and RN's Share is core — no native module,
  // so it can't crash a dev client built before the dependency existed
  // ("Cannot find native module 'ExpoClipboard'").
  const shareLink = async () => {
    if (!result) return;
    try {
      await Share.share({ message: result.paymentLink.shortUrl });
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* user dismissed the sheet */ }
  };
  const shareWhatsApp = () => {
    if (!result) return;
    const listingName = (isService ? svc?.title : isTransport ? (tr ? `${tr.vehicle} · ${tr.driver}` : undefined) : stay?.title) ?? "your booking";
    const msg = t("m.bfg.waMsg", {
      defaultValue: "Here's your booking at {{listing}}. Tap to pay securely: {{link}}",
      listing: listingName,
      link: result.paymentLink.shortUrl,
    });
    Linking.openURL(`https://wa.me/${cc.code.replace(/\D/g, "")}${digits}?text=${encodeURIComponent(msg)}`).catch(() => {});
  };

  const personLabel = (isService || isTransport)
    ? t("m.bfg.customer", { defaultValue: "customer" })
    : t("m.bfg.guest", { defaultValue: "guest" });

  return (
    <View style={[s.lob, { paddingTop: insets.top }]}>
      <View style={s.head}>
        <IconBtn name="x" onPress={onClose} />
        <View style={{ flex: 1 }}>
          <Text style={s.headTitle}>
            {(isService || isTransport)
              ? t("m.bfg.titleService", { defaultValue: "Book for a customer" })
              : t("m.bfg.title", { defaultValue: "Book for a guest" })}
          </Text>
          <Text style={s.headSub}>
            {result
              ? t("m.bfg.awaitingPayment", { defaultValue: "Awaiting the {{who}}'s payment", who: personLabel })
              : t("m.bfg.sub", { defaultValue: "They'll get a QR / link to pay — no account needed" })}
          </Text>
        </View>
      </View>

      {result ? (
        // ─── Success: QR the guest scans to pay ───
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40, alignItems: "center", gap: 14 }} showsVerticalScrollIndicator={false}>
          <View style={s.qrCard}>
            <QRCode value={result.paymentLink.shortUrl} size={196} />
          </View>
          <Text style={s.qrAmount}>₹{result.amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
          <Text style={s.qrHint}>
            {t("m.bfg.qrHint", { defaultValue: "{{name}} can scan this QR or tap the link we texted + emailed to pay.", name: name.trim() || t("m.bfg.theGuest", { defaultValue: "The guest" }) })}
          </Text>
          <Pressable style={s.linkRow} onPress={shareLink}>
            <Text style={s.linkTxt} numberOfLines={1}>{result.paymentLink.shortUrl}</Text>
            <Icon name={copied ? "check" : "share"} size={16} color={T.aubergine} />
          </Pressable>
          <View style={{ flexDirection: "row", gap: 10, width: "100%" }}>
            <Pressable style={[s.shareBtn, { flex: 1 }]} onPress={shareWhatsApp}>
              <Icon name="message" size={16} color={T.aubergine} />
              <Text style={s.shareTxt}>{t("m.bfg.whatsapp", { defaultValue: "WhatsApp" })}</Text>
            </Pressable>
            <View style={{ flex: 1 }}>
              <PrimaryButton label={t("m.bfg.bookAnother", { defaultValue: "Book another" })} onPress={() => {
                setResult(null); setRange({ start: null, end: null }); setPickDate(null); setSlot("");
                setName(""); setPhone(""); setEmail(""); setGuests(1); setRooms(1); setAddons(new Set());
                setPickup(""); setPassengers(1); setTrHours(2);
                setCouponInput(""); setCouponQuote(null); setCouponMsg("");
              }} />
            </View>
          </View>
        </ScrollView>
      ) : (
        <>
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 130 }} showsVerticalScrollIndicator={false}>
            {/* Listing */}
            <Text style={s.label}>{isService ? t("m.bfg.service", { defaultValue: "Service" }) : isTransport ? t("m.bfg.vehicle", { defaultValue: "Vehicle" }) : t("m.bfg.property", { defaultValue: "Property" })}</Text>
            <Pressable style={s.applies} onPress={() => setDropOpen(true)}>
              <Icon name={isService ? "sparkle" : isTransport ? "car" : "bedDouble"} size={15} color={T.terra} />
              <Text style={s.appliesTxt} numberOfLines={1}>
                {picked?.name ?? t("m.bfg.pickListing", { defaultValue: "Select…" })}
              </Text>
              <Icon name="chevD" size={16} color={T.muted} />
            </Pressable>

            {listingQ.isLoading && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14 }}>
                <ActivityIndicator size="small" color={T.aubergine} />
                <Text style={s.hint}>{t("m.bfg.loading", { defaultValue: "Loading…" })}</Text>
              </View>
            )}

            {/* ─── SERVICE FORM ─── */}
            {svc && (
              <>
                {variants && (
                  <>
                    <Text style={s.label}>{t("m.bfg.serviceOption", { defaultValue: "Service option" })}</Text>
                    <View style={{ gap: 8 }}>
                      {variants.map((v, i) => {
                        const active = i === Math.min(variantSel, variants.length - 1);
                        return (
                          <Pressable key={v.id ?? i} style={[s.roomRow, active && s.roomRowActive]} onPress={() => { setVariantSel(i); setAddons(new Set()); }}>
                            <Text style={[s.roomName, active && { color: "#fff" }]} numberOfLines={1}>{v.name}</Text>
                            <Text style={[s.roomPrice, active && { color: "rgba(255,255,255,0.85)" }]}>₹{v.price.toLocaleString("en-IN")}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </>
                )}

                {svcAddOns.length > 0 && (
                  <>
                    <Text style={s.label}>{t("m.bfg.addOns", { defaultValue: "Add-ons" })}</Text>
                    <View style={{ gap: 8 }}>
                      {svcAddOns.map((a, i) => {
                        const on = addons.has(i);
                        return (
                          <Pressable key={a.id ?? i} style={[s.roomRow, on && s.roomRowActive]} onPress={() => {
                            setAddons((p) => { const n = new Set(p); if (on) n.delete(i); else n.add(i); return n; });
                          }}>
                            <Text style={[s.roomName, on && { color: "#fff" }]} numberOfLines={1}>{a.name}</Text>
                            <Text style={[s.roomPrice, on && { color: "rgba(255,255,255,0.85)" }]}>+₹{a.price}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </>
                )}

                {svc.mode.length > 0 && (
                  <>
                    <Text style={s.label}>{t("m.bfg.mode", { defaultValue: "Service mode" })}</Text>
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      {svc.mode.map((m) => {
                        const active = m === effMode;
                        return (
                          <Pressable key={m} style={[s.modeChip, active && s.roomRowActive]} onPress={() => setMode(m)}>
                            <Text style={[s.modeTxt, active && { color: "#fff" }]}>{t(`m.bfg.mode_${m}`, { defaultValue: MODE_LBL[m] ?? m })}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    {effMode === "at-home" && (
                      <TextInput
                        style={[s.input, { marginTop: 10 }]}
                        value={svcAddress}
                        onChangeText={setSvcAddress}
                        placeholder={t("m.bfg.customerAddress", { defaultValue: "Customer's address" })}
                        placeholderTextColor={T.muted}
                      />
                    )}
                  </>
                )}

                <Text style={s.label}>{t("m.bfg.date", { defaultValue: "Date" })}</Text>
                <MonthCalendar
                  mode="single"
                  value={pickDate ?? undefined}
                  onPick={(d: Date) => { setPickDate(d); setSlot(""); }}
                  blockedOf={blockedOf}
                  priceOf={() => baseItem?.price ?? svc.price}
                  showPrice={false}
                  checkout={false}
                />

                {pickDate && (
                  <>
                    <Text style={s.label}>{t("m.bfg.timeSlot", { defaultValue: "Time slot" })}</Text>
                    {svc.slots.length === 0 && <Text style={s.hint}>{t("m.bfg.noSlots", { defaultValue: "This service has no bookable slots configured." })}</Text>}
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      {svc.slots.map((sl) => {
                        const taken = slotOccupied(sl, pickDate);
                        const active = sl === slot;
                        return (
                          <Pressable key={sl} disabled={taken} style={[s.slotChip, active && s.roomRowActive, taken && { opacity: 0.35 }]} onPress={() => setSlot(sl)}>
                            <Text style={[s.modeTxt, active && { color: "#fff" }, taken && { textDecorationLine: "line-through" }]}>{sl}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </>
                )}
              </>
            )}

            {/* ─── TRANSPORT FORM ─── */}
            {tr && (
              <>
                {trModes.length > 0 && (
                  <>
                    <Text style={s.label}>{t("m.bfg.bookingType", { defaultValue: "Booking type" })}</Text>
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      {trModes.map((m) => {
                        const active = m === effTrMode;
                        const lbl = m === "hourly" ? t("m.bfg.hourly", { defaultValue: "Hourly" }) : m === "day" ? t("m.bfg.dayRental", { defaultValue: "Day rental" }) : t("m.bfg.package", { defaultValue: "Package" });
                        return (
                          <Pressable key={m} style={[s.modeChip, active && s.roomRowActive]} onPress={() => { setTrMode(m); setSlot(""); setRange({ start: null, end: null }); setPickDate(null); }}>
                            <Text style={[s.modeTxt, active && { color: "#fff" }]}>{lbl}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </>
                )}

                {effTrMode === "package" && (tr.tours?.length ?? 0) > 0 && (
                  <>
                    <Text style={s.label}>{t("m.bfg.package", { defaultValue: "Package" })}</Text>
                    <View style={{ gap: 8 }}>
                      {tr.tours.map((p, i) => {
                        const active = i === Math.min(pkgSel, tr.tours.length - 1);
                        return (
                          <Pressable key={p.id || i} style={[s.roomRow, active && s.roomRowActive]} onPress={() => setPkgSel(i)}>
                            <Text style={[s.roomName, active && { color: "#fff" }]} numberOfLines={1}>{p.name}</Text>
                            <Text style={[s.roomPrice, active && { color: "rgba(255,255,255,0.85)" }]}>₹{p.price.toLocaleString("en-IN")}{p.hours ? ` · ${p.hours} hr` : ""}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </>
                )}

                <Text style={s.label}>{effTrMode === "day" ? t("m.bfg.rentalDates", { defaultValue: "Rental dates" }) : t("m.bfg.date", { defaultValue: "Date" })}</Text>
                {effTrMode === "day" ? (
                  <MonthCalendar
                    mode="range"
                    range={range}
                    onPick={pickRange}
                    blockedOf={blockedOf}
                    flaggedOf={flaggedOf}
                    priceOf={() => tr.day}
                    showPrice={false}
                    checkout={false}
                    note={t("m.bfg.dayNote", { defaultValue: "Both start and end days are rental days." })}
                  />
                ) : (
                  <MonthCalendar
                    mode="single"
                    value={pickDate ?? undefined}
                    onPick={(d: Date) => { setPickDate(d); setSlot(""); }}
                    blockedOf={blockedOf}
                    flaggedOf={flaggedOf}
                    priceOf={() => (effTrMode === "hourly" ? tr.hourly : pkg?.price ?? 0)}
                    showPrice={false}
                    checkout={false}
                  />
                )}

                {effTrMode === "hourly" && pickDate && (
                  <>
                    <Text style={s.label}>{t("m.bfg.startTime", { defaultValue: "Start time" })}</Text>
                    {trSlots.length === 0 && <Text style={s.hint}>{t("m.bfg.driverClosed", { defaultValue: "Driver is closed on this day." })}</Text>}
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      {trSlots.map((sl) => {
                        const taken = slotOccupied(sl, pickDate);
                        const active = sl === slot;
                        return (
                          <Pressable key={sl} disabled={taken} style={[s.slotChip, active && s.roomRowActive, taken && { opacity: 0.35 }]} onPress={() => setSlot(sl)}>
                            <Text style={[s.modeTxt, active && { color: "#fff" }, taken && { textDecorationLine: "line-through" }]}>{sl}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    {!!slot && (
                      <View style={{ marginTop: 12 }}>
                        <Text style={[s.label, { marginTop: 0 }]}>{t("m.bfg.hours", { defaultValue: "Hours (max {{max}})", max: trHoursMax })}</Text>
                        <Counter value={trHoursEff} min={1} max={trHoursMax} onChange={setTrHours} />
                      </View>
                    )}
                  </>
                )}

                <Text style={s.label}>{t("m.bfg.pickup", { defaultValue: "Pickup location" })}</Text>
                <TextInput style={s.input} value={pickup} onChangeText={setPickup} placeholder={t("m.bfg.pickupPh", { defaultValue: "Where should the driver pick them up?" })} placeholderTextColor={T.muted} />
                <View style={{ marginTop: 12 }}>
                  <Text style={[s.label, { marginTop: 0 }]}>{t("m.bfg.passengers", { defaultValue: "Passengers" })}</Text>
                  <Counter value={passengers} min={1} max={Math.max(1, tr.seats || 6)} onChange={setPassengers} />
                </View>
              </>
            )}

            {/* ─── STAY FORM ─── */}
            {stay && (
              <>
                {roomTypes && (
                  <>
                    <Text style={s.label}>{t("m.bfg.roomType", { defaultValue: "Room type" })}</Text>
                    <View style={{ gap: 8 }}>
                      {roomTypes.map((r) => {
                        const active = (selectedRoom?.id ?? null) === (r.id ?? null);
                        return (
                          <Pressable key={r.id ?? r.name} style={[s.roomRow, active && s.roomRowActive]} onPress={() => { setRoomId(r.id ?? null); setRange({ start: null, end: null }); setRooms(1); }}>
                            <Text style={[s.roomName, active && { color: "#fff" }]} numberOfLines={1}>{r.name}</Text>
                            <Text style={[s.roomPrice, active && { color: "rgba(255,255,255,0.85)" }]}>₹{r.price.toLocaleString("en-IN")}/night</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </>
                )}

                <Text style={s.label}>{t("m.bfg.dates", { defaultValue: "Dates" })}</Text>
                <MonthCalendar
                  mode="range"
                  range={range}
                  onPick={pickRange}
                  blockedOf={blockedOf}
                  flaggedOf={flaggedOf}
                  priceOf={() => selectedRoom?.price ?? stay.price}
                  showPrice={false}
                  checkout
                  note={t("m.bfg.calNote", { defaultValue: "Struck-through dates are blocked — you can still book over your own blocks." })}
                />
                {nights > 0 && (
                  <Text style={s.hint}>{t("m.bfg.nights", { defaultValue: "{{n}} night{{plural}}", n: nights, plural: nights === 1 ? "" : "s" })}</Text>
                )}

                <View style={{ flexDirection: "row", gap: 14, marginTop: 16 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.label, { marginTop: 0 }]}>{t("m.bfg.guests", { defaultValue: "Guests" })}</Text>
                    <Counter value={guests} min={1} max={stay.guests || 20} onChange={setGuests} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.label, { marginTop: 0 }]}>{t("m.bfg.rooms", { defaultValue: "Rooms" })}</Text>
                    <Counter value={rooms} min={1} max={Math.max(1, selectedRoom?.quantity ?? 1)} onChange={setRooms} />
                  </View>
                </View>
              </>
            )}

            {/* Coupon + price breakdown — shared by both kinds. The math is the
                same server mirror the customer BookingScreen previews with, so
                the total equals the payment-link amount. */}
            {(stay || svc || tr) && (
              <>
                <Text style={s.label}>{t("m.bfg.coupon", { defaultValue: "Coupon code" })}</Text>
                {couponQuote ? (
                  <View style={s.couponApplied}>
                    <Text style={s.couponAppliedTxt}>
                      {couponQuote.code} · {t("m.bfg.couponOff", { defaultValue: "₹{{amount}} off", amount: couponQuote.discountAmount })}
                    </Text>
                    <Pressable onPress={() => { setCouponQuote(null); setCouponInput(""); }}>
                      <Text style={s.couponRemove}>{t("m.bfg.remove", { defaultValue: "Remove" })}</Text>
                    </Pressable>
                  </View>
                ) : (
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <TextInput
                      style={[s.input, { flex: 1 }]}
                      value={couponInput}
                      onChangeText={(v) => { setCouponInput(v.toUpperCase()); setCouponMsg(""); }}
                      placeholder={t("m.bfg.couponOptional", { defaultValue: "Optional" })}
                      placeholderTextColor={T.muted}
                      autoCapitalize="characters"
                    />
                    <Pressable
                      style={[s.applyBtn, (!couponInput.trim() || couponBusy || subtotal <= 0) && { opacity: 0.45 }]}
                      disabled={!couponInput.trim() || couponBusy || subtotal <= 0}
                      onPress={applyCoupon}
                    >
                      {couponBusy
                        ? <ActivityIndicator size="small" color={T.aubergine} />
                        : <Text style={s.applyTxt}>{t("m.bfg.apply", { defaultValue: "Apply" })}</Text>}
                    </Pressable>
                  </View>
                )}
                {!!couponMsg && <Text style={s.err}>{couponMsg}</Text>}

                {fees && (
                  <View style={s.billCard}>
                    <View style={s.billRow}>
                      <Text style={s.billLabel} numberOfLines={1}>
                        {isService
                          ? `${baseItem?.name ?? svc?.title}${addons.size > 0 ? ` + ${t("m.bfg.addOnCount", { defaultValue: "{{n}} add-on{{plural}}", n: addons.size, plural: addons.size === 1 ? "" : "s" })}` : ""}`
                          : isTransport
                          ? (effTrMode === "hourly" ? `₹${tr?.hourly.toLocaleString("en-IN")} × ${trHoursEff} hr`
                            : effTrMode === "day" ? `₹${tr?.day.toLocaleString("en-IN")} × ${trDays} day${trDays === 1 ? "" : "s"}`
                            : pkg?.name ?? t("m.bfg.package", { defaultValue: "Package" }))
                          : t("m.bfg.nightsLine", { defaultValue: "{{n}} night{{plural}}{{rooms}}", n: nights, plural: nights === 1 ? "" : "s", rooms: rooms > 1 ? ` × ${rooms} rooms` : "" })}
                      </Text>
                      <Text style={s.billVal}>₹{fees.subtotal.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</Text>
                    </View>
                    {fees.discount > 0 && (
                      <View style={s.billRow}>
                        <Text style={[s.billLabel, { color: "#2f7d55" }]}>{t("m.bfg.couponRow", { defaultValue: "Coupon ({{code}})", code: couponQuote?.code })}</Text>
                        <Text style={[s.billVal, { color: "#2f7d55" }]}>−₹{fees.discount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</Text>
                      </View>
                    )}
                    <View style={s.billRow}>
                      <Text style={s.billLabel}>{t("m.bfg.platformFee", { defaultValue: "Platform fee" })}</Text>
                      <Text style={s.billVal}>₹{fees.platformFee.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</Text>
                    </View>
                    <View style={s.billRow}>
                      <Text style={s.billLabel}>{t("m.bfg.gst", { defaultValue: "GST ({{rate}}%)", rate: Math.round(fees.gstRate * 100) })}</Text>
                      <Text style={s.billVal}>₹{fees.taxes.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</Text>
                    </View>
                    <View style={s.billDivider} />
                    <View style={s.billRow}>
                      <Text style={s.billTotalLabel}>{t("m.bfg.totalPays", { defaultValue: "Total the {{who}} pays", who: personLabel })}</Text>
                      <Text style={s.billTotalVal}>₹{fees.total.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</Text>
                    </View>
                  </View>
                )}
              </>
            )}

            {/* Guest/customer details — all required */}
            {(stay || svc || tr) && (
              <>
                <Text style={s.label}>{isService ? t("m.bfg.customerDetails", { defaultValue: "Customer details" }) : t("m.bfg.guestDetails", { defaultValue: "Guest details" })}</Text>
                <TextInput style={s.input} value={name} onChangeText={setName} placeholder={isService ? t("m.bfg.customerName", { defaultValue: "Customer name" }) : t("m.bfg.guestName", { defaultValue: "Guest name" })} placeholderTextColor={T.muted} />
                <View style={s.phoneRow}>
                  <Pressable style={s.ccBtn} onPress={() => setCcOpen(true)}>
                    <Text style={{ fontSize: 16 }}>{cc.flag}</Text>
                    <Text style={s.ccTxt}>{cc.code}</Text>
                  </Pressable>
                  <TextInput
                    style={[s.input, { flex: 1, marginTop: 0 }]}
                    value={phone}
                    onChangeText={setPhone}
                    placeholder={t("m.bfg.phone", { defaultValue: "Phone (for the payment SMS)" })}
                    placeholderTextColor={T.muted}
                    keyboardType="phone-pad"
                    maxLength={cc.len + 4}
                  />
                </View>
                <TextInput style={[s.input, { marginTop: 10 }]} value={email} onChangeText={setEmail} placeholder={t("m.bfg.email", { defaultValue: "Email (gets the QR + link)" })} placeholderTextColor={T.muted} keyboardType="email-address" autoCapitalize="none" />
                {email.trim().length > 0 && !emailOk && (
                  <Text style={s.err}>{t("m.bfg.badEmail", { defaultValue: "Enter a valid email address." })}</Text>
                )}
              </>
            )}
          </ScrollView>

          {/* Sticky CTA */}
          <View style={[s.cta, { paddingBottom: Math.max(insets.bottom, 14) }]}>
            <PrimaryButton
              label={submitting
                ? t("m.bfg.creating", { defaultValue: "Creating…" })
                : t("m.bfg.create", { defaultValue: "Create booking & payment link" })}
              onPress={ready ? submit : () => {}}
              style={!ready ? { opacity: 0.45 } : undefined}
            />
          </View>
        </>
      )}

      {/* Listing dropdown */}
      <Modal visible={dropOpen} transparent animationType="fade" onRequestClose={() => setDropOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setDropOpen(false)}>
          <View style={s.dropCard}>
            <Text style={s.dropTitle}>{isService ? t("m.bfg.service", { defaultValue: "Service" }) : isTransport ? t("m.bfg.vehicle", { defaultValue: "Vehicle" }) : t("m.bfg.property", { defaultValue: "Property" })}</Text>
            {real.map((l) => (
              <Pressable key={l.apiId} style={s.dropRow} onPress={() => {
                setListingId(l.apiId!); setRoomId(null); setRange({ start: null, end: null });
                setVariantSel(0); setAddons(new Set()); setMode(""); setPickDate(null); setSlot(""); setRooms(1);
                setTrMode(""); setPkgSel(0); setTrHours(2); setPickup(""); setPassengers(1);
                setCouponInput(""); setCouponQuote(null); setCouponMsg("");
                setDropOpen(false);
              }}>
                <Text style={s.dropTxt} numberOfLines={1}>{l.name}</Text>
                {listingId === l.apiId && <Icon name="check" size={16} color={T.terra} />}
              </Pressable>
            ))}
            {real.length === 0 && <Text style={[s.dropTxt, { padding: 12 }]}>{t("m.bfg.noListings", { defaultValue: "No published listings yet." })}</Text>}
          </View>
        </Pressable>
      </Modal>

      {/* Country code picker */}
      <Modal visible={ccOpen} transparent animationType="fade" onRequestClose={() => setCcOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setCcOpen(false)}>
          <View style={s.dropCard}>
            {COUNTRIES.map((c) => (
              <Pressable key={c.code} style={s.dropRow} onPress={() => { setCc(c); setCcOpen(false); }}>
                <Text style={s.dropTxt}>{c.flag}  {c.name}  {c.code}</Text>
                {cc.code === c.code && <Icon name="check" size={16} color={T.terra} />}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  lob: { ...StyleSheet.absoluteFillObject, backgroundColor: T.bg, zIndex: 46 },
  head: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.surface },
  headTitle: { fontSize: 16, fontFamily: font.head, color: T.ink },
  headSub: { fontSize: 12, color: T.muted, fontFamily: font.body },
  label: { fontSize: 12.5, fontFamily: font.bodyHeavy, color: T.aubergine, marginTop: 16, marginBottom: 8 },
  input: { minHeight: 46, paddingHorizontal: 14, borderRadius: 13, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", fontSize: 14.5, fontFamily: font.bodySemi, color: T.ink, ...noOutline },
  applies: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 46, paddingHorizontal: 14, borderRadius: 13, borderWidth: 1, borderColor: "rgba(139,94,74,0.3)", backgroundColor: "rgba(139,94,74,0.07)" },
  appliesTxt: { flex: 1, fontSize: 14, fontFamily: font.bodyHeavy, color: T.aubergine },
  hint: { fontSize: 12, color: T.muted, fontFamily: font.body, marginTop: 8 },
  err: { fontSize: 11.5, color: T.coral, marginTop: 6, fontFamily: font.body },
  roomRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, minHeight: 46, paddingHorizontal: 14, borderRadius: 13, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },
  roomRowActive: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  roomName: { flex: 1, fontSize: 14, fontFamily: font.bodySemi, color: T.ink },
  roomPrice: { fontSize: 12.5, fontFamily: font.bodyBold, color: T.muted },
  modeChip: { paddingHorizontal: 12, minHeight: 40, alignItems: "center", justifyContent: "center", borderRadius: 12, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },
  modeTxt: { fontSize: 12.5, fontFamily: font.bodyBold, color: T.ink },
  slotChip: { paddingHorizontal: 14, minHeight: 40, alignItems: "center", justifyContent: "center", borderRadius: 12, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },
  couponApplied: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, minHeight: 44, paddingHorizontal: 14, borderRadius: 13, borderWidth: 1, borderColor: "rgba(47,125,85,0.35)", backgroundColor: "rgba(47,125,85,0.08)" },
  couponAppliedTxt: { flex: 1, fontSize: 13.5, fontFamily: font.bodyHeavy, color: "#2f7d55" },
  couponRemove: { fontSize: 12.5, fontFamily: font.bodyBold, color: "#2f7d55" },
  applyBtn: { paddingHorizontal: 16, minHeight: 46, alignItems: "center", justifyContent: "center", borderRadius: 13, borderWidth: 1, borderColor: "rgba(139,94,74,0.35)", backgroundColor: "rgba(139,94,74,0.08)" },
  applyTxt: { fontSize: 13.5, fontFamily: font.bodyHeavy, color: T.aubergine },
  billCard: { marginTop: 14, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.75)", gap: 7 },
  billRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  billLabel: { flex: 1, fontSize: 13, color: T.muted, fontFamily: font.body },
  billVal: { fontSize: 13, color: T.ink, fontFamily: font.bodySemi },
  billDivider: { height: 1, backgroundColor: T.line, marginVertical: 3 },
  billTotalLabel: { flex: 1, fontSize: 13.5, fontFamily: font.bodyHeavy, color: T.ink },
  billTotalVal: { fontSize: 15, fontFamily: font.headHeavy, color: T.ink },
  phoneRow: { flexDirection: "row", gap: 8, marginTop: 10, alignItems: "stretch" },
  ccBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, borderRadius: 13, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },
  ccTxt: { fontSize: 14, fontFamily: font.bodyBold, color: T.ink },
  cta: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12, backgroundColor: T.bg, borderTopWidth: 1, borderTopColor: T.line },
  qrCard: { padding: 18, borderRadius: 22, backgroundColor: "#fff", borderWidth: 1, borderColor: T.line, marginTop: 18 },
  qrAmount: { fontSize: 22, fontFamily: font.headHeavy, color: T.ink },
  qrHint: { fontSize: 13, color: T.muted, fontFamily: font.body, textAlign: "center", paddingHorizontal: 12 },
  linkRow: { flexDirection: "row", alignItems: "center", gap: 10, width: "100%", minHeight: 44, paddingHorizontal: 14, borderRadius: 13, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.7)" },
  linkTxt: { flex: 1, fontSize: 13, fontFamily: font.bodySemi, color: T.ink },
  shareBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: "rgba(139,94,74,0.35)", backgroundColor: "rgba(139,94,74,0.08)" },
  shareTxt: { fontSize: 14, fontFamily: font.bodyHeavy, color: T.aubergine },
  backdrop: { flex: 1, backgroundColor: "rgba(34,31,39,0.4)", alignItems: "center", justifyContent: "center", padding: 28 },
  dropCard: { width: "100%", maxWidth: 420, borderRadius: 20, backgroundColor: "#fff", paddingVertical: 8, paddingHorizontal: 6 },
  dropTitle: { fontSize: 12.5, fontFamily: font.bodyHeavy, color: T.muted, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 },
  dropRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingVertical: 13, paddingHorizontal: 12, borderRadius: 12 },
  dropTxt: { flex: 1, fontSize: 14.5, fontFamily: font.bodySemi, color: T.ink },
});
