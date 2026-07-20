// design/api/assistant.ts — Ista AI assistant (real agent loop on POST /api/assistant).
// Response: { message, action:{type,params}, suggestions:[], toolCalls, requestId }.
import { api } from "@/lib/api";

export type AssistantAction = { type: string; params?: Record<string, unknown> };
export type AssistantReply = { message: string; action: AssistantAction; suggestions: string[] };
export type ChatMsg = { role: "user" | "assistant"; content: string };

/** Payload of the `prepare_booking_done` action — the server agent already
 *  created the slot hold + Razorpay order; the chat renders an inline
 *  Confirm & Pay card from this (mirrors the web BookingConfirmCard). */
export type ChatPreparedBooking = {
  bookingId: string;
  orderId: string;
  keyId: string;
  amount: number;       // rupees, server-authoritative (may carry paise)
  amountPaise: number;
  currency: "INR" | "USD";
  holdExpiresAt: string;
  listing: { id: string; name: string; image?: string; location?: string };
  schedule: { scheduledDate: string; startTime: string; endTime: string; checkOutDate?: string; nights?: number };
  room?: { id: string; name: string };
  transport?: { mode: "hourly" | "day" | "package"; pickupLocation?: string; passengerCount?: number; days?: number; hours?: number };
  insurance?: { included: boolean; amount: number };
};

/** Validate prepare_booking_done params into a card payload (null if malformed). */
export function parsePreparedBooking(p?: Record<string, unknown>): ChatPreparedBooking | null {
  if (!p || typeof p.bookingId !== "string" || typeof p.orderId !== "string") return null;
  const amount = Number(p.amount);
  if (!Number.isFinite(amount)) return null;
  // Nested params come off the wire untyped — one cast per group, coerced field-by-field below.
  const listing = p.listing as { id?: unknown; name?: unknown; image?: string; location?: string } | undefined;
  const schedule = p.schedule as { scheduledDate?: unknown; startTime?: unknown; endTime?: unknown; checkOutDate?: string; nights?: unknown } | undefined;
  const room = p.room as { id?: unknown; name?: unknown } | undefined;
  const transport = p.transport as ChatPreparedBooking["transport"];
  return {
    bookingId: p.bookingId,
    orderId: p.orderId,
    keyId: String(p.keyId ?? ""),
    amount,
    amountPaise: Number(p.amountPaise ?? Math.round(amount * 100)),
    currency: p.currency === "USD" ? "USD" : "INR",
    holdExpiresAt: String(p.holdExpiresAt ?? ""),
    listing: { id: String(listing?.id ?? ""), name: String(listing?.name ?? "Booking"), image: listing?.image, location: listing?.location },
    schedule: {
      scheduledDate: String(schedule?.scheduledDate ?? ""),
      startTime: String(schedule?.startTime ?? ""),
      endTime: String(schedule?.endTime ?? ""),
      checkOutDate: schedule?.checkOutDate,
      nights: schedule?.nights != null ? Number(schedule.nights) : undefined,
    },
    room: room?.name ? { id: String(room.id ?? ""), name: String(room.name) } : undefined,
    transport: transport?.mode ? transport : undefined,
    insurance: p.insurance as ChatPreparedBooking["insurance"],
  };
}

/** Payload of `show_listing_cards` — search/saved hits the chat renders as a
 *  horizontal card strip (mirrors the web ListingCardsInline). */
export type InlineListingHit = {
  id: string;
  title: string;
  /** stay | service | transport (stays may carry property types like "hotel"). */
  type: string;
  location?: string;
  /** Pre-formatted by the server tool, e.g. "₹2,500/night". */
  price?: string;
  rating?: number;
  image?: string;
};

export function parseListingHits(p?: Record<string, unknown>): InlineListingHit[] {
  const hits = p?.hits;
  if (!Array.isArray(hits)) return [];
  return hits
    .filter((h) => h && typeof h.id === "string" && typeof h.title === "string")
    .map((h) => ({
      id: h.id,
      title: h.title,
      type: String(h.type ?? ""),
      location: typeof h.location === "string" ? h.location : undefined,
      price: typeof h.price === "string" ? h.price : undefined,
      rating: Number.isFinite(Number(h.rating)) ? Number(h.rating) : undefined,
      image: typeof h.image === "string" ? h.image : undefined,
    }));
}

/** Payload of `show_bookings` — the user's bookings rendered as a compact list. */
export type InlineBooking = {
  id: string;
  status: string;
  listing?: string;
  provider?: string;
  /** ISO date (YYYY-MM-DD) of the stay/service start. */
  start?: string;
  /** Pre-formatted amount, e.g. "₹3,500". */
  amount?: string;
};

