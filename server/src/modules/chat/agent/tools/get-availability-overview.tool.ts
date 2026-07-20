import { z } from 'zod';
import { listingsRepository } from '../../../listings/repositories/listings.repository.js';
import { roomTypesRepository } from '../../../listings/repositories/room-types.repository.js';
import { availabilityOverridesRepository } from '../../../listings/repositories/availability-overrides.repository.js';
import { bookingsRepository } from '../../../bookings/repositories/bookings.repository.js';
import { logger } from '../../../../common/logging/logger.js';
import type { ToolDefinition } from '../types.js';

/**
 * "What's open?" tool — answers the question the agent could never answer
 * before. Until now the only availability tool (`check_availability`) needed
 * a specific date as input, so when a user asked "what dates are available?"
 * the agent had to bounce the question back: "what dates were you thinking?".
 * That's a tool gap masquerading as a reasoning failure.
 *
 * Returns a per-day rollup over the next N days (default 14) for any listing
 * type. The shape changes per type — stays get room-level fullness, services
 * and transport get working-hours + sample free time-slots — so the agent
 * can speak naturally about what's possible:
 *   stay     → "May 24–26 open, May 27 sold out (Deluxe), May 28+ open"
 *   service  → "Mon–Fri 9–17 — Wed has 11am, 2pm, 4pm free"
 *   transport → "Mon–Fri 9–17, May 27 11am–2pm booked, otherwise wide open"
 *
 * Read-only. Calls the same data sources the host's own dashboard uses,
 * so what the agent sees matches what the provider sees.
 */
const ArgsSchema = z.object({
  listingId: z
    .string()
    .min(1)
    .describe('Listing UUID. Pass the id from a previous search_listings or get_listing_details result — never a hand-typed string.'),
  daysAhead: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(14)
    .describe('How many days from today to summarise. Default 14 — enough to give the user real choice without flooding the chat. Cap 30.'),
  transportPricingMode: z
    .enum(['hourly', 'day', 'package'])
    .optional()
    .describe('Transport only. The mode the user wants. Pass it so the rollup is computed for that mode — day/package treat ANY booking that day as whole-day-blocking (not "partial"), and the result flags whether the listing even supports the mode. A day-rate-only driver must not be presented as having hourly openings.'),
});
type Args = z.infer<typeof ArgsSchema>;

type DayRollup =
  | {
      date: string;       // YYYY-MM-DD
      weekday: string;    // Mon, Tue, ...
      status: 'open' | 'partial' | 'fully_booked' | 'blocked' | 'closed';
      // Optional per-type detail:
      roomsAvailable?: Array<{ roomTypeId: string; name: string; available: boolean }>;
      workingHours?: { start: string; end: string };
      sampleFreeSlots?: string[]; // up to 3 "HH:MM" starts
      bookedRanges?: Array<{ start: string; end: string }>;
    };

interface OverviewResult {
  listingType: 'stay' | 'service' | 'transport';
  listingName: string;
  daysAhead: number;
  /** Summary string the agent can quote verbatim if it wants. */
  summary: string;
  days: DayRollup[];
  /** Transport only — the modes this listing actually prices for. */
  supportedModes?: string[];
  /** Transport only — false when the caller asked about a mode this listing
   *  doesn't offer (so the agent says "this driver only does X", not a slot). */
  requestedModeSupported?: boolean;
}

/** Transport modes a listing prices for — same signals search_listings uses. */
function deriveTransportModes(meta: Record<string, unknown>): string[] {
  const n = (v: unknown) => { const x = typeof v === 'string' ? Number(v.replace(/[^\d.]/g, '')) : Number(v); return Number.isFinite(x) && x > 0 ? x : null; };
  const modes: string[] = [];
  if (n(meta.pricePerHour) != null) modes.push('hourly');
  if (n(meta.pricePerDay) != null) modes.push('day');
  if (Array.isArray(meta.packageOptions) && meta.packageOptions.length > 0) modes.push('package');
  return modes;
}

const ISO_DOW: Record<number, string> = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat' };
const WEEKDAY_LABEL: Record<number, string> = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

/** Working hours map per weekday from listing metadata. Returns null when
 *  the day is closed (or when metadata is malformed). */
