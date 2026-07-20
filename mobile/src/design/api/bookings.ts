// design/api/bookings.ts — Phase 4b: booking write path (POST /api/bookings, auth-gated).
import { api } from "@/lib/api";

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * "Today" in India (IST), as a LOCAL-frame Date at midnight — so all the
 * booking date math (addDays, ymd via local getters) stays internally
 * consistent and matches the backend, which operates in IST. The marketplace
 * is India-only; a rider whose phone is in another timezone must still see the
 * Indian calendar date, not their device's.
 *
 * IST is a fixed UTC+5:30 with no DST, so we shift `now` by +330 min and read
 * the UTC components of the shifted instant — that yields the IST wall-clock
 * Y/M/D without depending on Intl timezone data (unreliable on Android Hermes).
 */
export function istToday(): Date {
  const istWall = new Date(Date.now() + 330 * 60_000);
  return new Date(istWall.getUTCFullYear(), istWall.getUTCMonth(), istWall.getUTCDate());
}
/** Today's IST calendar date as "YYYY-MM-DD". */
export const istTodayYMD = () => ymd(istToday());

/** "10:00 AM" / "6:30 PM" → "10:00" / "18:30" (24h HH:MM). */
export function to24h(slot?: string): string {
  if (!slot) return "10:00";
  const m = /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(slot.trim());
  if (!m) return "10:00";
  let h = Number(m[1]); const min = m[2] ? Number(m[2]) : 0;
  const ap = (m[3] || "").toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return `${pad(h)}:${pad(min)}`;
}

/** Minutes since IST midnight, right now (0–1439). */
export function istNowMinutes(): number {
  const istWall = new Date(Date.now() + 330 * 60_000);
  return istWall.getUTCHours() * 60 + istWall.getUTCMinutes();
}

/**
 * Lead time (minutes) a same-day service/transport slot must still be in the
 * future before it's bookable. Mirrors web `BOOKING_LEAD_MINUTES` (src/lib/
 * ist-time.ts) and the server createHold gate — keep the three in sync.
 */
export const BOOKING_LEAD_MINUTES = 30;

/** True when slot `label` ("10:00 AM") on date `d` is already past or within the
 *  lead-time buffer, in IST. Only today can be too soon; future dates never are. */
export function slotTooSoon(label: string, d: Date): boolean {
  if (ymd(d) !== istTodayYMD()) return false;
  const [h, m] = to24h(label).split(":").map(Number);
  const slotMin = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  return slotMin < istNowMinutes() + BOOKING_LEAD_MINUTES;
}

