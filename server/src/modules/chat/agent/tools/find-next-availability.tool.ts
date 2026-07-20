import { z } from 'zod';
import { listingsService } from '../../../listings/services/listings.service.js';
import { roomTypesRepository } from '../../../listings/repositories/room-types.repository.js';
import { availabilityOverridesRepository } from '../../../listings/repositories/availability-overrides.repository.js';
import { bookingsRepository } from '../../../bookings/repositories/bookings.repository.js';
import { logger } from '../../../../common/logging/logger.js';
import type { ToolDefinition } from '../types.js';

/**
 * "When's the SOONEST I can actually book X?" — the capability the agent was
 * missing. Until now the only forward-looking tool was
 * get_availability_overview, which is single-listing and mode-blind: it would
 * happily report "free slots" on a day-rate-only driver for an hourly ask,
 * and it can't answer "find the earliest open date across the drivers that do
 * hourly". So the model improvised — guessing "today" or hallucinating a
 * specific slot — and pitched unbookable suggestions.
 *
 * This tool composes the existing pieces into one honest answer:
 *   1. Pull active listings of the category, FILTER to ones that actually
 *      support the requested mode (transport hourly/day/package; service mode).
 *   2. Fetch each candidate's bookings + blocks ONCE over the horizon.
 *   3. Walk forward from `fromDate` (default today, IST) and stop at the FIRST
 *      date that is genuinely bookable for the requested mode/window — using
 *      the same overlap rules as the hold check (so a full-day rental blocks
 *      every hourly slot that day, etc.).
 *   4. Rank that date's bookable listings: soonest is fixed (it's one date),
 *      then rating desc, then price asc. Surface the top 3 — the agent quotes
 *      real options instead of inventing one.
 *
 * Read-only. Never mutates state; prepare_booking still re-validates at hold
 * time under FOR UPDATE.
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^\d{2}:\d{2}$/;

const ArgsSchema = z.object({
  category: z
    .enum(['stay', 'service', 'transport'])
    .describe('Listing type to scan.'),
  location: z
    .string()
    .max(80)
    .optional()
    .describe('Optional city/area filter (substring match on name/location/city).'),
  listingId: z
    .string()
    .min(1)
    .optional()
    .describe('Optional. Restrict the scan to ONE listing — use when the user asks "when is THIS one next free?". Otherwise all mode-matching listings in the category are scanned.'),
  transportMode: z
    .enum(['hourly', 'day', 'package'])
    .optional()
    .describe('Transport only. The billing mode the user wants. REQUIRED for transport so day-rate-only drivers are not offered for an hourly ask (and vice-versa). hourly: a free time window; day/package: a fully-free day.'),
  serviceMode: z
    .enum(['at-home', 'visit-provider', 'online'])
    .optional()
    .describe('Service only. Optional — filter to listings that offer this delivery mode.'),
  startTime: z
    .string()
    .regex(HHMM)
    .optional()
    .describe('Services / hourly transport — HH:MM. Pass with endTime when the user wants a SPECIFIC window on the next free day ("same 2-5pm trip, next day that works"). Omit to find the earliest day with ANY open slot.'),
  endTime: z
    .string()
    .regex(HHMM)
    .optional()
    .describe('Services / hourly transport — HH:MM end of the desired window. Pass alongside startTime.'),
  durationMinutes: z
    .number()
    .int()
    .min(15)
    .max(720)
    .optional()
    .describe('Services / hourly transport — used when no explicit window is given, to size "any open slot". Default 60.'),
  nights: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe('Stays — number of nights the guest wants (default 1). The scan finds the earliest check-in where every night in the stay is free.'),
  fromDate: z
    .string()
    .regex(DATE)
    .optional()
    .describe('YYYY-MM-DD to start scanning from (inclusive). Default: today (IST). Resolve "next week" etc. via Today (IST) first.'),
  daysAhead: z
    .number()
    .int()
    .min(1)
    .max(60)
    .optional()
    .describe('How far forward to scan. Default 30.'),
});
type Args = z.infer<typeof ArgsSchema>;

interface AvailabilityOption {
  listingId: string;
  title: string;
  location?: string;
  rating?: number;
  reviewCount?: number;
  priceLabel?: string;
  image?: string;
  /** Hourly transport / services: the free window we found (the requested one,
   *  or the first open slot of the size asked for). */
  window?: { start: string; end: string };
  /** Hourly transport / services without a fixed window: a few open starts. */
  sampleSlots?: string[];
  /** Stays: which room types are free across the requested nights. */
  availableRooms?: Array<{ roomTypeId: string; name: string; pricePerNight?: number }>;
}

