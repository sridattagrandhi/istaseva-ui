import { z } from 'zod';
import { listingsService } from '../../../listings/services/listings.service.js';
import { matchRoomType } from '../room-matching.js';
import { availabilityOverridesService } from '../../../listings/services/availability-overrides.service.js';
import { bookingsRepository } from '../../../bookings/repositories/bookings.repository.js';
import {
  applyFees,
  subtotalForStayPaise,
  resolveNightlyStayPaiseList,
} from '../../../payments/pricing/booking-price.js';
import { insurancePremiumRupees } from '../../../payments/pricing/fees.js';
import { feeRulesService } from '../../../payments/services/fee-rules.service.js';
import { NotFoundError } from '../../../../common/errors/app-error.js';
import { logger } from '../../../../common/logging/logger.js';
import type { ToolDefinition } from '../types.js';

/**
 * Non-mutating price preview for a stay.
 *
 * Drift-prevention contract:
 *   - Per-night override resolution uses `resolveNightlyStayPaiseList`, the
 *     same helper `bookings.service.computeHoldSubtotalPaise` calls. So a
 *     room or listing override applied here will be applied identically
 *     when prepare_booking actually creates the hold.
 *   - Discount + fee + GST math uses `subtotalForStayPaise` + `applyFees`,
 *     also the canonical helpers. The hold IS the source of truth — this
 *     preview matches it exactly, by construction.
 *   - Insurance uses `insurancePremiumRupees`, the same helper
 *     paymentsService.createOrder uses. There used to be drift between
 *     "preview = 1%" and "order = 2%"; that's now impossible.
 *
 * What this tool DOES NOT do:
 *   - Apply a coupon. Coupon discounts are consumed atomically during the
 *     hold (one-shot, transactional). A preview can't reserve them. If
 *     the user mentions one, mention the discount will apply at checkout.
 *   - Validate room max-guests strictly. Returns a soft warning in
 *     userMessage; prepare_booking is the one that enforces it.
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const ArgsSchema = z
  .object({
    listingId: z.string().min(1),
    checkInDate: z.string().regex(DATE),
    // Optional, mirroring prepare_booking: omit for a single-night stay and
    // the tool defaults to check-in + 1. Requiring it here (while
    // prepare_booking didn't) made the model ask "how many nights?" for an
    // obvious one-night booking.
    checkOutDate: z.string().regex(DATE).optional(),
    roomTypeId: z.string().min(1).optional(),
    guestCount: z.number().int().min(1).max(40).optional(),
    numberOfRooms: z.number().int().min(1).max(20).optional(),
    insuranceOptIn: z.boolean().optional(),
  })
  .refine((v) => !v.checkOutDate || v.checkOutDate > v.checkInDate, {
    message: 'checkOutDate must be after checkInDate',
    path: ['checkOutDate'],
  });
type Args = z.infer<typeof ArgsSchema>;

// Safe, non-leaky line for an unresolvable listingId. The model usually got
// here by passing a stale/invented id — the prompt's `unknown_listing` rule
// tells it to silently re-pull the real id from the recent search hit and
// retry, NOT to surface ids to the user.
const UNKNOWN_LISTING_MSG = "I lost track of that stay for a second — let me pull it back up.";

/** Exact paise → rupees (2-dp number) so the previewed total reconciles to the
 *  paise-accurate charge instead of rounding to whole rupees. */
function rupees(paise: number): number {
  return Math.round(paise) / 100;
}

/** check-in + 1 day, used when the caller omits checkOutDate (single night). */
function addOneDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10);
}

interface NightlyLine {
  date: string;
  price: number;        // rupees, post-override but pre-discount/fee
  customPriceApplied: boolean;
  blocked: boolean;
  booked: boolean;
}