function workingHoursFor(metadata: Record<string, unknown>, dow: number): { start: string; end: string } | null {
  const wh = (metadata.workingHours ?? {}) as Record<string, [string, string] | null | undefined>;
  const key = ISO_DOW[dow];
  const tuple = wh?.[key];
  if (!Array.isArray(tuple) || tuple.length !== 2) return null;
  const [start, end] = tuple;
  if (!start || !end) return null;
  return { start, end };
}

/** Bucket a list of bookings on a single day into time-overlap pairs and
 *  derive up to N free 1-hour slots inside the working window, cascading
 *  past each booking + buffer (same rule the strip uses on the frontend). */
function deriveFreeSlots(
  workingStart: number,
  workingEnd: number,
  bookings: Array<{ s: number; e: number }>,
  bufferMin: number,
  durationMin: number = 60,
  cap: number = 3,
): string[] {
  const sorted = [...bookings].sort((a, b) => a.s - b.s);
  const out: string[] = [];
  let cursor = workingStart;
  const tryEmit = (until: number) => {
    while (cursor + durationMin <= until && out.length < cap) {
      out.push(fmtHHMM(cursor));
      cursor += durationMin;
    }
  };
  for (const b of sorted) {
    if (b.e <= workingStart || b.s >= workingEnd) continue;
    tryEmit(b.s);
    cursor = Math.max(cursor, Math.min(workingEnd, b.e) + bufferMin);
    if (out.length >= cap) return out;
  }
  tryEmit(workingEnd);
  return out;
}

async function overviewForStay(listing: Record<string, unknown>, days: Date[], _metadata: Record<string, unknown>): Promise<DayRollup[]> {
  const listingId = String(listing.id);
  const from = toIso(days[0]);
  const to = toIso(days[days.length - 1]);

  // Three signals, fetched in parallel:
  //   1. Host overrides (listing-level + per-room blocks).
  //   2. Room types (so we can say "Deluxe sold out, Suite still free").
  //   3. Per-room booked dates (quantity-aware — same query check_availability uses).
  const [overridesRes, roomsRes] = await Promise.all([
    availabilityOverridesRepository.listForListing(listingId, from, to).catch(() => ({ rows: [] as Array<any> })),
    roomTypesRepository.listForListing(listingId).catch(() => ({ rows: [] as Array<any> })),
  ]);
  const overrides = (overridesRes as { rows?: any[]; data?: any[] }).rows
    ?? (overridesRes as { data?: any[] }).data
    ?? [];
  const rooms = roomsRes.rows ?? [];

  const perRoomBooked = await Promise.all(
    rooms.map((r: any) =>
      bookingsRepository.listBookedDatesForListing(listingId, String(r.id))
        .then((res) => res.rows.map((row) => row.date))
        .catch(() => [] as string[]),
    ),
  );
  const listingWideBooked = await bookingsRepository.listBookedDatesForListing(listingId)
    .then((res) => new Set(res.rows.map((r) => r.date)))
    .catch(() => new Set<string>());

  const listingBlocked = new Set<string>();
  const blocksByRoom = new Map<string, Set<string>>();
  for (const o of overrides as Array<{ date: string; blocked: boolean; room_type_id: string | null }>) {
    if (!o.blocked) continue;
    if (o.room_type_id == null) listingBlocked.add(o.date);
    else {
      if (!blocksByRoom.has(o.room_type_id)) blocksByRoom.set(o.room_type_id, new Set());
      blocksByRoom.get(o.room_type_id)!.add(o.date);
    }
  }
  const bookedByRoom = new Map<string, Set<string>>();
  rooms.forEach((r: any, i: number) => {
    bookedByRoom.set(String(r.id), new Set(perRoomBooked[i]));
  });

  return days.map((d) => {
    const iso = toIso(d);
    const dow = d.getDay();
    if (listingBlocked.has(iso)) {
      return { date: iso, weekday: WEEKDAY_LABEL[dow], status: 'blocked' as const };
    }
    if (rooms.length === 0) {
      // No room types — treat the whole listing as one bucket.
      return {
        date: iso, weekday: WEEKDAY_LABEL[dow],
        status: listingWideBooked.has(iso) ? 'fully_booked' as const : 'open' as const,
      };
    }
    const roomsAvailable = rooms.map((r: any) => {
      const id = String(r.id);
      const blocks = blocksByRoom.get(id) ?? new Set();
      const booked = bookedByRoom.get(id) ?? new Set();
      return {
        roomTypeId: id,
        name: typeof r.name === 'string' ? r.name : 'Room',
        available: !blocks.has(iso) && !booked.has(iso),
      };
    });
    const freeCount = roomsAvailable.filter((r) => r.available).length;
    const status: DayRollup['status'] =
      freeCount === 0 ? 'fully_booked' :
      freeCount < roomsAvailable.length ? 'partial' :
      'open';
    return { date: iso, weekday: WEEKDAY_LABEL[dow], status, roomsAvailable };
  });
}