interface NextAvailabilityResult {
  category: 'stay' | 'service' | 'transport';
  transportMode?: 'hourly' | 'day' | 'package';
  fromDate: string;
  daysAhead: number;
  /** How many mode-matching listings were scanned. 0 ⇒ nothing even supports
   *  the requested mode (agent should say so, not invent options). */
  scannedListings: number;
  found: boolean;
  earliestDate?: string;
  weekday?: string;
  /** Top 3 bookable options on `earliestDate`, ranked rating-desc then price-asc. */
  options: AvailabilityOption[];
  /** One-line digest the agent can quote verbatim. */
  summary: string;
}

const ISO_DOW: Record<number, string> = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat' };
const WEEKDAY_LABEL: Record<number, string> = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Normalise a pg DATE value to 'YYYY-MM-DD'. node-postgres parses `date`
 *  columns into JS Date objects (at local midnight), so String(value) yields
 *  "Sat Mar 15 2031 …" — slicing that gives a key that never matches the ISO
 *  dates we compute. Handle both Date objects and already-ISO strings. */
function isoDate(v: unknown): string {
  if (v instanceof Date) return toIso(v);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}
function parseHHMM(s: string | null | undefined): number | null {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]); const mm = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  return h * 60 + mm;
}
function fmtHHMM(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}
function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.replace(/[^\d.]/g, '')) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Supported modes from metadata — same signals search_listings uses. */
function deriveTransportModes(meta: Record<string, unknown>): string[] {
  const modes: string[] = [];
  if (num(meta.pricePerHour) != null) modes.push('hourly');
  if (num(meta.pricePerDay) != null) modes.push('day');
  if (Array.isArray(meta.packageOptions) && meta.packageOptions.length > 0) modes.push('package');
  return modes;
}

function workingHoursFor(meta: Record<string, unknown>, dow: number): { startMin: number; endMin: number } | null {
  const wh = (meta.workingHours ?? {}) as Record<string, [string, string] | null | undefined>;
  const tuple = wh?.[ISO_DOW[dow]];
  if (!Array.isArray(tuple) || tuple.length !== 2) return null;
  const s = parseHHMM(tuple[0]); const e = parseHHMM(tuple[1]);
  if (s == null || e == null || e <= s) return null;
  return { startMin: s, endMin: e };
}

/** Earliest free start of `durationMin` inside [startMin,endMin) that clears
 *  every booking + buffer. Returns null when the day can't fit it. */
function firstFreeStart(
  startMin: number,
  endMin: number,
  bookings: Array<{ s: number; e: number }>,
  bufferMin: number,
  durationMin: number,
): number | null {
  const sorted = [...bookings].filter((b) => b.e > startMin && b.s < endMin).sort((a, b) => a.s - b.s);
  let cursor = startMin;
  for (const b of sorted) {
    if (cursor + durationMin <= b.s) return cursor;
    cursor = Math.max(cursor, Math.min(endMin, b.e) + bufferMin);
  }
  return cursor + durationMin <= endMin ? cursor : null;
}

