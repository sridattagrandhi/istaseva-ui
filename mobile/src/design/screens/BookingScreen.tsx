// design/screens/BookingScreen.tsx — unified booking flow ported from booking.jsx.
// details → review → pay (Razorpay-style) → confirmation. Pricing mirrors the prototype.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet, Alert, KeyboardTypeOptions, Linking, Platform } from "react-native";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import * as Location from "expo-location";
import { Icon } from "../Icon";
import { AppBar, Counter, Ph, Segmented } from "../primitives";
import { Stay, Service, Transport, BLANK_STAY, BLANK_SERVICE, BLANK_TRANSPORT } from "../types";
import { useDesign } from "../DesignContext";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { isApiId } from "../api/listings";
import { AddressAutocomplete } from "../AddressAutocomplete";
import { geocodeAddress } from "../api/geocode";
import { useFeeSpec, useListingDetail } from "../api/hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { to24h, ymd, addHour, istToday, slotTooSoon } from "../api/bookings";
import { payForBooking, PaymentCancelledError } from "../api/payment";
import { displayRef } from "../reference";
import { fullPctLabel, gstStateCodeFromText, halfPctLabel, isInterStateText, splitTax } from "../gstStates";
import { track } from "../api/analyticsEvents";
import { validateCoupon } from "../api/coupons";
import { fetchAvailability, fetchBookedDates, fetchServiceBookings, fetchTransportBookings, fetchRoomAvailability } from "../api/dash";
import { toast } from "@/lib/toast";
import { computeBookingFees, insurancePremiumRupees } from "../pricing";
import { T, font, toneOf, rupee, noOutline, Tone } from "../theme";
import type { RootParamList } from "../Navigator";

// Narrow navigation surface — typed RootParamList navigation can't express the
// nested tab targets used here (navigate("Tabs", { screen: "Bookings" })).
type Nav = { navigate: (screen: string, params?: object) => void; goBack: () => void };
// Shape of the API error fields the handlers below read (axios-style).
type ApiErr = { message?: string; response?: { data?: { error?: { message?: string }; message?: string } } };

/* ---------------- date helpers ---------------- */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON_S = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["S", "M", "T", "W", "T", "F", "S"];
const WD_S = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
// India time, not device time — the marketplace is IST and the backend dates
// are IST, so "today"/past-date checks must use the Indian calendar date.
const TODAY = istToday();
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const sameDay = (a?: Date | null, b?: Date | null) => !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const fmtShort = (d?: Date | null) => (d ? `${d.getDate()} ${MON_S[d.getMonth()]}` : "—");
const fmtLong = (d?: Date | null) => (d ? `${WD_S[d.getDay()]}, ${d.getDate()} ${MON_S[d.getMonth()]}` : "—");
const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