async function overviewForServiceOrTransport(
  listing: Record<string, unknown>,
  days: Date[],
  metadata: Record<string, unknown>,
  transportPricingMode?: 'hourly' | 'day' | 'package',
): Promise<DayRollup[]> {
  // Day/package are WHOLE-DAY modes: the vehicle is committed for the entire
  // day, so any booking that day (and any host block) means the date is taken
  // — there is no "partial". Slot math only applies to hourly / services.
  const wholeDayMode = transportPricingMode === 'day' || transportPricingMode === 'package';
  const listingId = String(listing.id);
  const from = toIso(days[0]);
  const to = toIso(days[days.length - 1]);

  // Pull only what we need: existing bookings for this listing across the
  // window, plus the listing's own blocked-day set. The per-listing scoping
  // we shipped earlier means cross-listing bookings won't leak in.
  const isTransport = String(listing.listing_type ?? '') === 'transport';
  const bookingsCall = isTransport
    ? bookingsRepository.listTransportBookingsForProvider(null, listingId, from, to)
    : bookingsRepository.listServiceBookingsForProvider(null, listingId, from, to);

  const bookingsRes = await bookingsCall.catch(() => ({ rows: [] as any[] }));
  const bookings = bookingsRes.rows as Array<{ scheduled_date: string; start_time: string; end_time: string; status: string }>;

  // Group bookings by date for O(1) per-day lookup. node-postgres parses
  // `date` columns into JS Date objects, so String(scheduled_date) is
  // "Sat Mar 15 2031 …" — slicing that never matches the ISO keys we build
  // from toIso(). Normalise Date | ISO-string the same way.
  const byDate = new Map<string, Array<{ s: number; e: number }>>();
  for (const b of bookings as Array<{ scheduled_date: unknown; start_time: string; end_time: string }>) {
    const date = b.scheduled_date instanceof Date ? toIso(b.scheduled_date) : String(b.scheduled_date).slice(0, 10);
    const s = parseHHMM(b.start_time);
    const e = parseHHMM(b.end_time);
    if (s == null || e == null || e <= s) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push({ s, e });
  }

  // Host-declared blocked dates live in metadata, not the overrides table
  // (that's stays-only today). Treat as opaque ISO strings.
  const blockedDates = new Set<string>(
    Array.isArray(metadata.blockedDates)
      ? (metadata.blockedDates as unknown[]).filter((d): d is string => typeof d === 'string')
      : [],
  );

  const bufferMin = typeof metadata.bufferMinutes === 'number' ? metadata.bufferMinutes : 15;

  return days.map((d) => {
    const iso = toIso(d);
    const dow = d.getDay();
    if (blockedDates.has(iso)) {
      return { date: iso, weekday: WEEKDAY_LABEL[dow], status: 'blocked' as const };
    }
    const hours = workingHoursFor(metadata, dow);
    if (!hours) {
      return { date: iso, weekday: WEEKDAY_LABEL[dow], status: 'closed' as const };
    }
    const startMin = parseHHMM(hours.start);
    const endMin = parseHHMM(hours.end);
    if (startMin == null || endMin == null || endMin <= startMin) {
      return { date: iso, weekday: WEEKDAY_LABEL[dow], status: 'closed' as const };
    }
    const dayBookings = byDate.get(iso) ?? [];
    const bookedRanges = dayBookings.map((b) => ({ start: fmtHHMM(b.s), end: fmtHHMM(b.e) }));

    // Whole-day modes (transport day/package): the date is open ONLY if it has
    // no booking at all — one ride that day commits the vehicle. No "partial",
    // no slot list (booking the whole day, not a window).
    if (wholeDayMode) {
      return {
        date: iso,
        weekday: WEEKDAY_LABEL[dow],
        status: dayBookings.length > 0 ? 'fully_booked' as const : 'open' as const,
        workingHours: hours,
        bookedRanges: bookedRanges.length > 0 ? bookedRanges : undefined,
      };
    }

    const sampleFreeSlots = deriveFreeSlots(startMin, endMin, dayBookings, bufferMin);
    // Status precedence (hourly / services):
    //   - if working-window has zero free slot-starts → fully_booked
    //   - if any booking on the day → partial
    //   - otherwise → open
    const status: DayRollup['status'] =
      sampleFreeSlots.length === 0 ? 'fully_booked' :
      dayBookings.length > 0 ? 'partial' :
      'open';

    return {
      date: iso,
      weekday: WEEKDAY_LABEL[dow],
      status,
      workingHours: hours,
      sampleFreeSlots,
      bookedRanges: bookedRanges.length > 0 ? bookedRanges : undefined,
    };
  });
}