/** Up to `cap` free starts (for the "any open slot" presentation). */
function sampleFreeStarts(
  startMin: number,
  endMin: number,
  bookings: Array<{ s: number; e: number }>,
  bufferMin: number,
  durationMin: number,
  cap = 3,
): string[] {
  const sorted = [...bookings].filter((b) => b.e > startMin && b.s < endMin).sort((a, b) => a.s - b.s);
  const out: string[] = [];
  let cursor = startMin;
  const emit = (until: number) => {
    while (cursor + durationMin <= until && out.length < cap) {
      out.push(fmtHHMM(cursor));
      cursor += durationMin;
    }
  };
  for (const b of sorted) {
    emit(b.s);
    cursor = Math.max(cursor, Math.min(endMin, b.e) + bufferMin);
    if (out.length >= cap) return out;
  }
  emit(endMin);
  return out;
}

function listingImage(r: Record<string, unknown>): string | undefined {
  const cands = [Array.isArray(r.photos) ? r.photos[0] : undefined, Array.isArray(r.images) ? r.images[0] : undefined, r.image_url, r.image];
  for (const c of cands) if (typeof c === 'string' && /^https?:/.test(c)) return c;
  return undefined;
}

/** Per-mode sort price (rupees) + display label. */
function priceFor(category: string, meta: Record<string, unknown>, row: Record<string, unknown>, transportMode?: string): { sort: number; label?: string } {
  if (category === 'transport') {
    if (transportMode === 'day') { const d = num(meta.pricePerDay); return { sort: d ?? Infinity, label: d ? `₹${Math.round(d).toLocaleString('en-IN')}/day` : undefined }; }
    if (transportMode === 'package') {
      const prices = Array.isArray(meta.packageOptions) ? (meta.packageOptions as Array<Record<string, unknown>>).map((p) => num(p.price)).filter((n): n is number => n != null) : [];
      const min = prices.length ? Math.min(...prices) : Infinity;
      return { sort: min, label: prices.length ? `from ₹${Math.round(min).toLocaleString('en-IN')} pkg` : undefined };
    }
    const h = num(meta.pricePerHour); return { sort: h ?? Infinity, label: h ? `₹${Math.round(h)}/hr` : undefined };
  }
  const pn = num(row.price_per_night);
  if (pn != null) return { sort: pn, label: `₹${Math.round(pn).toLocaleString('en-IN')}/night` };
  const pp = typeof row.price_paise === 'number' ? row.price_paise / 100 : null;
  if (pp != null && pp > 0) return { sort: pp, label: `₹${Math.round(pp).toLocaleString('en-IN')}` };
  const flat = num(row.price);
  return { sort: flat ?? Infinity, label: flat ? `₹${Math.round(flat).toLocaleString('en-IN')}` : undefined };
}

/** Per-listing precomputed availability over the scan window. */
interface Candidate {
  row: Record<string, unknown>;
  meta: Record<string, unknown>;
  rating?: number;
  reviewCount?: number;
  /** date → bookings (minutes) for service/transport. */
  byDate: Map<string, Array<{ s: number; e: number }>>;
  /** any booking that day (date-level) for transport day/package. */
  busyDates: Set<string>;
  /** host-blocked ISO dates. */
  blockedDates: Set<string>;
  bufferMin: number;
  /** stays: per-room booked nights + room rows + listing-wide booked. */
  rooms?: Array<{ id: string; name: string; pricePerNight?: number }>;
  bookedByRoom?: Map<string, Set<string>>;
  listingWideBooked?: Set<string>;
}

