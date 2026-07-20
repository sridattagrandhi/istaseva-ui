import { z } from 'zod';
import { assistantBookingService } from '../../services/assistant-booking.service.js';
import { AddOnOfferRequiredError } from '../../services/assistant-booking.errors.js';
import { roomTypesRepository } from '../../../listings/repositories/room-types.repository.js';
import { NotFoundError, ValidationError, ConflictError, ForbiddenError } from '../../../../common/errors/app-error.js';
import { logger } from '../../../../common/logging/logger.js';
import type { ToolDefinition } from '../types.js';

/**
 * Wraps assistantBookingService.prepare so the agent can lock a slot +
 * create a Razorpay order INLINE during the tool loop and reference real
 * numbers in the final reply ("Locked Taj Goa, ₹12,400, hold's good for
 * 5 min").
 *
 * Confirmation gate:
 *   The HOLD itself is not user-confirmed; it's reversible (5-min TTL,
 *   no money moved). Real money only moves when the user taps Confirm
 *   & Pay on the BookingConfirmCard.
 *
 * Output contract:
 *   This tool ALWAYS returns `ok:true` at the loop level — the loop never
 *   sees a thrown exception from this tool. Inside the result, `success`
 *   tells the model whether to emit `prepare_booking_done` (success) or
 *   surface the failure `userMessage` + suggested action (`auth_required`
 *   → navigate to /login, anything else → just explain in chat).
 *
 *   This shape exists because the previous behaviour — throwing the raw
 *   error message — meant the model either (a) leaked backend strings
 *   like "Listing not found: 4f1b…" or (b) paraphrased into useless
 *   "I hit a snag" replies. Classifying server-side and handing the
 *   model a fixed userMessage closes both.
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

const ArgsSchema = z
  .object({
    listingId: z.string().min(1),
    scheduledDate: z
      .string()
      .regex(DATE)
      .describe('YYYY-MM-DD; check-in date for stays, the day for services/transport.'),
    checkOutDate: z
      .string()
      .regex(DATE)
      .optional()
      .describe('Stays only — check-out date YYYY-MM-DD. Omit for single-night or non-stay bookings.'),
    startTime: z.string().regex(TIME).optional().describe('Optional HH:MM; only set if user explicitly named a time.'),
    endTime: z.string().regex(TIME).optional(),
    notes: z.string().max(500).optional(),
    roomTypeId: z
      .string()
      .min(1)
      .optional()
      .describe('Multi-room stays (hotel / lodge / heritage / sathram): which room the user chose. Pass the room_type id from get_listing_details rooms[].id OR the room_options[].id returned by a prior room_required result. If you don\'t have a real id, pass the exact room NAME instead ("Single", "Deluxe Suite") — the server resolves names too. NEVER invent or guess a UUID here; a fabricated id is rejected and forces the user to re-pick. REQUIRED when the listing hasRoomTypes=true; omit for single-unit homestays and services/transport.'),
    guestCount: z
      .number()
      .int()
      .min(1)
      .max(40)
      .optional()
      .describe('Number of guests (stays). Defaults to 1; only set if the user named one.'),
    numberOfRooms: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('Multi-room stays only — how many units of the chosen room type to book ("3 single rooms"). Defaults to 1. Confirm against check_availability\'s `unitsRemaining` first; the booking is priced per room and rejected (reason `room_full`) if it exceeds inventory.'),
    insuranceOptIn: z
      .boolean()
      .optional()
      .describe('Whether the user opted into trip protection. Set true only if the user explicitly said yes; set false if they explicitly declined; omit when not discussed.'),
    // Service-only fields. Mode and address come from get_listing_details and
    // the user; the service treats `at-home` as the only mode that REQUIRES
    // an address (visit-provider/online get the host\'s address/details from
    // the listing).
    serviceMode: z
      .enum(['at-home', 'visit-provider', 'online'])
      .optional()
      .describe('Service listings only. Set to the mode the user picked from get_listing_details.serviceModes. Required when the listing exposes more than one mode.'),
    serviceAddress: z
      .string()
      .min(3)
      .max(1000)
      .optional()
      .describe('Service listings only. The customer\'s address. REQUIRED when serviceMode is "at-home" and the customer hasn\'t already saved one. Skip for visit-provider/online.'),
    serviceHours: z
      .number()
      .positive()
      .max(24)
      .optional()
      .describe('Service listings only. Number of hours, REQUIRED when the listing is priced per_hour. Passed through to the hold so price × hours matches the get_booking_price_preview quote.'),
    serviceCatalogId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('Service listings with multiple variants only. The id of the service variant the user chose (e.g. "Men\'s Haircut" vs "Women\'s Haircut"), taken from serviceCatalog[].id on get_listing_details. REQUIRED when get_listing_details returns a serviceCatalog with more than one entry — it sets the base price. If omitted on a multi-variant listing the server prices the FIRST variant, which is usually wrong. Add-ons (serviceAddOnIds) must come from the CHOSEN variant\'s addOns.'),
    serviceAddOnIds: z
      .array(z.string().min(1).max(64))
      .max(20)
      .optional()
      .describe('Service listings only. Ids of extras the user wants in the SAME appointment, taken from the chosen variant\'s addOns[] (serviceCatalog[].addOns) or listing-level addOns[]. You may ALSO include another serviceCatalog[].id here to book multiple distinct services at once (e.g. Men\'s Haircut as serviceCatalogId + a separate "Beard Trim" service id here) — the server prices each sibling service at its own rate as a line item. Server re-validates and prices every id from the listing; inventing ids triggers ValidationError.'),
    // Transport-only fields. Carry mode-derived booking details so the host
    // sees what was actually agreed (hourly count vs. selected package etc.).
    transportMode: z
      .enum(['hourly', 'day', 'package'])
      .optional()
      .describe('Transport listings only. Set to the mode from get_listing_details.transportMode. REQUIRED for transport bookings so pricing has a unit.'),
    transportHours: z
      .number()
      .positive()
      .max(24)
      .optional()
      .describe('Transport hourly mode — number of hours the user wants. REQUIRED when transportMode is "hourly", UNLESS you also pass both startTime and endTime (the server will derive hours from end − start).'),
    transportDays: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe('Transport day mode — number of days (defaults to 1 if omitted; capped at 30 server-side).'),
    transportPackageId: z
      .string()
      .min(1)
      .optional()
      .describe('Transport package mode — id from get_listing_details.packageOptions. REQUIRED when transportMode is "package".'),
    pickupLocation: z
      .string()
      .min(3)
      .max(1000)
      .optional()
      .describe('Transport listings — pickup point. Ask the user when missing.'),
    passengerCount: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('Transport listings — number of passengers. REQUIRED before booking any transport mode.'),
  })
  .refine(
    (v) => !v.checkOutDate || v.checkOutDate > v.scheduledDate,
    { message: 'checkOutDate must be after scheduledDate', path: ['checkOutDate'] },
  );
type Args = z.infer<typeof ArgsSchema>;

interface PrepareBookingDone {
  bookingId: string;
  holdExpiresAt: string;
  orderId: string;
  paymentId: string;
  keyId: string;
  amount: number;
  amountPaise: number;
  currency: 'INR' | 'USD';
  listing: { id: string; name: string; image?: string; location?: string };
  schedule: { scheduledDate: string; startTime: string; endTime: string; checkOutDate?: string; nights?: number };
  room?: { id: string; name: string; pricePerNight?: number };
  transport?: {
    mode: 'hourly' | 'day' | 'package';
    pickupLocation?: string;
    passengerCount?: number;
    days?: number;
    hours?: number;
    packageId?: string;
  };
  insurance?: { included: boolean; amount: number };
}

/** Why a prepare_booking attempt couldn't go through. */
type FailureReason =
  | 'auth_required'        // user not signed in (rarely reaches the tool — route is auth-gated, but kept for safety)
  | 'listing_not_found'    // listingId doesn't exist
  | 'listing_inactive'     // listing exists but is_active=false
  | 'no_price'             // listing has no resolvable price (host hasn't set one)
  | 'room_required'        // hotel-style stay; agent must ask which room type
  | 'addon_offer_required' // service with optional add-ons; agent must OFFER them orally, then retry with serviceAddOnIds
  | 'no_provider'          // listing has no linked provider_profile (can't take bookings)
  | 'slot_taken'           // unique-constraint conflict — someone else grabbed the slot
  | 'too_many_pending'     // user already has the max concurrent holds
  | 'invalid_dates'        // dates fail validation (past date, bad range)
  | 'forbidden'            // user can't book this (own listing, blocked, etc.)
  | 'unknown';             // anything else — keep internal details internal