const addHour = (hhmm: string, hrs: number) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${pad((h + hrs) % 24)}:${pad(m)}`;
};

export type CreateBookingInput = {
  kind: "stay" | "service" | "transport";
  listingId: string;
  serviceCategory: string;
  scheduledDate: string; // YYYY-MM-DD
  endDate?: string;
  startTime: string; // HH:MM
  endTime: string;
  agreedPrice?: number;
  address?: string;
  notes?: string;
  couponCode?: string;
  // Trip protection opt-in — the server adds the flat ₹2 premium AFTER tax to
  // the order when true. Without this the premium is shown on the review screen
  // but never charged or persisted, so the booking detail can't show it.
  insuranceOptIn?: boolean;
  numberOfRooms?: number;
  guestCount?: number;
  // Multi-room stays: the SELECTED room type, so the server prices by that
  // room's base_price_paise (the listing-level price is 0 for hotels). Without
  // it the subtotal is ₹0 and only the platform fee is charged.
  roomTypeId?: string;
  // Service selection — needed so the server prices the SELECTED catalog
  // variant + add-ons (resolveServiceCatalogGroup matches by serviceCatalogId).
  serviceMode?: string;
  serviceCatalogId?: string;
  serviceCatalogName?: string;
  serviceCatalogBasePrice?: number;
  serviceAddOns?: { id?: string; label: string; price: number }[];
  // Transport (Phase 6A unified contract) — the server builds the canonical
  // notes from THESE structured fields (buildBookingNotes); a raw client
  // `notes` JSON string is ignored. transportPackageId → notes.packageId,
  // transportHours → notes.durationHours, transportDays → notes.days.
  transportMode?: "hourly" | "day" | "package";
  transportHours?: number;
  transportDays?: number;
  /** Inclusive display end for multi-day rentals (notes.endDate). The hold's
   *  conflict-check end is the separate EXCLUSIVE `endDate` (last day + 1). */
  transportEndDate?: string;
  transportPackageId?: string;
  pickupLocation?: string;
  passengerCount?: number;
};

/** Everything the client needs to launch Razorpay checkout after a prepare. */
export type PreparedBooking = {
  bookingId: string;
  orderId: string;
  keyId: string;           // Razorpay key — "rzp_..." in prod, a mock key in dev
  amount: number;          // rupees, server-authoritative (includes insurance)
  amountPaise: number;
  currency: "INR" | "USD";
  /** Transport only — driver/operator contact + booked-vehicle identity, so
   *  the confirmation screen shows who's coming and how to reach them. */
  driver?: {
    name: string | null;
    phone: string | null;
    vehicle: string | null;
    plate: string | null;
    color: string | null;
  };
};

/**
 * Prepare a booking: the server prices it from authoritative rows, creates a
 * hold + a Razorpay order, and returns the order the client opens in checkout.
 * Requires an authenticated token + a real listing UUID. Throws on failure.
 */
export async function prepareBooking(input: CreateBookingInput): Promise<PreparedBooking> {
  const prep: Record<string, unknown> = {
    listingType: input.kind,
    listingId: input.listingId,
    serviceCategory: input.serviceCategory,
    scheduledDate: input.scheduledDate,
    startTime: input.startTime,
    endTime: input.endTime,
  };
  if (input.endDate) prep.endDate = input.endDate;
  if (input.address) prep.address = input.address;
  if (input.couponCode) prep.couponCode = input.couponCode;
  if (input.insuranceOptIn) prep.insuranceOptIn = true;
  if (input.numberOfRooms) prep.numberOfRooms = input.numberOfRooms;
  if (input.guestCount) prep.guestCount = input.guestCount;
  if (input.roomTypeId) prep.roomTypeId = input.roomTypeId;
  if (input.serviceMode) prep.serviceMode = input.serviceMode;
  if (input.serviceCatalogId) prep.serviceCatalogId = input.serviceCatalogId;
  if (input.serviceCatalogName) prep.serviceCatalogName = input.serviceCatalogName;
  if (typeof input.serviceCatalogBasePrice === "number") prep.serviceCatalogBasePrice = input.serviceCatalogBasePrice;
  if (input.serviceAddOns && input.serviceAddOns.length) prep.serviceAddOns = input.serviceAddOns;
  // Phase 6A transport pricing inputs travel as STRUCTURED fields — the
  // server's buildBookingNotes assembles the canonical notes from them and
  // ignores any raw client `notes` string ("Missing packageId" otherwise).
  if (input.transportMode) prep.transportMode = input.transportMode;
  if (input.transportHours) prep.transportHours = input.transportHours;
  if (input.transportDays) prep.transportDays = input.transportDays;
  if (input.transportEndDate) prep.transportEndDate = input.transportEndDate;
  if (input.transportPackageId) prep.transportPackageId = input.transportPackageId;
  if (input.pickupLocation) prep.pickupLocation = input.pickupLocation;
  if (input.passengerCount) prep.passengerCount = input.passengerCount;

  const prepRes = await api.post("/api/bookings/prepare", prep);
  const d = prepRes.data?.data ?? prepRes.data;
  return {
    bookingId: String(d.bookingId),
    orderId: String(d.orderId),
    keyId: String(d.keyId ?? ""),
    amount: Number(d.amount),
    amountPaise: Number(d.amountPaise ?? Math.round(Number(d.amount) * 100)),
    currency: (d.currency ?? "INR") as "INR" | "USD",
    ...(d.driver ? { driver: {
      name: d.driver.name ?? null,
      phone: d.driver.phone ?? null,
      vehicle: d.driver.vehicle ?? null,
      plate: d.driver.plate ?? null,
      color: d.driver.color ?? null,
    } } : {}),
  };
}

/** Walk-up guest a host books on behalf of — all fields collected in the
 *  Book-for-a-guest sheet and mandatory there (email/phone drive the payment
 *  link SMS/email + account-linking). */
export type OnBehalfGuest = { name: string; phone: string; email: string };

/** What the host sheet renders after creating an on-behalf booking: the
 *  Razorpay Payment Link the guest pays (QR target + share URL). */
export type OnBehalfResult = {
  bookingId: string;
  paymentLink: { shortUrl: string; paymentLinkId: string };
  amount: number;      // rupees, server-authoritative
  amountPaise: number;
  holdExpiresAt: string | null;
};

/**
 * Host/provider-books-on-behalf (stays + services): same structured payload as
 * prepareBooking but no Razorpay order — the server creates a long-TTL hold +
 * a Payment Link the guest pays via QR/SMS/email. Booking confirms on the
 * payment_link.paid webhook. Mirrors the web modals' requests byte-for-byte.
 */
export async function prepareOnBehalf(input: {
  listingType?: "stay" | "service" | "transport";  // defaults to stay
  listingId: string;
  serviceCategory: string;      // stay type ("hotel"), service category, or driver-{mode}
  scheduledDate: string;        // check-in / service / ride date YYYY-MM-DD
  checkOutDate?: string;        // stays only — exclusive check-out
  /** Transport day rentals: EXCLUSIVE conflict end (last rental day + 1). */
  endDate?: string;
  startTime: string;
  endTime: string;
  // Stay
  roomTypeId?: string;
  roomName?: string;
  numberOfRooms?: number;
  guestCount?: number;
  // Service — same structured fields the customer BookingScreen sends so the
  // server builds identical notes + pricing (catalog variant + add-ons).
  serviceMode?: string;
  serviceAddress?: string;
  visitAddress?: string;
  meetingDetails?: string;
  slot?: string;
  serviceAddOns?: { id?: string; label: string; price: number }[];
  serviceCatalogId?: string;
  serviceCatalogName?: string;
  serviceCatalogBasePrice?: number;
  // Transport — same Phase 6A structured fields the customer flow sends; the
  // server prices off notes built from these (hourly × hours / day × days /
  // packageId match).
  transportMode?: "hourly" | "day" | "package";
  transportHours?: number;
  transportDays?: number;
  transportEndDate?: string;   // INCLUSIVE display end for notes
  transportPackageId?: string;
  pickupLocation?: string;
  passengerCount?: number;
  address?: string;
  listingTitle?: string;
  couponCode?: string;
}, guest: OnBehalfGuest, opts: { admin?: boolean } = {}): Promise<OnBehalfResult> {
  const body: Record<string, unknown> = {
    listingType: input.listingType ?? "stay",
    listingId: input.listingId,
    serviceCategory: input.serviceCategory,
    scheduledDate: input.scheduledDate,
    startTime: input.startTime,
    endTime: input.endTime,
    guestName: guest.name,
    contact: { name: guest.name, phone: guest.phone },
    guest,
  };
  if (input.checkOutDate) body.checkOutDate = input.checkOutDate;
  if (input.endDate) body.endDate = input.endDate;
  if (input.transportMode) body.transportMode = input.transportMode;
  if (input.transportHours) body.transportHours = input.transportHours;
  if (input.transportDays) body.transportDays = input.transportDays;
  if (input.transportEndDate) body.transportEndDate = input.transportEndDate;
  if (input.transportPackageId) body.transportPackageId = input.transportPackageId;
  if (input.pickupLocation) body.pickupLocation = input.pickupLocation;
  if (input.passengerCount) body.passengerCount = input.passengerCount;
  if (input.roomTypeId) body.roomTypeId = input.roomTypeId;
  if (input.roomName) body.roomName = input.roomName;
  if (input.numberOfRooms && input.numberOfRooms > 1) body.numberOfRooms = input.numberOfRooms;
  if (input.guestCount) body.guestCount = input.guestCount;
  if (input.listingTitle) { body.listingTitle = input.listingTitle; body.listingName = input.listingTitle; }
  if (input.serviceMode) body.serviceMode = input.serviceMode;
  if (input.serviceAddress) body.serviceAddress = input.serviceAddress;
  if (input.visitAddress) body.visitAddress = input.visitAddress;
  if (input.meetingDetails) body.meetingDetails = input.meetingDetails;
  if (input.slot) body.slot = input.slot;
  if (input.serviceAddOns && input.serviceAddOns.length) body.serviceAddOns = input.serviceAddOns;
  if (input.serviceCatalogId) body.serviceCatalogId = input.serviceCatalogId;
  if (input.serviceCatalogName) body.serviceCatalogName = input.serviceCatalogName;
  if (typeof input.serviceCatalogBasePrice === "number") body.serviceCatalogBasePrice = input.serviceCatalogBasePrice;
  if (input.address) body.address = input.address;
  if (input.couponCode) body.couponCode = input.couponCode;

  // Admin ops console: the admin endpoint skips the "host owns this listing"
  // check and records an admin action; the flow (payment link, webhook
  // confirm, guest linking) is otherwise identical.
  const res = await api.post(opts.admin ? "/api/admin/bookings/on-behalf" : "/api/bookings/on-behalf", body);
  const d = res.data?.data ?? res.data;
  return {
    bookingId: String(d.bookingId),
    paymentLink: {
      shortUrl: String(d.paymentLink?.shortUrl ?? ""),
      paymentLinkId: String(d.paymentLink?.paymentLinkId ?? ""),
    },
    amount: Number(d.amount),
    amountPaise: Number(d.amountPaise ?? Math.round(Number(d.amount) * 100)),
    holdExpiresAt: d.holdExpiresAt ?? null,
  };
}

/** Verify a payment against a prepared booking, marking it confirmed.
 *  Returns pending:true when Razorpay AUTHORIZED but hasn't CAPTURED yet —
 *  the booking is NOT confirmed in that case (the payment.captured webhook
 *  finishes it later); callers must not show a "confirmed" screen. */
export async function verifyBooking(p: {
  bookingId: string;
  orderId: string;
  paymentId: string;
  signature: string;
}): Promise<{ pending: boolean }> {
  const res = await api.post("/api/payments/verify", {
    bookingId: p.bookingId,
    razorpay_order_id: p.orderId,
    razorpay_payment_id: p.paymentId,
    razorpay_signature: p.signature,
  });
  return { pending: res.data?.pending === true };
}

export { addHour };

/* ---------------- bookings read (Phase: real bookings) ---------------- */
import { Booking } from "../types";
import { Tone } from "../theme";

/** Raw backend booking row (snake_case, plus joined display fields). Hot
 *  fields are typed; everything else stays `unknown` and is coerced at the
 *  use site (Number()/String()/truthiness guards). */
export type ApiBookingRow = {
  id: string;
  status?: string;
  service_category: string;
  scheduled_date?: string | null;
  end_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  created_at?: string | null;
  listing_id?: string | null;
  provider_id?: string | null;
  listing_name?: string | null;
  host_name?: string | null;
  provider_name?: string | null;
  host_user_id?: string | null;
  provider_user_id?: string | null;
  address?: string | null;
  has_exact_address?: boolean | null;
  guest_name?: string | null;
  guest_name_snapshot?: string | null;
  guest_phone?: string | null;
  driver_phone_snapshot?: string | null;
  vehicle_model_snapshot?: string | null;
  vehicle_plate_snapshot?: string | null;
  vehicle_color_snapshot?: string | null;
  guest_contact?: { name?: string; phone?: string } | null;
  [key: string]: unknown;
};

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TONES: Tone[] = ["saffron", "blue", "aubergine", "coral"];
const toneFor = (id: string) => TONES[[...String(id || "x")].reduce((a, c) => a + c.charCodeAt(0), 0) % TONES.length];
// Paise → rupees, keeping the paise as decimals (10815 → 108.15). Money must
// never be truncated to whole rupees on display.
const paise = (b: ApiBookingRow) => Math.round(Number(b.payment_amount_paise ?? b.subtotal_paise ?? b.agreed_price_paise ?? 0)) / 100;

// Booking categories come in TWO formats: web writes "stay:hotel", mobile
// writes the bare property type ("hotel"). Match both — mirrors the web's
// bookingKindOf (src/lib/booking-kind.ts); keep the two rule-identical.
export function kindOf(cat: string): "stay" | "service" | "transport" {
  const c = (cat || "").toLowerCase();
  if (c.startsWith("driver") || c.includes("cab") || c.includes("auto") || c.includes("van")) return "transport";
  if (c.startsWith("stay") || ["homestay", "hotel", "lodge", "village-stay", "farm-stay", "heritage", "sathram"].some((s) => c.includes(s))) return "stay";
  return "service";
}
const ICON: Record<string, string> = { stay: "bedDouble", transport: "car", service: "sparkle" };

// Pad a Postgres TIME ("15:00" / "15:00:00") to a parseable "HH:MM:SS".
const padTime = (t: string) => {
  const p = (t || "").split(":");
  return `${(p[0] || "00").padStart(2, "0")}:${(p[1] || "00").padStart(2, "0")}:${(p[2] || "00").padStart(2, "0")}`;
};

/**
 * Date-aware status — exact mirror of the web's `effectiveBookingStatus`
 * (src/lib/booking-status.ts). The backend stores "confirmed" the moment
 * payment clears and never flips to completed on its own (no cron yet), so a
 * confirmed booking whose window has already passed must read as completed,
 * and one mid-window as in_progress. cancelled/expired/completed/pending/
 * in_progress pass through untouched. Pure display-time transform on the raw
 * API row — we don't mutate the DB from the client.
 */
function effectiveStatus(b: ApiBookingRow): string {
  const raw = String(b.status || "").toLowerCase();
  if (["cancelled", "expired", "pending", "in_progress", "completed"].includes(raw)) return raw;
  if (raw !== "confirmed") return raw;
  const dateStr = b.scheduled_date ? String(b.scheduled_date).slice(0, 10) : null;
  if (!dateStr) return raw;
  // Stays carry a check-out (end_date); multi-day rentals carry an exclusive
  // end_date. Single-day services/transport have no end_date → the booking's
  // own day, ending at end_time (or 23:59 when none stored).
  const endDateStr = b.end_date ? String(b.end_date).slice(0, 10) : null;
  const endBase = endDateStr || dateStr;
  // Stored date + time are IST wall-clock; pin the parse to IST (+05:30, no
  // DST) so the instant is correct on any device timezone. Mirrors web's
  // effectiveBookingStatus (src/lib/booking-status.ts).
  const IST = "+05:30";
  const startMs = new Date(`${dateStr}T${padTime(b.start_time || "00:00")}${IST}`).getTime();
  const endMs = new Date(`${endBase}T${padTime(b.end_time || "23:59")}${IST}`).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return raw;
  const now = Date.now();
  if (now >= endMs) return "completed";
  if (now >= startMs) return "in_progress";
  return "confirmed";
}

function statusOf(s: string): Booking["status"] {
  const v = (s || "").toLowerCase();
  if (v === "completed") return "completed";
  if (v === "cancelled" || v === "expired") return "cancelled";
  if (v === "confirmed") return "confirmed";
  return "upcoming";
}
const fmtD = (d: Date) => `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
function whenStr(b: ApiBookingRow): string {
  const sd = b.scheduled_date ? new Date(b.scheduled_date) : null;
  const ed = b.end_date ? new Date(b.end_date) : null;
  const multiDay = !!(sd && ed && String(b.end_date).slice(0, 10) !== String(b.scheduled_date).slice(0, 10));
  const cat = String(b.service_category || "").toLowerCase();
  // Package + day-rental holds span the driver's WORKING WINDOW for that
  // date (server-side widening) — those times are real and worth showing
  // ("Full-day tour · 9 AM – 5 PM"). Bookings made before the widening (or
  // on listings without working hours) carry the 00:00–23:59 artifact —
  // show just the label for those.
  if (cat === "driver-package" || cat === "driver-day") {
    const st = (b.start_time || "").slice(0, 5);
    const et = (b.end_time || "").slice(0, 5);
    const window = st && et && !(st === "00:00" && et === "23:59") ? ` · ${fmt12(st)} – ${fmt12(et)}` : "";
    // Multi-day rental: end_date is the EXCLUSIVE hold end (last day + 1),
    // so the day count is the plain diff and the displayed end is ed − 1.
    if (multiDay && cat === "driver-day") {
      const days = Math.max(1, Math.round((ed!.getTime() - sd!.getTime()) / 86400000));
      const lastDay = new Date(ed!.getTime() - 86400000);
      return `${fmtD(sd!)} → ${fmtD(lastDay)} · ${days} day${days > 1 ? "s" : ""}${window}`;
    }
    const lbl = cat === "driver-package" ? "Full-day tour" : "Full day";
    return [sd ? fmtD(sd) : "", `${lbl}${window}`].filter(Boolean).join(" · ");
  }
  // Stays span nights: show "9 Jun → 11 Jun · 2 nights" (check-in → check-out).
  // Services are a single date + start time.
  if (multiDay) {
    const nights = Math.max(1, Math.round((ed!.getTime() - sd!.getTime()) / 86400000));
    return `${fmtD(sd!)} → ${fmtD(ed!)} · ${nights} night${nights > 1 ? "s" : ""}`;
  }
  const date = sd ? fmtD(sd) : "";
  const t = (b.start_time || "").slice(0, 5);
  return [date, t].filter(Boolean).join(" · ");
}
// Trim a display string, dropping empties and the placeholder names the
// backend seeds for users who never set a real one.
function clean(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() && v !== "User" && v !== "Anonymous" ? v.trim() : undefined;
}
// "09:00" → "9 AM", "17:30" → "5:30 PM".
function fmt12(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]), p = h >= 12 ? "PM" : "AM", h12 = ((h + 11) % 12) + 1;
  return m[2] === "00" ? `${h12} ${p}` : `${h12}:${m[2]} ${p}`;
}