async function buildServiceTransportCandidate(row: Record<string, unknown>, from: string, to: string, isTransport: boolean): Promise<Candidate> {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const [res, overridesRes] = await Promise.all([
    (isTransport
      ? bookingsRepository.listTransportBookingsForProvider(null, String(row.id), from, to)
      : bookingsRepository.listServiceBookingsForProvider(null, String(row.id), from, to)
    ).catch(() => ({ rows: [] as Array<{ scheduled_date: string; start_time: string; end_time: string }> })),
    availabilityOverridesRepository.listForListing(String(row.id), from, to).catch(() => ({ rows: [] as Array<any> })),
  ]);
  const byDate = new Map<string, Array<{ s: number; e: number }>>();
  const busyDates = new Set<string>();
  for (const b of res.rows as Array<{ scheduled_date: unknown; start_time: string; end_time: string }>) {
    const date = isoDate(b.scheduled_date);
    busyDates.add(date);
    const s = parseHHMM(b.start_time); const e = parseHHMM(b.end_time);
    if (s == null || e == null || e <= s) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push({ s, e });
  }
  // Provider-blocked whole days. Source of truth is the availability_overrides
  // table (listing-level, room_type_id null) — the same store the Schedule UI
  // writes and createHold enforces — so find-next-availability won't suggest a
  // day the provider blocked. Union legacy metadata.blockedDates for older
  // listings that still wrote there.
  const blockedDates = new Set<string>(Array.isArray(meta.blockedDates) ? (meta.blockedDates as unknown[]).filter((d): d is string => typeof d === 'string') : []);
  const overrides = ((overridesRes as { rows?: any[] }).rows ?? []) as Array<{ date: unknown; blocked: boolean; room_type_id: string | null }>;
  for (const o of overrides) {
    if (o.blocked && o.room_type_id == null) blockedDates.add(isoDate(o.date));
  }
  return {
    row, meta,
    rating: num(row.avg_rating) ?? undefined,
    reviewCount: typeof row.review_count === 'number' ? row.review_count : (num(row.review_count) ?? undefined),
    byDate, busyDates, blockedDates,
    bufferMin: typeof meta.bufferMinutes === 'number' ? meta.bufferMinutes : 15,
  };
}

async function buildStayCandidate(row: Record<string, unknown>, from: string, to: string): Promise<Candidate> {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const listingId = String(row.id);
  const [roomsRes, overridesRes] = await Promise.all([
    roomTypesRepository.listForListing(listingId).catch(() => ({ rows: [] as Array<Record<string, unknown>> })),
    availabilityOverridesRepository.listForListing(listingId, from, to).catch(() => ({ rows: [] as Array<any> })),
  ]);
  const roomRows = roomsRes.rows ?? [];
  const overrides = ((overridesRes as { rows?: any[]; data?: any[] }).rows ?? (overridesRes as { data?: any[] }).data ?? []) as Array<{ date: string; blocked: boolean; room_type_id: string | null }>;

  const blockedDates = new Set<string>();
  const blocksByRoom = new Map<string, Set<string>>();
  for (const o of overrides) {
    if (!o.blocked) continue;
    const od = isoDate(o.date);
    if (o.room_type_id == null) blockedDates.add(od);
    else { if (!blocksByRoom.has(o.room_type_id)) blocksByRoom.set(o.room_type_id, new Set()); blocksByRoom.get(o.room_type_id)!.add(od); }
  }

  const perRoomBooked = await Promise.all(roomRows.map((r) =>
    bookingsRepository.listBookedDatesForListing(listingId, String(r.id)).then((res) => res.rows.map((x) => isoDate(x.date))).catch(() => [] as string[])));
  const bookedByRoom = new Map<string, Set<string>>();
  roomRows.forEach((r, i) => {
    const merged = new Set<string>([...perRoomBooked[i], ...(blocksByRoom.get(String(r.id)) ?? [])]);
    bookedByRoom.set(String(r.id), merged);
  });
  const listingWideBooked = await bookingsRepository.listBookedDatesForListing(listingId)
    .then((res) => new Set(res.rows.map((r) => isoDate(r.date)))).catch(() => new Set<string>());

  return {
    row, meta,
    rating: num(row.avg_rating) ?? undefined,
    reviewCount: typeof row.review_count === 'number' ? row.review_count : (num(row.review_count) ?? undefined),
    byDate: new Map(), busyDates: new Set(), blockedDates,
    bufferMin: 0,
    rooms: roomRows.map((r) => ({ id: String(r.id), name: typeof r.name === 'string' ? r.name : 'Room', pricePerNight: (() => { const p = num(r.base_price_paise); return p != null ? Math.round(p / 100) : undefined; })() })),
    bookedByRoom,
    listingWideBooked,
  };
}

/** Decide if `cand` is bookable on `iso` for the requested mode/window, and
 *  return the option detail (window/slots/rooms) when it is. */
