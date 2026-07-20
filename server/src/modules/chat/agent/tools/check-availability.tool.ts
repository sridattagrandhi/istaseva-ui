import { z } from 'zod';
import { matchRoomType } from '../room-matching.js';
import { availabilityOverridesService } from '../../../listings/services/availability-overrides.service.js';
import { listingsRepository } from '../../../listings/repositories/listings.repository.js';
import { roomTypesRepository } from '../../../listings/repositories/room-types.repository.js';
import { bookingsRepository } from '../../../bookings/repositories/bookings.repository.js';
import { NotFoundError } from '../../../../common/errors/app-error.js';
import { logger } from '../../../../common/logging/logger.js';
import type { ToolDefinition } from '../types.js';

/**
 * Check whether a listing is bookable on a date (or date range for stays).
 *
 * Inputs three layers of "unavailable":
 *   1) Listing-level host blocks (apply to every room).
 *   2) Room-level host blocks (apply only to the scoped room).
 *   3) Existing bookings/holds — uses `bookingsRepository.listBookedDatesForListing`
 *      which is room-quantity-aware (a date is "booked" only when every physical
 *      room of that type is occupied).
 *
 * Why not call into bookingsService.createHold to "really" check?
 *   1. Holds mutate state (Redis slot lock + DB row). The agent must not lock
 *      a slot just to check.
 *   2. The DB trigger that enforces "no booking without payment" runs on
 *      insert; we'd be triggering it speculatively.
 *
 * This tool is still NOT the final authority — prepare_booking re-validates
 * under FOR UPDATE — but it's accurate enough for the agent to offer real
 * room choices to the user.
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const ArgsSchema = z
  .object({
    listingId: z
      .string()
      .min(1)
      .describe('Listing UUID from a previous tool result.'),
    date: z
      .string()
      .regex(DATE)
      .describe('Check-in / service date in YYYY-MM-DD (IST).'),
    checkOutDate: z
      .string()
      .regex(DATE)
      .optional()
      .describe('Stays only — check-out date in YYYY-MM-DD. Omit for services/transport.'),
    roomTypeId: z
      .string()
      .min(1)
      .optional()
      .describe('Hotel-style stays: optional room_type id to scope the availability check to a specific room.'),
  })
  .refine(
    (v) => !v.checkOutDate || v.checkOutDate > v.date,
    { message: 'checkOutDate must be after date', path: ['checkOutDate'] },
  );
type Args = z.infer<typeof ArgsSchema>;

interface RoomAvailability {
  id: string;
  name: string;
  pricePerNight?: number;
  maxGuests?: number;
  quantity?: number;
  /** Physical units of this room type STILL FREE across the requested range
   *  (quantity − the max already booked over any night). This is the number
   *  to quote ("2 of 5 left") and to validate a multi-room request against —
   *  NOT `quantity`, which is the total the host owns. */
  unitsRemaining?: number;
  /** True when at least one physical room of this type is free across EVERY
   *  requested night. */
  available: boolean;
  /** When unavailable, the nights that block this room (host-blocked or fully booked). */
  unavailableDates?: string[];
  unavailableReason?: 'blocked' | 'booked' | 'full';
}

interface AvailabilityResult {
  available: boolean;
  reason?: 'blocked' | 'fully_booked' | 'unknown_listing' | 'room_full';
  blockedDates?: string[];
  bookedDates?: string[];
  /** Lists all room types for the listing, each annotated with availability.
   *  Useful to show the user options ("Deluxe sold out, Suite still free"). */
  roomTypes?: RoomAvailability[];
  /** If a roomTypeId was supplied, echoes the rate for that room (paise → rupees). */
  roomPricePerNight?: number;
}

/**
 * The availability check itself, callable outside the tool. Used by
 * check_availability (the model-facing tool) AND by search_listings'
 * hard availability gate (probing each hit when the user named a date) —
 * one implementation so the two can never disagree about what "free" means.
 */