const seedOf = (id: string) => [...String(id)].reduce((a, c) => a + c.charCodeAt(0), 7);
const dayKey = (d: Date) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
function hashDay(seed: number, d: Date) { let h = (dayKey(d) ^ (seed * 2654435761)) >>> 0; h = (Math.imul(h, 1103515245) + 12345) >>> 0; return h; }
function isBlocked(seed: number, d: Date) { if (startOfDay(d) < TODAY) return true; return hashDay(seed, d) % 100 < 13; }
function priceForDate(seed: number, base: number, d: Date) {
  const dow = d.getDay();
  let mult = dow === 5 || dow === 6 ? 1.18 : dow === 0 ? 1.08 : 1;
  if (hashDay(seed, d) % 19 === 0) mult *= 1.3;
  return Math.round((base * mult) / 10) * 10;
}
const compact = (n: number) => (n >= 1000 ? "₹" + (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "k" : "₹" + n);
function rangeTotal(priceOf: (d: Date) => number, start?: Date | null, end?: Date | null) {
  if (!start || !end) return { nights: 0, total: 0 };
  let t = 0, n = 0, cur = startOfDay(start); const e = startOfDay(end);
  while (cur < e) { t += priceOf(cur); n++; cur = addDays(cur, 1); }
  return { nights: n, total: t };
}
function defaultRange(blockedOf: (d: Date) => boolean) {
  let s = addDays(TODAY, 1);
  for (let i = 0; i < 90; i++, s = addDays(s, 1)) {
    if (blockedOf(s)) continue;
    if (!blockedOf(addDays(s, 1))) return { start: s, end: addDays(s, 2) };
  }
  return { start: addDays(TODAY, 1), end: addDays(TODAY, 3) };
}
function firstAvail(blockedOf: (d: Date) => boolean) {
  let d = addDays(TODAY, 1);
  for (let i = 0; i < 90; i++, d = addDays(d, 1)) if (!blockedOf(d)) return d;
  return addDays(TODAY, 1);
}

const COUPONS: Record<string, { label: string; type: "percent" | "flat"; value: number }> = {
  SAVE10: { label: "10% off", type: "percent", value: 10 },
  FIRST200: { label: "₹200 off first booking", type: "flat", value: 200 },
  TEMPLE50: { label: "₹50 off temple loops", type: "flat", value: 50 },
};
const MODE_LBL: Record<string, string> = { "at-home": "At home", "visit-provider": "At provider", online: "Online" };

/** Directions link for a free-text address — Apple Maps on iOS, Google Maps
 *  elsewhere. Both URLs hand off to the native maps app when installed. */
const mapsSearchUrl = (q: string) =>
  Platform.OS === "ios"
    ? `https://maps.apple.com/?q=${encodeURIComponent(q)}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;

// Transport booking-type options (filtered to the modes a driver offers).
const TR_BOOK_MODES: [string, string, string][] = [
  ["package", "landmark", "Package"], ["hourly", "clock", "Hourly"], ["day", "calendar", "Day rental"],
];
const TR_TIMES = ["6:00 AM", "8:00 AM", "4:00 PM"];

/* ---------------- Month calendar ---------------- */
// Exported for the host "Book for a guest" sheet (dash/BookForGuest), which
// reuses this exact calendar. `flaggedOf` is its addition: dates the host has
// blocked render with a distinct struck-through tint but stay SELECTABLE —
// the host owns the block and can book over it. Booked dates (real conflicts)
// still come through `blockedOf` and stay hard-disabled. Callers that omit
// `flaggedOf` (the whole customer flow) are byte-for-byte unchanged.
export function MonthCalendar({ mode, blockedOf, priceOf, isCustom, showPrice, value, range, onPick, note, checkout, flaggedOf }: {
  mode?: "range" | "single";
  blockedOf: (d: Date) => boolean;
  /** Only read when `showPrice` is set — callers that hide prices omit it. */
  priceOf?: (d: Date) => number;
  isCustom?: (d: Date) => boolean;
  showPrice?: boolean;
  value?: Date | null;
  range?: { start?: Date | null; end?: Date | null } | null;
  onPick: (d: Date) => void;
  note?: string;
  checkout?: boolean;
  flaggedOf?: (d: Date) => boolean;
}) {
  const { t } = useLanguage();
  const anchor = mode === "range" ? (range && range.start) || TODAY : value || TODAY;
  const [view, setView] = useState(() => monthStart(anchor));
  const y = view.getFullYear(), m = view.getMonth();
  const pad = new Date(y, m, 1).getDay();
  const dim = new Date(y, m + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < pad; i++) cells.push(null);
  for (let d = 1; d <= dim; d++) cells.push(new Date(y, m, d));
  const canPrev = y > TODAY.getFullYear() || (y === TODAY.getFullYear() && m > TODAY.getMonth());

  const cellState = (d: Date) => {
    if (mode === "range") {
      const { start, end } = range || {};
      if (sameDay(d, start) || sameDay(d, end)) return "endpoint";
      if (start && end && d > start && d < end) return "mid";
      return "";
    }
    return sameDay(d, value) ? "single" : "";
  };

  // Hotel check-out semantics (STAYS only — `checkout` prop): while choosing the
  // check-OUT date (a check-in is picked, no check-out yet), a date is selectable
  // as the end even if its own night is fully booked — you leave that morning,
  // you don't sleep there. The only requirement is that every NIGHT actually
  // stayed, [start, d), is free. Mirrors pickRange, which excludes the check-out
  // day. NOT applied to transport day rentals, where the end day IS occupied.
  const pickingCheckout = checkout && mode === "range" && range?.start && !range?.end;
  const isCheckoutCandidate = (d: Date) => {
    if (!pickingCheckout || !range?.start || !(d > range.start)) return false;
    for (let cur = range.start; cur < d; cur = addDays(cur, 1)) {
      if (blockedOf(cur)) return false;
    }
    return true;
  };

  return (
    <View style={s.cal}>
      <View style={s.calHead}>
        <Pressable style={[s.calNav, !canPrev && { opacity: 0.3 }]} disabled={!canPrev} onPress={() => setView(new Date(y, m - 1, 1))}>
          <Icon name="chevL" size={17} color={T.ink} />
        </Pressable>
        <Text style={s.calTitle}>{t(`m.booking.month.${MONTHS[m]}`, { defaultValue: MONTHS[m] })} {y}</Text>
        <Pressable style={s.calNav} onPress={() => setView(new Date(y, m + 1, 1))}>
          <Icon name="chevR" size={17} color={T.ink} />
        </Pressable>
      </View>
      <View style={s.calGrid}>
        {WD.map((w, i) => <Text key={"w" + i} style={s.calWd}>{t(`m.booking.wd1.${i}`, { defaultValue: w })}</Text>)}
        {cells.map((d, i) => {
          if (!d) return <View key={i} style={s.cell} />;
          const rawBlocked = blockedOf(d);
          // A booked night that's a valid check-OUT day is still selectable
          // (and not greyed) while the guest is choosing their check-out.
          const checkoutOk = isCheckoutCandidate(d);
          const blocked = rawBlocked && !checkoutOk;
          const st = cellState(d);
          // Range styling: endpoints get the dark chip; the days in between
          // get the SAME chip shape in a light tint — clean pills all the
          // way through, no contiguous band.
          const isEnd = st === "endpoint" || st === "single";
          const isMid = st === "mid";
          // Host-set custom price for this date — tint it so the guest sees the
          // special rate (mirrors the host calendar's custom-price styling).
          const custom = !rawBlocked && !isEnd && !isMid && isCustom && isCustom(d);
          // Host-blocked-but-bookable (Book for a guest only): struck-through
          // coral, still tappable.
          const flagged = !blocked && !isEnd && !isMid && flaggedOf && flaggedOf(d);
          return (
            <Pressable
              key={i}
              disabled={blocked}
              onPress={() => !blocked && onPick(d)}
              style={({ pressed }) => [s.cell, pressed && !blocked && { transform: [{ scale: 0.9 }] }]}
            >
              <View style={[s.cellChip, custom && s.cellChipCustom, isMid && s.cellMidChip, isEnd && s.cellEnd]}>
                <Text style={[s.cd, blocked && s.cdBlocked, flagged && { color: T.coral, textDecorationLine: "line-through" }, isEnd && { color: "#fff" }]}>{d.getDate()}</Text>
                {showPrice && !rawBlocked && <Text style={[s.cp, custom && { color: T.terra }, isEnd && { color: "rgba(255,255,255,0.85)" }]}>{compact(priceOf!(d))}</Text>}
              </View>
            </Pressable>
          );
        })}
      </View>
      {note && <Text style={s.calNote}>{note}</Text>}
    </View>
  );
}

function WeekStrip({ blockedOf, weekStart, value, onPick }: { blockedOf: (d: Date) => boolean; weekStart: Date; value?: Date | null; onPick: (d: Date) => void }) {
  const { t } = useLanguage();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 9, paddingVertical: 4 }}>
      {Array.from({ length: 7 }).map((_, i) => {
        const d = addDays(weekStart, i);
        const blocked = blockedOf(d);
        const active = sameDay(d, value);
        return (
          <Pressable key={i} disabled={blocked} onPress={() => onPick(d)} style={[s.dateCell, active && s.dateCellActive, blocked && { opacity: 0.32 }]}>
            <Text style={[s.dateWd, active && { color: "rgba(255,255,255,0.85)" }]}>{t(`m.booking.wd.${d.getDay()}`, { defaultValue: WD_S[d.getDay()] })}</Text>
            <Text style={[s.dateNum, active && { color: "#fff" }, blocked && s.strike]}>{d.getDate()}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function Progress({ i, total }: { i: number; total: number }) {
  return (
    <View style={s.steps}>
      {Array.from({ length: total }).map((_, k) => (
        <View key={k} style={[s.stepDot, (k < i || k === i) && s.stepDotOn]} />
      ))}
    </View>
  );
}

function Field({ icon, placeholder, value, onChangeText, keyboardType }: { icon: string; placeholder?: string; value?: string; onChangeText?: (v: string) => void; keyboardType?: KeyboardTypeOptions }) {
  return (
    <View style={s.field}>
      <Icon name={icon} size={18} color={T.terra} />
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={T.muted} keyboardType={keyboardType} style={s.fieldInput} />
    </View>
  );
}

export function BookingScreen() {
  const nav = useNavigation<Nav>();
  const route = useRoute<RouteProp<RootParamList, "Booking">>();
  const insets = useSafeAreaInsets();
  const { addBooking } = useDesign();
  const { user } = useAuth();
  const { t } = useLanguage();
  const { kind, id, mode: modeParam, roomIndex, variantIndex, addonIndexes } = route.params;
  // Transport booking mode is user-selectable in the modal (package / hourly /
  // day) — constrained below to the modes the driver actually offers. For
  // services the route param carries the service mode (at-home / visit / online).
  const [mode, setMode] = useState<string>(modeParam || "package");

  // Resolve the listing — real backend row when id is a UUID. The empty
  // placeholder only fills the transient load before real data arrives (the
  // booking is always reached from a real listing, usually already cached).
  const blank: Stay | Service | Transport = kind === "stay" ? BLANK_STAY : kind === "service" ? BLANK_SERVICE : BLANK_TRANSPORT;
  const { item: resolved } = useListingDetail(id, kind, blank);
  const stay = kind === "stay" ? (resolved as Stay) : null;
  const svc = kind === "service" ? (resolved as Service) : null;
  const tr = kind === "transport" ? (resolved as Transport) : null;
  // Server-resolved platform-fee spec (admin fee rules); legacy ₹3 fallback.
  const feeSpec = useFeeSpec(id ? String(id) : null);
  useEffect(() => { if (id) void track("booking_modal_opened", { listingId: String(id), listingType: kind, source: "booking_screen" }); }, [id, kind]);
  // Tour package — user-selectable when the driver offers more than one.
  // `id` is what the server prices against (notes.packageId).
  const [pkgSel, setPkgSel] = useState(0);
  const pkgTour = tr && tr.tours && tr.tours.length ? tr.tours[Math.min(pkgSel, tr.tours.length - 1)] : null;
  const pkgObj = pkgTour
    ? {
        id: pkgTour.id,
        price: pkgTour.price,
        title: pkgTour.name,
        hours: `${pkgTour.hours} hrs`,
        stops: pkgTour.places.map((p) => p.name).filter(Boolean).join(" · "),
      }
    : null;
  // Hourly rentals: rider picks how many hours (web parity — server caps at 24).
  const [trHours, setTrHours] = useState(4);
  // Day rentals: optional multi-day range (web parity). pickDate is the
  // rental START; trDayEnd null = single-day. Inclusive on both ends,
  // capped at 30 days to match the server's notes.days limit.
  const [trDayEnd, setTrDayEnd] = useState<Date | null>(null);
  useEffect(() => { setTrDayEnd(null); }, [mode]);
  // Snap the transport mode to one the driver actually offers once the listing
  // loads (e.g. a day-rental-only driver opened with a stale "package" param).
  const trModes = tr && tr.modes && tr.modes.length ? tr.modes : [];
  useEffect(() => {
    if (kind === "transport" && trModes.length && !trModes.includes(mode)) setMode(trModes[0]);
  }, [trModes.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const roomTypes = stay && stay.roomTypes ? stay.roomTypes : null;
  const seed = seedOf(id || "x");

  const [step, setStep] = useState(0);
  const [adults, setAdults] = useState(2);
  const [kids, setKids] = useState(1);
  const [slot, setSlot] = useState(1);
  const [passengers, setPassengers] = useState(1);
  const [addr, setAddr] = useState("");
  const [locating, setLocating] = useState(false);
  const [roomSel, setRoomSel] = useState(roomIndex ?? 0);
  const [roomQty, setRoomQty] = useState(1);
  const [protect, setProtect] = useState(false);
  const [code, setCode] = useState("");
  const [applied, setApplied] = useState<{ code: string; label: string; discountAmount: number } | null>(null);
  const [couponMsg, setCouponMsg] = useState("");
  const [paying, setPaying] = useState(false);

  const selectedRoom = roomTypes ? roomTypes[roomSel] : null;
  const stayRate = selectedRoom ? selectedRoom.price : stay ? stay.price : 0;
  // Host ceiling: how many of THIS room type exist (capped 1–20, mirrors web).
  const hostMaxRooms = Math.max(1, Math.min(20, Number(selectedRoom?.quantity ?? 1) || 1));
  const guestCap = roomTypes ? roomQty * (selectedRoom ? selectedRoom.sleeps : 1) : stay ? stay.guests : 99;
  useEffect(() => {
    if (!stay) return;
    if (adults + kids > guestCap) {
      const a = Math.min(adults, guestCap);
      setAdults(Math.max(1, a));
      setKids(Math.max(0, guestCap - Math.max(1, a)));
    }
  }, [roomQty, roomSel, guestCap]);

  // Real host availability + already-booked dates for real (UUID) listings.
  // Mock/slug listings keep the deterministic hash so the demo stays rich.
  const realAvail = isApiId(id);
  const availQ = useQuery({ queryKey: ["availability", id], queryFn: () => fetchAvailability(id), enabled: realAvail, staleTime: 60_000, retry: 1 });
  const bookedQ = useQuery({ queryKey: ["booked-dates", id, selectedRoom?.id ?? null], queryFn: () => fetchBookedDates(id, selectedRoom?.id ?? undefined), enabled: realAvail, staleTime: 60_000, retry: 1 });
  // Per-slot occupancy for service listings (so we grey individual time slots,
  // not the whole day). staleTime 0 so a just-made booking shows immediately.
  const svcBookQ = useQuery({ queryKey: ["service-bookings", id], queryFn: () => fetchServiceBookings(id), enabled: realAvail && kind === "service", staleTime: 0, retry: 1 });
  // Per-slot transport bookings for HOURLY mode — same per-slot greying as
  // services. A day/package booking is stored across the whole working window,
  // so its interval blanks every hourly slot; an hourly booking only knocks out
  // its own hours. day/package modes use whole-day blocking (bookedQ) instead.
  const trBookQ = useQuery({ queryKey: ["transport-bookings", id], queryFn: () => fetchTransportBookings(id), enabled: realAvail && kind === "transport" && mode === "hourly", staleTime: 0, retry: 1 });
  // Fold availability overrides like the web (stay-pricing.foldAvailabilityOverrides):
  // listing-wide (roomTypeId null) blocks are GLOBAL; the selected room's own
  // blocks add on top. A room price override shadows the listing price, but
  // never on a listing-blocked date.
  const rid = selectedRoom?.id ?? null;
  const blockedSet = useMemo(() => {
    const set = new Set<string>();
    (availQ.data || []).forEach((a) => { if (a.roomTypeId == null && a.blocked) set.add(a.date); });
    if (rid) (availQ.data || []).forEach((a) => { if (a.roomTypeId === rid && a.blocked) set.add(a.date); });
    // booked-dates are WHOLE-day blocks — correct for stays and for transport
    // DAY/PACKAGE (whole-day modes). But NOT for services (a 10–11 booking
    // mustn't grey the whole day) and NOT for transport HOURLY (a 10–13 ride
    // mustn't grey 2–5pm). Those two use per-slot greying via occByDate below.
    const wholeDayBooked = kind === "stay" || (kind === "transport" && mode !== "hourly");
    if (wholeDayBooked) (bookedQ.data || []).forEach((d) => set.add(d));
    return set;
  }, [availQ.data, bookedQ.data, kind, mode, rid]);
  const minutesOf = (t: string) => { const [h, m] = (t || "").split(":").map(Number); return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0); };
  const fmtMin = (m: number) => { const h = Math.floor(m / 60), mm = m % 60, p = h >= 12 ? "PM" : "AM", h12 = ((h + 11) % 12) + 1; return `${h12}:${String(mm).padStart(2, "0")} ${p}`; };
  const occByDate = useMemo(() => {
    const map = new Map<string, { s: number; e: number }[]>();
    [...(svcBookQ.data || []), ...(trBookQ.data || [])].forEach((b) => {
      const arr = map.get(b.date) ?? [];
      arr.push({ s: minutesOf(b.start), e: minutesOf(b.end) });
      map.set(b.date, arr);
    });
    return map;
  }, [svcBookQ.data, trBookQ.data]);
  // Does the given slot label (e.g. "10:00 AM") overlap an existing booking on d?
  const slotOccupied = (label: string, d: Date) => {
    const arr = occByDate.get(ymd(d));
    if (!arr || !arr.length) return false;
    const st = minutesOf(to24h(label)), en = st + 60;
    return arr.some((o) => st < o.e && en > o.s);
  };
  const priceMap = useMemo(() => {
    const m = new Map<string, number>();
    const listingBlocked = new Set<string>();
    (availQ.data || []).forEach((a) => { if (a.roomTypeId == null && a.blocked) listingBlocked.add(a.date); });
    (availQ.data || []).forEach((a) => { if (a.roomTypeId == null && !a.blocked && a.price != null) m.set(a.date, a.price); });
    // Room-level price shadows the listing price — except where the listing is
    // blocked (the whole property is offline; a room price can't override that).
    if (rid) (availQ.data || []).forEach((a) => { if (a.roomTypeId === rid && !a.blocked && a.price != null && !listingBlocked.has(a.date)) m.set(a.date, a.price); });
    return m;
  }, [availQ.data, rid]);
  // Transport calendar rule (mirrors the server's hold-time gate): closed
  // weekdays are unbookable in EVERY mode — packages book the whole day and
  // their stated hours are descriptive, so there's no window-length math.
  // Listings without usable workingHours (legacy) are exempt — server too.
  const trWindowFor = (d: Date): { open: number; close: number } | "closed" | null => {
    const wh = tr?.workingHours;
    if (!wh || !Object.values(wh).some((s) => Array.isArray(s) && s.length === 2)) return null;
    const slot = wh[["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d.getDay()]];
    if (!Array.isArray(slot) || slot.length !== 2) return "closed";
    const open = minutesOf(slot[0]), close = minutesOf(slot[1]);
    return close > open ? { open, close } : null; // overnight/unparseable → don't enforce
  };
  const trUnbookable = (d: Date) => !!tr && trWindowFor(d) === "closed";
  // Hourly start slots for ANY date, derived from the driver's working window
  // (legacy listings without workingHours fall back to TR_TIMES). A function,
  // not a const, so the week strip can test every date — not just the picked
  // one — for the "is this whole day full?" check below.
  const trSlotsFor = (d: Date): string[] => {
    // Drop start slots that are already past / within the lead-time buffer on
    // today, so they never show and can't be picked. Future dates are untouched.
    const lead = (arr: string[]) => arr.filter((sl) => !slotTooSoon(sl, d));
    if (!tr) return lead(TR_TIMES);
    const win = trWindowFor(d);
    if (win === "closed") return [];
    if (!win) return lead(TR_TIMES);
    const out: string[] = [];
    for (let m = Math.ceil(win.open / 60) * 60; m + 60 <= win.close; m += 60) out.push(fmtMin(m));
    return lead(out);
  };
  // Hourly: a date is fully unavailable only when EVERY start slot overlaps an
  // existing booking. A day/package booking is stored across the whole working
  // window, so it occupies every slot (greying the date); an hourly booking
  // only knocks out its own hours (the other slots stay open).
  const hourlyDateFullyBooked = (d: Date): boolean => {
    const slots = trSlotsFor(d);
    return slots.length > 0 && slots.every((sl) => slotOccupied(sl, d));
  };
  const blockedOf = (d: Date) => {
    if (startOfDay(d) < TODAY) return true;
    if (trUnbookable(d)) return true;
    if (!realAvail) return isBlocked(seed, d);
    // Host blocks + whole-day booked dates (stays, transport day/package).
    // Transport HOURLY is deliberately NOT whole-day blocked here — its booked
    // dates live in occByDate and are tested per slot; the date only greys when
    // every slot is taken.
    if (blockedSet.has(ymd(d))) return true;
    if (kind === "transport" && mode === "hourly") return hourlyDateFullyBooked(d);
    return false;
  };
  const priceOf = (d: Date) => (realAvail ? priceMap.get(ymd(d)) ?? stayRate : priceForDate(seed, stayRate, d));

  const [range, setRange] = useState(() => (stay ? defaultRange(blockedOf) : { start: null as Date | null, end: null as Date | null }));
  const pickRange = (d: Date) => {
    if (!range.start || (range.start && range.end)) { setRange({ start: d, end: null }); return; }
    if (d <= range.start) { setRange({ start: d, end: null }); return; }
    let cur = range.start, ok = true;
    while (cur < d) { if (blockedOf(cur)) { ok = false; break; } cur = addDays(cur, 1); }
    if (!ok) {
      // Web parity: tell the guest why the range was rejected instead of
      // silently resetting (their selection spanned a blocked/booked night).
      toast.info(t("m.booking.range.blockedNight", { defaultValue: "Those dates include a blocked or already-booked night — starting a new selection." }));
      setRange({ start: d, end: null });
      return;
    }
    setRange({ start: range.start, end: d });
  };

  // Live remaining inventory of the selected room type across the picked range.
  // Caps the Rooms stepper to what's actually bookable (mirrors web). null while
  // loading / not applicable → host cap is the ceiling and the server's
  // createHold conflict check stays the final authority.
  const roomAvailQ = useQuery({
    queryKey: ["room-availability", id, selectedRoom?.id ?? null, range.start ? ymd(range.start) : null, range.end ? ymd(range.end) : null],
    queryFn: () => fetchRoomAvailability(id, selectedRoom!.id!, ymd(range.start!), ymd(range.end!)),
    enabled: realAvail && !!selectedRoom?.id && !!range.start && !!range.end,
    staleTime: 20_000,
    retry: 1,
  });
  const availableRooms = roomAvailQ.data ? roomAvailQ.data.remaining : null;
  const maxRooms = availableRooms != null ? Math.max(1, Math.min(hostMaxRooms, availableRooms)) : hostMaxRooms;
  const cappedByAvailability = availableRooms != null && availableRooms < hostMaxRooms;
  // Clamp the room count down whenever the cap drops (e.g. the guest extended
  // the stay into nights that have fewer rooms left).
  useEffect(() => { setRoomQty((n) => Math.min(Math.max(1, n), maxRooms)); }, [maxRooms]);

  const [pickDate, setPickDate] = useState(() => firstAvail(blockedOf));
  // The week strip ALWAYS starts on today so the user sees the current date and
  // the days right after it (booked/blocked days render greyed but visible),
  // rather than the strip jumping ahead to the first open date. The SELECTED
  // date still defaults to the first available one (pickDate above); explicit
  // calendar/strip picks re-anchor the strip via setWeekStart.
  const [weekStart, setWeekStart] = useState(() => TODAY);

  // When real availability resolves, drop any now-invalid initial selection.
  useEffect(() => {
    if (!realAvail || (!availQ.data && !bookedQ.data)) return;
    if (stay) {
      if (range.start && range.end) {
        let cur = startOfDay(range.start); let hit = false;
        while (cur < startOfDay(range.end)) { if (blockedSet.has(ymd(cur))) { hit = true; break; } cur = addDays(cur, 1); }
        if (hit) setRange(defaultRange(blockedOf));
      } else {
        setRange(defaultRange(blockedOf));
      }
    } else if (blockedSet.has(ymd(pickDate))) {
      // Move the SELECTED date to the first open one; leave the strip on today.
      setPickDate(firstAvail(blockedOf));
    }
  }, [blockedSet]);
  // Switching transport mode can make the picked date unbookable (closed
  // weekday) — snap forward to the first date that actually works so the
  // server never has to 400.
  useEffect(() => {
    if (!tr) return;
    // Snap off any date that's unpickable in the CURRENT mode — a closed
    // weekday, a host block, a day/package-booked date, or (hourly) a date
    // whose every slot is taken. blockedOf knows all four. occByDate is a dep
    // so this re-runs once per-slot transport bookings load.
    if (blockedOf(pickDate)) {
      // Move the SELECTED date to the first bookable one; leave the strip on today.
      setPickDate(firstAvail(blockedOf));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pkgSel, occByDate, tr?.workingHours && JSON.stringify(tr.workingHours)]);
  const [calOpen, setCalOpen] = useState(false);
  const pickSingle = (d: Date) => { setPickDate(d); setWeekStart(d); setCalOpen(false); };
  // Day-rental range picking — same semantics as the stay range picker:
  // first tap (or tapping at/before the start) restarts the range; a later
  // tap closes it after checking every day in between is bookable
  // (blockedOf already includes closed weekdays + booked/blocked days).
  const pickTrDay = (d: Date) => {
    if (trDayEnd || d.getTime() <= pickDate.getTime()) { setPickDate(d); setWeekStart(d); setTrDayEnd(null); return; }
    const days = Math.round((startOfDay(d).getTime() - startOfDay(pickDate).getTime()) / 86400000) + 1;
    // Over the 30-day cap or spanning an unavailable day → silently restart
    // the selection from the tapped date (no popup — the greyed days already
    // tell the story, and the alert got annoying fast).
    if (days > 30) { setPickDate(d); setWeekStart(d); setTrDayEnd(null); return; }
    let cur = new Date(pickDate); let ok = true;
    while (cur <= d) { if (blockedOf(cur)) { ok = false; break; } cur = addDays(cur, 1); }
    if (!ok) { setPickDate(d); setWeekStart(d); setTrDayEnd(null); return; }
    setTrDayEnd(d);
  };
  // Billable days — inclusive on both ends ("Wed–Fri" = 3), single-day default.
  const trDays = trDayEnd ? Math.max(1, Math.min(30, Math.round((startOfDay(trDayEnd).getTime() - startOfDay(pickDate).getTime()) / 86400000) + 1)) : 1;

  const [variantSel, setVariantSel] = useState(variantIndex ?? 0);
  // addonIndexes preselects the add-ons the user toggled on the detail
  // screen; the variant-switch reset below must skip its mount run or it
  // would immediately wipe that preset.
  const [addons, setAddons] = useState(() => new Set<number>(addonIndexes ?? []));
  const toggleAddon = (i: number) => setAddons((set) => { const n = new Set(set); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  // Each catalog variant (Men's / Women's / Kid's…) carries its OWN add-ons, so
  // resolve add-ons from the selected variant and reset the selection on switch.
  const svcBaseItem = svc ? (svc.variants ? svc.variants[variantSel] : { name: svc.title, price: svc.price, addOns: svc.addOns || [] }) : null;
  const svcAddOns = svcBaseItem?.addOns ?? [];
  const addonsMounted = useRef(false);
  useEffect(() => {
    if (!addonsMounted.current) { addonsMounted.current = true; return; }
    setAddons(new Set());
  }, [variantSel]);
  const addonTotal = svc ? svcAddOns.reduce((t, a, i) => t + (addons.has(i) ? a.price : 0), 0) : 0;

  // Host discount (listings.discount_percent) applies per NIGHT, pre-round,
  // exactly like the server's subtotalForStayPaise — the calendar keeps
  // showing the list price, but the charged subtotal must be the discounted
  // one or the Review screen overstates what Razorpay will collect.
  const hostDiscountPct = stay ? Math.max(0, Math.min(90, stay.discountPercent ?? 0)) : 0;
  const discountedNightOf = (d: Date) => Math.round(priceOf(d) * 100 * (1 - hostDiscountPct / 100)) / 100;
  const rangeCalc = stay ? rangeTotal(discountedNightOf, range.start, range.end) : { nights: 0, total: 0 };
  const nights = rangeCalc.nights;
  const stayTotal = rangeCalc.total * (roomTypes ? roomQty : 1);

  // Hourly start slots come from the driver's REAL working hours for the
  // picked date — every hour on the hour, last start leaving >=1h before
  // close. The hardcoded TR_TIMES mock only survives for legacy listings
  // without workingHours (and mock rows).
  const trSlots = trSlotsFor(pickDate);
  const trSlot = trSlots[Math.min(slot, Math.max(0, trSlots.length - 1))] ?? "";
  // The rental must END inside the day's window: cap the Hours stepper at
  // close − start so "8 AM + 4 hours" can't be offered on a day that closes
  // at 11 AM. The charged window is exactly start → start+hours.
  const trHoursMax = (() => {
    if (!tr) return 12;
    const win = trWindowFor(pickDate);
    if (!win || win === "closed" || !trSlot) return 12;
    return Math.max(1, Math.min(12, Math.floor((win.close - minutesOf(to24h(trSlot))) / 60)));
  })();
  const trHoursEff = Math.min(trHours, trHoursMax);

  let base = 0, label = "";
  if (stay) {
    base = stayTotal;
    const nightsLbl = nights !== 1 ? t("m.booking.label.nightsN", { defaultValue: "{{n}} nights", n: nights }) : t("m.booking.label.nights1", { defaultValue: "{{n}} night", n: nights });
    const offLbl = hostDiscountPct > 0 ? " · " + t("m.booking.label.hostDiscount", { defaultValue: "{{p}}% off", p: hostDiscountPct }) : "";
    label = `${nightsLbl}${selectedRoom ? " · " + selectedRoom.name : ""}${roomTypes && roomQty > 1 ? " × " + t("m.booking.label.roomsX", { defaultValue: "{{n}} rooms", n: roomQty }) : ""}${offLbl}`;
  }
  if (svc && svcBaseItem) { base = svcBaseItem.price + addonTotal; label = `${svcBaseItem.name} · ${svc.duration}`; }
  if (tr) {
    base = mode === "hourly" ? tr.hourly * trHoursEff : mode === "package" ? (pkgObj?.price ?? tr.day) : tr.day * trDays;
    label = mode === "package" ? (pkgObj?.title ?? t("m.booking.label.package", { defaultValue: "Package" }))
      : mode === "hourly" ? (trHoursEff !== 1 ? t("m.booking.label.hoursN", { defaultValue: "{{n}} hours", n: trHoursEff }) : t("m.booking.label.hours1", { defaultValue: "{{n}} hour", n: trHoursEff }))
      : trDays > 1 ? t("m.booking.label.daysX", { defaultValue: "{{n}} days × {{price}}", n: trDays, price: rupee(tr.day) }) : t("m.booking.label.fullDay", { defaultValue: "Full day" });
  }
  // Category string sent to the server as `serviceCategory` (see doPay). The
  // preview below uses the SAME string so the GST the guest previews equals
  // the GST the server charges (root CLAUDE.md "pricing parity" invariant).
  // Transport MUST send the Phase 6A mode category (driver-hourly/day/package)
  // — the server's pricing branch keys off the driver- prefix; a generic
  // "transport" string silently falls into the flat-price services branch
  // and the user gets charged the wrong amount.
  const bookingCategory = stay ? stay.type || "stay" : svc ? svc.category
    : mode === "package" ? "driver-package" : mode === "day" ? "driver-day" : "driver-hourly";
  const nightlyPaise = stay ? Math.round(stayRate * 100) : null;

  // Server-authoritative breakdown, mirrored: platform fee from the
  // server-resolved fee spec (admin fee rules; legacy flat ₹3 fallback),
  // category GST on the discounted subtotal, flat ₹2 protection after tax.
  const couponOff = applied ? Math.min(applied.discountAmount, base) : 0;
  const fees = computeBookingFees({
    subtotal: base,
    category: bookingCategory,
    nightlyPaise,
    discount: couponOff,
    insurance: protect ? insurancePremiumRupees(base) : 0,
    feeSpec,
  });
  const protectFee = fees.insurance;
  const fee = fees.platformFee;
  const tax = fees.taxes;
  const total = fees.total;

  // IGST vs CGST+SGST label preview (the server's pricing-breakdown stays
  // authoritative on the invoice): inter-state only when the customer-typed
  // address names a different state than the listing's. Stays never collect
  // a customer address → always intra-state (CGST+SGST). The tax AMOUNT is
  // identical either way — this only relabels the row(s).
  const gstInterState = svc && mode === "at-home"
    ? isInterStateText(svc.visitAddress || svc.address, addr)
    : tr ? isInterStateText(tr.area, addr) : false;
  const gstSplit = splitTax(tax, gstInterState);
  const gstRows: { label: string; value: string }[] = gstInterState
    ? [{ label: t("m.booking.row.igst", { defaultValue: "IGST ({{pct}}%)", pct: fullPctLabel(fees.gstRate) }), value: rupee(gstSplit.igst) }]
    : [
        { label: t("m.booking.row.cgst", { defaultValue: "CGST ({{pct}}%)", pct: halfPctLabel(fees.gstRate) }), value: rupee(gstSplit.cgst) },
        { label: t("m.booking.row.sgst", { defaultValue: "SGST ({{pct}}%)", pct: halfPctLabel(fees.gstRate) }), value: rupee(gstSplit.sgst) },
      ];

  const title = stay ? stay.title : svc ? svc.title : tr!.driver;
  const tone = stay ? stay.tone : svc ? svc.tone : tr!.tone;
  const icon = stay ? "bedDouble" : svc ? svc.icon : "car";
  const sub = stay ? stay.location : svc ? svc.provider : tr!.vehicle;

  const whenText = stay
    ? `${fmtShort(range.start)} → ${fmtShort(range.end)}`
    : svc
      ? `${fmtLong(pickDate)} · ${svc.slots[slot]}`
      : mode === "hourly"
        ? `${fmtLong(pickDate)} · ${trSlot}`
        : mode === "day" && trDayEnd
          ? `${fmtShort(pickDate)} → ${fmtShort(trDayEnd)}`
          : fmtLong(pickDate);

  const applyCoupon = async () => {
    const c = code.trim();
    if (!c) return;
    // Real listing + signed in → server-authoritative validation (the same
    // discount the booking write path will apply, so the preview matches).
    if (user && isApiId(id)) {
      try {
        const q = await validateCoupon({ code: c, listingId: id, basePrice: base });
        // Keep the EXACT rupee discount the server returned — rounding to a
        // whole rupee here made the Review total drift from the Razorpay
        // charge on fractional discounts (web removed the same rounding).
        const off = q.discountAmount;
        setApplied({ code: q.code, label: t("m.booking.coupon.offLabel", { defaultValue: "{{amount}} off", amount: rupee(off) }), discountAmount: off });
        setCouponMsg("");
      } catch (e) {
        const err = e as ApiErr;
        setApplied(null);
        setCouponMsg(err?.response?.data?.error?.message || err?.response?.data?.message || t("m.booking.coupon.notValid", { defaultValue: "Coupon not valid for this booking." }));
      }
      return;
    }
    // Demo fallback for mock listings (no backend coupon row exists).
    const hit = COUPONS[c.toUpperCase()];
    if (!hit) { setApplied(null); setCouponMsg(t("m.booking.coupon.notRecognised", { defaultValue: "Coupon not recognised. Try SAVE10." })); return; }
    const off = hit.type === "percent" ? Math.round((base * hit.value) / 100) : Math.min(hit.value, base);
    setApplied({ code: c.toUpperCase(), label: t(`m.booking.couponLabel.${c.toUpperCase()}`, { defaultValue: hit.label }), discountAmount: off });
    setCouponMsg("");
  };
  const clearCoupon = () => { setApplied(null); setCode(""); setCouponMsg(""); };

  // Autofill the pickup point from the device GPS (transport). Permission-gated;
  // reverse-geocodes to a human address, falling back to raw coordinates.
  const useMyLocation = async () => {
    if (locating) return;
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(t("m.booking.loc.offTitle", { defaultValue: "Location off" }), t("m.booking.loc.offMsg", { defaultValue: "Allow location access to autofill your pickup point." }));
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const [g] = await Location.reverseGeocodeAsync({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      const parts = g ? [g.name, g.street, g.city || g.subregion, g.postalCode].filter(Boolean) : [];
      setAddr(parts.length ? parts.join(", ") : `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`);
    } catch {
      Alert.alert(t("m.booking.loc.failTitle", { defaultValue: "Couldn't get location" }), t("m.booking.loc.failMsg", { defaultValue: "Please type your pickup point instead." }));
    } finally {
      setLocating(false);
    }
  };

  // For services, the chosen slot must be free on the chosen date (greyed slots
  // are blocked, but the default index could land on a booked one). Transport
  // hourly needs at least one real start slot on the picked day.
  const datesReady = stay ? !!(range.start && range.end)
    : svc ? svc.slots.length > 0 && !slotOccupied(svc.slots[slot], pickDate) && !slotTooSoon(svc.slots[slot], pickDate)
    : tr && mode === "hourly" ? trSlots.length > 0 && !!trSlot && !slotOccupied(trSlot, pickDate)
    : true;

  // Booking-confirm gate: dates + (transport) a pickup point. Contact
  // name/phone are NOT collected here anymore — the backend uses the
  // signed-in user's account details and the Razorpay sheet is prefilled
  // from the same source.
  // Transport needs a pickup point; at-home services need the customer's
  // address (web parity — the address is also geocode-verified at pay time).
  const pickupOk = tr
    ? addr.trim().length > 3
    : svc && mode === "at-home"
      ? addr.trim().length > 3
      : true;
  const canReview = datesReady && pickupOk;

  // Coordinates of a Places-picked address — precise by construction, so the
  // review gate and pay-time check skip re-geocoding it. Cleared on any
  // manual keystroke. (AddressAutocomplete already resolves these at pick
  // time; previously they were discarded.)
  const [addrGeo, setAddrGeo] = useState<{ lat: number; lng: number } | null>(null);
  // Set when a free-typed at-home address failed to resolve at review time.
  const [addrUnresolved, setAddrUnresolved] = useState(false);
  const [checkingAddr, setCheckingAddr] = useState(false);
  /**
   * At-home address must resolve to a real place — checked at REVIEW time so
   * a partial autofill ("Trident Hotels") can't sail through and then fail
   * at payment. Acceptance, most→least precise: Places pick → forward
   * geocode (coarse village/district points OK) → tier-3/4 safety net (text
   * names a real Indian state — allow rather than block a hamlet the
   * geocoder doesn't know). Same rule runs in doPay, so review-pass ==
   * pay-pass.
   */
  const addrResolvable = async (): Promise<boolean> => {
    if (addrGeo) return true;
    if (await geocodeAddress(addr)) return true;
    return gstStateCodeFromText(addr) != null;
  };

  // Review-gate UX: the CTA stays tappable — tapping with missing fields
  // red-highlights them and scrolls the first one into view instead of
  // silently doing nothing (web parity).
  const [showErrors, setShowErrors] = useState(false);
  const formScrollRef = useRef<ScrollView>(null);
  const dateSecRef = useRef<View>(null);
  const addrSecRef = useRef<View>(null);
  const scrollToSection = (ref: React.RefObject<View>) => {
    const inner = formScrollRef.current?.getInnerViewNode?.();
    if (!inner || !ref.current) return;
    ref.current.measureLayout(inner, (_x: number, y: number) => formScrollRef.current?.scrollTo({ y: Math.max(0, y - 90), animated: true }), () => {});
  };
  const onReviewGate = async () => {
    if (!canReview) {
      setShowErrors(true);
      scrollToSection(!datesReady ? dateSecRef : addrSecRef);
      return;
    }
    // At-home services: verify the address resolves BEFORE review — a
    // partial autofill used to pass here and only fail at payment.
    if (svc && mode === "at-home") {
      if (checkingAddr) return;
      setCheckingAddr(true);
      const ok = await addrResolvable();
      setCheckingAddr(false);
      if (!ok) {
        setAddrUnresolved(true);
        setShowErrors(true);
        scrollToSection(addrSecRef);
        return;
      }
    }
    setAddrUnresolved(false);
    setStep(1);
  };
  const addrMissing = showErrors && !pickupOk;

  const [confirmedPrice, setConfirmedPrice] = useState<number | null>(null);
  // Real booking id from the pay flow — shown as the support reference on the
  // confirmation screen (mock rows keep the legacy pseudo-id).
  const [confBookingId, setConfBookingId] = useState<string | null>(null);
  // Driver/operator contact resolved by the server at prepare time — shown on
  // the confirmation screen ("who's coming + how to reach them").
  const [confDriver, setConfDriver] = useState<{ name: string | null; phone: string | null; vehicle: string | null; plate: string | null; color: string | null } | null>(null);

  const queryClient = useQueryClient();
  const finishLocal = (amount?: number) => {
    const paid = amount ?? total;
    setConfirmedPrice(paid);
    setPaying(false);
    setStep(3);
    // Refresh every list that should reflect the new booking. The guest
    // Bookings tab stays mounted in the tab navigator, so without this its
    // ["my-bookings","user"] query never refetches and the booking is missing
    // until a cold reload (the provider dashboard only worked because it
    // remounts on navigation). Mirrors the web's invalidate-on-success.
    queryClient.invalidateQueries({ queryKey: ["my-bookings"] });
    queryClient.invalidateQueries({ queryKey: ["service-bookings", id] });
    queryClient.invalidateQueries({ queryKey: ["transport-bookings", id] });
    queryClient.invalidateQueries({ queryKey: ["booked-dates", id] });
    queryClient.invalidateQueries({ queryKey: ["availability", id] });
    addBooking({
      id: "nb" + Math.round(paid) + nights,
      kind,
      title,
      sub: stay ? `${stay.location} · ${label}` : svc ? `${svc.provider} · ${MODE_LBL[mode] ? t(`m.booking.mode.${mode}`, { defaultValue: MODE_LBL[mode] }) : ""}` : `${tr!.vehicle}`,
      when: stay ? `${fmtShort(range.start)}–${fmtShort(range.end)} · ${nights}n` : svc ? `${fmtShort(pickDate)} · ${svc.slots[slot]}` : `${fmtShort(pickDate)}`,
      status: "confirmed",
      price: paid,
      tone,
      icon,
    });
  };

  const doPay = async () => {
    setPaying(true);
    // destCity pairs with the envelope's originCity in the origin→destination
    // rollup — mirror of the web booking modal's props.destCity.
    const destCity = stay?.city || svc?.city || tr?.city;
    void track("payment_started", {
      listingId: String(id),
      listingType: kind,
      source: "booking_screen",
      ...(destCity ? { props: { destCity } } : {}),
    });

    // Real, server-backed payment when signed in against a real (UUID) listing:
    // prepare → Razorpay checkout (native, when a live key is issued) → verify.
    if (user && isApiId(id)) {
      // Package pricing is id-matched server-side; a legacy row without ids
      // can't be priced — fail fast instead of letting the server 400.
      if (tr && mode === "package" && !pkgObj?.id) {
        toast.error(t("m.booking.pay.tourUnbookable", { defaultValue: "This tour can't be booked yet — ask the driver to re-save their packages." }));
        setPaying(false);
        return;
      }
      // At-home services: same acceptance ladder as the review gate (Places
      // pick → geocode → state-name safety net, see addrResolvable) so an
      // address that passed review can never fail here at pay time.
      if (svc && mode === "at-home") {
        const ok = await addrResolvable();
        if (!ok) {
          toast.error(t("m.booking.errAddressNotFound", { defaultValue: "We couldn't find that address. Pick a suggestion from the dropdown or add more detail (house, street, area)." }));
          setPaying(false);
          return;
        }
      }
      const startT = stay ? "12:00" : svc ? to24h(svc.slots[slot]) : mode === "hourly" ? to24h(trSlot) : "09:00";
      try {
        const res = await payForBooking(
          {
            kind, listingId: id,
            serviceCategory: bookingCategory,
            scheduledDate: ymd(stay ? range.start! : pickDate),
            // Hold end is EXCLUSIVE (last rental day + 1) so the conflict
            // check scans the whole range; transportEndDate carries the
            // inclusive display end for notes (web parity).
            endDate: stay ? ymd(range.end!) : tr && mode === "day" && trDayEnd ? ymd(addDays(trDayEnd, 1)) : undefined,
            startTime: startT,
            // Package times are cosmetic — the server widens driver-package
            // holds to a full-day window (00:00–23:59) so the tour blocks
            // the driver's whole day.
            endTime: stay ? "11:00"
              : addHour(startT, mode === "day" ? 8 : svc ? 1 : tr && mode === "hourly" ? trHoursEff : 4),
            // Phase 6A structured transport fields — the server builds the
            // canonical notes from these (a raw client `notes` JSON string is
            // ignored by the unified prepare endpoint) and prices off them:
            // durationHours × hourly rate / days × day rate / the
            // packageId-matched package price.
            transportMode: tr ? (mode as "hourly" | "day" | "package") : undefined,
            transportHours: tr && mode === "hourly" ? trHoursEff : undefined,
            transportDays: tr && mode === "day" ? trDays : undefined,
            transportEndDate: tr && mode === "day" && trDayEnd ? ymd(trDayEnd) : undefined,
            transportPackageId: tr && mode === "package" ? pkgObj!.id : undefined,
            pickupLocation: tr ? addr.trim() || undefined : undefined,
            passengerCount: tr ? passengers : undefined,
            agreedPrice: total,
            address: addr || undefined,
            couponCode: applied?.code,
            insuranceOptIn: protect,
            numberOfRooms: roomTypes ? roomQty : undefined,
            // Multi-room stays: price the selected room type (else subtotal ₹0).
            roomTypeId: selectedRoom?.id,
            guestCount: tr ? passengers : stay ? adults + kids : undefined,
            // Service selection so the server prices the chosen variant + add-ons.
            serviceMode: svc ? mode : undefined,
            serviceCatalogId: svc && svc.variants ? svc.variants[variantSel].id : undefined,
            serviceCatalogName: svc ? svcBaseItem!.name : undefined,
            serviceCatalogBasePrice: svc ? svcBaseItem!.price : undefined,
            serviceAddOns: svc ? [...addons].map((i) => svcAddOns[i]).filter(Boolean).map((a) => ({ id: a.id, label: a.name, price: a.price })) : undefined,
          },
          // Contact details are no longer collected in the modal — prefill the
          // payment sheet from the signed-in user's account. The backend
          // snapshots the guest name from the same account server-side.
          { name: user?.name || undefined, contact: user?.phone || undefined, email: user?.email || undefined, description: title },
        );
        if (res.pending) {
          // Razorpay AUTHORIZED but capture is still in flight — the booking
          // stays pending until the payment.captured webhook lands. Web shows
          // a "processing" stage here; a full "Booking confirmed" screen
          // would be a lie if capture later fails.
          setPaying(false);
          queryClient.invalidateQueries({ queryKey: ["my-bookings"] });
          Alert.alert(
            t("m.booking.pay.processingTitle", { defaultValue: "Payment processing" }),
            t("m.booking.pay.processingMsg", { defaultValue: "Your payment was received and is being confirmed. The booking will appear in your Bookings once the payment completes — no further action needed." }),
          );
          return;
        }
        if (res.driver) setConfDriver(res.driver);
        setConfBookingId(res.bookingId);
        finishLocal(res.amount);
      } catch (e) {
        // Cancellation / failure must NOT show a confirmation.
        setPaying(false);
        if (e instanceof PaymentCancelledError) {
          Alert.alert(t("m.booking.pay.cancelledTitle", { defaultValue: "Payment cancelled" }), t("m.booking.pay.cancelledMsg", { defaultValue: "No charge was made. You can try again when you're ready." }));
        } else {
          console.warn("booking payment failed", e);
          // Surface the server's reason verbatim — availability/slot conflicts,
          // overbooking ("Only N rooms available…"), price drift, and the
          // 3-pending-holds limit all arrive here before any charge.
          Alert.alert(t("m.booking.pay.failTitle", { defaultValue: "Couldn't complete booking" }), (e as ApiErr)?.message || t("m.booking.pay.failMsg", { defaultValue: "Something went wrong. Please try again." }));
        }
      }
      return;
    }

    // Demo browsing (signed-out or mock listing) — simulated confirmation.
    setTimeout(() => finishLocal(), 600);
  };

  if (step === 3) {
    // Mirror the web confirmation (SuccessBody): schedule facts + a fare
    // summary, alongside the headline total. Rows reuse the SAME values the
    // Review screen showed, so the breakdown matches what was charged.
    const confFacts: { label: string; value: string }[] = [
      { label: stay ? t("m.booking.fact.dates", { defaultValue: "Dates" }) : t("m.booking.fact.when", { defaultValue: "When" }), value: stay ? `${fmtLong(range.start)} → ${fmtShort(range.end)}` : whenText },
      ...(stay ? [{ label: t("m.booking.fact.guests", { defaultValue: "Guests" }), value: `${adults > 1 ? t("m.booking.value.adultsN", { defaultValue: "{{n}} adults", n: adults }) : t("m.booking.value.adults1", { defaultValue: "{{n}} adult", n: adults })}${kids ? `, ${kids !== 1 ? t("m.booking.value.kidsN", { defaultValue: "{{n}} kids", n: kids }) : t("m.booking.value.kids1", { defaultValue: "{{n}} kid", n: kids })}` : ""}` }] : []),
      ...(stay && selectedRoom ? [{ label: t("m.booking.fact.room", { defaultValue: "Room" }), value: `${roomQty} × ${selectedRoom.name}` }] : []),
      ...(svc ? [{ label: t("m.booking.fact.duration", { defaultValue: "Duration" }), value: svc.duration }] : []),
      ...(svc && svcBaseItem ? [{ label: t("m.booking.fact.service", { defaultValue: "Service" }), value: svcBaseItem.name }] : []),
      ...(tr ? [{ label: t("m.booking.fact.booking", { defaultValue: "Booking" }), value: label }] : []),
      ...(tr ? [{ label: t("m.booking.fact.vehicle", { defaultValue: "Vehicle" }), value: confDriver?.vehicle || tr.vehicle }] : []),
      // Vehicle colour + plate so the rider can spot the car.
      ...(tr && (confDriver?.color || tr.color) ? [{ label: t("m.booking.fact.colour", { defaultValue: "Colour" }), value: (confDriver?.color || tr.color) as string }] : []),
      ...(tr && (confDriver?.plate || tr.plate) ? [{ label: t("m.booking.fact.plate", { defaultValue: "Number plate" }), value: (confDriver?.plate || tr.plate) as string }] : []),
      // Driver name + phone — who's coming and how to reach them.
      ...(tr && confDriver?.name ? [{ label: t("m.booking.fact.driver", { defaultValue: "Driver" }), value: confDriver.name }] : []),
      ...(tr && confDriver?.phone ? [{ label: t("m.booking.fact.driverPhone", { defaultValue: "Driver phone" }), value: confDriver.phone }] : []),
      { label: stay ? t("m.booking.fact.property", { defaultValue: "Property" }) : svc ? t("m.booking.fact.where", { defaultValue: "Where" }) : t("m.booking.fact.pickup", { defaultValue: "Pickup" }), value: stay ? stay.location : svc ? (mode === "at-home" ? (addr || t("m.booking.value.yourAddress", { defaultValue: "Your address" })) : svc.location) : (addr || tr!.area) },
      ...(user?.name ? [{ label: t("m.booking.fact.bookedBy", { defaultValue: "Booked by" }), value: user?.phone ? `${user.name} · ${user.phone}` : user.name }] : []),
    ];
    const confRows: { label: string; value: string; green?: boolean }[] = [
      { label, value: rupee(stay ? stayTotal : svcBaseItem ? svcBaseItem.price : base) },
      ...(svc ? [...addons].map((i) => svcAddOns[i]).filter(Boolean).map((a) => ({ label: a.name, value: `+${rupee(a.price)}` })) : []),
      ...(applied ? [{ label: `${t("m.booking.row.coupon", { defaultValue: "Coupon" })} · ${applied.code}`, value: `−${rupee(couponOff)}`, green: true }] : []),
      ...(protect ? [{ label: t("m.booking.row.protection", { defaultValue: "Protection" }), value: rupee(protectFee) }] : []),
      { label: t("m.booking.row.platformFee", { defaultValue: "Platform fee" }), value: rupee(fee) },
      ...gstRows,
    ];
    return <Confirmation total={confirmedPrice ?? total} title={title} sub={sub} tone={tone} icon={icon} kind={kind} facts={confFacts} rows={confRows} insetTop={insets.top} insetBottom={insets.bottom} nav={nav} bookingId={confBookingId} />;
  }

  const reviewCta = kind === "stay" ? t("m.booking.cta.confirmPay", { defaultValue: "Confirm & pay" }) : kind === "service" ? t("m.booking.cta.confirmBook", { defaultValue: "Confirm & book" }) : t("m.booking.cta.confirmRequest", { defaultValue: "Confirm & request" });
  const headTitle = step === 2 ? t("m.booking.head.payment", { defaultValue: "Payment" }) : step === 1 ? t("m.booking.head.review", { defaultValue: "Review & confirm" }) : kind === "stay" ? t("m.booking.head.bookStay", { defaultValue: "Book your stay" }) : kind === "service" ? t("m.booking.head.bookService", { defaultValue: "Book this service" }) : t("m.booking.head.requestTransport", { defaultValue: "Request transport" });

  return (
    <View style={{ flex: 1, backgroundColor: "#f4efe9" }}>
      <View style={{ paddingTop: insets.top }}>
        <AppBar title={headTitle} sub={title} onBack={() => (step === 0 ? nav.goBack() : setStep(step - 1))} />
        <View style={{ paddingHorizontal: 20, paddingBottom: 14 }}>
          <Progress i={step} total={3} />
        </View>
      </View>

      <ScrollView ref={formScrollRef} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 140 }} showsVerticalScrollIndicator={false}>
        {step === 0 && (
          <>
            {stay && (
              <>
                {roomTypes && (
                  <>
                    <Text style={s.secTitle}>{t("m.booking.roomType", { defaultValue: "Room type" })}</Text>
                    <View style={{ gap: 10 }}>
                      {roomTypes.map((r, i) => (
                        <Pressable key={i} style={({ pressed }) => [s.opt, roomSel === i && s.optActive, pressed && { opacity: 0.85, transform: [{ scale: 0.99 }] }]} onPress={() => setRoomSel(i)}>
                          <View style={s.optIco}><Icon name="bedDouble" size={20} color={T.aubergine} /></View>
                          <View style={{ flex: 1 }}>
                            <Text style={s.optStrong}>{r.name}</Text>
                            <Text style={s.optSub}>{t("m.booking.sleeps", { defaultValue: "Sleeps {{n}}", n: r.sleeps })} · {r.beds > 1 ? t("m.booking.bedsN", { defaultValue: "{{n}} beds", n: r.beds }) : t("m.booking.beds1", { defaultValue: "{{n}} bed", n: r.beds })}</Text>
                          </View>
                          <Text style={s.optPrice}>{rupee(r.price)}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </>
                )}

                <View ref={dateSecRef} collapsable={false} style={[s.secTitleRow, { marginTop: 24 }]}>
                  <Icon name="calendar" size={16} color={T.ink} />
                  <Text style={[s.secTitle, { marginTop: 0 }]}>{t("m.booking.checkInOut", { defaultValue: "Check-in → Check-out" })}</Text>
                </View>
                <View style={[s.rangeSummary, showErrors && !(range.start && range.end) && s.fieldErr]}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.rsLabel}>{t("m.booking.checkInLabel", { defaultValue: "CHECK-IN" })}</Text>
                    <Text style={s.rsVal} numberOfLines={1}>{range.start ? fmtLong(range.start) : t("m.booking.select", { defaultValue: "Select" })}</Text>
                  </View>
                  <Icon name="arrowR" size={16} color={T.muted} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.rsLabel}>{t("m.booking.checkOutLabel", { defaultValue: "CHECK-OUT" })}</Text>
                    <Text style={s.rsVal} numberOfLines={1}>{range.end ? fmtLong(range.end) : t("m.booking.select", { defaultValue: "Select" })}</Text>
                  </View>
                  <View style={s.rsNights}><Text style={s.rsNightsTxt}>{nights ? (nights > 1 ? t("m.booking.label.nightsN", { defaultValue: "{{n}} nights", n: nights }) : t("m.booking.label.nights1", { defaultValue: "{{n}} night", n: nights })) : "—"}</Text></View>
                </View>
                {showErrors && !(range.start && range.end) && (
                  <Text style={s.errTxt}>{t("m.booking.errPickDates", { defaultValue: "Select your check-in and check-out dates to continue." })}</Text>
                )}

                <View style={{ marginTop: 12 }}>
                  <MonthCalendar mode="range" checkout blockedOf={blockedOf} priceOf={priceOf} isCustom={(d: Date) => priceMap.has(ymd(d))} showPrice range={range} onPick={pickRange} note={t("m.booking.note.stayRange", { defaultValue: "Greyed dates are blocked or already booked. A fully-booked date can still be your check-out day." })} />
                </View>
                <View style={{ flexDirection: "row", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <Pressable style={({ pressed }) => [s.btnSmGhost, pressed && { opacity: 0.6, transform: [{ scale: 0.97 }] }]} onPress={() => setRange({ start: null, end: null })}><Text style={s.btnSmTxt}>{t("m.booking.clearDates", { defaultValue: "Clear dates" })}</Text></Pressable>
                  {range.start && !range.end && <Text style={s.muted12}>{t("m.booking.pickCheckout", { defaultValue: "Now pick your check-out date" })}</Text>}
                </View>

                <View style={s.divider} />
                {roomTypes && (
                  <>
                    <View style={s.rowBetween}>
                      <Text style={[s.secTitle, { marginTop: 0, marginBottom: 0 }]}>{t("m.booking.rooms", { defaultValue: "Rooms" })}</Text>
                      <Counter
                        value={roomQty}
                        min={1}
                        max={maxRooms}
                        onChange={setRoomQty}
                        onLimit={(which) => {
                          if (which !== "max") return;
                          toast.info(
                            cappedByAvailability
                              ? (availableRooms === 1
                                  ? t("m.booking.rooms.onlyAvail1", { defaultValue: "Only {{n}} {{room}} room available for these dates.", n: availableRooms, room: selectedRoom!.name })
                                  : t("m.booking.rooms.onlyAvailN", { defaultValue: "Only {{n}} {{room}} rooms available for these dates.", n: availableRooms, room: selectedRoom!.name }))
                              : (hostMaxRooms === 1
                                  ? t("m.booking.rooms.hostHas1", { defaultValue: "This room type only has {{n}} room.", n: hostMaxRooms })
                                  : t("m.booking.rooms.hostHasN", { defaultValue: "This room type only has {{n}} rooms.", n: hostMaxRooms })),
                          );
                        }}
                      />
                    </View>
                    <Text style={[s.muted12, { marginTop: 4 }]}>{t("m.booking.rooms.summary", { defaultValue: "{{room}} · each sleeps {{sleeps}} · sleeps up to {{cap}} across {{qty}} {{roomWord}}", room: selectedRoom!.name, sleeps: selectedRoom!.sleeps, cap: guestCap, qty: roomQty, roomWord: roomQty > 1 ? t("m.booking.word.roomsPlural", { defaultValue: "rooms" }) : t("m.booking.word.roomSingular", { defaultValue: "room" }) })}</Text>
                    <Text style={[s.muted12, { marginBottom: 14, marginTop: 2 }, cappedByAvailability && { color: T.terra, fontFamily: font.bodyHeavy }]}>
                      {cappedByAvailability
                        ? (availableRooms === 1
                            ? t("m.booking.rooms.left1", { defaultValue: "Only {{n}} room of this type left for these dates", n: availableRooms })
                            : t("m.booking.rooms.leftN", { defaultValue: "Only {{n}} rooms of this type left for these dates", n: availableRooms }))
                        : (hostMaxRooms === 1
                            ? t("m.booking.rooms.upTo1", { defaultValue: "Up to {{n}} room of this type", n: hostMaxRooms })
                            : t("m.booking.rooms.upToN", { defaultValue: "Up to {{n}} rooms of this type", n: hostMaxRooms }))}
                    </Text>
                  </>
                )}
                <View style={s.rowBetween}>
                  <Text style={[s.secTitle, { marginTop: roomTypes ? 8 : 0, marginBottom: 0 }]}>{t("m.booking.guests", { defaultValue: "Guests" })}</Text>
                  <Text style={s.muted12}>{t("m.booking.upTo", { defaultValue: "Up to {{n}}", n: guestCap })}{adults + kids >= guestCap ? ` · ${t("m.booking.full", { defaultValue: "full" })}` : ""}</Text>
                </View>
                <View style={[s.rowBetween, { marginTop: 12 }]}>
                  <View><Text style={s.bold14}>{t("m.booking.adults", { defaultValue: "Adults" })}</Text><Text style={s.muted12}>{t("m.booking.age13", { defaultValue: "Age 13+" })}</Text></View>
                  <Counter value={adults} min={1} max={Math.max(1, guestCap - kids)} onChange={setAdults} />
                </View>
                <View style={[s.rowBetween, { marginTop: 16 }]}>
                  <View><Text style={s.bold14}>{t("m.booking.children", { defaultValue: "Children" })}</Text><Text style={s.muted12}>{t("m.booking.age212", { defaultValue: "Age 2–12" })}</Text></View>
                  <Counter value={kids} max={Math.max(0, guestCap - adults)} onChange={setKids} />
                </View>
              </>
            )}

            {svc && (
              <>
                {(svc.variants || svcAddOns.length > 0) && (
                  <>
                    <View style={[s.secTitleRow, { marginTop: 24 }]}>
                      <Icon name="sparkle" size={16} color={T.ink} />
                      <Text style={[s.secTitle, { marginTop: 0 }]}>{t("m.booking.servicesCatalog", { defaultValue: "Services catalog" })}</Text>
                    </View>
                    {svc.variants && (
                      <View style={[s.chipRow, { marginBottom: 12 }]}>
                        {svc.variants.map((v, i) => (
                          <Pressable key={i} style={({ pressed }) => [s.pill, variantSel === i && s.pillActive, pressed && { opacity: 0.8 }]} onPress={() => setVariantSel(i)}>
                            <Text style={[s.pillTxt, variantSel === i && { color: "#fff" }]}>{v.name} · {rupee(v.price)}</Text>
                          </Pressable>
                        ))}
                      </View>
                    )}
                    <View style={[s.catalogRow, { borderColor: "rgba(58,50,71,0.3)" }]}>
                      <View style={s.crCheck}><Icon name="checkSm" size={14} color="#fff" strokeWidth={2.8} /></View>
                      <Text style={s.catalogTxt}>{svcBaseItem!.name}</Text>
                      <Text style={s.catalogPrice}>{rupee(svcBaseItem!.price)}</Text>
                    </View>
                    {svcAddOns.map((a, i) => {
                      const on = addons.has(i);
                      return (
                        <Pressable key={i} style={({ pressed }) => [s.catalogRow, on && { borderColor: "rgba(58,50,71,0.35)" }, pressed && { opacity: 0.85 }]} onPress={() => toggleAddon(i)}>
                          <View style={[s.crAdd, on && { backgroundColor: T.aubergine, borderColor: T.aubergine }]}>
                            <Icon name={on ? "checkSm" : "plus"} size={13} color={on ? "#fff" : T.aubergine} strokeWidth={2.6} />
                          </View>
                          <Text style={s.catalogTxt}>{a.name}</Text>
                          <Text style={s.catalogPrice}>+{rupee(a.price)}</Text>
                        </Pressable>
                      );
                    })}
                  </>
                )}

                <View ref={dateSecRef} collapsable={false} style={[s.rowBetween, { marginTop: 24, marginBottom: 12 }]}>
                  <View style={s.secTitleRow}>
                    <Icon name="calendar" size={16} color={T.ink} />
                    <Text style={[s.secTitle, { marginTop: 0, marginBottom: 0 }]}>{t("m.booking.pickSlot", { defaultValue: "Pick a slot" })}</Text>
                  </View>
                  <Pressable style={({ pressed }) => [s.calToggle, calOpen && { backgroundColor: T.aubergine }, pressed && { opacity: 0.8 }]} onPress={() => setCalOpen((o) => !o)}>
                    <Icon name="calendar" size={18} color={calOpen ? "#fff" : T.ink} />
                  </Pressable>
                </View>
                {calOpen ? (
                  <MonthCalendar mode="single" blockedOf={blockedOf} value={pickDate} onPick={pickSingle} note={t("m.booking.note.svcSingle", { defaultValue: "Pick any future date. Greyed dates are unavailable." })} />
                ) : (
                  <WeekStrip blockedOf={blockedOf} weekStart={weekStart} value={pickDate} onPick={(d: Date) => setPickDate(d)} />
                )}
                <View style={s.confirmLine}><Icon name="check" size={14} color={T.terra} /><Text style={s.muted12}> {fmtLong(pickDate)}</Text></View>

                <Text style={s.secTitle}>{t("m.booking.timeSlot", { defaultValue: "Time slot" })}</Text>
                <View style={s.slotGrid}>
                  {svc.slots.map((sl, i) => {
                    // Past / within-lead-time slots on today are unbookable — hide
                    // them entirely (index preserved so `slot` selection stays valid).
                    if (slotTooSoon(sl, pickDate)) return null;
                    const occ = slotOccupied(sl, pickDate);
                    return (
                      <Pressable key={sl} disabled={occ} style={({ pressed }) => [s.slot, i === slot && !occ && s.slotActive, occ && s.slotTaken, pressed && !occ && { transform: [{ scale: 0.96 }] }]} onPress={() => !occ && setSlot(i)}>
                        <Text style={[s.slotTxt, i === slot && !occ && { color: "#fff" }, occ && s.slotTakenTxt]}>{sl}</Text>
                        {occ ? <Text style={s.slotTakenTag}>{t("m.booking.booked", { defaultValue: "Booked" })}</Text> : null}
                      </Pressable>
                    );
                  })}
                </View>
                {svc.slots.length === 0 && (
                  <Text style={s.muted12}>{t("m.booking.noSlots", { defaultValue: "No bookable time slots yet — the provider hasn't published their working hours. Try messaging them instead." })}</Text>
                )}
                {svc.slots.length > 0 && !svc.slots.some((sl) => !slotTooSoon(sl, pickDate) && !slotOccupied(sl, pickDate)) && (
                  <Text style={s.muted12}>{t("m.booking.noSlotsToday", { defaultValue: "No more slots available for this day — please pick another date." })}</Text>
                )}
                {showErrors && !datesReady && svc.slots.length > 0 && svc.slots.some((sl) => !slotTooSoon(sl, pickDate) && !slotOccupied(sl, pickDate)) && (
                  <Text style={s.errTxt}>{t("m.booking.errPickSlot", { defaultValue: "Pick an available time slot to continue." })}</Text>
                )}
                {mode === "at-home" && (
                  <>
                    <View ref={addrSecRef} collapsable={false} style={[s.rowBetween, { marginTop: 24, marginBottom: 10 }]}>
                      <Text style={[s.secTitle, { marginTop: 0, marginBottom: 0 }]}>{t("m.booking.yourAddress", { defaultValue: "Your address" })}</Text>
                      {/* Same GPS autofill as the transport pickup — both write
                          the shared `addr` field. */}
                      <Pressable onPress={useMyLocation} disabled={locating} style={({ pressed }) => [s.locBtn, pressed && { opacity: 0.7 }, locating && { opacity: 0.5 }]}>
                        <Icon name={locating ? "refresh" : "mappin"} size={13} color={T.terra} />
                        <Text style={s.locBtnTxt}>{locating ? t("m.booking.locating", { defaultValue: "Locating…" }) : t("m.booking.useLocation", { defaultValue: "Use current location" })}</Text>
                      </Pressable>
                    </View>
                    {/* zIndex: dropdown must overlay the sections below.
                        A pick captures the place's already-resolved lat/lng
                        (skips the review-time geocode); typing clears it. */}
                    <AddressAutocomplete
                      containerStyle={{ zIndex: 30 }}
                      value={addr}
                      onChangeText={(v) => { setAddr(v); setAddrGeo(null); setAddrUnresolved(false); }}
                      onPick={(desc, details) => { setAddr(desc); setAddrGeo(details ? { lat: details.lat, lng: details.lng } : null); setAddrUnresolved(false); }}
                      mode="address"
                      placeholder={t("m.booking.ph.flatStreet", { defaultValue: "Flat / house, street, landmark" })}
                      invalid={addrMissing || addrUnresolved}
                    />
                    {addrMissing && (
                      <Text style={s.errTxt}>{t("m.booking.errEnterAddress", { defaultValue: "Enter your address to continue." })}</Text>
                    )}
                    {!addrMissing && addrUnresolved && (
                      <Text style={s.errTxt}>{t("m.booking.errAddressNotFound", { defaultValue: "We couldn't find that address. Pick a suggestion from the dropdown or add more detail (house, street, area)." })}</Text>
                    )}
                  </>
                )}
                {mode === "visit-provider" && !!(svc.visitAddress || svc.address) && (
                  <>
                    <Text style={s.secTitle}>{t("m.booking.providerAddress", { defaultValue: "Provider address" })}</Text>
                    {/* Tapping the address opens directions — Apple Maps on
                        iOS, Google Maps elsewhere (web parity). */}
                    <Pressable
                      onPress={() => { void Linking.openURL(mapsSearchUrl(svc.visitAddress || svc.address)); }}
                      style={({ pressed }) => [s.mapsLinkRow, pressed && { opacity: 0.7 }]}
                    >
                      <View style={{ marginTop: 2.5 }}><Icon name="mappin" size={15} color={T.terra} /></View>
                      <Text style={s.mapsLinkTxt}>{svc.visitAddress || svc.address}</Text>
                    </Pressable>
                    <Text style={[s.muted12, { marginTop: 6 }]}>{t("m.booking.arriveEarlyNote", { defaultValue: "Please arrive 10 minutes early." })}</Text>
                  </>
                )}
              </>
            )}

            {tr && (
              <>
                {trModes.length > 1 && (
                  <>
                    <View style={[s.secTitleRow, { marginTop: 4, marginBottom: 12 }]}>
                      <Icon name="car" size={16} color={T.ink} />
                      <Text style={[s.secTitle, { marginTop: 0, marginBottom: 0 }]}>{t("m.booking.bookingType", { defaultValue: "Booking type" })}</Text>
                    </View>
                    <Segmented options={TR_BOOK_MODES.filter(([k]) => trModes.includes(k)).map(([k, ic, lb]) => [k, ic, t(`m.booking.trMode.${k}`, { defaultValue: lb })] as [string, string, string])} value={mode} onChange={setMode} small faint />
                  </>
                )}
                {mode === "package" && pkgObj && (
                  <>
                    <View style={[s.secTitleRow, { marginTop: 24 }]}>
                      <Icon name="sparkle" size={16} color={T.ink} />
                      <Text style={[s.secTitle, { marginTop: 0 }]}>{t("m.booking.tourPackage", { defaultValue: "Tour package" })}</Text>
                    </View>
                    {/* Multi-package drivers: pick which tour to book — the
                        server prices by the selected package's id. */}
                    {tr!.tours.length > 1 && (
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                        {tr!.tours.map((t, i) => (
                          <Pressable key={t.id || i} style={[s.slot, i === pkgSel && s.slotActive]} onPress={() => setPkgSel(i)}>
                            <Text style={[s.slotTxt, i === pkgSel && { color: "#fff" }]} numberOfLines={1}>{t.name}</Text>
                          </Pressable>
                        ))}
                      </View>
                    )}
                    <View style={s.glass}>
                      <View style={s.rowBetween}>
                        <Text style={{ fontSize: 16, fontFamily: font.head, color: T.ink, flex: 1 }}>{pkgObj.title}</Text>
                        <View style={s.darkTag}><Text style={s.darkTagTxt}>{rupee(pkgObj.price)}</Text></View>
                      </View>
                      <Text style={[s.muted12, { marginTop: 8 }]}>{pkgObj.hours}</Text>
                      <Text style={[s.body13, { marginTop: 12 }]}><Text style={{ fontFamily: font.bodyBold }}>{t("m.booking.stops", { defaultValue: "Stops:" })}</Text> {pkgObj.stops}</Text>
                    </View>
                  </>
                )}

                <View style={[s.rowBetween, { marginTop: 24, marginBottom: 12 }]}>
                  <View style={s.secTitleRow}>
                    <Icon name="calendar" size={16} color={T.ink} />
                    <Text style={[s.secTitle, { marginTop: 0, marginBottom: 0 }]}>{mode === "package" ? t("m.booking.tourDate", { defaultValue: "Tour date" }) : mode === "day" ? t("m.booking.rentalDate", { defaultValue: "Rental date" }) : t("m.booking.pickDate", { defaultValue: "Pick a date" })}</Text>
                  </View>
                  {/* Hourly uses the week strip by default; this toggles the full
                      month calendar so a rider can book further out (e.g. 2
                      weeks). day/package already render the month calendar. */}
                  {mode === "hourly" && (
                    <Pressable style={({ pressed }) => [s.calToggle, calOpen && { backgroundColor: T.aubergine }, pressed && { opacity: 0.8 }]} onPress={() => setCalOpen((o) => !o)}>
                      <Icon name="calendar" size={18} color={calOpen ? "#fff" : T.ink} />
                    </Pressable>
                  )}
                </View>

                {mode === "hourly" ? (
                  <>
                    {calOpen ? (
                      <MonthCalendar mode="single" blockedOf={blockedOf} value={pickDate} onPick={pickSingle} note={t("m.booking.note.trHourly", { defaultValue: "Pick any future date. Greyed dates are blocked." })} />
                    ) : (
                      <WeekStrip blockedOf={blockedOf} weekStart={weekStart} value={pickDate} onPick={(d: Date) => setPickDate(d)} />
                    )}
                    <Text style={s.secTitle}>{t("m.booking.pickupTime", { defaultValue: "Pickup time" })}</Text>
                    <View style={s.slotGrid}>
                      {trSlots.map((sl, i) => {
                        const occ = slotOccupied(sl, pickDate);
                        return (
                          <Pressable key={sl} disabled={occ} style={({ pressed }) => [s.slot, i === slot && !occ && s.slotActive, occ && s.slotTaken, pressed && !occ && { transform: [{ scale: 0.96 }] }]} onPress={() => !occ && setSlot(i)}>
                            <Text style={[s.slotTxt, i === slot && !occ && { color: "#fff" }, occ && s.slotTakenTxt]}>{sl}</Text>
                            {occ ? <Text style={s.slotTakenTag}>{t("m.booking.booked", { defaultValue: "Booked" })}</Text> : null}
                          </Pressable>
                        );
                      })}
                    </View>
                    {trSlots.length === 0 && (
                      <Text style={s.muted12}>{t("m.booking.noHourlySlots", { defaultValue: "No hourly slots on this day — pick another date." })}</Text>
                    )}
                    {showErrors && !datesReady && trSlots.length > 0 && (
                      <Text style={s.errTxt}>{t("m.booking.errPickSlot", { defaultValue: "Pick an available time slot to continue." })}</Text>
                    )}
                    <View style={[s.rowBetween, { marginTop: 16 }]}>
                      <View>
                        <Text style={s.bold14}>{t("m.booking.hours", { defaultValue: "Hours" })}</Text>
                        <Text style={s.muted12}>{t("m.booking.perHour", { defaultValue: "{{price}}/hour", price: rupee(tr!.hourly) })} · {trSlot ? `${trSlot} – ${fmtMin(minutesOf(to24h(trSlot)) + trHoursEff * 60)}` : t("m.booking.billedFullWindow", { defaultValue: "billed for the full window" })}</Text>
                      </View>
                      <Counter value={trHoursEff} min={1} max={trHoursMax} onChange={setTrHours} />
                    </View>
                  </>
                ) : (
                  mode === "day" ? (
                    <MonthCalendar mode="range" blockedOf={blockedOf} range={{ start: pickDate, end: trDayEnd }} onPick={pickTrDay} note={t("m.booking.note.trDay", { defaultValue: "Tap a start and end date for a multi-day rental (or just one day). Greyed dates are blocked, booked, or the driver's off-days." })} />
                  ) : (
                    <MonthCalendar mode="single" blockedOf={blockedOf} value={pickDate} onPick={pickSingle} note={t("m.booking.note.trPackage", { defaultValue: "Greyed dates are blocked by the driver or already fully booked." })} />
                  )
                )}

                <View style={s.confirmLine}><Icon name="check" size={14} color={T.terra} /><Text style={s.muted12}> {mode === "day" && trDayEnd ? t("m.booking.confirm.dayRange", { defaultValue: "{{start}} → {{end}} · {{n}} days", start: fmtShort(pickDate), end: fmtShort(trDayEnd), n: trDays }) : `${fmtLong(pickDate)}${mode === "hourly" && trSlot ? ` · ${trSlot}` : ""}`}</Text></View>

                <View style={[s.rowBetween, { marginTop: 24 }]}>
                  <Text style={[s.secTitle, { marginTop: 0, marginBottom: 0 }]}>{t("m.booking.passengers", { defaultValue: "Passengers" })}</Text>
                  <Text style={s.muted12}>{t("m.booking.upToSeats", { defaultValue: "Up to {{n}} seats", n: tr.seats })}{passengers >= tr.seats ? ` · ${t("m.booking.full", { defaultValue: "full" })}` : ""}</Text>
                </View>
                <View style={[s.rowBetween, { marginTop: 12 }]}>
                  <View><Text style={s.bold14}>{t("m.booking.travellers", { defaultValue: "Travellers" })}</Text><Text style={s.muted12}>{t("m.booking.includingYourself", { defaultValue: "Including yourself" })}</Text></View>
                  <Counter value={passengers} min={1} max={Math.max(1, tr.seats)} onChange={setPassengers} />
                </View>

                <View ref={addrSecRef} collapsable={false} style={[s.rowBetween, { marginTop: 24, marginBottom: 0 }]}>
                  <Text style={[s.secTitle, { marginTop: 0, marginBottom: 0 }]}>{t("m.booking.pickupPoint", { defaultValue: "Pickup point" })}</Text>
                  <Pressable onPress={useMyLocation} disabled={locating} style={({ pressed }) => [s.locBtn, pressed && { opacity: 0.7 }, locating && { opacity: 0.5 }]}>
                    <Icon name={locating ? "refresh" : "mappin"} size={13} color={T.terra} />
                    <Text style={s.locBtnTxt}>{locating ? t("m.booking.locating", { defaultValue: "Locating…" }) : t("m.booking.useLocation", { defaultValue: "Use current location" })}</Text>
                  </Pressable>
                </View>
                {/* zIndex lifts the predictions dropdown ABOVE the Contact
                    details section below — without it the two paint over
                    each other. */}
                <View style={{ marginTop: 10, zIndex: 30 }}>
                  <AddressAutocomplete value={addr} onChangeText={setAddr} onPick={(desc) => setAddr(desc)} mode="address" placeholder={t("m.booking.ph.hotelStation", { defaultValue: "Hotel, station, or house" })} invalid={addrMissing} />
                </View>
                {addrMissing && (
                  <Text style={s.errTxt}>{t("m.booking.errEnterPickup", { defaultValue: "Enter a pickup point to continue." })}</Text>
                )}
              </>
            )}

            <Text style={s.secTitle}>{t("m.booking.protectTitle", { defaultValue: "Protect your {{what}}", what: kind === "stay" ? t("m.booking.protectWord.stay", { defaultValue: "stay" }) : kind === "service" ? t("m.booking.protectWord.appointment", { defaultValue: "appointment" }) : t("m.booking.protectWord.ride", { defaultValue: "ride" }) })}</Text>
            <Pressable style={[s.protect, protect && { borderColor: "rgba(139,94,74,0.5)" }]} onPress={() => setProtect(!protect)}>
              <View style={s.ptIco}><Icon name="shield" size={20} color={T.terra} /></View>
              <View style={{ flex: 1 }}>
                <Text style={s.bold14}>{t("m.booking.addProtection", { defaultValue: "Add protection" })}</Text>
                <Text style={[s.muted12, { marginTop: 2 }]}>{t("m.booking.protectDesc", { defaultValue: "Cancellation cover, damage protection & 24/7 support" })}</Text>
              </View>
              <Text style={s.protectPrice}>+{rupee(insurancePremiumRupees(base))}</Text>
              <View style={[s.switch, protect && { backgroundColor: T.terra }]}>
                <View style={[s.knob, protect && { transform: [{ translateX: 18 }] }]} />
              </View>
            </Pressable>

            {/* Transport: show how the footer total is composed right on the
                selection step — riders adjust hours/packages here, so the
                bare "₹423 incl. taxes" footer read as a mystery number. Same
                values as the Review step's Price details (one source: fees). */}
            {tr && (
              <View style={[s.glass, { marginTop: 14 }]}>
                <Text style={[s.secTitle, { marginTop: 0 }]}>{t("m.booking.priceDetails", { defaultValue: "Price details" })}</Text>
                <View style={{ gap: 11 }}>
                  <BillRow label={label} value={rupee(base)} />
                  {applied && <BillRow label={`${t("m.booking.row.coupon", { defaultValue: "Coupon" })} · ${applied.code}`} value={`−${rupee(couponOff)}`} green />}
                  {protect && <BillRow label={t("m.booking.row.protection", { defaultValue: "Protection" })} value={rupee(protectFee)} />}
                  <BillRow label={t("m.booking.row.platformFee", { defaultValue: "Platform fee" })} value={rupee(fee)} />
                  {gstRows.map((r) => <BillRow key={r.label} label={r.label} value={r.value} />)}
                  <View style={s.billTotal}>
                    <Text style={s.billTotalLabel}>{t("m.booking.totalPayable", { defaultValue: "Total payable" })}</Text>
                    <Text style={s.billTotalVal}>{rupee(total)}</Text>
                  </View>
                </View>
              </View>
            )}
          </>
        )}

        {step === 1 && (
          <>
            <View style={s.glass}>
              <Text style={[s.secTitle, { marginTop: 0 }]}>{t("m.booking.bookingSummary", { defaultValue: "Booking summary" })}</Text>
              <InfoRow icon={icon} strong={title} sub={sub} first />
              <InfoRow icon="calendar" strong={stay ? `${fmtLong(range.start)} → ${fmtShort(range.end)}` : whenText} sub={stay ? (nights > 1 ? t("m.booking.label.nightsN", { defaultValue: "{{n}} nights", n: nights }) : t("m.booking.label.nights1", { defaultValue: "{{n}} night", n: nights })) : svc ? svc.duration : mode === "package" ? (pkgObj?.hours ?? t("m.booking.label.package", { defaultValue: "Package" })) : mode === "day" ? (trDays > 1 ? t("m.booking.daysN", { defaultValue: "{{n}} days", n: trDays }) : t("m.booking.label.fullDay", { defaultValue: "Full day" })) : (trHoursEff !== 1 ? t("m.booking.label.hoursN", { defaultValue: "{{n}} hours", n: trHoursEff }) : t("m.booking.label.hours1", { defaultValue: "{{n}} hour", n: trHoursEff }))} />
              {stay && (stay.checkIn || stay.checkOut) && <InfoRow icon="clock" strong={`${stay.checkIn || t("m.booking.checkInWord", { defaultValue: "Check-in" })} → ${stay.checkOut || t("m.booking.checkOutWord", { defaultValue: "Check-out" })}`} sub={t("m.booking.checkInOutSub", { defaultValue: "Check-in & check-out" })} />}
              {tr && <InfoRow icon="users" strong={passengers > 1 ? t("m.booking.passengersN", { defaultValue: "{{n}} passengers", n: passengers }) : t("m.booking.passengers1", { defaultValue: "{{n}} passenger", n: passengers })} sub={t("m.booking.seatsN", { defaultValue: "{{n}} seats", n: tr.seats })} />}
              {/* Vehicle identity so the rider can spot the car. Model + colour
                  on the strong line, number plate as the sub. */}
              {tr && (tr.vehicle || tr.color || tr.plate) ? (
                <InfoRow
                  icon="car"
                  strong={[tr.vehicle, tr.color].filter(Boolean).join(" · ") || tr.vehicle || t("m.booking.vehicleWord", { defaultValue: "Vehicle" })}
                  sub={tr.plate ? t("m.booking.plateLabel", { defaultValue: "Plate {{plate}}", plate: tr.plate }) : t("m.booking.vehicleWord", { defaultValue: "Vehicle" })}
                />
              ) : null}
              <InfoRow icon={stay ? "users" : "mappin"} strong={stay ? `${adults > 1 ? t("m.booking.value.adultsN", { defaultValue: "{{n}} adults", n: adults }) : t("m.booking.value.adults1", { defaultValue: "{{n}} adult", n: adults })}, ${kids !== 1 ? t("m.booking.value.childrenN", { defaultValue: "{{n}} children", n: kids }) : t("m.booking.value.children1", { defaultValue: "{{n}} child", n: kids })}` : svc ? (mode === "at-home" ? addr || t("m.booking.value.yourAddress", { defaultValue: "Your address" }) : svc.location) : tr!.area} sub={stay ? (selectedRoom ? `${roomQty} × ${selectedRoom.name}` : t("m.booking.oneRoom", { defaultValue: "1 room" })) : svc ? t(`m.booking.mode.${mode}`, { defaultValue: MODE_LBL[mode] }) : tr!.languages.join(", ")} />
              {svc && addons.size > 0 && <InfoRow icon="sparkle" strong={[...addons].map((i) => svcAddOns[i]?.name).filter(Boolean).join(", ")} sub={t("m.booking.addOns", { defaultValue: "Add-ons" })} />}
              <InfoRow icon="user" strong={user?.name || t("m.booking.you", { defaultValue: "You" })} sub={user?.phone || user?.email || t("m.booking.fromYourAccount", { defaultValue: "From your account" })} last />
            </View>

            <View style={[s.glass, { marginTop: 14 }]}>
              <Text style={[s.secTitle, { marginTop: 0 }]}>{t("m.booking.priceDetails", { defaultValue: "Price details" })}</Text>
              <View style={{ gap: 11 }}>
                <BillRow label={label} value={rupee(stay ? stayTotal : svcBaseItem ? svcBaseItem.price : base)} />
                {svc && [...addons].map((i) => svcAddOns[i] && <BillRow key={i} label={svcAddOns[i].name} value={`+${rupee(svcAddOns[i].price)}`} />)}
                {applied && <BillRow label={`${t("m.booking.row.coupon", { defaultValue: "Coupon" })} · ${applied.code}`} value={`−${rupee(couponOff)}`} green />}
                {protect && <BillRow label={t("m.booking.row.protection", { defaultValue: "Protection" })} value={rupee(protectFee)} />}
                <BillRow label={t("m.booking.row.platformFee", { defaultValue: "Platform fee" })} value={rupee(fee)} />
                {gstRows.map((r) => <BillRow key={r.label} label={r.label} value={r.value} />)}
                <View style={s.billTotal}>
                  <Text style={s.billTotalLabel}>{t("m.booking.totalPayable", { defaultValue: "Total payable" })}</Text>
                  <Text style={s.billTotalVal}>{rupee(total)}</Text>
                </View>
              </View>
            </View>

            <View style={[s.glass, { marginTop: 14, flexDirection: "row", gap: 11, alignItems: "center" }]}>
              <View style={[s.infoIco, { backgroundColor: "rgba(189,135,82,0.14)" }]}><Icon name="ticket" size={20} color={T.terra} /></View>
              <TextInput
                value={code}
                editable={!applied}
                onChangeText={(t) => setCode(t.toUpperCase())}
                placeholder={t("m.booking.ph.coupon", { defaultValue: "Have a coupon code?" })}
                placeholderTextColor={T.muted}
                autoCapitalize="characters"
                style={s.couponInput}
              />
              {applied ? (
                <Pressable style={s.btnSmGhost} onPress={clearCoupon}><Text style={[s.btnSmTxt, { color: T.coral }]}>{t("m.booking.remove", { defaultValue: "Remove" })}</Text></Pressable>
              ) : (
                <Pressable style={s.btnSmGhost} onPress={applyCoupon}><Text style={s.btnSmTxt}>{t("m.booking.apply", { defaultValue: "Apply" })}</Text></Pressable>
              )}
            </View>
            {couponMsg ? <Text style={[s.couponNote, { color: T.coral }]}>{couponMsg}</Text> : null}
            {applied ? <Text style={[s.couponNote, { color: "#2f7d55" }]}>{t("m.booking.couponApplied", { defaultValue: "✓ {{label}} applied", label: applied.label })}</Text> : null}

            <View style={{ flexDirection: "row", gap: 8, marginTop: 16, alignItems: "flex-start" }}>
              <Icon name="shield" size={16} color={T.terra} />
              <Text style={[s.muted12, { flex: 1, lineHeight: 17 }]}>{stay ? t("m.booking.assurance.stay", { defaultValue: "No charge until you confirm. Free cancellation up to 24h before check-in." }) : svc ? t("m.booking.assurance.service", { defaultValue: "Provider slot is held now. Pay securely to confirm." }) : t("m.booking.assurance.transport", { defaultValue: "Final extra kilometers settled after the driver confirms." })}</Text>
            </View>
          </>
        )}

        {step === 2 && <Razorpay total={total} paying={paying} />}
      </ScrollView>

      <View style={[s.ctaBar, { bottom: Math.max(insets.bottom, 12) }]}>
        {step < 2 ? (
          <>
            <View style={{ flexShrink: 1 }}>
              <Text style={s.ctaPrice}>{rupee(total)}</Text>
              <Text style={s.ctaUnit}>{step === 0 && !canReview ? (!pickupOk ? t("m.booking.hint.addPickup", { defaultValue: "Add a pickup point" }) : t("m.booking.hint.pickDates", { defaultValue: "Pick your dates" })) : step === 0 ? t("m.booking.totalInclTaxes", { defaultValue: "Total incl. taxes" }) : t("m.booking.allTaxesIncluded", { defaultValue: "All taxes included" })}</Text>
            </View>
            <Pressable style={({ pressed }) => [s.ctaBtn, pressed && { transform: [{ scale: 0.98 }] }]} onPress={() => (step === 0 ? onReviewGate() : setStep(step + 1))}>
              <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.ctaBtnInner}>
                <Text style={s.ctaBtnTxt}>{step === 0 ? t("m.booking.reviewBooking", { defaultValue: "Review booking" }) : reviewCta}</Text>
              </LinearGradient>
            </Pressable>
          </>
        ) : (
          <Pressable style={({ pressed }) => [s.ctaBtn, { flex: 1 }, paying && { opacity: 0.6 }, pressed && !paying && { transform: [{ scale: 0.98 }] }]} disabled={paying} onPress={doPay}>
            <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.ctaBtnInner}>
              <Icon name={paying ? "refresh" : "shield"} size={19} color="#fff" />
              <Text style={s.ctaBtnTxt}>  {paying ? t("m.booking.processing", { defaultValue: "Processing…" }) : t("m.booking.payAmount", { defaultValue: "Pay {{amount}}", amount: rupee(total) })}</Text>
            </LinearGradient>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function InfoRow({ icon, strong, sub, first, last }: { icon: string; strong: React.ReactNode; sub: React.ReactNode; first?: boolean; last?: boolean }) {
  return (
    <View style={[s.infoRow, last && { borderBottomWidth: 0 }, first && { paddingTop: 4 }]}>
      <View style={s.infoIco}><Icon name={icon} size={20} color={T.aubergine} /></View>
      <View style={{ flex: 1 }}>
        <Text style={s.infoStrong}>{strong}</Text>
        <Text style={s.infoSub}>{sub}</Text>
      </View>
    </View>
  );
}

function BillRow({ label, value, green }: { label: string; value: string; green?: boolean }) {
  return (
    <View style={s.billRow}>
      <Text style={s.billLabel}>{label}</Text>
      <Text style={[s.billValue, green && { color: "#2f7d55" }]}>{value}</Text>
    </View>
  );
}

/* ---------- Razorpay-style payment ---------- */
function Razorpay({ total, paying }: { total: number; paying: boolean }) {
  const { t } = useLanguage();
  const [method, setMethod] = useState("upi");
  const [upi, setUpi] = useState("gpay");
  if (paying) {
    return (
      <View style={{ alignItems: "center", paddingVertical: 70, gap: 20 }}>
        <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.successRing}>
          <Icon name="refresh" size={40} color="#fff" />
        </LinearGradient>
        <Text style={{ fontSize: 20, fontFamily: font.head, color: T.ink }}>{t("m.booking.pay.securing", { defaultValue: "Securing your payment…" })}</Text>
        <Text style={s.muted12}>{t("m.booking.pay.doNotClose", { defaultValue: "Do not press back or close the app." })}</Text>
      </View>
    );
  }
  const methods: [string, string, string, string][] = [
    ["upi", "zap", "UPI", t("m.booking.pay.upiSub", { defaultValue: "GPay, PhonePe, Paytm" })],
    ["card", "card", t("m.booking.pay.cards", { defaultValue: "Cards" }), t("m.booking.pay.cardsSub", { defaultValue: "Visa, Mastercard, RuPay" })],
    ["nb", "landmark", t("m.booking.pay.netbanking", { defaultValue: "Netbanking" }), t("m.booking.pay.netbankingSub", { defaultValue: "All major banks" })],
    ["wallet", "ticket", t("m.booking.pay.wallets", { defaultValue: "Wallets" }), t("m.booking.pay.walletsSub", { defaultValue: "Paytm, Amazon Pay" })],
  ];
  return (
    <>
      <LinearGradient colors={["rgba(58,50,71,0.97)", "rgba(139,94,74,0.97)"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.payHead}>
        <View style={s.payShield}><Icon name="shield" size={22} color="#fff" /></View>
        <View style={{ flex: 1 }}>
          <Text style={s.payHeadTitle}>{t("m.booking.pay.secureCheckout", { defaultValue: "IstaSeva · Secure checkout" })}</Text>
          <Text style={s.payHeadSub}>{t("m.booking.pay.poweredBy", { defaultValue: "Powered by Razorpay" })}</Text>
        </View>
        <Text style={s.payHeadAmt}>{rupee(total)}</Text>
      </LinearGradient>

      <Text style={s.secTitle}>{t("m.booking.pay.payUsing", { defaultValue: "Pay using" })}</Text>
      <View style={{ gap: 10 }}>
        {methods.map(([k, ic, lb, subt]) => (
          <Pressable key={k} style={[s.opt, method === k && s.optActive]} onPress={() => setMethod(k)}>
            <View style={s.optIco}><Icon name={ic} size={20} color={T.aubergine} /></View>
            <View style={{ flex: 1 }}>
              <Text style={s.optStrong}>{lb}</Text>
              <Text style={s.optSub}>{subt}</Text>
            </View>
            <View style={[s.optCheck, method === k && { borderColor: T.aubergine, backgroundColor: T.aubergine }]}>
              {method === k && <Icon name="checkSm" size={15} color="#fff" strokeWidth={2.6} />}
            </View>
          </Pressable>
        ))}
      </View>

      {method === "upi" && (
        <>
          <Text style={s.secTitle}>{t("m.booking.pay.chooseUpi", { defaultValue: "Choose UPI app" })}</Text>
          <View style={s.slotGrid}>
            {[["gpay", "GPay"], ["phonepe", "PhonePe"], ["paytm", "Paytm"]].map(([k, lb]) => (
              <Pressable key={k} style={[s.slot, { minHeight: 56 }, upi === k && s.slotActive]} onPress={() => setUpi(k)}>
                <Text style={[s.slotTxt, upi === k && { color: "#fff" }]}>{lb}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
      {method === "card" && (
        <View style={[s.glass, { marginTop: 16, gap: 12 }]}>
          <Field icon="card" placeholder={t("m.booking.pay.cardNumber", { defaultValue: "Card number" })} keyboardType="number-pad" />
          <View style={{ flexDirection: "row", gap: 12 }}>
            <View style={{ flex: 1 }}><Field icon="calendar" placeholder={t("m.booking.pay.expiry", { defaultValue: "MM / YY" })} /></View>
            <View style={{ flex: 1 }}><Field icon="shield" placeholder={t("m.booking.pay.cvv", { defaultValue: "CVV" })} keyboardType="number-pad" /></View>
          </View>
        </View>
      )}
      <Text style={[s.muted12, { textAlign: "center", marginTop: 20 }]}>{t("m.booking.pay.encrypted", { defaultValue: "🔒 256-bit encrypted · PCI-DSS compliant" })}</Text>
    </>
  );
}

/* ---------- Confirmation ---------- */
function Confirmation({ total, title, sub, facts, rows, tone, icon, kind, nav, insetTop, insetBottom, bookingId }: {
  total: number;
  title: string;
  sub: string;
  facts: { label: string; value: string }[];
  rows: { label: string; value: string; green?: boolean }[];
  tone: Tone;
  icon: string;
  kind: "stay" | "service" | "transport";
  nav: Nav;
  insetTop: number;
  insetBottom: number;
  /** Real booking id from the pay flow — mock rows pass null. */
  bookingId: string | null;
}) {
  const { t } = useLanguage();
  const c = toneOf(tone);
  const colors = ["#bd8752", "#a45d62", "#617a92", "#3a3247", "#e7c39c"];
  return (
    <View style={{ flex: 1, backgroundColor: "#f4efe9" }}>
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 300, overflow: "hidden" }}>
        {Array.from({ length: 24 }).map((_, i) => (
          <View key={i} style={{ position: "absolute", top: (i % 6) * 36 + 10, left: `${(i * 37) % 100}%`, width: 7, height: 11, borderRadius: 2, backgroundColor: colors[i % colors.length], opacity: 0.9, transform: [{ rotate: `${(i * 47) % 360}deg` }] }} />
        ))}
      </View>
      <ScrollView contentContainerStyle={{ alignItems: "center", paddingHorizontal: 20, paddingTop: insetTop + 50, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
        <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.successRing}>
          <Icon name="check" size={50} color="#fff" strokeWidth={2.6} />
        </LinearGradient>
        <Text style={{ fontSize: 26, fontFamily: font.head, color: T.ink, marginTop: 26 }}>{t("m.booking.conf.title", { defaultValue: "Booking confirmed!" })}</Text>
        <Text style={[s.muted12, { marginTop: 8, textAlign: "center", maxWidth: 280, fontSize: 14, lineHeight: 20 }]}>
          {t("m.booking.conf.subtitle", { defaultValue: "Your {{kind}} is booked. We've sent the details and a receipt to your phone.", kind: kind === "stay" ? t("m.booking.kind.stay", { defaultValue: "stay" }) : kind === "service" ? t("m.booking.kind.service", { defaultValue: "service" }) : t("m.booking.kind.transport", { defaultValue: "transport" }) })}
        </Text>

        <View style={[s.glass, { marginTop: 26, width: "100%" }]}>
          <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
            <View style={[s.summaryThumb, { width: 50, height: 50 }]}><Ph tone={tone} icon={icon} style={StyleSheet.absoluteFill} /></View>
            <View style={{ flex: 1 }}>
              <Text style={s.summaryTitle}>{title}</Text>
              {sub ? <Text style={[s.muted12, { marginTop: 1 }]} numberOfLines={1}>{sub}</Text> : null}
              <Text style={[s.muted12, { marginTop: 2 }]}>{bookingId
                ? t("m.booking.conf.bookingIdReal", { defaultValue: "Booking ID · {{id}}", id: displayRef(bookingId) })
                : t("m.booking.conf.bookingId", { defaultValue: "Booking ID · ISV{{id}}", id: (Math.round(total) % 90000) + 10000 })}</Text>
            </View>
            <View style={s.statusChip}><Icon name="checkSm" size={12} color="#2f7d55" strokeWidth={2.6} /><Text style={s.statusChipTxt}>{t("m.booking.conf.confirmed", { defaultValue: "Confirmed" })}</Text></View>
          </View>
          <View style={[s.divider, { marginVertical: 14 }]} />
          <View style={s.rowBetween}>
            <Text style={s.muted12}>{t("m.booking.conf.amountPaid", { defaultValue: "Amount paid" })}</Text>
            <Text style={{ fontSize: 17, fontFamily: font.bodyHeavy, color: T.ink }}>{rupee(total)}</Text>
          </View>
        </View>

        {facts && facts.length > 0 && (
          <View style={[s.glass, { marginTop: 14, width: "100%" }]}>
            <Text style={[s.secTitle, { marginTop: 0, marginBottom: 14 }]}>{t("m.booking.conf.bookingDetails", { defaultValue: "Booking details" })}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
              {facts.map((f: { label: string; value: string }) => (
                <View key={f.label} style={{ width: "50%", marginBottom: 14, paddingRight: 8 }}>
                  <Text style={s.factLabel}>{f.label.toUpperCase()}</Text>
                  <Text style={s.factValue}>{f.value}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {rows && rows.length > 0 && (
          <View style={[s.glass, { marginTop: 14, width: "100%" }]}>
            <Text style={[s.secTitle, { marginTop: 0, marginBottom: 12 }]}>{t("m.booking.conf.fareSummary", { defaultValue: "Fare summary" })}</Text>
            <View style={{ gap: 11 }}>
              {rows.map((r: { label: string; value: string; green?: boolean }) => (
                <BillRow key={r.label} label={r.label} value={r.value} green={r.green} />
              ))}
              <View style={s.billTotal}>
                <Text style={s.billTotalLabel}>{t("m.booking.conf.totalPaid", { defaultValue: "Total paid" })}</Text>
                <Text style={s.billTotalVal}>{rupee(total)}</Text>
              </View>
            </View>
          </View>
        )}

        <Text style={[s.muted12, { marginTop: 16, textAlign: "center", fontSize: 11.5, maxWidth: 300 }]}>
          {t("m.booking.conf.receiptNote", { defaultValue: "A receipt and tax invoice have been sent to your phone. Manage this booking anytime under My bookings." })}
        </Text>
      </ScrollView>

      <View style={[s.ctaBar, { bottom: Math.max(insetBottom, 12) }]}>
        <Pressable style={[s.ghostCta, { flex: 1 }]} onPress={() => nav.navigate("Tabs", { screen: "Bookings" })}>
          <Text style={s.ghostCtaTxt}>{t("m.booking.conf.myBookings", { defaultValue: "My bookings" })}</Text>
        </Pressable>
        <Pressable style={[s.ctaBtn, { flex: 1 }]} onPress={() => nav.navigate("Tabs", { screen: "Explore" })}>
          <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.ctaBtnInner}>
            <Text style={s.ctaBtnTxt}>{t("m.booking.conf.done", { defaultValue: "Done" })}</Text>
          </LinearGradient>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  steps: { flexDirection: "row", alignItems: "center", gap: 6 },
  stepDot: { flex: 1, height: 4, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.14)" },
  stepDotOn: { backgroundColor: T.aubergine },

  muted12: { color: T.muted, fontSize: 12, fontFamily: font.body },
  // Visit-provider address → maps deep link (bordered row, matches the
  // AddressAutocomplete field treatment so the section reads consistently).
  // No fixed height — symmetric vertical padding lets the box hug a one-line
  // address and grow evenly for multi-line ones; the pin tops-aligns to the
  // first line instead of floating against a tall centered block.
  mapsLinkRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 13, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },
  mapsLinkTxt: { flex: 1, fontSize: 14, lineHeight: 20, fontFamily: font.bodyBold, color: T.ink, textDecorationLine: "underline" },
  factLabel: { fontSize: 10.5, fontFamily: font.bodyBold, color: T.muted, letterSpacing: 0.5 },
  factValue: { fontSize: 13.5, fontFamily: font.bodyBold, color: T.ink, marginTop: 3 },
  body13: { color: T.ink, fontSize: 13, fontFamily: font.body, lineHeight: 19 },
  bold14: { fontSize: 14, fontFamily: font.bodyBold, color: T.ink },
  secTitle: { fontSize: 16, fontFamily: font.headHeavy, color: T.ink, marginBottom: 12, marginTop: 24 },
  secTitleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  locBtn: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 6, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: "rgba(139,94,74,0.4)", backgroundColor: "rgba(139,94,74,0.08)" },
  locBtnTxt: { fontSize: 12, fontFamily: font.bodyBold, color: T.terra },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  divider: { height: 1, backgroundColor: T.line, marginVertical: 18 },

  summaryThumb: { width: 56, height: 56, borderRadius: 13, overflow: "hidden" },
  summaryTitle: { fontSize: 14.5, fontFamily: font.bodyBold, color: T.ink },

  opt: { flexDirection: "row", alignItems: "center", gap: 13, padding: 15, borderRadius: 16, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.55)" },
  optActive: { borderColor: "rgba(58,50,71,0.4)", borderWidth: 1.5 },
  optIco: { width: 44, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: T.greenSoft },
  optStrong: { fontSize: 14.5, fontFamily: font.bodyBold, color: T.ink },
  optSub: { color: T.muted, fontSize: 12.5, fontFamily: font.body, marginTop: 1 },
  optPrice: { fontSize: 13.5, fontFamily: font.bodyBold, color: T.ink },
  optCheck: { width: 24, height: 24, borderRadius: 999, borderWidth: 2, borderColor: T.line, alignItems: "center", justifyContent: "center" },

  rangeSummary: { flexDirection: "row", alignItems: "center", gap: 12, padding: 13, borderRadius: 16, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.55)" },
  // Review-gate UX: red-bordered field + message when a required input is
  // missing at "Review booking" time.
  fieldErr: { borderWidth: 1.5, borderColor: T.coral, backgroundColor: "rgba(164,93,98,0.04)" },
  errTxt: { fontSize: 12, fontFamily: font.bodyBold, color: T.coral, marginTop: 8 },
  rsLabel: { fontSize: 10.5, fontFamily: font.bodyHeavy, letterSpacing: 0.4, color: T.muted },
  rsVal: { fontSize: 14.5, fontFamily: font.bodyBold, color: T.ink, marginTop: 2 },
  rsNights: { backgroundColor: "rgba(189,135,82,0.14)", paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999 },
  rsNightsTxt: { fontSize: 12, fontFamily: font.bodyHeavy, color: T.terra },

  cal: { borderWidth: 1, borderColor: T.line, borderRadius: 20, padding: 14, backgroundColor: "rgba(255,255,255,0.55)" },
  calHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  calNav: { width: 34, height: 34, borderRadius: 999, borderWidth: 1, borderColor: T.line, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.7)" },
  calTitle: { fontFamily: font.headHeavy, fontSize: 15, color: T.ink },
  calGrid: { flexDirection: "row", flexWrap: "wrap" },
  calWd: { width: `${100 / 7}%`, textAlign: "center", fontSize: 11, fontFamily: font.bodyHeavy, color: T.muted, paddingBottom: 6 },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: "center", justifyContent: "center" },
  // The selected/endpoint highlight is a centered square chip (not the whole
  // cell), so it sits neatly aligned on the date number.
  cellChip: { width: 38, height: 38, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  cellChipCustom: { backgroundColor: "rgba(139,94,74,0.12)", borderWidth: 1, borderColor: "rgba(139,94,74,0.35)" },
  cellMidChip: { backgroundColor: "rgba(139,94,74,0.14)" },
  cellEnd: { backgroundColor: T.aubergine },
  cd: { fontSize: 14.5, fontFamily: font.bodyBold, color: T.ink, lineHeight: 16 },
  cdBlocked: { color: "rgba(23,22,28,0.25)", textDecorationLine: "line-through" },
  cp: { fontSize: 8.5, fontFamily: font.bodyBold, color: T.muted, marginTop: 1 },
  calNote: { fontSize: 11.5, color: T.muted, marginTop: 12, lineHeight: 17, fontFamily: font.body },
  calToggle: { width: 40, height: 40, borderRadius: 13, borderWidth: 1, borderColor: T.line, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.6)" },

  dateCell: { width: 56, paddingVertical: 11, borderRadius: 16, alignItems: "center", borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.55)" },
  dateCellActive: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  dateWd: { color: T.muted, fontSize: 11, fontFamily: font.bodyBold },
  dateNum: { fontSize: 17, fontFamily: font.bodyBold, color: T.ink, marginTop: 2 },
  strike: { textDecorationLine: "line-through" },

  confirmLine: { flexDirection: "row", alignItems: "center", marginTop: 10 },

  slotGrid: { flexDirection: "row", flexWrap: "wrap", gap: 9 },
  slot: { width: "31.5%", minHeight: 44, borderRadius: 13, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.55)", alignItems: "center", justifyContent: "center" },
  slotActive: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  slotTaken: { backgroundColor: "rgba(23,22,28,0.04)", borderColor: "transparent" },
  slotTxt: { fontFamily: font.bodyBold, fontSize: 13, color: T.ink },
  slotTakenTxt: { color: "rgba(23,22,28,0.3)", textDecorationLine: "line-through" },
  slotTakenTag: { marginTop: 2, fontFamily: font.bodyBold, fontSize: 9, color: "rgba(23,22,28,0.35)", textTransform: "uppercase", letterSpacing: 0.3 },

  pill: { flexDirection: "row", alignItems: "center", paddingVertical: 7, paddingHorizontal: 13, borderRadius: 999, borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.7)" },
  pillActive: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  pillTxt: { color: T.aubergine, fontSize: 12.5, fontFamily: font.bodyBold },

  catalogRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 14, paddingHorizontal: 16, marginTop: 9, borderWidth: 1, borderColor: T.line, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.5)" },
  crCheck: { width: 22, height: 22, borderRadius: 999, backgroundColor: T.aubergine, alignItems: "center", justifyContent: "center" },
  crAdd: { width: 22, height: 22, borderRadius: 999, borderWidth: 1.5, borderColor: T.line, alignItems: "center", justifyContent: "center" },
  catalogTxt: { flex: 1, fontSize: 14.5, fontFamily: font.bodySemi, color: T.ink },
  catalogPrice: { fontSize: 15, fontFamily: font.bodyBold, color: T.ink },

  protect: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.5)" },
  ptIco: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(189,135,82,0.14)" },
  protectPrice: { fontSize: 12, fontFamily: font.bodyHeavy, color: T.terra, marginRight: 4 },
  switch: { width: 44, height: 26, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.18)", justifyContent: "center", paddingHorizontal: 3 },
  knob: { width: 20, height: 20, borderRadius: 999, backgroundColor: "#fff" },

  glass: { borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", borderRadius: 18, backgroundColor: "rgba(255,255,255,0.85)", padding: 16 },
  darkTag: { backgroundColor: T.ink, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999 },
  darkTagTxt: { color: "#fff", fontSize: 12, fontFamily: font.bodyHeavy },

  infoRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: T.line },
  infoIco: { width: 28, alignItems: "center", justifyContent: "center" },
  infoStrong: { fontSize: 14.5, fontFamily: font.bodyBold, color: T.ink },
  infoSub: { color: T.muted, fontSize: 12.5, fontFamily: font.body, marginTop: 1 },

  billRow: { flexDirection: "row", justifyContent: "space-between" },
  billLabel: { fontSize: 13.5, color: T.muted, fontFamily: font.body, flex: 1 },
  billValue: { fontSize: 13.5, color: T.ink, fontFamily: font.bodyBold },
  billTotal: { flexDirection: "row", justifyContent: "space-between", paddingTop: 11, marginTop: 3, borderTopWidth: 1, borderTopColor: T.line },
  billTotalLabel: { fontSize: 15, color: T.ink, fontFamily: font.bodySemi },
  billTotalVal: { fontSize: 18, color: T.ink, fontFamily: font.bodyHeavy },

  couponInput: { flex: 1, fontFamily: font.bodyBold, fontSize: 14, color: T.ink, paddingVertical: 0, ...noOutline },
  couponNote: { fontSize: 12, marginTop: 6, paddingLeft: 2, fontFamily: font.bodySemi },

  field: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 50, paddingHorizontal: 16, borderRadius: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.85)" },
  fieldInput: { flex: 1, fontFamily: font.body, fontSize: 15, color: T.ink, paddingVertical: 0, ...noOutline },

  payHead: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 18 },
  payShield: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.18)" },
  payHeadTitle: { fontSize: 15, fontFamily: font.bodyBold, color: "#fff" },
  payHeadSub: { fontSize: 12, color: "rgba(255,255,255,0.8)", fontFamily: font.body },
  payHeadAmt: { fontSize: 18, fontFamily: font.bodyHeavy, color: "#fff" },

  successRing: { width: 110, height: 110, borderRadius: 999, alignItems: "center", justifyContent: "center", shadowColor: "#3a3247", shadowOffset: { width: 0, height: 24 }, shadowOpacity: 0.4, shadowRadius: 50, elevation: 16 },
  statusChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, backgroundColor: "rgba(47,125,85,0.12)" },
  statusChipTxt: { fontSize: 11, fontFamily: font.bodyHeavy, color: "#2f7d55" },

  ctaBar: { position: "absolute", left: 12, right: 12, flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 12, paddingLeft: 18, paddingRight: 14, borderRadius: 24, borderWidth: 1, borderColor: "rgba(255,255,255,0.72)", backgroundColor: "rgba(255,255,255,0.97)", shadowColor: "#221f27", shadowOffset: { width: 0, height: 22 }, shadowOpacity: 0.22, shadowRadius: 40, elevation: 16 },
  ctaPrice: { fontSize: 19, fontFamily: font.headHeavy, color: T.ink },
  ctaUnit: { fontSize: 11.5, color: T.muted, fontFamily: font.body },
  ctaBtn: { flex: 1, borderRadius: 16, overflow: "hidden" },
  ctaBtnInner: { minHeight: 50, flexDirection: "row", alignItems: "center", justifyContent: "center", paddingHorizontal: 18 },
  ctaBtnTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 16 },
  ghostCta: { minHeight: 50, borderRadius: 16, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.72)", backgroundColor: "rgba(255,255,255,0.6)" },
  ghostCtaTxt: { color: T.aubergine, fontFamily: font.bodyHeavy, fontSize: 15 },

  btnSmGhost: { minHeight: 38, paddingHorizontal: 16, borderRadius: 12, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.72)", backgroundColor: "rgba(255,255,255,0.6)" },
  btnSmTxt: { color: T.aubergine, fontFamily: font.bodyHeavy, fontSize: 14 },
});