function evaluate(
  cand: Candidate,
  iso: string,
  dow: number,
  args: Args,
): AvailabilityOption | null {
  const { row, meta } = cand;
  const base: AvailabilityOption = {
    listingId: String(row.id),
    title: String(row.title ?? row.name ?? 'Listing'),
    location: typeof row.location === 'string' ? row.location : (typeof row.city === 'string' ? row.city : undefined),
    rating: cand.rating,
    reviewCount: cand.reviewCount,
    image: listingImage(row),
  };

  if (cand.blockedDates.has(iso)) return null;

  if (args.category === 'stay') {
    const nights = args.nights ?? 1;
    // Every night in [iso, iso+nights) must be free. Parse as LOCAL midnight
    // (not UTC) so toIso()'s local getters round-trip the same date the
    // forward-walk produced — a UTC parse + local format shifts a day on
    // machines west of UTC and silently checks the wrong night.
    const nightsIso: string[] = [];
    const start = new Date(`${iso}T00:00:00`);
    for (let i = 0; i < nights; i += 1) nightsIso.push(toIso(new Date(start.getTime() + i * 86_400_000)));
    if (nightsIso.some((d) => cand.blockedDates.has(d))) return null;
    if (!cand.rooms || cand.rooms.length === 0) {
      // No room types — single bucket. Free iff no night is listing-wide booked.
      if (nightsIso.some((d) => cand.listingWideBooked?.has(d))) return null;
      const { label } = priceFor('stay', meta, row);
      return { ...base, priceLabel: label };
    }
    const freeRooms = cand.rooms.filter((rm) => {
      const booked = cand.bookedByRoom?.get(rm.id) ?? new Set<string>();
      return !nightsIso.some((d) => booked.has(d));
    });
    if (freeRooms.length === 0) return null;
    const cheapest = [...freeRooms].sort((a, b) => (a.pricePerNight ?? Infinity) - (b.pricePerNight ?? Infinity))[0];
    return {
      ...base,
      priceLabel: cheapest.pricePerNight ? `₹${cheapest.pricePerNight.toLocaleString('en-IN')}/night` : undefined,
      availableRooms: freeRooms.map((r) => ({ roomTypeId: r.id, name: r.name, pricePerNight: r.pricePerNight })),
    };
  }

  // transport day/package: any booking that whole day → unavailable.
  if (args.category === 'transport' && (args.transportMode === 'day' || args.transportMode === 'package')) {
    const hours = workingHoursFor(meta, dow);
    if (!hours) return null; // closed weekday
    if (cand.busyDates.has(iso)) return null;
    const { label } = priceFor('transport', meta, row, args.transportMode);
    return { ...base, priceLabel: label };
  }

  // hourly transport OR service: window or any-slot within working hours.
  const hours = workingHoursFor(meta, dow);
  // No working hours configured → treat as open all day (legacy listings).
  const startMin = hours ? hours.startMin : 0;
  const endMin = hours ? hours.endMin : 24 * 60;
  if (hours === null && (meta.workingHours && typeof meta.workingHours === 'object')) {
    // workingHours present but this weekday is closed → unavailable.
    return null;
  }
  const dayBookings = cand.byDate.get(iso) ?? [];
  const priceLabel = priceFor(args.category, meta, row, args.transportMode).label;

  const reqStart = parseHHMM(args.startTime);
  const reqEnd = parseHHMM(args.endTime);
  if (reqStart != null && reqEnd != null && reqEnd > reqStart) {
    // Specific window must fit working hours AND clear every booking.
    if (reqStart < startMin || reqEnd > endMin) return null;
    const overlaps = dayBookings.some((b) => b.s < reqEnd && b.e > reqStart);
    if (overlaps) return null;
    return { ...base, priceLabel, window: { start: fmtHHMM(reqStart), end: fmtHHMM(reqEnd) } };
  }

  // Any open slot of the requested duration.
  const duration = args.durationMinutes ?? 60;
  const first = firstFreeStart(startMin, endMin, dayBookings, cand.bufferMin, duration);
  if (first == null) return null;
  const slots = sampleFreeStarts(startMin, endMin, dayBookings, cand.bufferMin, duration);
  return {
    ...base,
    priceLabel,
    window: { start: fmtHHMM(first), end: fmtHHMM(first + duration) },
    sampleSlots: slots.length > 0 ? slots : undefined,
  };
}