export async function checkListingAvailability(args: {
  listingId: string;
  date: string;
  checkOutDate?: string;
  roomTypeId?: string;
}): Promise<AvailabilityResult> {
    const from = args.date;
    // For a stay range we need every night from check-in (inclusive) to
    // check-out (exclusive). For services/transport it's just the date.
    const to = args.checkOutDate ?? args.date;

    try {
      const [result, roomsRes, listingRes] = await Promise.all([
        availabilityOverridesService.listForListing(args.listingId, from, to),
        roomTypesRepository.listForListing(args.listingId).catch(() => ({ rows: [] as Array<Record<string, unknown>> })),
        listingsRepository.getById(args.listingId).catch(() => ({ rows: [] as Array<Record<string, unknown>> })),
      ]);
      const overrides = (result as { data?: Array<{ date: string; blocked: boolean; room_type_id: string | null }> }).data ?? [];
      // Host-dialog whole-day blocks live in listings.metadata.blockedDates
      // (the store the web service/transport Schedule dialogs write) — union
      // them with the overrides table, same as find-next-availability and
      // the hold-time gate in bookings.service.ts, so the assistant can't
      // offer a day the provider blocked.
      const listingMeta = (listingRes.rows?.[0]?.metadata ?? {}) as Record<string, unknown>;
      const metaBlockedRaw = Array.isArray(listingMeta.blockedDates)
        ? (listingMeta.blockedDates as unknown[]).filter((d): d is string => typeof d === 'string')
        : [];
      const rooms = (roomsRes.rows ?? []) as Array<Record<string, unknown>>;

      // Build the set of dates the user cares about (every night in [from, to)).
      const wantedDates = new Set<string>();
      if (args.checkOutDate) {
        const start = new Date(`${args.date}T00:00:00Z`);
        const end = new Date(`${args.checkOutDate}T00:00:00Z`);
        for (let d = start; d < end; d = new Date(d.getTime() + 86_400_000)) {
          wantedDates.add(d.toISOString().slice(0, 10));
        }
      } else {
        wantedDates.add(args.date);
      }

      // Listing-level host blocks affect every room. Collect them first.
      const listingBlocked = new Set(
        overrides
          .filter((o) => o.blocked && o.room_type_id == null && wantedDates.has(o.date))
          .map((o) => o.date),
      );
      for (const d of metaBlockedRaw) {
        if (wantedDates.has(d)) listingBlocked.add(d);
      }

      // Fetch existing-bookings exhaustion per room IN PARALLEL (also the
      // listing-wide query for the no-rooms case). Each call returns the
      // dates where COUNT(active bookings) >= room.quantity.
      const [listingBookedRes, ...perRoomBookedRes] = await Promise.all([
        bookingsRepository.listBookedDatesForListing(args.listingId).catch(() => ({ rows: [] as Array<{ date: string }> })),
        ...rooms.map((r) =>
          bookingsRepository
            .listBookedDatesForListing(args.listingId, String(r.id))
            .catch(() => ({ rows: [] as Array<{ date: string }> })),
        ),
      ]);
      const listingBooked = new Set(
        (listingBookedRes.rows ?? []).map((r) => r.date).filter((d) => wantedDates.has(d)),
      );
      const bookedByRoom = new Map<string, Set<string>>();
      rooms.forEach((r, i) => {
        const set = new Set(
          (perRoomBookedRes[i]?.rows ?? []).map((row) => row.date).filter((d) => wantedDates.has(d)),
        );
        bookedByRoom.set(String(r.id), set);
      });

      // Remaining physical units per room over the requested range (quantity −
      // the busiest night's booked count). Quantity-aware: 3 of 5 Singles taken
      // on a night ⇒ remaining 2. This is what the agent quotes / validates a
      // multi-room request against. Same query the booking modal's room stepper
      // uses, so the two never disagree about how many are left.
      const remainingByRoom = new Map<string, number>();
      const remainingRes = await Promise.all(
        // async wrapper so a missing/throwing helper degrades to "no remaining
        // info" instead of failing the whole availability check.
        rooms.map(async (r) => {
          try {
            return await bookingsRepository.getRoomTypeAvailability(args.listingId, String(r.id), from, to);
          } catch {
            return { rows: [] as Array<{ quantity: number; remaining: number }> };
          }
        }),
      );
      rooms.forEach((r, i) => {
        const row = remainingRes[i]?.rows?.[0];
        if (row && Number.isFinite(Number(row.remaining))) {
          remainingByRoom.set(String(r.id), Math.max(0, Number(row.remaining)));
        }
      });

      // For each room, intersect listing-level blocks + this room's blocks +
      // this room's booked-out nights. If any wanted night lands in that union,
      // the room can't cover the whole range.
      const roomTypes: RoomAvailability[] = rooms.map((r) => {
        const id = String(r.id);
        const blocksForRoom = new Set<string>([...listingBlocked]);
        for (const o of overrides) {
          if (!o.blocked || o.room_type_id !== id) continue;
          if (wantedDates.has(o.date)) blocksForRoom.add(o.date);
        }
        const bookedForRoom = bookedByRoom.get(id) ?? new Set();
        const conflicts = new Set<string>([...blocksForRoom, ...bookedForRoom]);
        const available = conflicts.size === 0;
        const paise = Number(r.base_price_paise);
        // Reason precedence: block beats booked (host action is more specific
        // than guest inventory). 'full' is reserved for the rare case where
        // we marked the room unavailable but every conflicting date is a
        // host block — kept for future expansion (e.g. seasonal closures).
        let reason: RoomAvailability['unavailableReason'] | undefined;
        if (!available) {
          reason = blocksForRoom.size > 0 ? 'blocked' : 'booked';
        }
        return {
          id,
          name: typeof r.name === 'string' ? r.name : 'Room',
          pricePerNight: Number.isFinite(paise) && paise > 0 ? Math.round(paise / 100) : undefined,
          maxGuests: typeof r.max_guests === 'number' ? r.max_guests : undefined,
          quantity: typeof r.quantity === 'number' ? r.quantity : undefined,
          unitsRemaining: remainingByRoom.has(id) ? remainingByRoom.get(id) : undefined,
          available,
          unavailableDates: available ? undefined : [...conflicts].sort(),
          unavailableReason: reason,
        };
      });

      // If the caller pinned a roomTypeId, the top-level `available` reflects
      // ONLY that room. Otherwise it reflects "is anything bookable":
      //   - no rooms on listing → use listing-level blocks + listing-level booked
      //   - rooms on listing → at least one room must be `available: true`
      // Tolerate a slug/name in roomTypeId (model habit) — match by id or name.
      const roomPricePerNightMatch = args.roomTypeId
        ? ((matchRoomType(args.roomTypeId, roomTypes as unknown as Array<Record<string, unknown>>) as RoomAvailability | null) ?? undefined)
        : undefined;

      if (args.roomTypeId) {
        if (!roomPricePerNightMatch) {
          return { available: false, reason: 'unknown_listing', roomTypes };
        }
        if (!roomPricePerNightMatch.available) {
          const reason =
            roomPricePerNightMatch.unavailableReason === 'blocked' ? 'blocked' : 'room_full';
          return {
            available: false,
            reason,
            blockedDates: roomPricePerNightMatch.unavailableReason === 'blocked'
              ? roomPricePerNightMatch.unavailableDates
              : undefined,
            bookedDates: roomPricePerNightMatch.unavailableReason !== 'blocked'
              ? roomPricePerNightMatch.unavailableDates
              : undefined,
            roomTypes,
            roomPricePerNight: roomPricePerNightMatch.pricePerNight,
          };
        }
        return {
          available: true,
          roomTypes,
          roomPricePerNight: roomPricePerNightMatch.pricePerNight,
        };
      }

      // No room pinned. With rooms: ok if any room is available.
      if (roomTypes.length > 0) {
        const anyFree = roomTypes.some((rt) => rt.available);
        if (anyFree) return { available: true, roomTypes };

        // Everything's full or blocked. Build top-level date arrays by
        // unioning every unavailable room's dates by reason. The listing-wide
        // booked-date query alone misses this case for hotels (it only marks
        // a date as booked when EVERY room is full simultaneously), so we
        // can't rely on `listingBooked` here.
        const blockedUnion = new Set<string>([...listingBlocked]);
        const bookedUnion = new Set<string>();
        let allBlocked = true;
        for (const rt of roomTypes) {
          if (!rt.unavailableDates) continue;
          if (rt.unavailableReason === 'blocked') {
            for (const d of rt.unavailableDates) blockedUnion.add(d);
          } else {
            allBlocked = false;
            for (const d of rt.unavailableDates) bookedUnion.add(d);
          }
        }
        // If ALL room types are blocked for the entire wanted range, prefer
        // the cleaner 'blocked' reason; otherwise call it fully_booked. Either
        // way, return both sets so the agent can quote the right dates.
        return {
          available: false,
          reason: allBlocked ? 'blocked' : 'fully_booked',
          blockedDates: blockedUnion.size > 0 ? [...blockedUnion].sort() : undefined,
          bookedDates: bookedUnion.size > 0 ? [...bookedUnion].sort() : undefined,
          roomTypes,
        };
      }

      // Single-listing stay/service/transport — no rooms.
      if (listingBlocked.size > 0) {
        return { available: false, reason: 'blocked', blockedDates: [...listingBlocked].sort() };
      }
      if (listingBooked.size > 0) {
        return { available: false, reason: 'fully_booked', bookedDates: [...listingBooked].sort() };
      }
      return { available: true };
    } catch (err) {
      // listForListing throws NotFoundError for unknown listingId. Treat as
      // "we can't tell" rather than "definitely available" — the model's
      // job is to ask the user to retry, not push them into a bad booking.
      if (err instanceof NotFoundError) {
        return { available: false, reason: 'unknown_listing' };
      }
      throw err;
    }
}