export async function fetchBookings(scope: "user" | "provider" = "user"): Promise<ApiBookingRow[]> {
  const res = await api.get("/api/bookings", { params: scope === "provider" ? { scope: "provider" } : {} });
  const rows: ApiBookingRow[] = res.data?.data ?? res.data?.bookings ?? (Array.isArray(res.data) ? res.data : []);
  return rows.filter((b) => {
    const eff = effectiveStatus(b);
    // Expired holds never surface: the guest didn't pay, so no booking ever
    // existed. Previously statusOf folded them into "cancelled", inflating
    // the dashboard Cancelled counts vs the web (which has always hidden
    // expired on every surface).
    if (eff === "expired") return false;
    // Hidden until paid: a host-created (on-behalf) booking is only a payment-
    // link hold while pending — mobile has no "pending" bucket (statusOf folds
    // pending into "upcoming"), so an unpaid hold would masquerade as a locked-
    // in booking on BOTH the host dashboard and the linked guest's Bookings
    // tab. It appears the moment the guest pays and the webhook confirms it.
    return !(b.booked_on_behalf && eff === "pending");
  });
}

export type CallRelationship = { hasActiveBooking: boolean; phone: string | null; roles: string[] };

/**
 * Call gate for the in-chat Call button: does an active booking (confirmed /
 * in_progress / completed, either direction) link me and this peer? Returns the
 * peer's phone to dial and their role(s) relative to me (host/provider/driver/
 * guest) for the thread subtitle. Best-effort — a failure just hides the button.
 */