export async function findNextAvailability(args: Args): Promise<NextAvailabilityResult> {
  const daysAhead = args.daysAhead ?? 30;
  const startDay = args.fromDate ? new Date(`${args.fromDate}T00:00:00`) : new Date();
  startDay.setHours(0, 0, 0, 0);
  const fromIso = toIso(startDay);
  const lastDay = new Date(startDay.getTime() + (daysAhead - 1) * 86_400_000);
  const toIsoStr = toIso(lastDay);

  // 1. Candidate listings of the category, filtered by location + mode.
  let rows: Record<string, unknown>[] = [];
  if (args.listingId) {
    // GEO PRIVACY (WS6): getByIdPublic, NOT getById — this result's
    // `location` goes into the model context AND verbatim to the client
    // via toolCalls[]. The no-listingId branch below is already masked
    // (listPublic); the raw single-listing row here was the leak.
    const one = await listingsService.getByIdPublic(args.listingId).then((r) => (r as { data?: Record<string, unknown> }).data).catch(() => null);
    if (one) rows = [one];
  } else {
    const res = await listingsService.listPublic({ type: args.category, limit: 40 }).catch(() => ({ data: [] as Record<string, unknown>[] }));
    rows = (res.data ?? []) as Record<string, unknown>[];
  }

  const needle = args.location?.trim().toLowerCase() || '';
  rows = rows.filter((r) => {
    if (r.is_active === false) return false;
    if (needle) {
      const hay = [r.city, r.state, r.location, r.address, r.name, r.title].filter((v): v is string => typeof v === 'string').join(' ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    if (args.category === 'transport' && args.transportMode) {
      if (!deriveTransportModes(meta).includes(args.transportMode)) return false;
    }
    if (args.category === 'service' && args.serviceMode) {
      const modes = Array.isArray(meta.serviceModes) ? (meta.serviceModes as unknown[]).filter((m): m is string => typeof m === 'string') : [];
      if (modes.length > 0 && !modes.includes(args.serviceMode)) return false;
    }
    return true;
  });

  const scannedListings = rows.length;
  if (scannedListings === 0) {
    return {
      category: args.category, transportMode: args.transportMode,
      fromDate: fromIso, daysAhead, scannedListings: 0, found: false, options: [],
      summary: args.category === 'transport' && args.transportMode
        ? `No ${args.transportMode} ${args.category} listings exist to scan.`
        : `No ${args.category} listings exist to scan.`,
    };
  }

  // 2. Precompute each candidate's availability over the window (one batch of
  //    queries per listing — bounded, parallel).
  const isTransport = args.category === 'transport';
  const candidates: Candidate[] = await Promise.all(rows.slice(0, 40).map((r) =>
    args.category === 'stay'
      ? buildStayCandidate(r, fromIso, toIsoStr)
      : buildServiceTransportCandidate(r, fromIso, toIsoStr, isTransport),
  ));

  // 3. Walk forward; stop at the first date with ≥1 bookable candidate.
  for (let i = 0; i < daysAhead; i += 1) {
    const d = new Date(startDay.getTime() + i * 86_400_000);
    const iso = toIso(d);
    const dow = d.getDay();
    const hits: AvailabilityOption[] = [];
    for (const cand of candidates) {
      const opt = evaluate(cand, iso, dow, args);
      if (opt) hits.push(opt);
    }
    if (hits.length === 0) continue;

    // 4. Rank: rating desc (nulls last), then price asc (nulls last). Top 3.
    hits.sort((a, b) => {
      const ra = a.rating ?? -1; const rb = b.rating ?? -1;
      if (rb !== ra) return rb - ra;
      const pa = priceSort(a); const pb = priceSort(b);
      return pa - pb;
    });
    const top = hits.slice(0, 3);
    return {
      category: args.category, transportMode: args.transportMode,
      fromDate: fromIso, daysAhead, scannedListings,
      found: true, earliestDate: iso, weekday: WEEKDAY_LABEL[dow],
      options: top,
      summary: `Earliest ${args.category} availability is ${WEEKDAY_LABEL[dow]} ${iso} — ${top.length} option${top.length === 1 ? '' : 's'} (${top.map((o) => o.title).join(', ')}).`,
    };
  }

  return {
    category: args.category, transportMode: args.transportMode,
    fromDate: fromIso, daysAhead, scannedListings,
    found: false, options: [],
    summary: `No ${args.category} availability in the next ${daysAhead} days from ${fromIso}.`,
  };
}

/** Numeric price for ranking ties — pulled from the label we built (rupees). */
function priceSort(o: AvailabilityOption): number {
  if (o.availableRooms && o.availableRooms.length > 0) {
    const min = Math.min(...o.availableRooms.map((r) => r.pricePerNight ?? Infinity));
    return Number.isFinite(min) ? min : Infinity;
  }
  if (!o.priceLabel) return Infinity;
  const n = Number(o.priceLabel.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

export const findNextAvailabilityTool: ToolDefinition<Args, NextAvailabilityResult> = {
  name: 'find_next_availability',
  description:
    'Find the SOONEST date a category can actually be booked, across all listings that match what the user asked for — then quote the best 2-3 options on that date. CALL THIS whenever the user\'s requested date/slot is unavailable and they want the next one ("when\'s the next available date?", "what\'s the soonest you can do X?", "any other day that works?"), OR when they ask for the earliest option without naming a date. It walks forward from `fromDate` (default today, IST), skips booked/blocked/closed days, and returns `{found, earliestDate, weekday, options[]}` ranked by rating then price (top 3). **For transport you MUST pass `transportMode`** (hourly / day / package) so day-rate-only drivers are never offered for an hourly ask — `hourly` finds a free time window (pass startTime+endTime to keep the SAME window the user wanted, or omit for any open slot), `day`/`package` find a fully-free day. For services, pass startTime+endTime (or durationMinutes) and optionally serviceMode. For stays, pass `nights`. Each option carries the real listingId, rating, price and the free window/rooms — quote those; never invent a date or listing this tool didn\'t return. If `scannedListings` is 0, nothing supports that mode — say so honestly.',
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['stay', 'service', 'transport'] },
      location: { type: 'string' },
      listingId: { type: 'string', description: 'Optional — scan just one listing.' },
      transportMode: { type: 'string', enum: ['hourly', 'day', 'package'], description: 'Transport: REQUIRED — the mode the user wants.' },
      serviceMode: { type: 'string', enum: ['at-home', 'visit-provider', 'online'] },
      startTime: { type: 'string', description: 'HH:MM — services/hourly transport desired window start.' },
      endTime: { type: 'string', description: 'HH:MM — services/hourly transport desired window end.' },
      durationMinutes: { type: 'number', description: 'Used when no explicit window; default 60.' },
      nights: { type: 'number', description: 'Stays — nights wanted (default 1).' },
      fromDate: { type: 'string', description: 'YYYY-MM-DD — start of scan; default today.' },
      daysAhead: { type: 'number', description: 'Horizon; default 30, max 60.' },
    },
    required: ['category'],
  },

  async execute(args, _ctx) {
    try {
      return await findNextAvailability(args);
    } catch (err) {
      logger.warn('find_next_availability: failed', { category: args.category, error: (err as Error).message });
      throw err;
    }
  },

  summarize(_args, result) {
    return result.found
      ? `Soonest: ${result.weekday} ${result.earliestDate} (${result.options.length} option${result.options.length === 1 ? '' : 's'})`
      : result.scannedListings === 0
        ? 'Nothing matches that mode'
        : `Nothing open in ${result.daysAhead} days`;
  },
};