/**
 * Window-precise availability for a service/transport listing on one date:
 * 'busy' if the day is host-blocked OR an active booking overlaps the exact
 * [startTime, endTime) window, 'free' if neither, 'unknown' on error/unknown
 * listing. Lets the assistant's search gate HARD-DROP a driver booked
 * 9 AM–5 PM from a 2–5 PM search (date-level checks can only say "something's
 * booked that day"). Shares the hold's overlap predicate via
 * bookingsRepository.listActiveBookingsOverlappingWindow.
 */
export async function checkListingWindowAvailability(args: {
  listingId: string;
  date: string;
  startTime: string;
  endTime: string;
}): Promise<'free' | 'busy' | 'unknown'> {
  try {
    const [ov, conflict] = await Promise.all([
      availabilityOverridesService.listForListing(args.listingId, args.date, args.date),
      bookingsRepository.listActiveBookingsOverlappingWindow(args.listingId, args.date, args.startTime, args.endTime),
    ]);
    const overrides = (ov as { data?: Array<{ date: string; blocked: boolean; room_type_id: string | null }> }).data ?? [];
    const hostBlocked = overrides.some((o) => o.blocked && o.room_type_id == null && o.date === args.date);
    if (hostBlocked) return 'busy';
    return (conflict.rows ?? []).length > 0 ? 'busy' : 'free';
  } catch (err) {
    if (err instanceof NotFoundError) return 'unknown';
    logger.warn('checkListingWindowAvailability failed', {
      listingId: args.listingId,
      error: (err as Error).message,
    });
    return 'unknown';
  }
}

