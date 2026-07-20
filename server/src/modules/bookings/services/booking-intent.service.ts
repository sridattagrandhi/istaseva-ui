/**
 * Booking-intent orchestration — the single server-owned core that turns a
 * fully-resolved booking request into a held booking + Razorpay order, ready
 * for the client to launch checkout.
 *
 * Phase 1 of unifying the two booking paths (chat assistant + marketplace
 * modal). Today the chat path (assistantBookingService.prepare) runs this
 * hold→price→order→release sequence server-side, while the marketplace modal
 * hand-rolls the same sequence client-side. This service extracts the shared,
 * high-risk mechanic so there is ONE place that:
 *   1. creates the slot hold (which runs the authoritative server-side
 *      pricing — `agreed_price_paise` is the source of truth, never the
 *      client's number),
 *   2. guards against a ₹0 / missing price,
 *   3. creates the Razorpay order against that server-stored price, and
 *   4. releases the hold if order creation fails, so a failed payment setup
 *      never leaves a phantom pending booking occupying the slot.
 *
 * It deliberately does NOT build `notes`, resolve listing type/mode, or
 * assemble the user-facing PrepareBookingResult — those still live in the
 * caller for now. Later phases move notes assembly + result decoration here
 * too, and repoint the marketplace modal at this service via an HTTP endpoint.
 */
import { randomUUID } from 'crypto';
import type { CreateBookingInput } from '../schemas/booking.schema.js';
import { bookingsService, type OnBehalfGuest } from './bookings.service.js';
import { bookingsRepository } from '../repositories/bookings.repository.js';
import { paymentsService } from '../../payments/services/payments.service.js';
import { buildBookingNotes, type PrepareBookingIntentInput } from './booking-notes.js';
import { listingsService } from '../../listings/services/listings.service.js';
import { insurancePremiumRupees } from '../../payments/pricing/fees.js';
import { logger } from '../../../common/logging/logger.js';

export interface HoldAndOrderInput {
  /** The exact, fully-resolved createHold payload. The caller owns notes
   *  assembly, room/mode resolution, idempotency key, and conditional fields
   *  (endDate, roomTypeId, …). This service does not interpret it. */
  hold: CreateBookingInput;
  /** Whether trip protection was opted into — forwarded to createOrder, which
   *  adds the flat premium AFTER tax (the order amount = agreed_price + premium). */
  insuranceOptIn?: boolean;
  /** Prefix for the order idempotency key. The booking id is appended, so the
   *  caller controls its own namespace (e.g. "assistant-order-<userId>") while
   *  the key stays stable per booking. */
  orderIdempotencyKeyPrefix: string;
}

export interface HoldAndOrderResult {
  /** The created booking row (status=pending, agreed_price_paise populated). */
  booking: Record<string, unknown>;
  /** ISO timestamp the 5-minute slot hold expires at. */
  holdExpiresAt: string;
  /** Server-authoritative host total (rupees) — excludes insurance. */
  agreedPrice: number;
  agreedPricePaise: number;
  /** Razorpay order details the client needs to launch checkout. The order
   *  amount INCLUDES the insurance premium when insuranceOptIn is true. */
  order: {
    orderId: string;
    paymentId: string;
    keyId: string;
    amount: number;
    amountPaise: number;
    currency: string;
  };
}

/**
 * Everything the client needs to launch Razorpay checkout immediately after a
 * booking is prepared. Shared by the chat assistant's Confirm & Pay card and
 * (Phase 4) the marketplace modal — one shape, one renderer contract.
 */
export interface PrepareBookingResult {
  bookingId: string;
  holdExpiresAt: string;
  orderId: string;
  paymentId: string;
  keyId: string;
  amount: number;            // rupees (includes insurance premium when opted in)
  amountPaise: number;
  currency: 'INR' | 'USD';
  listing: { id: string; name: string; image?: string; location?: string };
  schedule: {
    scheduledDate: string;
    startTime: string;
    endTime: string;
    checkOutDate?: string;
    nights?: number;
  };
  room?: { id: string; name: string; pricePerNight?: number };
  transport?: {
    mode: 'hourly' | 'day' | 'package';
    pickupLocation?: string;
    passengerCount?: number;
    days?: number;
    hours?: number;
    packageId?: string;
  };
  /** Transport only — the driver/operator the rider booked, so the
   *  confirmation screen can show who's coming and how to reach them.
   *  name/phone are the host's personal contact (live); vehicle/plate/color
   *  are the booked-vehicle snapshot. Any field may be null. */
  driver?: {
    name: string | null;
    phone: string | null;
    vehicle: string | null;
    plate: string | null;
    color: string | null;
  };
  insurance: { included: boolean; amount: number };
}