export async function fetchCallRelationship(peerUserId: string): Promise<CallRelationship> {
  try {
    const res = await api.get("/api/bookings/relationship", { params: { peerUserId } });
    const d = res.data ?? {};
    return {
      hasActiveBooking: Boolean(d.hasActiveBooking),
      phone: typeof d.phone === "string" && d.phone.trim() ? d.phone : null,
      roles: Array.isArray(d.roles) ? d.roles : [],
    };
  } catch {
    return { hasActiveBooking: false, phone: null, roles: [] };
  }
}

/** API booking → guest Bookings-tab card shape. */
export function mapGuestBooking(b: ApiBookingRow): Booking {
  const kind = kindOf(b.service_category);
  // The card subtitle names the PERSON providing the booking — the driver
  // (transport), the provider (service), or the host (stay). That's the
  // listing owner's own name (host_name = user_profiles.display_name on
  // listings.user_id), NOT the provider_profile business name
  // (provider_name, e.g. "Ravi's Trips") which a host can reuse across many
  // listings. Fall back to the business name only when the person's name is
  // missing on older rows.
  const isStay = kind === "stay";
  const hostName = b.host_name || b.provider_name || undefined;
  const hostUserId = (isStay ? b.host_user_id : b.provider_user_id) || b.provider_user_id || undefined;
  return {
    id: b.id, kind, title: b.listing_name || hostName || "Booking",
    sub: hostName || b.service_category || "", when: whenStr(b),
    status: statusOf(effectiveStatus(b)), price: paise(b), tone: toneFor(b.id), icon: ICON[kind],
    listingId: b.listing_id ?? undefined, providerId: b.provider_id ?? undefined,
    providerUserId: hostUserId,
    providerName: hostName,
    scheduledDate: b.scheduled_date ? String(b.scheduled_date).slice(0, 10) : undefined,
    startTime: (b.start_time || "").slice(0, 5) || undefined,
    endTime: (b.end_time || "").slice(0, 5) || undefined,
    address: b.address ?? undefined,
    // WS6: false = the host gave no street-level address (city-only) —
    // details surfaces show the "message/call your host" note.
    hasExactAddress: b.has_exact_address !== false,
    guestName: b.guest_name_snapshot ?? b.guest_name ?? undefined,
    roomCount: b.room_count != null ? Number(b.room_count) : undefined,
    guestCount: b.guest_count != null ? Number(b.guest_count) : undefined,
    // Transport vehicle snapshots — frozen at booking time (the booked car).
    vehicleModel: b.vehicle_model_snapshot ?? undefined,
    vehiclePlate: b.vehicle_plate_snapshot ?? undefined,
    vehicleColor: b.vehicle_color_snapshot ?? undefined,
    // Driver name + phone are LIVE (host's current personal name/phone) so the
    // rider always has a working number — falls back to the booking-time
    // snapshot for the phone on older rows. Driver name is the person
    // (host_name), NOT the provider-profile business name.
    driverName: clean(b.host_name) ?? undefined,
    driverPhone: clean(b.host_phone) ?? (b.driver_phone_snapshot ?? undefined),
    breakdown: {
      subtotal: rupeesOf(b.payment_subtotal_paise ?? b.subtotal_paise),
      fee: rupeesOf(b.payment_platform_fee_paise ?? b.platform_fee_paise),
      tax: rupeesOf(b.payment_taxes_paise ?? b.taxes_paise),
      insurance: rupeesOf(b.payment_insurance_premium_paise),
      discount: rupeesOf(b.payment_discount_paise ?? b.discount_paise),
      total: rupeesOf(b.payment_amount_paise ?? b.agreed_price_paise),
    },
  };
}

