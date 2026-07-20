/**
 * Assistant-driven booking preparation.
 *
 * When the chat agent emits a `prepare_booking` action, the UI calls into
 * this service which does TWO things in one shot:
 *   1) Creates a real pending booking + slot hold via bookingsService.createHold.
 *   2) Creates a Razorpay order via paymentsService.createOrder using the
 *      listing's authoritative price.
 *
 * The response gives the client everything it needs to open the Razorpay
 * checkout immediately — the user literally just confirms and pays. No
 * booking modal, no form fill, no extra round trip.
 *
 * Why one service function instead of the client chaining two existing
 * endpoints: the agent doesn't know the listing price (we deliberately
 * don't trust the LLM with numbers), and we want the hold + order tied
 * atomically so the UI can't end up with a hold but no order to pay for.
 */
import { randomUUID } from 'crypto';
import { bookingIntentService, type PrepareBookingResult } from '../../bookings/services/booking-intent.service.js';
import { resolveServiceCatalogGroup } from '../../payments/pricing/booking-price.js';
import { UUID_RE, matchRoomType, matchPackageId } from '../agent/room-matching.js';
import { verifyAtHomeAddress } from './address-verification.js';
import { listingsService } from '../../listings/services/listings.service.js';
import { publicLocationLabel } from '../../listings/services/listing-geo-privacy.js';
import { roomTypesRepository } from '../../listings/repositories/room-types.repository.js';
import { bookingsRepository } from '../../bookings/repositories/bookings.repository.js';
import { NotFoundError, ValidationError } from '../../../common/errors/app-error.js';
import { AddOnOfferRequiredError } from './assistant-booking.errors.js';
import { logger } from '../../../common/logging/logger.js';

export interface PrepareBookingInput {
  listingId: string;
  scheduledDate: string;     // YYYY-MM-DD — check-in date for stays
  checkOutDate?: string;     // YYYY-MM-DD — stays only; defaults to next day
  startTime?: string;        // HH:MM
  endTime?: string;          // HH:MM
  notes?: string;
  insuranceOptIn?: boolean;
  /** Hotel-style stays only — which room type the guest selected. Required
   *  when the listing has room_types and no listing-level price_per_night. */
  roomTypeId?: string;
  /** Optional guest count (defaults to 1). Used for room max_guests validation
   *  and snapshotted into booking notes for the host. */
  guestCount?: number;
  /** Multi-room stays only — how many physical units of the chosen room type
   *  to book (e.g. "3 single rooms"). Defaults to 1. Validated against the
   *  room type's remaining inventory; priced per room by createHold. */
  numberOfRooms?: number;
  /** Service-only — booking mode chosen by the customer. Required (in chat)
   *  when the listing exposes more than one mode. */
  serviceMode?: 'at-home' | 'visit-provider' | 'online';
  /** Service-only — customer's address. Required when `serviceMode==="at-home"`. */
  serviceAddress?: string;
  /** Service-only — number of hours the customer wants, when the listing is
   *  priced per_hour. Passed through notes.serviceHours so the hold's
   *  subtotal matches the preview tool's quote. */
  serviceHours?: number;
  /** Service-only — ids of optional add-ons the customer picked, resolved
   *  server-side against `listing.metadata.addOns`. Forwarded into notes
   *  so createHold's add-on subtotal helper sums them into the charge. */
  serviceAddOnIds?: string[];
  /** Service-only — id of the chosen service variant from
   *  `listing.metadata.servicesCatalog` (e.g. Men's vs Women's haircut).
   *  Forwarded into notes.selectedServiceCatalogId so createHold prices the
   *  RIGHT variant's basePrice instead of defaulting to the first one. */
  serviceCatalogId?: string;
  /** Transport-only — billing mode the price is based on. */
  transportMode?: 'hourly' | 'day' | 'package';
  /** Transport hourly mode — number of hours the customer wants. */
  transportHours?: number;
  /** Transport day mode — number of days (defaults to 1, capped at 30 by
   *  bookings.service to bound accidental abuse). */
  transportDays?: number;
  /** Transport package mode — id from listing.metadata.packageOptions. */
  transportPackageId?: string;
  /** Transport — pickup location the driver should see. */
  pickupLocation?: string;
  /** Transport — passenger count the driver should expect. */
  passengerCount?: number;
}

// PrepareBookingResult now lives in the bookings module (booking-intent.service)
// — the canonical, shared shape both the assistant and the marketplace modal
// return. Imported above; re-exported here for existing importers.
export type { PrepareBookingResult };

// Sathram community-gate error — own module so tool tests that mock this
// service keep a real class for instanceof checks. Re-exported for callers.
export { AddOnOfferRequiredError };

type ListingType = 'stay' | 'service' | 'transport';