export class BookingIntentService {
  /**
   * Create the hold + Razorpay order atomically (from the client's point of
   * view): on any failure after the hold is created, the hold is released so
   * the slot isn't left occupied by an unpayable booking.
   *
   * Throws on a missing/zero price or order-creation failure — callers map
   * these to a user-safe message.
   */
  async executeHoldAndOrder(input: HoldAndOrderInput, userId: string): Promise<HoldAndOrderResult> {
    // 1. Create the hold. Reuses every existing invariant (listing-scoped slot
    //    conflict checks, Redis lock, 5-min expiry, max pending per user) and
    //    runs the authoritative server-side pricing into `agreed_price_paise`.
    const holdRes = await bookingsService.createHold(input.hold, userId);
    const booking = holdRes.data.booking as Record<string, unknown>;
    const hold = holdRes.data.hold as { expiresAt: string };
    const bookingId = String(booking.id);

    // 2. Guard against a ₹0 / missing price — createHold should always populate
    //    agreed_price_paise, but never create a Razorpay order at ₹0. Release
    //    the hold first so we don't leave a phantom pending booking.
    const agreedPricePaise = Number(booking.agreed_price_paise ?? 0);
    if (!Number.isFinite(agreedPricePaise) || agreedPricePaise <= 0) {
      await bookingsService.releaseHold(bookingId, userId).catch(() => { /* best-effort */ });
      throw new Error('Booking pricing was not available — please retry.');
    }
    const agreedPrice = agreedPricePaise / 100;

    // 3. Create the Razorpay order against the SERVER-stored total. The
    //    payments service re-validates `amount` against `agreed_price_paise`
    //    (no drift) and adds the insurance premium after tax when opted in.
    let orderRes: HoldAndOrderResult['order'];
    try {
      orderRes = await paymentsService.createOrder({
        bookingId,
        amount: agreedPrice,
        currency: 'INR',
        insuranceOptIn: Boolean(input.insuranceOptIn),
        idempotencyKey: `${input.orderIdempotencyKeyPrefix}-${bookingId}`,
      }, userId);
    } catch (err) {
      // 4. Order creation failed after the hold was created — release the hold
      //    so the slot frees up instead of holding a booking nobody can pay for.
      logger.error('booking-intent: order creation failed — releasing hold', {
        bookingId,
        error: (err as Error).message,
      });
      await bookingsService.releaseHold(bookingId, userId).catch(() => { /* best-effort */ });
      throw err;
    }

    return {
      booking,
      holdExpiresAt: hold.expiresAt,
      agreedPrice,
      agreedPricePaise,
      order: orderRes,
    };
  }

  /**
   * Prepare a booking from a fully-resolved structured request: build the
   * unified notes, create the hold + order via executeHoldAndOrder, and
   * assemble the PrepareBookingResult the client renders. This is the single
   * entry point both the marketplace modal (via /api/bookings/prepare) and
   * the chat assistant converge on — neither builds notes, holds, orders, or
   * the result shape itself.
   *
   * Pure over its input: display fields (listingName/image/location, room
   * price) come from the caller, and the authoritative PRICE comes from
   * createHold inside executeHoldAndOrder — never from the caller.
   */
  /**
   * GEO PRIVACY (WS6): visit-provider bookings must snapshot the PROVIDER's
   * real address into the notes/address column, and public reads now scrub
   * `metadata.visitAddress` — so the client's copy is the masked area label
   * for most listings. Resolve it server-side from the raw row, same
   * authoritative stance as pricing ("never from the caller"). Mutates
   * `input` in place; a listing without a stored visitAddress keeps whatever
   * the client sent (the old fallback-to-location behaviour).
   */
  private async resolveVisitAddress(input: PrepareBookingIntentInput): Promise<void> {
    if (input.serviceMode !== 'visit-provider') return;
    const listing = await listingsService.getById(input.listingId)
      .then((r) => r.data as Record<string, unknown>)
      .catch(() => null);
    const meta = (listing?.metadata ?? {}) as Record<string, unknown>;
    const real = typeof meta.visitAddress === 'string' && meta.visitAddress.trim().length > 0
      ? meta.visitAddress.trim()
      : null;
    if (!real) return;
    input.visitAddress = real;
    // Also the booking's `address` column — dashboards read it, and
    // createHold geocodes it for the job's lat/lng.
    input.address = real;
  }