const rupeesOf = (n: unknown) => Math.round(Number(n) || 0) / 100;

/** Refund preview before a guest cancels — server computes the refund per the
 *  booking's cancellation policy (GET /api/bookings/:id/cancel-preview). Mirrors
 *  the web CancelBookingCard. No side effects; read-only. */
export type CancelPreview = {
  cancellable: boolean;
  refundRupees: number;
  platformKeepsRupees: number;
  insuranceVoided: boolean;
  reason: string;
};
export async function fetchCancelPreview(id: string): Promise<CancelPreview> {
  const res = await api.get(`/api/bookings/${id}/cancel-preview`);
  const d = res.data?.data ?? res.data ?? {};
  return {
    cancellable: d.cancellable !== false,
    refundRupees: Math.round(Number(d.refundPaise) || 0) / 100,
    platformKeepsRupees: Math.round(Number(d.platformKeepsPaise) || 0) / 100,
    insuranceVoided: !!d.insuranceVoided,
    reason: typeof d.reason === "string" ? d.reason : "",
  };
}

// Categorical guest-facing cancellation reasons. Mirrors the server enum in
// server/src/modules/bookings/schemas/cancellation-reasons.ts and the web
// const in src/domains/bookings/booking.service.ts (mobile shares no code
// with either) — change all three in the same PR.
export const CANCELLATION_REASONS = [
  "plans_changed",
  "found_alternative",
  "price_too_high",
  "booked_by_mistake",
  "host_asked_offline",
  "property_issue",
  "other",
] as const;