export const checkAvailabilityTool: ToolDefinition<Args, AvailabilityResult> = {
  name: 'check_availability',
  description:
    "Check whether a listing is bookable on a date (or date range for stays). Returns {available, blockedDates?, bookedDates?, roomTypes?}. For hotels, roomTypes[] has per-room `available` flags, prices, `quantity` (total units the host owns) AND `unitsRemaining` (units STILL FREE over the requested range). **Quote `unitsRemaining`, never `quantity`** — a hotel with 5 Singles and 3 booked has `quantity:5, unitsRemaining:2`, so the honest answer to 'how many can I get?' is 2. When the user asks for N rooms, compare N to `unitsRemaining`: if N > unitsRemaining, say only `unitsRemaining` are free and offer that many (or another room). Inventory-aware: counts existing bookings' room_count against quantity. NOT authoritative — actual booking still validates at hold time. Always call before suggesting prepare_booking.",
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      listingId: { type: 'string' },
      date: { type: 'string', description: 'YYYY-MM-DD' },
      checkOutDate: { type: 'string', description: 'YYYY-MM-DD; stays only' },
      roomTypeId: { type: 'string', description: 'Optional — scope check to one hotel room type.' },
    },
    required: ['listingId', 'date'],
  },

  async execute(args, _ctx) {
    return checkListingAvailability(args);
  },

  summarize(args, result) {
    if (result.available) {
      const free = result.roomTypes?.filter((rt) => rt.available).length;
      return free ? `Available — ${free} room type${free === 1 ? '' : 's'} free` : `Available on ${args.date}`;
    }
    if (result.reason === 'blocked') return `Blocked on ${result.blockedDates?.join(', ') ?? args.date}`;
    if (result.reason === 'fully_booked') return `Fully booked on ${result.bookedDates?.join(', ') ?? args.date}`;
    if (result.reason === 'room_full') return `That room is sold out for ${result.bookedDates?.join(', ') ?? args.date}`;
    return `Couldn't verify availability for ${args.listingId}`;
  },
};