  async prepare(input: PrepareBookingIntentInput & { scheduledDate: string }, userId: string): Promise<PrepareBookingResult> {
    if (!input.serviceCategory) {
      throw new Error('serviceCategory is required to prepare a booking.');
    }
    await this.resolveVisitAddress(input);
    const startTime = input.startTime ?? '09:00';
    const endTime = input.endTime ?? '10:00';

    // Resolve the hold's endDate so the conflict check validates the full
    // range: stays use checkOutDate (exclusive), multi-day transport rentals
    // use the rental end. An explicit input.endDate always wins.
    const holdEndDate = input.endDate
      ?? (input.listingType === 'stay' ? input.checkOutDate : undefined)
      ?? (input.listingType === 'transport' && input.transportMode === 'day' ? input.transportEndDate : undefined);

    const notes = buildBookingNotes(input);

    const holdInput = {
      listingId: input.listingId,
      serviceCategory: input.serviceCategory,
      scheduledDate: input.scheduledDate,
      startTime,
      endTime,
      notes,
      idempotencyKey:
        input.idempotencyKey
        ?? `prepare-hold-${userId}-${input.listingId}-${input.scheduledDate}-${randomUUID().slice(0, 8)}`,
      ...(holdEndDate ? { endDate: holdEndDate } : {}),
      ...(input.roomTypeId ? { roomTypeId: input.roomTypeId } : {}),
      ...(typeof input.numberOfRooms === 'number' && input.numberOfRooms > 1 ? { numberOfRooms: input.numberOfRooms } : {}),
      ...(input.couponCode ? { couponCode: input.couponCode } : {}),
      ...(input.address ? { address: input.address } : {}),
    } as unknown as CreateBookingInput;

    const intent = await this.executeHoldAndOrder(
      { hold: holdInput, insuranceOptIn: Boolean(input.insuranceOptIn), orderIdempotencyKeyPrefix: `prepare-order-${userId}` },
      userId,
    );

    const nights = input.listingType === 'stay' && input.checkOutDate
      ? (() => {
          const ms = new Date(`${input.checkOutDate}T00:00:00Z`).getTime() - new Date(`${input.scheduledDate}T00:00:00Z`).getTime();
          const n = Math.round(ms / 86400000);
          return n > 0 ? n : undefined;
        })()
      : undefined;

    // Transport only — resolve the driver's live contact (host's personal name
    // + phone) so the confirmation screen can show who's coming and how to
    // reach them. Vehicle/plate/colour come from the booking-time snapshot on
    // the hold row. Best-effort: never fail the prepare on a contact lookup.
    const booking = intent.booking as Record<string, unknown>;
    let driver: PrepareBookingResult['driver'];
    if (input.listingType === 'transport') {
      let name: string | null = null;
      let phone: string | null = null;
      try {
        const providerId = booking.provider_id ? String(booking.provider_id) : null;
        if (providerId) {
          const contact = (await bookingsRepository.getDriverContact(providerId)).rows[0] as
            { driver_name?: string | null; driver_phone?: string | null } | undefined;
          const clean = (v: unknown) => (typeof v === 'string' && v.trim() && v !== 'User' && v !== 'Anonymous' ? v.trim() : null);
          name = clean(contact?.driver_name);
          phone = clean(contact?.driver_phone);
        }
      } catch (err) {
        logger.debug('prepare: driver contact lookup failed', { err: String(err) });
      }
      const snap = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      driver = {
        name,
        phone,
        vehicle: snap(booking.vehicle_model_snapshot),
        plate: snap(booking.vehicle_plate_snapshot),
        color: snap(booking.vehicle_color_snapshot),
      };
    }

    return {
      bookingId: String(intent.booking.id),
      holdExpiresAt: intent.holdExpiresAt,
      orderId: intent.order.orderId,
      paymentId: intent.order.paymentId,
      keyId: intent.order.keyId,
      amount: intent.order.amount,
      amountPaise: intent.order.amountPaise,
      currency: intent.order.currency as 'INR' | 'USD',
      listing: {
        id: input.listingId,
        name: input.listingName ?? input.listingTitle ?? 'Listing',
        image: input.listingImage,
        location: input.listingLocation,
      },
      schedule: {
        scheduledDate: input.scheduledDate,
        startTime,
        endTime,
        ...(input.listingType === 'stay' && input.checkOutDate ? { checkOutDate: input.checkOutDate, nights } : {}),
      },
      room: input.roomTypeId
        ? { id: input.roomTypeId, name: input.roomName ?? 'Room', pricePerNight: input.roomPricePerNight }
        : undefined,
      transport: input.listingType === 'transport' && input.transportMode
        ? {
            mode: input.transportMode,
            pickupLocation: input.pickupLocation,
            passengerCount: input.passengerCount,
            ...(input.transportMode === 'hourly' ? { hours: input.transportHours } : {}),
            ...(input.transportMode === 'day' ? { days: typeof input.transportDays === 'number' ? Math.round(input.transportDays) : 1 } : {}),
            ...(input.transportMode === 'package' ? { packageId: input.transportPackageId } : {}),
          }
        : undefined,
      ...(driver ? { driver } : {}),
      insurance: {
        included: Boolean(input.insuranceOptIn),
        amount: input.insuranceOptIn ? insurancePremiumRupees(intent.agreedPrice) : 0,
      },
    };
  }