/** Structured room options the agent can use to map "the suite" → roomTypeId
 *  without a second get_listing_details round-trip. Only populated when
 *  reason === 'room_required'. */
interface RoomOption {
  id: string;
  name: string;
  pricePerNight?: number;
  maxGuests?: number;
}

type PrepareResult =
  | ({ success: true } & PrepareBookingDone)
  | {
      success: false;
      reason: FailureReason;
      userMessage: string;
      roomOptions?: RoomOption[];
      /** addon_offer_required only — the optional extras to offer the user
       *  orally before retrying. Each { id, label, price (rupees) }. */
      addOns?: Array<{ id: string; label: string; price: number }>;
      /** addon_offer_required — the exact booking args to retry with once the
       *  model adds the user's serviceAddOnIds choice. */
      bookingArgs?: Record<string, unknown>;
    };

function classifyFailure(err: unknown): { reason: FailureReason; userMessage: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (err instanceof NotFoundError) {
    return {
      reason: 'listing_not_found',
      userMessage: "I can't find that listing anymore — it might have been removed. Want me to search again?",
    };
  }

  if (err instanceof ForbiddenError) {
    return {
      reason: 'forbidden',
      userMessage: raw, // Forbidden messages from the service are already user-safe
    };
  }

  if (err instanceof ConflictError || lower.includes('slot') || lower.includes('already booked') || lower.includes('unique')) {
    // When the service tells us EXACTLY which windows are booked
    // ("driver is already booked 1 PM–2 PM"), surface that message so
    // the agent can explain the conflict instead of a generic apology.
    // Falls back to the canned message when the conflict didn't carry
    // a specific window.
    const hasSpecificWindow = /driver is already booked|host has blocked|active slot hold/i.test(raw);
    return {
      reason: 'slot_taken',
      userMessage: hasSpecificWindow
        ? raw
        : 'Someone else just grabbed that slot. Want me to look for nearby dates or alternatives?',
    };
  }

  if (err instanceof ValidationError) {
    if (lower.includes('multiple room types') || lower.includes('which one?') || lower.includes('room option doesn')) {
      return {
        reason: 'room_required',
        userMessage: raw, // service-side message already names the rooms
      };
    }
    if (lower.includes('sleeps up to')) {
      return {
        reason: 'invalid_dates',
        userMessage: raw,
      };
    }
    if (lower.includes('no longer active')) {
      return {
        reason: 'listing_inactive',
        userMessage: "That listing isn't accepting bookings right now. Want me to find similar options?",
      };
    }
    if (lower.includes('not fully set up') || lower.includes("isn't fully set up")) {
      return {
        reason: 'no_price',
        userMessage: raw,
      };
    }
    if (lower.includes('price') && lower.includes('set')) {
      return {
        reason: 'no_price',
        userMessage: raw, // service writes a stay-vs-service-tuned message; use it verbatim
      };
    }
    // Mode-specific service/transport validation messages — quote the
    // service's wording verbatim ("address?", "how many hours?", "which
    // package?", "where should the driver pick you up?", "how many guests?")
    // so the agent asks the right follow-up, instead of falling through to
    // the generic "provider not set up" / "invalid dates" fallbacks below.
    if (
      lower.includes('address')
      || lower.includes('how many hours')
      || lower.includes('which package')
      || lower.includes('which one would you like')
      || lower.includes('how would you like to book')
      || lower.includes('where should the driver pick')
      || lower.includes('how many passengers')
      || lower.includes('passengers will be riding')
      || lower.includes('seats up to')
      || lower.includes('how many guests')
      || lower.includes('isn\'t on this listing anymore')
    ) {
      return { reason: 'invalid_dates', userMessage: raw };
    }
    if (lower.includes('provider')) {
      return {
        reason: 'no_provider',
        userMessage: "That listing isn't fully set up to take bookings yet. Want me to find similar options that are ready to go?",
      };
    }
    if (lower.includes('past') || lower.includes('date')) {
      return {
        reason: 'invalid_dates',
        userMessage: 'Those dates don\'t work — pick a future date and I\'ll try again.',
      };
    }
    if (lower.includes('pending') || lower.includes('too many')) {
      return {
        reason: 'too_many_pending',
        userMessage: 'You already have a couple of holds open. Confirm or cancel one of those and we\'ll try this again.',
      };
    }
    // Unknown ValidationError — pass the service's message through; those
    // are already user-facing by convention.
    return { reason: 'invalid_dates', userMessage: raw };
  }

  // Anything else is unexpected. Don't leak it to the model — give a clean
  // line and log the real reason server-side for ops to dig into.
  return {
    reason: 'unknown',
    userMessage: "Something on our end stopped the booking from going through. Try again in a moment, or message support and they'll sort it.",
  };
}