export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

/** Cancel a booking the signed-in user made as the GUEST. The backend computes
 *  the refund + issues it + sends cancellation/refund emails — same endpoint
 *  the web calls, so the side effects are identical. */
export async function cancelBookingAsGuest(id: string, reason?: CancellationReason) {
  await api.patch(`/api/bookings/${id}/status`, {
    status: "cancelled",
    as: "guest",
    ...(reason ? { cancellationReason: reason } : {}),
  });
}

/** API booking → provider/dashboard booking-row shape. */
export function mapDashBooking(b: ApiBookingRow) {
  const kind = kindOf(b.service_category);
  // Host-on-behalf bookings carry the walk-up guest's real name/phone in the
  // guest_contact jsonb (the row's user may be the host). It wins; then the
  // form-entered snapshot; then the guest's account name the backend joins in
  // as `guest_name` (mirrors the web). "Guest" is last resort.
  const guest = b.guest_contact?.name || b.guest_name_snapshot || b.guest_name || "Guest";
  return {
    id: b.id,
    kind, // listing type, so the dashboard can scope bookings to the active role
    guest, avatar: guest.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase(),
    item: b.listing_name || b.service_category || "", meta: `${whenStr(b)}${b.room_count ? ` · ${b.room_count} room` : ""}`,
    amount: paise(b), status: statusOf(effectiveStatus(b)) === "confirmed" ? "upcoming" : statusOf(effectiveStatus(b)),
    when: b.created_at ? new Date(b.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "",
    tone: toneFor(b.id), icon: ICON[kind],
    // Scheduling fields so the dashboard can place a booking on its listing's
    // calendar/schedule grid (listing-scoped — see DashSchedule).
    listingId: b.listing_id ?? undefined,
    scheduledDate: b.scheduled_date ? String(b.scheduled_date).slice(0, 10) : undefined,
    endDate: b.end_date ? String(b.end_date).slice(0, 10) : undefined,
    startTime: (b.start_time || "").slice(0, 5) || undefined,
    endTime: (b.end_time || "").slice(0, 5) || undefined,
    // Full breakdown so the host sees the same total composition as the guest.
    roomCount: b.room_count != null ? Number(b.room_count) : undefined,
    guestCount: b.guest_count != null ? Number(b.guest_count) : undefined,
    // Guest's reachable number for the host/provider booking detail — the
    // walk-up guest's contact on on-behalf bookings, else the guest's profile
    // phone (`guest_phone` join). Tapped → tel: link.
    guestPhone: b.guest_contact?.phone ?? b.guest_phone ?? undefined,
    // Booked vehicle identity snapshot — shown in the host booking detail.
    // Driver phone is the host's own number, so it's omitted here.
    vehicleModel: b.vehicle_model_snapshot ?? undefined,
    vehiclePlate: b.vehicle_plate_snapshot ?? undefined,
    vehicleColor: b.vehicle_color_snapshot ?? undefined,
    breakdown: {
      subtotal: rupeesOf(b.payment_subtotal_paise ?? b.subtotal_paise),
      fee: rupeesOf(b.payment_platform_fee_paise ?? b.platform_fee_paise),
      tax: rupeesOf(b.payment_taxes_paise ?? b.taxes_paise),
      insurance: rupeesOf(b.payment_insurance_premium_paise),
      discount: rupeesOf(b.payment_discount_paise ?? b.discount_paise),
      total: rupeesOf(b.payment_amount_paise ?? b.agreed_price_paise),
    },
  };
}

/** Cancel a booking from the dashboard. Pass the actor role so the backend
 *  attributes the cancellation correctly (host for stays, provider for
 *  services/transport) — mirrors the web's per-dashboard `as` value. */
export async function cancelBookingStatus(id: string, as: "host" | "provider" = "provider") {
  await api.patch(`/api/bookings/${id}/status`, { status: "cancelled", as });
}