  /**
   * Host-books-on-behalf variant of prepare(): same server-built notes + hold,
   * but instead of a Razorpay order for the authed user we create a shareable
   * Payment Link (QR/SMS) the walk-up guest pays. Trip protection is never
   * added here — the guest didn't opt in, and the link amount must equal the
   * booking's authoritative total.
   *
   * Returns the booking + the payment link + display fields the host UI renders
   * (QR, short URL). The `payment_link.paid` webhook confirms the booking later.
   */
  async prepareOnBehalf(
    input: PrepareBookingIntentInput & { scheduledDate: string },
    hostUserId: string,
    guest: OnBehalfGuest,
    opts: { actorRole?: 'host' | 'admin' } = {},
  ) {
    if (!input.serviceCategory) {
      throw new Error('serviceCategory is required to prepare a booking.');
    }
    await this.resolveVisitAddress(input);
    const startTime = input.startTime ?? '09:00';
    const endTime = input.endTime ?? '10:00';

    const holdEndDate = input.endDate
      ?? (input.listingType === 'stay' ? input.checkOutDate : undefined)
      ?? (input.listingType === 'transport' && input.transportMode === 'day' ? input.transportEndDate : undefined);

    const notes = buildBookingNotes(input);

    const holdInput = {
      listingId: input.listingId,
      serviceCategory: input.serviceCategory,
      scheduledDate: input.scheduledDate,
      startTime,
      endTime,
      notes,
      idempotencyKey:
        input.idempotencyKey
        ?? `on-behalf-hold-${hostUserId}-${input.listingId}-${input.scheduledDate}-${randomUUID().slice(0, 8)}`,
      ...(holdEndDate ? { endDate: holdEndDate } : {}),
      ...(input.roomTypeId ? { roomTypeId: input.roomTypeId } : {}),
      ...(typeof input.numberOfRooms === 'number' && input.numberOfRooms > 1 ? { numberOfRooms: input.numberOfRooms } : {}),
      ...(input.couponCode ? { couponCode: input.couponCode } : {}),
      ...(input.address ? { address: input.address } : {}),
    } as unknown as CreateBookingInput;

    const { booking, paymentLink } = await bookingsService.createOnBehalf(holdInput, hostUserId, guest, opts);

    const nights = input.listingType === 'stay' && input.checkOutDate
      ? (() => {
          const ms = new Date(`${input.checkOutDate}T00:00:00Z`).getTime() - new Date(`${input.scheduledDate}T00:00:00Z`).getTime();
          const n = Math.round(ms / 86400000);
          return n > 0 ? n : undefined;
        })()
      : undefined;

    const amountPaise = Number((booking as Record<string, unknown>).agreed_price_paise);

    return {
      bookingId: String((booking as Record<string, unknown>).id),
      holdExpiresAt: (booking as Record<string, unknown>).hold_expires_at ?? null,
      paymentLink,
      amountPaise,
      amount: amountPaise / 100,
      currency: 'INR' as const,
      guest: { name: guest.name ?? null, phone: guest.phone, email: guest.email ?? null },
      listing: {
        id: input.listingId,
        name: input.listingName ?? input.listingTitle ?? 'Listing',
        image: input.listingImage,
        location: input.listingLocation,
      },
      schedule: {
        scheduledDate: input.scheduledDate,
        startTime,
        endTime,
        ...(input.listingType === 'stay' && input.checkOutDate ? { checkOutDate: input.checkOutDate, nights } : {}),
      },
      room: input.roomTypeId
        ? { id: input.roomTypeId, name: input.roomName ?? 'Room', pricePerNight: input.roomPricePerNight }
        : undefined,
    };
  }
}

export const bookingIntentService = new BookingIntentService();