// Default time windows per listing type — the agent is allowed to override,
// but when it doesn't specify we fill sane defaults so a "book this for
// Saturday" flow works without the user having to pick times.
const DEFAULT_TIMES: Record<ListingType, { start: string; end: string }> = {
  stay:      { start: '14:00', end: '23:59' },  // single-day hold; overnight is modeled by the schedule field
  service:   { start: '09:00', end: '10:00' },
  transport: { start: '09:00', end: '10:00' },
};

function timeToMinutes(value?: string): number | null {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [h, m] = value.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function minutesToTime(total: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(total)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function durationToMinutes(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return 60;
  const text = value.toLowerCase();
  if (text.includes('half day')) return 240;
  if (text.includes('full day')) return 480;
  const hours = text.match(/(\d+(?:\.\d+)?)\s*(?:hr|hour|h\b)/);
  const mins = text.match(/(\d+)\s*(?:min|minute|m\b)/);
  let total = 0;
  if (hours) total += Math.round(Number(hours[1]) * 60);
  if (mins) total += Number(mins[1]);
  if (!total) {
    const bare = text.match(/^(\d+(?:\.\d+)?)/);
    if (bare) total = Math.round(Number(bare[1]) * 60);
  }
  return total > 0 ? total : 60;
}

/** The optional add-ons a service customer could stack onto the chosen
 *  variant: the variant's OWN add-ons plus any listing-wide add-ons, deduped by
 *  id (variant wins on collision). Validates label + non-negative price the
 *  same way get_listing_details surfaces them, so the offered set matches what
 *  the user already saw. Returns [] when nothing is offerable. */
function collectOfferableAddOns(
  meta: Record<string, unknown>,
  chosenGroup: { addOns?: Array<{ id?: unknown; label?: unknown; price?: unknown }> } | null,
): Array<{ id: string; label: string; price: number }> {
  const out: Array<{ id: string; label: string; price: number }> = [];
  const seen = new Set<string>();
  const push = (raw: Array<{ id?: unknown; label?: unknown; price?: unknown }> | undefined, prefix: string) => {
    if (!Array.isArray(raw)) return;
    raw.forEach((row, idx) => {
      if (!row || typeof row !== 'object') return;
      const label = typeof row.label === 'string' ? row.label.trim() : '';
      const price = Number(row.price);
      if (!label || !Number.isFinite(price) || price < 0) return;
      const id = typeof row.id === 'string' && row.id.trim() ? row.id : `${prefix}-${idx + 1}`;
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ id, label, price: Math.round(price) });
    });
  };
  push(chosenGroup?.addOns, 'addon');
  push(Array.isArray(meta.addOns) ? (meta.addOns as Array<{ id?: unknown; label?: unknown; price?: unknown }>) : undefined, 'addon');
  return out;
}

function inferListingType(listing: Record<string, any>): ListingType {
  // Match the same heuristics as listings.repository.ts listPublic so the
  // agent's category reasoning and this service agree on what a listing "is".
  // The CHECK-constrained `listing_type` column (migration 20260427) is the
  // authoritative answer when present — heuristics only fill in for the
  // unmigrated legacy rows.
  const listingType = typeof listing.listing_type === 'string' ? listing.listing_type.toLowerCase() : '';
  if (listingType === 'stay' || listingType === 'service' || listingType === 'transport') {
    return listingType as ListingType;
  }
  if (listing.price_per_night || listing.property_type) return 'stay';
  if (listing.vehicle_name) return 'transport';
  const cat = String(listing.category || '').toLowerCase();
  if (['hotel', 'homestay', 'lodge', 'village-stay', 'farm-stay', 'heritage', 'sathram', 'stay'].includes(cat) || cat.startsWith('stay:')) return 'stay';
  if (['transport', 'auto', 'cab', 'van', 'bike', 'tempo', 'driver-auto', 'driver-cab', 'driver-hourly', 'driver-day', 'driver-package'].includes(cat) || cat.startsWith('driver-')) return 'transport';
  return 'service';
}