interface PricingPreviewResult {
  available: boolean;
  reason?: 'blocked' | 'fully_booked' | 'room_required' | 'no_price' | 'unknown_listing';
  userMessage?: string;
  blockedDates?: string[];
  bookedDates?: string[];
  room?: { id: string; name: string; pricePerNight: number; maxGuests?: number };
  nightly?: NightlyLine[];
  subtotal?: number;
  platformFee?: number;
  taxes?: number;
  gstRatePct?: number;
  insurance?: { included: boolean; amount: number };
  total?: number;
  currency?: 'INR';
}

function resolveBaseNightlyPaise(listing: Record<string, unknown>): number {
  const perNight = Number(listing.price_per_night);
  if (Number.isFinite(perNight) && perNight > 0) return Math.round(perNight * 100);
  const raw = listing.price;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.round(raw * 100);
  if (typeof raw === 'string') {
    const parsed = Number(raw.replace(/[^0-9.]/g, ''));
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed * 100);
  }
  return 0;
}

function buildNights(checkIn: string, checkOut: string): string[] {
  const out: string[] = [];
  const start = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);
  for (let d = start; d < end; d = new Date(d.getTime() + 86_400_000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export const getStayPricingPreviewTool: ToolDefinition<Args, PricingPreviewResult> = {
  name: 'get_stay_pricing_preview',
  description:
    "Preview the real total for a stay BEFORE booking — uses the EXACT same per-night override resolution, host-discount math, platform fee, GST, and insurance helper that prepare_booking/createHold use, so the number you quote is the number that will land on the Confirm & Pay card. Returns a nightly breakdown + subtotal + fees + total (and an `insurance` line if opted in). Use this once you have listingId + dates (and a roomTypeId for hotels) and the user is ready to hear the number — then ask 'shall I lock it in?' and only then call prepare_booking. **Pass `numberOfRooms` for a multi-room request** so the total scales per room and matches the booking. Returns {available:false, reason} when nights are blocked, sold out, or the listing has no resolvable price.",
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      listingId: { type: 'string' },
      checkInDate: { type: 'string', description: 'YYYY-MM-DD' },
      checkOutDate: { type: 'string', description: 'YYYY-MM-DD. Omit for a single-night stay — defaults to check-in + 1.' },
      roomTypeId: { type: 'string', description: 'Hotel-style stays only.' },
      guestCount: { type: 'number' },
      numberOfRooms: { type: 'number', description: 'Multi-room stays: units of the chosen room type (default 1). The total scales per room.' },
      insuranceOptIn: { type: 'boolean' },
    },
    required: ['listingId', 'checkInDate'],
  },

  async execute(args, _ctx) {
    try {
      const listingRes = await listingsService.getById(args.listingId);
      const listing = listingRes.data as Record<string, unknown> | undefined;
      if (!listing) return { available: false, reason: 'unknown_listing', userMessage: UNKNOWN_LISTING_MSG };

      const roomTypes = Array.isArray((listing as Record<string, unknown>).room_types)
        ? ((listing as Record<string, unknown>).room_types as Array<Record<string, unknown>>)
        : [];

      // Resolve the base nightly price exactly like createHold does:
      // prefer the chosen room's base_price_paise, otherwise listing-level.
      let room: { id: string; name: string; pricePerNight: number; maxGuests?: number } | undefined;
      let nightlyBasePaise = 0;
      if (args.roomTypeId) {
        // Tolerate the model passing a slug/name ("deluxe-suite") instead of
        // the room UUID — match by id, then name. Same resolution prepare_booking uses.
        const match = matchRoomType(args.roomTypeId, roomTypes);
        if (!match) {
          if (roomTypes.length > 0) {
            // The id/name didn't match a real room (usually an invented UUID).
            // The rooms DO exist — ask which one and LIST them, exactly like
            // prepare_booking's room_required path. NEVER "doesn't exist
            // anymore": the model relays that as a false "that room isn't
            // available" and the user gives up. Mirrors assistant-booking.service.
            const summary = roomTypes
              .map((r) => {
                const p = Number(r.base_price_paise);
                const price = Number.isFinite(p) && p > 0 ? ` (₹${Math.round(p / 100)}/night)` : '';
                return `${r.name ?? 'Room'}${price}`;
              })
              .join(', ');
            return {
              available: false,
              reason: 'room_required',
              userMessage: summary
                ? `That room option doesn't match this stay — which one? Options: ${summary}`
                : 'That room option doesn\'t match this stay — which one?',
            };
          }
          // Listing carries no joined rooms — fall back to listing-level price
          // rather than failing on a room that was never resolvable here.
          nightlyBasePaise = resolveBaseNightlyPaise(listing);
          if (nightlyBasePaise <= 0) {
            return {
              available: false,
              reason: 'no_price',
              userMessage: "This stay doesn't have a nightly price set yet — can't price it online.",
            };
          }
        } else {
          const paise = Number(match.base_price_paise);
          if (!Number.isFinite(paise) || paise <= 0) {
            return { available: false, reason: 'no_price', userMessage: "That room doesn't have a price set yet." };
          }
          nightlyBasePaise = paise;
          room = {
            id: String(match.id),
            name: typeof match.name === 'string' ? match.name : 'Room',
            pricePerNight: Math.round(paise / 100),
            maxGuests: typeof match.max_guests === 'number' ? match.max_guests : undefined,
          };
        }
      } else if (roomTypes.length > 0) {
        return {
          available: false,
          reason: 'room_required',
          userMessage: 'This stay has multiple room types — pass roomTypeId to preview the price for the room the user wants.',
        };
      } else {
        nightlyBasePaise = resolveBaseNightlyPaise(listing);
        if (nightlyBasePaise <= 0) {
          return {
            available: false,
            reason: 'no_price',
            userMessage: "This stay doesn't have a nightly price set yet — can't price it online.",
          };
        }
      }

      // Single-night stays may omit checkOutDate — default to check-in + 1.
      const checkOutDate = args.checkOutDate ?? addOneDay(args.checkInDate);
      const nights = buildNights(args.checkInDate, checkOutDate);
      if (nights.length === 0) {
        return { available: false, reason: 'unknown_listing', userMessage: 'Need at least one night.' };
      }

      const [overridesRes, bookedRes] = await Promise.all([
        availabilityOverridesService
          .listForListing(args.listingId, args.checkInDate, checkOutDate)
          .catch(() => ({ data: [] as Array<{ date: string; blocked: boolean; price_paise: number | null; room_type_id: string | null }> })),
        bookingsRepository
          .listBookedDatesForListing(args.listingId, args.roomTypeId)
          .catch(() => ({ rows: [] as Array<{ date: string }> })),
      ]);
      const overrides = overridesRes.data ?? [];
      const bookedSet = new Set((bookedRes.rows ?? []).map((r) => r.date));

      // Reuse the canonical resolver so the per-night list here is byte-
      // identical to what createHold will build during the actual hold.
      const overrideRows = overrides.map((o) => ({
        date: o.date,
        price_paise: o.price_paise,
        room_type_id: o.room_type_id,
      }));
      const nightlyPaiseList = resolveNightlyStayPaiseList({
        nights,
        nightlyBasePaise,
        roomTypeId: args.roomTypeId ?? null,
        overrideRows,
      });

      // Annotate each night with override/booked/blocked state for the UI.
      const blockedByScope = new Map<string, boolean>();
      for (const o of overrides) {
        const inScope =
          o.room_type_id == null ||
          (args.roomTypeId && o.room_type_id === args.roomTypeId);
        if (!inScope) continue;
        if (o.blocked) blockedByScope.set(o.date, true);
      }
      const overridePriceByDate = new Map<string, number>();
      for (let i = 0; i < nights.length; i++) {
        const date = nights[i];
        const paise = nightlyPaiseList[i] ?? nightlyBasePaise;
        if (paise !== nightlyBasePaise) overridePriceByDate.set(date, paise);
      }

      const nightlyOut: NightlyLine[] = nights.map((date, i) => ({
        date,
        price: Math.round((nightlyPaiseList[i] ?? nightlyBasePaise) / 100),
        customPriceApplied: overridePriceByDate.has(date),
        blocked: blockedByScope.get(date) === true,
        booked: bookedSet.has(date),
      }));

      const blockedDates = nightlyOut.filter((n) => n.blocked).map((n) => n.date);
      const bookedDates = nightlyOut.filter((n) => n.booked).map((n) => n.date);
      if (blockedDates.length > 0) {
        return { available: false, reason: 'blocked', blockedDates, nightly: nightlyOut, room };
      }
      if (bookedDates.length > 0) {
        return { available: false, reason: 'fully_booked', bookedDates, nightly: nightlyOut, room };
      }

      // Same call createHold makes. The discount applies uniformly across
      // every night (including override nights) — that's the established
      // server contract today. If that ever changes, the change happens
      // inside this helper and the preview moves with it.
      const hostDiscountPercent = Number(
        (listing as Record<string, unknown>).discount_percent ??
          (listing as Record<string, unknown>).discountPercent ??
          0,
      );
      // Multi-room: the customer pays for `numberOfRooms` copies of the same
      // per-night rate. Mirrors createHold's `perRoom * roomCount` so the
      // previewed total equals the amount that lands on the Confirm & Pay card.
      const roomCount = Math.max(1, Math.round(Number(args.numberOfRooms ?? 1)));
      const subtotalPostDiscountPaise = subtotalForStayPaise({
        nightlyPaiseList,
        hostDiscountPercent,
      }) * roomCount;

      const category =
        (typeof listing.category === 'string' ? listing.category : null) ?? 'stay';
      // Same fee-rule resolution as createHold, so the previewed platform
      // fee matches what the hold will actually charge under admin rules.
      const resolvedFee = await feeRulesService.resolveForListingRow(
        listing as Record<string, unknown>,
        category,
      );
      const fees = applyFees({
        subtotalPaise: subtotalPostDiscountPaise,
        category,
        nightlyHintPaise: nightlyBasePaise,
        fee: resolvedFee.spec,
      });

      // Insurance: shared helper with paymentsService.createOrder. The
      // base for the % is the agreed price (totalPaise / 100), i.e. the
      // amount that will land on the booking row at hold time.
      const insuranceAmount = args.insuranceOptIn ? insurancePremiumRupees(rupees(fees.totalPaise)) : 0;
      const totalRupees = rupees(fees.totalPaise + Math.round(insuranceAmount * 100));

      // Soft guest-capacity warning. Non-fatal — prepare_booking enforces it.
      let userMessage: string | undefined;
      if (room && args.guestCount && room.maxGuests && args.guestCount > room.maxGuests) {
        userMessage = `Heads up — ${room.name} sleeps up to ${room.maxGuests}, but you've got ${args.guestCount} guests.`;
      }

      return {
        available: true,
        userMessage,
        room,
        nightly: nightlyOut,
        subtotal: rupees(fees.discountedSubtotalPaise),
        platformFee: rupees(fees.platformFeePaise),
        taxes: rupees(fees.taxesPaise),
        gstRatePct: Math.round(fees.gstRate * 100),
        insurance: { included: Boolean(args.insuranceOptIn), amount: insuranceAmount },
        total: totalRupees,
        currency: 'INR',
      };
    } catch (err) {
      if (err instanceof NotFoundError) return { available: false, reason: 'unknown_listing', userMessage: UNKNOWN_LISTING_MSG };
      logger.warn('get_stay_pricing_preview failed', { error: (err as Error).message });
      return {
        available: false,
        reason: 'unknown_listing',
        userMessage: "Couldn't price that stay just now — try again in a moment.",
      };
    }
  },

  summarize(args, result) {
    if (result.available && result.total) {
      return `Preview: ₹${result.total.toLocaleString()} total (${result.nightly?.length ?? '?'} night${(result.nightly?.length ?? 0) === 1 ? '' : 's'})`;
    }
    if (result.reason) return `Can't price — ${result.reason}`;
    return `Priced ${args.listingId.slice(0, 8)}`;
  },
};