export function parseInlineBookings(p?: Record<string, unknown>): InlineBooking[] {
  const bookings = p?.bookings;
  if (!Array.isArray(bookings)) return [];
  return bookings
    .filter((b) => b && typeof b.id === "string")
    .map((b) => ({
      id: b.id,
      status: String(b.status ?? ""),
      listing: typeof b.listing === "string" ? b.listing : undefined,
      provider: typeof b.provider === "string" ? b.provider : undefined,
      start: typeof b.start === "string" ? b.start : undefined,
      amount: typeof b.amount === "string" ? b.amount : undefined,
    }));
}

/** Payload of `show_insights` — aggregated booking stats strip. */
export type BookingInsights = {
  totalSpent: string;
  counts: { upcoming: number; past: number; cancelled: number; total: number };
  nextTrip?: { id: string; listing?: string; date?: string; status?: string };
};

export function parseInsights(p?: Record<string, unknown>): BookingInsights | null {
  // Untyped wire payload — one cast, then the same field-level validation as before.
  const i = p?.insights as {
    totalSpent?: unknown;
    counts?: { upcoming?: unknown; past?: unknown; cancelled?: unknown; total?: unknown };
    nextTrip?: { id?: unknown; listing?: string; date?: string; status?: string };
  } | undefined;
  if (!i || typeof i.totalSpent !== "string" || !i.counts) return null;
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    totalSpent: i.totalSpent,
    counts: { upcoming: n(i.counts.upcoming), past: n(i.counts.past), cancelled: n(i.counts.cancelled), total: n(i.counts.total) },
    nextTrip: i.nextTrip && typeof i.nextTrip.id === "string"
      ? { id: i.nextTrip.id, listing: i.nextTrip.listing, date: i.nextTrip.date, status: i.nextTrip.status }
      : undefined,
  };
}

/** Payload of `confirm_cancel_booking` — the explicit user gate before a cancel. */
export type CancelBookingRequest = { bookingId: string; summary?: string };

export function parseCancelRequest(p?: Record<string, unknown>): CancelBookingRequest | null {
  if (!p || typeof p.bookingId !== "string") return null;
  return { bookingId: p.bookingId, summary: typeof p.summary === "string" ? p.summary : undefined };
}

/** Payload of `confirm_message_host` — editable draft DM the user must send. */
export type HostMessageDraft = { listingId: string; hostUserId: string; message: string; hostName?: string };

export function parseHostMessageDraft(p?: Record<string, unknown>): HostMessageDraft | null {
  if (!p || typeof p.hostUserId !== "string" || typeof p.message !== "string") return null;
  return {
    listingId: String(p.listingId ?? ""),
    hostUserId: p.hostUserId,
    message: p.message,
    hostName: typeof p.hostName === "string" ? p.hostName : undefined,
  };
}

/** LEGACY (ASSISTANT_TOOL_LOOP=0) `prepare_booking` action: the agent emitted
 *  booking args without running its tool, so the client creates the hold +
 *  order itself — same endpoint as above but WITHOUT the affirmation flag
 *  (that flag is a user tap, never model-set — root CLAUDE.md invariant). */
export async function prepareBookingFromAction(bookingArgs: Record<string, unknown>): Promise<ChatPreparedBooking> {
  const res = await api.post("/api/assistant/prepare-booking", bookingArgs);
  const booking = parsePreparedBooking(res.data?.data ?? res.data);
  if (!booking) throw new Error("Booking response looked incomplete — please try again.");
  return booking;
}

/** Where the user opened the chat from, in the WEB route vocabulary the
 *  backend's persona tuning expects ("/explore", "/dashboard/guest", …). */
export type AssistantContext = { path?: string };

/** Device UI language ("en", "hi", "te", …) — a hint only; the server detects
 *  the reply language from the user's message text. Hermes ships Intl on RN
 *  0.74, but stay defensive: fall back to "en" if it's unavailable. */
function deviceLang(): string {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || "en";
    return locale.split("-")[0].toLowerCase() || "en";
  } catch {
    return "en";
  }
}

export async function askAssistant(messages: ChatMsg[], context?: AssistantContext): Promise<AssistantReply> {
  const res = await api.post("/api/assistant", {
    messages,
    displayLang: deviceLang(),
    // platform tells the agent there's no marketplace grid here — it should
    // refine via fresh searches + cards, never filter_marketplace.
    context: { platform: "mobile", ...(context?.path ? { path: context.path } : {}) },
  });
  const d = res.data || {};
  return {
    message: d.message || "",
    action: d.action || { type: "none", params: {} },
    suggestions: Array.isArray(d.suggestions) ? d.suggestions : [],
  };
}