export const prepareBookingTool: ToolDefinition<Args, PrepareResult> = {
  name: 'prepare_booking',
  description:
    "Lock a real slot + create a Razorpay order for a listing. Call this ONLY when ALL of: (1) you have a real listingId from a previous tool result, (2) the user named a specific date, (3) the user has clearly said 'yes book it' / 'go ahead' / equivalent, (4) for ANY multi-room stay (get_listing_details returned hasRoomTypes=true — hotel/lodge/heritage/sathram all qualify) you have the chosen roomTypeId, AND (5) for transport you have pickupLocation and passengerCount. Returns either {success:true, ...payload} — in which case your final reply MUST emit action 'prepare_booking_done' with the payload so the inline Confirm & Pay card renders — OR {success:false, reason, userMessage}. For reason='room_required' quote userMessage and ask the user which room (don't retry until they pick). For reason='addon_offer_required' the chosen service variant has optional add-ons the user hasn't been offered — quote userMessage (it lists them), ask if they want any, and retry prepare_booking with serviceAddOnIds set to the chosen ids (or [] if they decline). Do NOT retry with serviceAddOnIds still unset. For reason='auth_required' also emit action 'auth_required'. For everything else, quote userMessage verbatim. Money is not moved here.",
  sideEffect: 'write',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      listingId: { type: 'string' },
      scheduledDate: { type: 'string', description: 'YYYY-MM-DD' },
      checkOutDate: { type: 'string', description: 'YYYY-MM-DD; stays only' },
      startTime: { type: 'string' },
      endTime: { type: 'string' },
      notes: { type: 'string' },
      roomTypeId: { type: 'string', description: 'Required for hotel-style stays with multiple room types. Pass the rooms[].id, or the room NAME ("Single") if you have no id — never invent a UUID.' },
      guestCount: { type: 'number', description: 'Number of guests (stays).' },
      numberOfRooms: { type: 'number', description: 'Multi-room stays: units of the chosen room type to book (default 1). Check unitsRemaining first.' },
      insuranceOptIn: { type: 'boolean', description: 'Whether the user opted into trip protection.' },
      serviceMode: { type: 'string', enum: ['at-home', 'visit-provider', 'online'], description: 'Service mode the user picked.' },
      serviceAddress: { type: 'string', description: 'Customer address — required when serviceMode is "at-home".' },
      serviceHours: { type: 'number', description: 'Hours for per_hour services.' },
      serviceCatalogId: {
        type: 'string',
        description: 'Service variant id (serviceCatalog[].id) — required when get_listing_details returns multiple service variants; sets the base price.',
      },
      serviceAddOnIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ids of extras for the same appointment — from the chosen variant\'s addOns (serviceCatalog[].addOns), listing-level addOns, or another serviceCatalog[].id to combine multiple distinct services in one booking (each priced at its own rate).',
      },
      transportMode: { type: 'string', enum: ['hourly', 'day', 'package'], description: 'Transport billing mode.' },
      transportHours: { type: 'number', description: 'Hours for transport hourly mode.' },
      transportDays: { type: 'number', description: 'Days for transport day mode (defaults to 1, max 30).' },
      transportPackageId: { type: 'string', description: 'Package id for transport package mode.' },
      pickupLocation: { type: 'string', description: 'Transport pickup point.' },
      passengerCount: { type: 'number', description: 'Transport passenger count. Required before booking transport.' },
    },
    required: ['listingId', 'scheduledDate'],
  },

  async execute(args, ctx): Promise<PrepareResult> {
    if (!ctx.userId) {
      return {
        success: false,
        reason: 'auth_required',
        userMessage: 'You need to sign in before I can book that. Want me to take you to sign-in?',
      };
    }

    try {
      const result = await assistantBookingService.prepare(
        {
          listingId: args.listingId,
          scheduledDate: args.scheduledDate,
          checkOutDate: args.checkOutDate,
          startTime: args.startTime,
          endTime: args.endTime,
          notes: args.notes,
          roomTypeId: args.roomTypeId,
          guestCount: args.guestCount,
          numberOfRooms: args.numberOfRooms,
          insuranceOptIn: args.insuranceOptIn,
          serviceMode: args.serviceMode,
          serviceAddress: args.serviceAddress,
          serviceHours: args.serviceHours,
          serviceCatalogId: args.serviceCatalogId,
          serviceAddOnIds: args.serviceAddOnIds,
          transportMode: args.transportMode,
          transportHours: args.transportHours,
          transportDays: args.transportDays,
          transportPackageId: args.transportPackageId,
          pickupLocation: args.pickupLocation,
          passengerCount: args.passengerCount,
        },
        ctx.userId,
      );
      return { success: true, ...result };
    } catch (err) {
      // Add-on offer gate: the chosen service variant has optional extras and
      // the user hasn't been offered them yet. Surface them so the model asks
      // ORALLY (no card), then retries prepare_booking with the user's choice
      // as serviceAddOnIds (or [] if they decline). The bookingArgs echo lets
      // the retry reuse everything already collected.
      if (err instanceof AddOnOfferRequiredError) {
        const list = err.addOns.map((a) => `${a.label} (+₹${a.price})`).join(', ');
        const variant = err.variantName ? `${err.variantName} ` : '';
        return {
          success: false,
          reason: 'addon_offer_required',
          userMessage:
            `Before I lock this in — ${variant}can be paired with optional add-ons: ${list}. `
            + 'Want to add any of those, or shall I book it as-is?',
          addOns: err.addOns,
          bookingArgs: { ...args },
        };
      }
      const classified = classifyFailure(err);
      // For room_required, hydrate structured room options so the agent can
      // map the user's next message ("the deluxe please") to a roomTypeId
      // WITHOUT another get_listing_details round-trip. Best-effort: failing
      // here doesn't block the failure response — the userMessage already
      // names the rooms inline as a fallback.
      let roomOptions: RoomOption[] | undefined;
      if (classified.reason === 'room_required') {
        try {
          const rooms = await roomTypesRepository.listForListing(args.listingId);
          roomOptions = (rooms.rows ?? []).map((r) => {
            const paise = Number(r.base_price_paise);
            return {
              id: String(r.id),
              name: r.name,
              pricePerNight: Number.isFinite(paise) && paise > 0 ? Math.round(paise / 100) : undefined,
              maxGuests: typeof r.max_guests === 'number' ? r.max_guests : undefined,
            };
          });
        } catch {
          // Swallow — the userMessage already lists the rooms by name & price.
        }
      }
      // ALWAYS log the underlying reason so operators can diagnose; the
      // model only ever sees the cleaned userMessage.
      logger.warn('prepare_booking: classified failure', {
        userId: ctx.userId,
        listingId: args.listingId,
        roomTypeId: args.roomTypeId,
        reason: classified.reason,
        rawError: err instanceof Error ? err.message : String(err),
      });
      return { success: false, ...classified, ...(roomOptions ? { roomOptions } : {}) };
    }
  },

  summarize(_args, result) {
    if (result.success) {
      return `Held ${result.listing.name} — ₹${result.amount}`;
    }
    return `Couldn't book — ${result.reason}`;
  },
};