function resolveListingPrice(listing: Record<string, any>): number | null {
  // Stays use price_per_night; services/transport typically use price.
  // All stored as numeric rupees (not paise) per the schema.
  const perNight = Number(listing.price_per_night);
  if (Number.isFinite(perNight) && perNight > 0) return perNight;

  const raw = listing.price;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const parsed = Number(raw.replace(/[^0-9.]/g, ''));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function resolveListingImage(listing: Record<string, any>): string | undefined {
  if (Array.isArray(listing.photos) && listing.photos.length > 0) return String(listing.photos[0]);
  if (Array.isArray(listing.images) && listing.images.length > 0) return String(listing.images[0]);
  if (typeof listing.image_url === 'string') return listing.image_url;
  return undefined;
}

// Room/package slug-tolerant matchers live in a shared module so every tool
// that takes a roomTypeId / packageId resolves them identically.

export class AssistantBookingService {
  async prepare(input: PrepareBookingInput, userId: string): Promise<PrepareBookingResult> {
    // 1. Hydrate the listing — we NEVER trust the agent to tell us the price.
    const listingResult = await listingsService.getById(input.listingId);
    const listing = listingResult.data;
    if (!listing) throw new NotFoundError('Listing', input.listingId);
    if (listing.is_active === false) throw new ValidationError('This listing is no longer active');

    const listingType = inferListingType(listing);
    const defaults = DEFAULT_TIMES[listingType];
    let startTime = input.startTime || defaults.start;
    let endTime = input.endTime || defaults.end;

    // Validate mode-specific required fields before we hit any side effects.
    // Failures here surface as ValidationErrors that the prepare_booking tool
    // classifier turns into "ask the user X" messages, not retryable holds.
    const meta = (listing.metadata as Record<string, unknown> | null | undefined) ?? {};

    // Resolved transport mode/category (closed over below when building notes
    // and serviceCategory). Initialized from input + listing metadata.
    // Resolved at-home pin from the address gate — snapshotted into notes.
    let serviceAddressGeo: { lat: number; lng: number } | undefined;
    let resolvedTransportMode: 'hourly' | 'day' | 'package' | null = null;
    // Canonical package id, resolved server-side from whatever the model passed
    // (it sometimes sends a label/slug instead of the real id).
    let resolvedPackageId: string | undefined = input.transportPackageId;
    if (listingType === 'service') {
      // No explicit time from the user → anchor the default slot to the
      // listing's OPENING time for that weekday instead of the global 09:00.
      // A salon that opens at 10:00 was rejecting every "book it for Monday"
      // because the 09:00 default slot fell outside working hours. Writing
      // the derived start back onto input lets the per_hour/duration end-time
      // logic below treat it like a user-supplied time.
      if (!input.startTime) {
        const wh = meta.workingHours && typeof meta.workingHours === 'object'
          ? meta.workingHours as Record<string, unknown>
          : null;
        const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
        const day = new Date(`${input.scheduledDate}T00:00:00`);
        const entry = wh && !Number.isNaN(day.getTime()) ? wh[DAY_KEYS[day.getDay()]] : undefined;
        if (Array.isArray(entry) && typeof entry[0] === 'string' && /^\d{2}:\d{2}$/.test(entry[0])) {
          (input as unknown as Record<string, unknown>).startTime = entry[0];
          startTime = entry[0];
          endTime = minutesToTime(timeToMinutes(entry[0])! + 60);
        }
      }
      const offeredModes = Array.isArray(meta.serviceModes) ? (meta.serviceModes as string[]) : [];
      if (offeredModes.length > 1 && !input.serviceMode) {
        throw new ValidationError(`This service is offered as: ${offeredModes.join(', ')}. Which one would you like?`);
      }
      const mode = input.serviceMode || (offeredModes.length === 1 ? offeredModes[0] : undefined);
      if (mode === 'at-home' && !input.serviceAddress) {
        throw new ValidationError('Where should the provider come to? Share the address you\'d like them at.');
      }
      if (mode === 'at-home' && input.serviceAddress) {
        // Same forward-geocode gate the booking modal applies client-side —
        // here it covers the agent path too, and it can't be skipped by the
        // model. Degrades gracefully: after two unresolvable attempts the
        // address goes through (see address-verification.ts header).
        // "address" in the message keys the tool layer's question classifier.
        const check = await verifyAtHomeAddress(userId, input.serviceAddress);
        if (!check.allow) {
          throw new ValidationError(
            'I couldn\'t find that address on the map — could you add the street, area, or pincode? A nearby landmark plus the area and city works too.',
          );
        }
        // Snapshot the resolved pin into the notes (undefined when degraded) —
        // the provider gets a mappable location, not a string to re-interpret.
        if (check.resolved) {
          serviceAddressGeo = { lat: check.resolved.lat, lng: check.resolved.lng };
        }
      }
      // Multi-variant services (metadata.servicesCatalog with >1 entry): the
      // user MUST pick which variant — Men's vs Women's vs Kid's set the base
      // price. The model invents catalog ids ("mens-haircut", a fake UUID), and
      // without a RESOLVABLE choice the hold would silently price the listing's
      // headline (cheapest) variant — charging the wrong amount. Mirror the
      // room-type gate: resolve tolerantly (id / name), else ask which one with
      // the real prices. resolveServiceCatalogGroup is the same resolver the
      // hold + preview use, so a choice that passes here prices identically.
      const variantCatalog = Array.isArray(meta.servicesCatalog)
        ? (meta.servicesCatalog as Array<Record<string, unknown>>).filter((g) => g && Number(g.basePrice) > 0)
        : [];
      if (variantCatalog.length > 1) {
        const chosen = input.serviceCatalogId ? resolveServiceCatalogGroup(meta, input.serviceCatalogId) : null;
        if (!chosen) {
          const opts = variantCatalog
            .map((g) => `${g.name ?? 'Option'} ₹${Math.round(Number(g.basePrice))}`)
            .join(', ');
          throw new ValidationError(`Which service would you like — ${opts}?`);
        }
      }
      // Add-on offer gate (deterministic, oral half of "always offer add-ons
      // before booking"). The variant is resolved by here; if the chosen
      // variant or the listing carries optional add-ons AND the request never
      // resolved the add-on question (`serviceAddOnIds === undefined`), refuse
      // the hold and ask the model to OFFER them. `[]` (explicit decline) or a
      // populated array both pass. Resolved orally — no confirm card.
      if (input.serviceAddOnIds === undefined) {
        const chosenGroup = resolveServiceCatalogGroup(meta, input.serviceCatalogId);
        const offerable = collectOfferableAddOns(meta, chosenGroup);
        if (offerable.length > 0) {
          throw new AddOnOfferRequiredError(
            typeof listing.title === 'string' ? listing.title : 'This service',
            chosenGroup?.name ?? '',
            offerable,
          );
        }
      }
      // For per_hour services, the hold's pricing branch reads
      // notes.serviceHours and multiplies. Refuse to lock a slot without
      // hours so the user isn't charged a single-hour rate for what they
      // expected to be a multi-hour job.
      const pricingUnit = typeof meta.pricingUnit === 'string' ? (meta.pricingUnit as string).toLowerCase() : '';
      if (pricingUnit === 'per_hour') {
        const hours = Number(input.serviceHours ?? 0);
        if (!Number.isFinite(hours) || hours < 1 || hours > 24) {
          throw new ValidationError('How many hours do you need the service for?');
        }
        if (!input.endTime && input.startTime) {
          endTime = minutesToTime(timeToMinutes(startTime)! + Math.round(hours * 60));
        }
      } else if (!input.endTime && input.startTime) {
        endTime = minutesToTime(timeToMinutes(startTime)! + durationToMinutes(meta.duration));
      }
    } else if (listingType === 'transport') {
      const advertisedMode = typeof meta.transportMode === 'string' ? meta.transportMode.toLowerCase() : '';
      let requested = input.transportMode ?? null;
      if (!requested) {
        // A concrete time window IS hourly intent. Without this, a missing
        // transportMode fell through to the listing's advertised default —
        // which booked a "2pm to 5pm" ask as a full-day rental at the day
        // rate. Infer hourly when the request carries a window and the
        // listing actually prices by the hour; only then fall back to the
        // advertised mode.
        const hourlyPrice = Number((meta as Record<string, unknown>).pricePerHour);
        const hasWindow = timeToMinutes(input.startTime) != null && timeToMinutes(input.endTime) != null;
        if (hasWindow && Number.isFinite(hourlyPrice) && hourlyPrice > 0) {
          requested = 'hourly';
        } else if (advertisedMode === 'hourly' || advertisedMode === 'day' || advertisedMode === 'package') {
          requested = advertisedMode as 'hourly' | 'day' | 'package';
        }
      }
      if (!requested) {
        throw new ValidationError('How would you like to book — hourly, full day, or one of the packages?');
      }
      resolvedTransportMode = requested as 'hourly' | 'day' | 'package';
      if (resolvedTransportMode === 'hourly') {
        // If the user gave a start AND end time ("10am to 12pm"), derive hours
        // from the delta instead of asking — otherwise the agent re-prompts
        // for something the user already said.
        let hours = Number(input.transportHours ?? 0);
        if ((!Number.isFinite(hours) || hours <= 0) && input.startTime && input.endTime) {
          const s = timeToMinutes(input.startTime);
          const e = timeToMinutes(input.endTime);
          if (s != null && e != null && e > s) {
            hours = (e - s) / 60;
            (input as unknown as Record<string, unknown>).transportHours = hours;
          }
        }
        if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
          throw new ValidationError('How many hours do you need the cab for?');
        }
        if (!input.endTime && input.startTime) {
          const startMinutes = timeToMinutes(startTime)!;
          const endMinutes = startMinutes + Math.round(hours * 60);
          if (endMinutes > 23 * 60 + 59) {
            throw new ValidationError('Hourly transport bookings must end on the same day. Pick an end time before midnight.');
          }
          endTime = minutesToTime(endMinutes);
        }
      }
      if (resolvedTransportMode === 'day') {
        // Mirror the hold's 1–30 cap (server-side enforcement in
        // bookings.service.computeHoldSubtotalPaise). transportDays is
        // optional — default 1.
        const days = Number(input.transportDays ?? 1);
        if (!Number.isFinite(days) || days < 1 || days > 30) {
          throw new ValidationError('Days must be between 1 and 30.');
        }
        if (!input.startTime) startTime = '00:00';
        if (!input.endTime) endTime = '23:59';
      }
      if (resolvedTransportMode === 'package') {
        const opts = Array.isArray(meta.packageOptions) ? meta.packageOptions as Array<Record<string, unknown>> : [];
        // Enumerate the REAL options in every bounce — a bare "pick one of the
        // options" reads as plural and the model told users a single-package
        // listing had "a few options". ("Which package" phrasing is load-bearing:
        // prepare-booking.tool classifies it as an ask-the-user question.)
        const optionLabels = opts
          .map((o) => `${String(o?.label ?? 'Package')} (₹${Number(o?.price) > 0 ? Number(o.price) : '?'})`)
          .join(', ');
        if (!input.transportPackageId) {
          // A single-package listing is unambiguous — select it instead of
          // bouncing the model into a which-one loop.
          if (opts.length === 1 && opts[0] && typeof opts[0] === 'object') {
            resolvedPackageId = typeof opts[0].id === 'string' ? (opts[0].id as string) : 'pkg-0';
          } else {
            throw new ValidationError(optionLabels
              ? `Which package would you like? The options are: ${optionLabels}.`
              : 'Which package would you like? Pick one from the listing\'s package options.');
          }
        } else {
          // Resolve the package against the listing's real options — tolerating
          // the model passing a label/slug instead of the canonical id (it does
          // this). matchPackageId returns the canonical id (or null), which we
          // then hand to the hold so pricing finds the right entry.
          const resolved = matchPackageId(input.transportPackageId, opts);
          if (!resolved) {
            // Wrong/stale ref ≠ removed package — never claim the listing changed.
            throw new ValidationError(optionLabels
              ? `That didn't match one of the packages — which package would you like? The options are: ${optionLabels}.`
              : 'Which package would you like? Pick one from the listing\'s package options.');
          }
          resolvedPackageId = resolved;
        }
      }
      // Pickup is required for every transport mode — the driver needs to know
      // where to show up. Don't silently leave it blank or stuff the listing
      // address in: ambiguous pickup is the #1 cancellation reason for cabs.
      if (!input.pickupLocation || !input.pickupLocation.trim()) {
        throw new ValidationError('Where should the driver pick you up?');
      }
      const passengers = Number(input.passengerCount ?? 0);
      if (!Number.isInteger(passengers) || passengers < 1) {
        throw new ValidationError('How many passengers will be riding?');
      }
      const capacity = Number((meta as Record<string, unknown>).capacity ?? (listing as Record<string, unknown>).capacity ?? 0);
      if (Number.isFinite(capacity) && capacity > 0 && passengers > capacity) {
        throw new ValidationError(`This vehicle seats up to ${capacity}. How many passengers should I book for?`);
      }
    }

    const startMinutes = timeToMinutes(startTime);
    const endMinutes = timeToMinutes(endTime);
    if (listingType !== 'stay' && (startMinutes == null || endMinutes == null || endMinutes <= startMinutes)) {
      throw new ValidationError('That time slot is not valid anymore — pick one of the available slots.');
    }

    // Hotel/multi-room stays: prefer the selected room's price. If the listing
    // has rooms and the agent didn't pick one, push that error back so the
    // agent can ASK which room — never silently fall through to "no price".
    let roomRow: { id: string; base_price_paise: string | number; name: string; max_guests: number } | null = null;
    const roomTypesOnListing = Array.isArray((listing as Record<string, unknown>).room_types)
      ? ((listing as Record<string, unknown>).room_types as Array<Record<string, unknown>>)
      : [];

    if (input.roomTypeId) {
      // Resolve against the listing's real rooms FIRST — the model often sends
      // a slug/name ("deluxe-room") instead of the room UUID, which would crash
      // a raw `getById` (uuid column) and otherwise reach createHold as a bogus
      // id. matchRoomType tolerates id / name / single-room.
      const matched = matchRoomType(input.roomTypeId, roomTypesOnListing);
      if (matched) {
        roomRow = {
          id: String(matched.id),
          base_price_paise: (matched.base_price_paise as string | number) ?? 0,
          name: String(matched.name ?? 'Room'),
          max_guests: Number(matched.max_guests ?? 0),
        };
      } else if (roomTypesOnListing.length === 0 && UUID_RE.test(input.roomTypeId)) {
        // The listing didn't carry joined rooms but a real-looking id was given
        // — validate directly against the table (legacy path). Only reachable
        // when there's nothing to match against above.
        const rt = await roomTypesRepository.getById(input.roomTypeId);
        const row = rt.rows[0];
        if (!row || row.listing_id !== input.listingId) {
          throw new ValidationError('That room option doesn\'t match this stay — which one?');
        }
        roomRow = { id: row.id, base_price_paise: row.base_price_paise, name: row.name, max_guests: row.max_guests };
      } else {
        // The listing carries its rooms and NONE matched — almost always the
        // model invented a UUID instead of passing a real room id or the room
        // name. The rooms DO exist, so ask which one and LIST them; never say
        // "doesn't exist on this listing anymore" — the model relays that to
        // the user as a false "that room isn't available". The "which one?"
        // wording is what classifyFailure maps to reason 'room_required'
        // (+ hydrated roomOptions[]) so the next turn can recover.
        const summary = roomTypesOnListing
          .map((r) => {
            const paise = Number(r.base_price_paise);
            const price = Number.isFinite(paise) && paise > 0 ? ` (₹${Math.round(paise / 100)}/night)` : '';
            return `${r.name ?? 'Room'}${price}`;
          })
          .join(', ');
        throw new ValidationError(
          summary
            ? `That room option doesn't match this stay — which one? Options: ${summary}`
            : 'That room option doesn\'t match this stay — which one?',
        );
      }
    } else if (listingType === 'stay' && roomTypesOnListing.length === 1) {
      // Single-room stay — nothing to disambiguate, auto-select it rather than
      // asking the user "which room?" for a list of one.
      const only = roomTypesOnListing[0];
      roomRow = {
        id: String(only.id),
        base_price_paise: (only.base_price_paise as string | number) ?? 0,
        name: String(only.name ?? 'Room'),
        max_guests: Number(only.max_guests ?? 0),
      };
    } else if (listingType === 'stay' && roomTypesOnListing.length > 0) {
      // Multiple rooms → surface a structured failure the prepare_booking tool
      // classifies as `room_required` and turns into "which room?" in chat.
      const summary = roomTypesOnListing
        .map((r) => {
          const paise = Number(r.base_price_paise);
          const price = Number.isFinite(paise) && paise > 0 ? ` (₹${Math.round(paise / 100)}/night)` : '';
          return `${r.name ?? 'Room'}${price}`;
        })
        .join(', ');
      throw new ValidationError(`This stay has multiple room types — which one? Options: ${summary}`);
    }

    const roomPerNightPaise = roomRow
      ? (() => { const n = Number(roomRow.base_price_paise); return Number.isFinite(n) && n > 0 ? n : 0; })()
      : 0;

    // Resolve a base nightly price: prefer the selected room, then fall back
    // to listing-level price. Only stays + services reach this gate.
    //
    // Transport is intentionally exempt: its price lives in metadata
    // (pricePerHour / pricePerDay / packageOptions[].price) and is
    // resolved later by `computeHoldSubtotalPaise` with mode-aware
    // logic. The old early check read `listing.price` / `price_per_night`,
    // which are null for transport rows — so a perfectly bookable cab
    // listing was being rejected here as "doesn't have a price set yet"
    // before the real pricing step ever ran. `computeHoldSubtotalPaise`
    // throws a precise per-mode error ("isn't priced for hourly bookings
    // yet" etc.) when transport metadata IS missing, so we don't lose
    // protection by deferring. `perNightPrice` is unused downstream
    // (see the `void perNightPrice` below), so skipping is safe.
    const perNightPrice = roomPerNightPaise > 0
      ? roomPerNightPaise / 100
      : (listingType === 'transport' ? 1 : resolveListingPrice(listing));
    if (!perNightPrice) {
      logger.warn('prepare_booking: listing has no resolvable price', {
        listingId: input.listingId, category: listing.category, type: listingType,
        hasRoomTypes: roomTypesOnListing.length > 0,
      });
      if (listingType === 'stay') {
        throw new ValidationError("This stay isn't fully set up for online booking yet — no room types or nightly price listed. Want me to message the host or find similar?");
      }
      throw new ValidationError("This listing doesn't have a price set yet, so it can't be booked online. Want me to find similar options?");
    }

    // Guest count enforcement for hotel-style stays. We need this BEFORE the
    // hold so the assistant can ask the question once instead of locking a
    // slot and bouncing on capacity. The rule:
    //   - any stay with room types (whether or not the agent picked one)
    //     requires a guestCount — even a 1-room listing can have maxGuests.
    //   - a selected room with maxGuests rejects when guestCount exceeds it
    //     (and we surface a larger available room when one exists).
    if (listingType === 'stay') {
      const hasRoomTypes = roomTypesOnListing.length > 0;
      const hasMaxGuests = roomRow ? roomRow.max_guests > 0 : false;
      const needsGuestCount = hasRoomTypes || hasMaxGuests;
      if (needsGuestCount && (input.guestCount == null || input.guestCount < 1)) {
        throw new ValidationError('How many guests will be staying?');
      }

      const roomsWanted = Math.max(1, Math.floor(Number(input.numberOfRooms ?? 1)));
      // Multi-room inventory gate: never lock more units than are actually free
      // for the range. We quote the real remaining so the agent can offer that
      // many instead of dead-ending. createHold re-validates under FOR UPDATE;
      // this is the friendly upfront refusal.
      if (roomRow && roomsWanted > 1) {
        const checkOutForAvail = input.checkOutDate && input.checkOutDate > input.scheduledDate
          ? input.checkOutDate
          : (() => {
              const d = new Date(`${input.scheduledDate}T00:00:00Z`);
              d.setUTCDate(d.getUTCDate() + 1);
              return d.toISOString().slice(0, 10);
            })();
        const availRow = await bookingsRepository
          .getRoomTypeAvailability(input.listingId, roomRow.id, input.scheduledDate, checkOutForAvail)
          .then((r) => r.rows[0])
          .catch(() => undefined);
        const remaining = availRow ? Math.max(0, Number(availRow.remaining)) : undefined;
        if (remaining != null && roomsWanted > remaining) {
          throw new ValidationError(
            remaining === 0
              ? `${roomRow.name} is fully booked for those dates.`
              : `Only ${remaining} ${roomRow.name} room${remaining === 1 ? '' : 's'} ${remaining === 1 ? 'is' : 'are'} free for those dates — want ${remaining}, or a different room?`,
          );
        }
      }

      // Guest capacity scales with the number of rooms booked (3 Singles that
      // sleep 2 each hold 6 guests). Single-room bookings keep the original
      // "offer a bigger room" suggestion.
      const effectiveMaxGuests = roomRow ? roomRow.max_guests * roomsWanted : 0;
      if (roomRow && input.guestCount && roomRow.max_guests > 0 && input.guestCount > effectiveMaxGuests) {
        if (roomsWanted > 1) {
          throw new ValidationError(
            `${roomsWanted} ${roomRow.name} rooms sleep up to ${effectiveMaxGuests} guests total. Reduce guests or add a room.`,
          );
        }
        // Find a larger available room from the listing's room_types list so
        // we can offer it inline instead of dead-ending the agent on capacity.
        const larger = roomTypesOnListing
          .map((r) => ({
            id: String(r.id),
            name: typeof r.name === 'string' ? r.name : 'Room',
            maxGuests: typeof r.max_guests === 'number' ? r.max_guests : 0,
            pricePaise: Number(r.base_price_paise),
          }))
          .filter((r) => r.maxGuests >= (input.guestCount as number) && r.id !== roomRow!.id)
          .sort((a, b) => a.maxGuests - b.maxGuests);
        if (larger.length > 0) {
          const opt = larger[0];
          const priceLabel = Number.isFinite(opt.pricePaise) && opt.pricePaise > 0
            ? ` (₹${Math.round(opt.pricePaise / 100)}/night, sleeps ${opt.maxGuests})`
            : ` (sleeps ${opt.maxGuests})`;
          throw new ValidationError(
            `${roomRow.name} sleeps up to ${roomRow.max_guests}. ${opt.name}${priceLabel} fits ${input.guestCount} — want that instead?`,
          );
        }
        throw new ValidationError(`${roomRow.name} sleeps up to ${roomRow.max_guests}. Pick a bigger room or reduce guests.`);
      }
    }

    // For stays, figure out the number of nights. Defaults to 1 night
    // (check-out = next day) when the agent didn't name an explicit range.
    // Services/transport are always single-slot and pay the base price.
    let nights = 1;
    let checkOutDate: string | undefined;
    if (listingType === 'stay') {
      const checkIn = new Date(`${input.scheduledDate}T00:00:00`);
      const MS_PER_DAY = 86_400_000;
      const rawOut = input.checkOutDate
        ? new Date(`${input.checkOutDate}T00:00:00`)
        : new Date(checkIn.getTime() + MS_PER_DAY);
      nights = Math.max(1, Math.round((rawOut.getTime() - checkIn.getTime()) / MS_PER_DAY));
      const y = rawOut.getFullYear();
      const m = String(rawOut.getMonth() + 1).padStart(2, '0');
      const d = String(rawOut.getDate()).padStart(2, '0');
      checkOutDate = `${y}-${m}-${d}`;
    }
    // Don't compute agreedPrice client-side. The booking-hold flow now runs
    // the authoritative pricing (subtotal + platform fee + GST + coupon)
    // server-side and stores the result on `bookings.agreed_price_paise`.
    // We read that back below and forward it to the payment order so the
    // amount the assistant pays matches the host total exactly.

    // Stays: carry checkOut in notes JSON so the existing guest/host booking
    // views (which read it via JSON.parse of notes) stay consistent with
    // the BookingModal flow. Falls back to the agent's raw notes text otherwise.
    const guestCount = input.guestCount && input.guestCount > 0 ? Math.floor(input.guestCount) : undefined;

    // Notes assembly is now owned by the shared buildBookingNotes (via
    // bookingIntentService.prepare below) — the same builder the marketplace
    // modal uses. The assistant just supplies its resolved fields as a
    // PrepareBookingIntentInput.

    // serviceCategory drives the pricing branch in bookings.service.ts. For
    // transport we override the listing's stored category whenever we know
    // the mode — listings carry a generic "transport" / "auto" / "cab" tag
    // that doesn't tell the pricing resolver which math to run. For services
    // we pass through whatever the listing declares (services price flat).
    let serviceCategory = String(listing.category || listingType);
    if (listingType === 'transport') {
      const modeToCategory: Record<string, string> = {
        hourly: 'driver-hourly',
        day: 'driver-day',
        package: 'driver-package',
      };
      const cat = resolvedTransportMode ? modeToCategory[resolvedTransportMode] : null;
      if (cat) {
        serviceCategory = cat;
      } else if (!/^driver-/.test(serviceCategory)) {
        // Legacy/unrecognised — fall back to the prebook path (driver-cab)
        // so the per-km × estimatedKm math runs instead of the default
        // `subtotalForServicePaise` which would price at 0.
        serviceCategory = 'driver-cab';
      }
    }

    void perNightPrice; void nights; // interpretation locals; the result's price/nights come from prepare.

    // Transport day rentals: derive the EXCLUSIVE hold end-date from
    // transportDays (a 3-day rental from May 27 → endDate May 30 so the
    // multi-night conflict check blocks May 27–29). Stays pass checkOutDate
    // and prepare derives endDate from it.
    const transportDayEndDate =
      listingType === 'transport' && resolvedTransportMode === 'day' && Number(input.transportDays ?? 1) > 1
        ? (() => {
            const days = Math.round(Number(input.transportDays ?? 1));
            const start = new Date(`${input.scheduledDate}T00:00:00Z`);
            return new Date(start.getTime() + days * 86400000).toISOString().slice(0, 10);
          })()
        : undefined;

    // Hand the resolved fields to the shared booking-intent core — the SAME
    // path the marketplace modal uses (/api/bookings/prepare). It builds the
    // unified notes, creates the hold (authoritative pricing) + Razorpay
    // order, and assembles the PrepareBookingResult. The assistant no longer
    // owns notes assembly or result shaping.
    const listingName = String(listing.title || listing.name || 'Listing');
    return bookingIntentService.prepare(
      {
        listingType,
        listingId: input.listingId,
        serviceCategory,
        scheduledDate: input.scheduledDate,
        startTime,
        endTime,
        note: input.notes,
        insuranceOptIn: Boolean(input.insuranceOptIn),
        idempotencyKey: `assistant-hold-${userId}-${input.listingId}-${input.scheduledDate}-${randomUUID().slice(0, 8)}`,
        // result display
        listingTitle: listingName,
        listingName,
        listingImage: resolveListingImage(listing),
        // GEO PRIVACY (WS6): the review card renders pre-payment — city-level
        // only. Raw `location` is untrusted free text that can carry the full
        // street address; the exact address arrives with the confirmation.
        listingLocation: publicLocationLabel(listing) ?? undefined,
        // stay
        ...(listingType === 'stay' && checkOutDate ? { checkOutDate } : {}),
        guestCount,
        // Multi-room stays: book N units of the chosen room type (priced per
        // room + validated against inventory by createHold). >1 only — 1 is the
        // default and keeps single-room holds byte-identical.
        ...(listingType === 'stay' && input.numberOfRooms && input.numberOfRooms > 1
          ? { numberOfRooms: Math.floor(input.numberOfRooms) }
          : {}),
        // Use the server-RESOLVED room id (matchRoomType), not the raw value the
        // model sent — which may be a slug/name.
        roomTypeId: roomRow?.id ?? input.roomTypeId,
        roomName: roomRow?.name,
        roomPricePerNight: roomPerNightPaise > 0 ? Math.round(roomPerNightPaise / 100) : undefined,
        // service
        serviceMode: input.serviceMode,
        serviceAddress: input.serviceAddress,
        serviceAddressGeo,
        serviceHours: input.serviceHours,
        serviceCatalogId: input.serviceCatalogId,
        serviceAddOnIds: input.serviceAddOnIds,
        // transport
        transportMode: resolvedTransportMode ?? undefined,
        pickupLocation: input.pickupLocation,
        passengerCount: input.passengerCount,
        scheduledTime: startTime,
        transportHours: input.transportHours,
        transportDays: input.transportDays,
        transportPackageId: resolvedPackageId,
        ...(transportDayEndDate ? { endDate: transportDayEndDate } : {}),
      },
      userId,
    );
  }
}

export const assistantBookingService = new AssistantBookingService();