/** One-line digest of the overview the agent can quote without rewriting. */
function buildSummary(name: string, days: DayRollup[]): string {
  const open = days.filter((d) => d.status === 'open' || d.status === 'partial').length;
  const total = days.length;
  if (open === 0) return `${name}: nothing available in the next ${total} days.`;
  const firstOpen = days.find((d) => d.status === 'open' || d.status === 'partial');
  if (!firstOpen) return `${name}: ${open}/${total} days open.`;
  return `${name}: ${open}/${total} days open — earliest is ${firstOpen.weekday} ${firstOpen.date}.`;
}

export const getAvailabilityOverviewTool: ToolDefinition<Args, OverviewResult> = {
  name: 'get_availability_overview',
  description:
    'Get a per-day open/booked rollup for one listing over the next N days (default 14). CALL THIS whenever the user asks "what dates are available?", "when are you free?", "what days work?" — anything where they want to see options BEFORE picking a specific date. Don\'t bounce that question back to them. For stays returns per-room availability per day; for services/transport returns working hours + sample free slot starts. Then quote concrete dates/times to the user. If they then pick one, follow with check_availability for the canonical check.',
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      listingId: { type: 'string' },
      daysAhead: { type: 'number', default: 14 },
      transportPricingMode: { type: 'string', enum: ['hourly', 'day', 'package'], description: 'Transport: the mode the user wants — day/package treat any booking as whole-day-blocking, and the result flags if the listing supports the mode.' },
    },
    required: ['listingId'],
  },

  async execute(args, _ctx) {
    const result = await listingsRepository.getById(args.listingId);
    const listing = result.rows[0] as Record<string, unknown> | undefined;
    if (!listing) {
      // Match check_availability's "we can't tell" failure mode rather than
      // pretending the listing has no availability — the agent should ask
      // the user to re-pick rather than push a non-existent listing.
      throw new Error(`Listing ${args.listingId} not found`);
    }

    const listingType = String(listing.listing_type ?? '').toLowerCase();
    const listingName = String(listing.name ?? listing.title ?? 'Listing');
    const metadata = (listing.metadata ?? {}) as Record<string, unknown>;

    // Build the day window: today (IST date) + N - 1 days. Use IST so the
    // "today" the agent sees lines up with the user's mental model.
    const today = new Date();
    const days: Date[] = Array.from({ length: args.daysAhead }, (_, i) => {
      const d = new Date(today);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + i);
      return d;
    });

    try {
      // Transport mode awareness: know which modes the listing prices for so
      // we never present a day-rate-only driver as having hourly openings.
      const supportedModes = listingType === 'transport' ? deriveTransportModes(metadata) : undefined;
      const requestedModeSupported = args.transportPricingMode != null && supportedModes != null
        ? supportedModes.includes(args.transportPricingMode)
        : undefined;

      const rollup = listingType === 'stay'
        ? await overviewForStay(listing, days, metadata)
        : await overviewForServiceOrTransport(listing, days, metadata, args.transportPricingMode);

      const summary = requestedModeSupported === false
        ? `${listingName} doesn't offer ${args.transportPricingMode} booking${supportedModes && supportedModes.length ? ` — only ${supportedModes.join(', ')}.` : '.'}`
        : buildSummary(listingName, rollup);
      return {
        listingType: (['stay', 'service', 'transport'].includes(listingType) ? listingType : 'service') as OverviewResult['listingType'],
        listingName,
        daysAhead: args.daysAhead,
        summary,
        days: rollup,
        ...(supportedModes ? { supportedModes } : {}),
        ...(requestedModeSupported != null ? { requestedModeSupported } : {}),
      };
    } catch (err) {
      logger.warn('get_availability_overview: failed', {
        listingId: args.listingId,
        error: (err as Error).message,
      });
      throw err;
    }
  },

  summarize(_args, result) {
    return result.summary;
  },
};
