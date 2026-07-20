import type pg from 'pg';
import { dbTransaction, dbQuery } from '../../../common/repositories/database.js';
import { config } from '../../../common/config/index.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../../common/errors/app-error.js';
import { logAuditEvent } from '../../../common/logging/audit-log.js';
import { seedBookingConfirmationMessage } from './booking-chat-seed.js';
import { shapeCallRelationship } from './call-relationship.js';
import { trackServerEvent } from '../../analytics/services/analytics-track.js';
import { getCacheProvider, getPaymentProvider } from '../../../common/providers/registry.js';
import { cacheDelByPattern } from '../../../common/cache/redis.js';
import { bookingsRepository } from '../repositories/bookings.repository.js';
import type { CreateBookingInput } from '../schemas/booking.schema.js';
import type { BookingStatus } from '../schemas/booking-status.js';
import type { CancellationReason } from '../schemas/cancellation-reasons.js';
import { listingsRepository } from '../../listings/repositories/listings.repository.js';
import { roomTypesRepository } from '../../listings/repositories/room-types.repository.js';
import {
  applyFees,
  resolveServiceAddOns,
  resolveServiceCatalogGroup,
  subtotalForServicePaise,
  subtotalForStayPaise,
  resolveNightlyStayPaiseList,
  subtotalForTransportDayPaise,
  subtotalForTransportHourlyPaise,
  subtotalForTransportPackagePaise,
  subtotalForTransportPrebookPaise,
  subtotalForTransportQuotePaise,
  type BookingPriceBreakdown,
} from '../../payments/pricing/booking-price.js';
import { computePlatformFeePaise } from '../../payments/pricing/fees.js';
import { feeRulesService } from '../../payments/services/fee-rules.service.js';
import { providersRepository } from '../../providers/repositories/providers.repository.js';
import { usersRepository } from '../../users/repositories/users.repository.js';
import { notificationsService } from '../../notifications/services/notifications.service.js';
import { couponsService } from '../../coupons/services/coupons.service.js';
import { logger } from '../../../common/logging/logger.js';
import { geocodeAddress } from '../../../common/services/geocode.service.js';
import { computePricingBreakdown, formatRupees, formatINR } from './pricing-breakdown.js';
import { shapeListingAddress, bookingHasExactAddress } from './listing-address.js';
import { describeCancellationPolicy } from './cancellation-policy.js';
import { computeCancellationRefund, type CancellationPolicy, type CancelledBy, type PaymentBreakdown } from '../../payments/pricing/cancellation.js';

const PUSH_CHANNELS = ['push', 'in_app', 'email'] as const;

/** Build a PaymentBreakdown from a payments row. Falls back to "subtotal =
 *  full amount" for legacy rows that pre-date the breakdown columns so
 *  cancellations still work; refund will be 100%-of-subtotal in that case
 *  (which equals the full amount) — matches the old behavior exactly. */
function paymentBreakdownFromRow(row: pg.QueryResultRow): PaymentBreakdown {
  const total = Number(row.amount_paise ?? 0);
  const subtotal = row.subtotal_paise != null ? Number(row.subtotal_paise) : total;
  const platformFee = row.platform_fee_paise != null ? Number(row.platform_fee_paise) : 0;
  const taxes = row.taxes_paise != null ? Number(row.taxes_paise) : 0;
  const insurance = row.insurance_premium_paise != null ? Number(row.insurance_premium_paise) : 0;
  const discount = row.discount_paise != null ? Number(row.discount_paise) : 0;
  return {
    subtotalPaise: subtotal,
    discountPaise: discount,
    platformFeePaise: platformFee,
    taxesPaise: taxes,
    insurancePremiumPaise: insurance,
    totalPaise: total,
  };
}

/** Combine scheduled_date + start_time into an ISO timestamp; defaults
 *  start_time to "00:00" when null so date-only bookings still get a
 *  comparable instant. Returns now() if both are missing — that produces
 *  hoursOut <= 0, i.e. "no refund window remaining".
 *
 *  Important: the pg driver returns DATE columns as JS Date objects, not
 *  strings. `String(dateObject).slice(0,10)` yields "Fri May 15" (Date's
 *  default locale string) which then fails to parse. We handle both shapes
 *  explicitly so cancellation never crashes on the date math. */
function scheduledStartIso(
  row: { scheduled_date: string | Date | null; start_time: string | null } | undefined,
): string {
  if (!row?.scheduled_date) return new Date().toISOString();
  const dateStr = row.scheduled_date instanceof Date
    ? row.scheduled_date.toISOString().slice(0, 10)
    : String(row.scheduled_date).slice(0, 10);
  const time = row.start_time ? String(row.start_time).slice(0, 8) : '00:00:00';
  const d = new Date(`${dateStr}T${time}`);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

/** The driver's working-hours window for a calendar date, from listing
 *  metadata. Distinguishes three cases:
 *    {openMin, closeMin} — a usable same-day window for that weekday
 *    'closed'            — workingHours exist but this weekday is off
 *    null                — no usable workingHours at all (legacy listings,
 *                          or an unparseable/overnight window) → don't enforce
 *  Used by the transport hold path so hourly/package bookings can't land
 *  outside the day's window ("fits some days but not others" → the
 *  non-fitting days are simply unbookable). */
/** Lead time (minutes) a same-day service/transport booking must still be in
 *  the future before createHold accepts it. Mirrors the client pickers'
 *  BOOKING_LEAD_MINUTES (web src/lib/ist-time.ts, mobile bookings.ts). */
const SAME_DAY_LEAD_MINUTES = 30;

const TRANSPORT_WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
function transportWindowForDate(
  meta: Record<string, unknown>,
  scheduledDate: string,
): { openMin: number; closeMin: number } | 'closed' | null {
  const wh = meta.workingHours;
  if (!wh || typeof wh !== 'object') return null;
  const hasAnyWindow = Object.values(wh as Record<string, unknown>).some(
    (slot) => Array.isArray(slot) && slot.length === 2,
  );
  if (!hasAnyWindow) return null;
  const d = new Date(`${scheduledDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const slot = (wh as Record<string, unknown>)[TRANSPORT_WEEKDAY_KEYS[d.getDay()]];
  if (!Array.isArray(slot) || slot.length !== 2) return 'closed';
  const parse = (s: unknown) => {
    if (typeof s !== 'string') return null;
    const m = /^(\d{1,2}):(\d{2})/.exec(s.trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const openMin = parse(slot[0]);
  const closeMin = parse(slot[1]);
  // Overnight (close <= open) or unparseable windows: out of scope for
  // enforcement — treat as no data rather than guessing.
  if (openMin == null || closeMin == null || closeMin <= openMin) return null;
  return { openMin, closeMin };
}

function receiptSnapshotFromNotes(notes: string | undefined | null): {
  guestName: string | null;
  guestCount: number | null;
} {
  try {
    const parsed = notes ? JSON.parse(notes) : null;
    if (!parsed || typeof parsed !== 'object') return { guestName: null, guestCount: null };
    const rawGuestName = typeof parsed.guestName === 'string' ? parsed.guestName.trim() : '';
    const guestName = rawGuestName && rawGuestName !== 'User' && rawGuestName !== 'Anonymous'
      ? rawGuestName
      : null;
    const rawCount = Number(parsed.guests ?? parsed.guestCount ?? parsed.adults);
    const guestCount = Number.isFinite(rawCount) && rawCount > 0 ? Math.round(rawCount) : null;
    return { guestName, guestCount };
  } catch {
    return { guestName: null, guestCount: null };
  }
}

// Fire-and-forget send wrapper. Notifications are best-effort — a delivery
// failure must not break the booking flow — but the raw `void promise` form
// swallows rejections and surfaces them as process-level unhandledRejections.
// This attaches a logger so failures are visible without propagating.
function sendNotificationAsync(input: Parameters<typeof notificationsService.send>[0]): void {
  notificationsService.send(input).catch((err) => {
    logger.warn('notification send failed', { type: input.type, err: String(err) });
  });
}

/** Format a date string (YYYY-MM-DD) into a readable form e.g. "Mon, 20 Apr" */
function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  } catch { return dateStr; }
}

/** Render either a single date or a "May 7 → May 10" range. */
function formatDateRange(start: string, end?: string | null) {
  const startStr = formatDate(start);
  if (!end || end === start) return startStr;
  return `${startStr} → ${formatDate(end)}`;
}

/**
 * Best-effort lookup of human-readable booking context (listing name, guest
 * name, provider name, check-out date) used to compose descriptive
 * notifications. Failures fall back to whatever fields the booking row
 * already carries — notifications are non-blocking.
 */
async function loadNotificationContext(client: pg.PoolClient, bookingId: string): Promise<{
  listingName: string | null;
  listingType: string | null;
  guestName: string | null;
  providerName: string | null;
  /** The provider's USER id (provider_profiles.user_id) — bookings rows only
   *  carry provider_id (the profile id), which is NOT a valid notification /
   *  FCM / analytics target. */
  providerUserId: string | null;
  checkOut: string | null;
  hotelAddress: string | null;
  /** WS6: false when the host gave no street-level address (city-only). */
  hasExactAddress: boolean;
  listingCity: string | null;
  roomType: string | null;
  roomCount: number | null;
  guestCount: number | null;
  bookedOn: Date | string | null;
  cancellationPolicy: 'flexible' | 'moderate' | 'strict';
  listingCategory: string | null;
  pricePerNightPaise: number | null;
  /** Transport driver contact — the host's personal name + phone, so the
   *  confirmation email/invoice can show who's driving and how to reach them. */
  driverName: string | null;
  driverPhone: string | null;
}> {
  const empty = {
    listingName: null,
    listingType: null,
    guestName: null,
    providerName: null,
    providerUserId: null,
    checkOut: null,
    hotelAddress: null,
    hasExactAddress: false,
    listingCity: null,
    roomType: null,
    roomCount: null as number | null,
    guestCount: null as number | null,
    bookedOn: null,
    cancellationPolicy: 'flexible' as const,
    listingCategory: null,
    pricePerNightPaise: null,
    driverName: null,
    driverPhone: null,
  };
  try {
    const r = await client.query(
      `SELECT l.name AS listing_name,
              l.listing_type AS listing_type,
              l.location AS listing_location,
              l.address AS listing_address,
              l.area AS listing_area,
              l.city AS listing_city,
              l.state AS listing_state,
              l.category AS listing_category,
              l.price_per_night AS price_per_night,
              COALESCE(l.cancellation_policy, 'flexible') AS cancellation_policy,
              up.display_name AS guest_name,
              pp.display_name AS provider_name,
              pp.user_id AS provider_user_id,
              host.display_name AS driver_name,
              host.phone AS driver_phone,
              rt.name AS room_type_name,
              b.guest_name_snapshot,
              b.guest_count,
              b.room_count,
              b.room_type_name_snapshot,
              b.created_at,
              b.notes,
              b.address AS booking_address,
              b.end_date AS booking_end_date,
              b.scheduled_date AS booking_scheduled_date,
              b.service_category AS booking_service_category
         FROM bookings b
         LEFT JOIN listings l ON l.id = b.listing_id
         LEFT JOIN user_profiles up ON up.user_id = b.user_id
         LEFT JOIN provider_profiles pp ON pp.id = b.provider_id
         LEFT JOIN user_profiles host ON host.user_id = l.user_id
         LEFT JOIN listing_room_types rt ON rt.id = b.room_type_id
        WHERE b.id = $1`,
      [bookingId]
    );
    const row = r.rows[0];
    if (!row) return empty;
    let checkOut: string | null = null;
    let notesGuestName: string | null = null;
    let guestCount: number | null = null;
    try {
      const parsed = row.notes ? JSON.parse(row.notes) : null;
      if (parsed?.checkOut) checkOut = String(parsed.checkOut);
      if (parsed?.guestName && parsed.guestName !== 'User') notesGuestName = String(parsed.guestName);
      const g = Number(parsed?.guests ?? parsed?.guestCount ?? parsed?.adults);
      if (Number.isFinite(g) && g > 0) guestCount = g;
    } catch { /* notes may be free text */ }
    // Transport multi-day rentals: derive a display checkOut from end_date
    // (stored EXCLUSIVE — last rental day + 1) so notification/email/invoice
    // surfaces show the actual rental range. Stays already use notes.checkOut;
    // services don't have multi-day. Subtract one day so the displayed range
    // ends on the LAST rental day, not the day after.
    if (!checkOut && row.booking_end_date && row.booking_scheduled_date) {
      const cat = String(row.booking_service_category || '').toLowerCase();
      const isTransport = cat.startsWith('driver-');
      if (isTransport) {
        const endDateStr = row.booking_end_date instanceof Date
          ? row.booking_end_date.toISOString().slice(0, 10)
          : String(row.booking_end_date).slice(0, 10);
        const startDateStr = row.booking_scheduled_date instanceof Date
          ? row.booking_scheduled_date.toISOString().slice(0, 10)
          : String(row.booking_scheduled_date).slice(0, 10);
        if (endDateStr > startDateStr) {
          // Convert exclusive end → inclusive last day for display.
          const last = new Date(`${endDateStr}T00:00:00Z`);
          last.setUTCDate(last.getUTCDate() - 1);
          checkOut = last.toISOString().slice(0, 10);
        }
      }
    }
    const sanitize = (s: string | null) => (s && s !== 'User' && s !== 'Anonymous' ? s : null);
    const { hotelAddress } = shapeListingAddress(row);
    // Booking-level flag (mode-aware) — the same rule the dashboard/success/
    // mobile surfaces get, so the email can never disagree with the app.
    const hasExactAddress = bookingHasExactAddress(row);
    return {
      listingName: sanitize(row.listing_name),
      listingType: row.listing_type ?? null,
      guestName: sanitize(row.guest_name_snapshot) ?? sanitize(row.guest_name) ?? notesGuestName,
      providerName: sanitize(row.provider_name),
      providerUserId: row.provider_user_id ? String(row.provider_user_id) : null,
      checkOut,
      hotelAddress,
      hasExactAddress,
      listingCity: sanitize(row.listing_city),
      roomType: sanitize(row.room_type_name_snapshot) ?? sanitize(row.room_type_name),
      roomCount: row.room_count != null && Number.isFinite(Number(row.room_count))
        ? Math.max(1, Math.round(Number(row.room_count)))
        : null,
      guestCount: row.guest_count != null ? Number(row.guest_count) : guestCount,
      bookedOn: row.created_at ?? null,
      cancellationPolicy: (row.cancellation_policy as 'flexible' | 'moderate' | 'strict') || 'flexible',
      listingCategory: row.listing_category ?? null,
      pricePerNightPaise: row.price_per_night != null
        ? Math.round(Number(row.price_per_night) * 100)
        : null,
      driverName: sanitize(row.driver_name),
      driverPhone: typeof row.driver_phone === 'string' && row.driver_phone.trim() ? row.driver_phone.trim() : null,
    };
  } catch {
    return empty;
  }
}

/** Contact details for the walk-up guest a host is booking for. */
export interface OnBehalfGuest {
  name?: string | null;
  phone: string;
  email?: string | null;
}

/** Optional knobs for createHold. Default (empty) = ordinary self-service hold. */
export interface CreateHoldOptions {
  /** Host-books-on-behalf: skips per-guest caps, flags the row, stores guest. */
  onBehalf?: boolean;
  /** Overrides the default 5-min hold. */
  holdMinutes?: number;
  guestContact?: OnBehalfGuest | null;
  createdByUserId?: string | null;
}

/**
 * How long a host-created, unpaid booking holds its slot before the sweeper
 * expires it. Same 5 minutes as a self-service hold: the guest is standing in
 * front of the host with the QR on screen — if they don't pay right away, the
 * whole booking is cancelled (expired) and the slot frees immediately.
 */
const PAYMENT_LINK_TTL_MINUTES = 5;

export class BookingsService {
  private isActiveSlotUniqueViolation(error: unknown) {
    const pgError = error as { code?: string; constraint?: string } | undefined;
    return pgError?.code === '23505'
      && (
        pgError.constraint === 'idx_bookings_active_slot_unique'
        || pgError.constraint === 'idx_slot_locks_active_slot_unique'
      );
  }

  async listForUser(params: { userId: string; status: unknown; page: number; limit: number; scope?: 'user' | 'provider' }) {
    const offset = (params.page - 1) * params.limit;
    const isProviderScope = params.scope === 'provider';
    const [result, countResult] = await Promise.all([
      isProviderScope
        ? bookingsRepository.listForProvider(params.userId, params.status, params.limit, offset)
        : bookingsRepository.listForUser(params.userId, params.status, params.limit, offset),
      isProviderScope
        ? bookingsRepository.countForProvider(params.userId)
        : bookingsRepository.countForUser(params.userId),
    ]);

    return {
      // WS6: stamp the "real street address?" flag from the single shared
      // rule (bookingHasExactAddress). Guest rows only — the provider list
      // query doesn't select the ingredient columns and never carried the
      // flag; stamping a spurious `false` there would show hosts a bogus
      // "message your host" row on their own bookings.
      data: isProviderScope
        ? result.rows
        : result.rows.map((row) => ({ ...row, has_exact_address: bookingHasExactAddress(row) })),
      total: parseInt(countResult.rows[0].count, 10),
      page: params.page,
      limit: params.limit,
    };
  }

  async getById(bookingId: string, userId: string) {
    const result = await bookingsRepository.getAccessibleBookingById(bookingId, userId);
    if (!result.rows[0]) throw new NotFoundError('Booking', bookingId);
    const row = result.rows[0];
    return { data: { ...row, has_exact_address: bookingHasExactAddress(row) } };
  }

  /**
   * Gate + payload for the in-chat "Call" button. Given the signed-in user and
   * a chat peer, reports whether an active booking links them (confirmed /
   * in_progress / completed, either direction), the peer's phone to dial, and
   * the peer's role(s) relative to the user (host / provider / driver / guest)
   * for the thread subtitle. When no active booking exists the client hides the
   * button — the call channel never opens for pre-booking discovery chats.
   */
  async getPeerCallRelationship(userId: string, peerUserId: string) {
    // Self / empty peer never has a call channel; skip the DB round-trip.
    if (!peerUserId || peerUserId === userId) {
      return shapeCallRelationship([]);
    }
    const result = await bookingsRepository.findActiveRelationship(userId, peerUserId);
    return shapeCallRelationship(result.rows);
  }

  /**
   * Read-only preview of what cancelling a booking would refund. Powers the
   * "You'll get back ₹X — ₹Y service fee retained" message on the cancel
   * card. Side-effect-free; safe to call speculatively (the agent's
   * cancel_booking_preview tool reuses this).
   */
  async previewCancellation(bookingId: string, userId: string) {
    const access = await bookingsRepository.getAccessibleBookingById(bookingId, userId);
    const booking = access.rows[0];
    if (!booking) throw new NotFoundError('Booking', bookingId);

    const isGuest = booking.user_id === userId;
    const isProvider = booking.provider_user_id === userId;
    if (!isGuest && !isProvider) throw new ForbiddenError('Not authorized to view cancellation preview');

    // When the caller is BOTH the guest and the host (e.g. a host who tested
    // their own listing), treat them as a guest for refund-policy purposes —
    // they're acting through the guest dashboard and the booking belongs to
    // them. Only flag as host when they're cancelling someone else's booking
    // on their listing.
    const cancelledBy: CancelledBy = isGuest ? 'guest' : 'host';

    return this.buildCancellationPreview(booking, cancelledBy);
  }

  /**
   * Ops-console variant: no ownership check (caller MUST be behind
   * requireRole('admin')). Admin cancels use host semantics — the guest is
   * never penalized for a platform-initiated cancellation.
   */
  async previewCancellationAsAdmin(bookingId: string) {
    const result = await bookingsRepository.getById(bookingId);
    const booking = result.rows[0];
    if (!booking) throw new NotFoundError('Booking', bookingId);
    return this.buildCancellationPreview(booking, 'host');
  }

  private async buildCancellationPreview(booking: pg.QueryResultRow, cancelledBy: CancelledBy) {
    const bookingId = booking.id as string;
    const cancellable = booking.status === 'pending' || booking.status === 'confirmed';

    const payment = (await bookingsRepository.getCompletedPaymentSummary(bookingId)).rows[0];
    const ctx = (await bookingsRepository.getCancellationContext(bookingId)).rows[0];
    const policy: CancellationPolicy = (ctx?.cancellation_policy as CancellationPolicy) || 'flexible';

    if (!payment || !cancellable) {
      // No completed payment → cancelling the hold is free; no refund to compute.
      return {
        bookingId,
        cancellable,
        currentStatus: booking.status,
        policy,
        refundPaise: 0,
        platformKeepsPaise: 0,
        hostKeepsPaise: 0,
        insuranceVoided: false,
        reason: cancellable
          ? 'No payment to refund — slot will be released.'
          : `Booking is ${booking.status}; cancellation isn't available.`,
        cancelledBy,
      };
    }

    const breakdown = paymentBreakdownFromRow(payment);
    const refund = computeCancellationRefund({
      breakdown,
      policy,
      cancelledBy,
      scheduledStartIso: scheduledStartIso(ctx),
      cancelledAtIso: new Date().toISOString(),
    });

    return {
      bookingId,
      cancellable,
      currentStatus: booking.status,
      policy,
      refundPaise: refund.refundPaise,
      platformKeepsPaise: refund.platformKeepsPaise,
      hostKeepsPaise: refund.hostKeepsPaise,
      insuranceVoided: refund.insuranceVoided,
      reason: refund.reason,
      cancelledBy: refund.cancelledBy,
      chargedPaise: breakdown.totalPaise,
      currency: payment.currency,
    };
  }

  /**
   * Resolve the host-portion subtotal in paise from authoritative DB data
   * (listing row + room type + booking notes JSON). Categories handled:
   *
   *   - stay: nightly walk over [scheduledDate, endDate) using room or
   *     listing base price + per-night availability overrides + host
   *     discount %. Falls back to single night × base price when end date
   *     is missing.
   *   - service: listing.price (rupees) × 1 visit.
   *   - transport: notes.estimatedKm × pricePerKm from listing metadata
   *     (legacy prebook). Doesn't run on transport-quote bookings — those resolve
   *     via transport-quotes.acceptQuote which calls applyFees directly.
   *
   *  Returns 0 when nothing matches; caller can then either accept that
   *  (rare — only for legacy/free bookings) or reject if it expects pricing.
   */
  private async computeHoldSubtotalPaise(
    input: CreateBookingInput,
    listing: pg.QueryResultRow | null,
  ): Promise<number> {
    const category = String(input.serviceCategory ?? listing?.category ?? '').toLowerCase();
    const isTransport = /^driver-/.test(category);
    const isStay = String(listing?.listing_type ?? '').toLowerCase() === 'stay'
      || /^(hotel|homestay|stay|farm|heritage)/.test(category);

    if (isStay && listing) {
      // Resolve nightly base price — prefer the room type when given.
      let nightlyBasePaise = Math.round(Number(listing.price_per_night ?? 0) * 100);
      if (input.roomTypeId) {
        try {
          const rt = await roomTypesRepository.getById(input.roomTypeId);
          const row = rt.rows[0];
          if (row && row.base_price_paise != null) {
            nightlyBasePaise = Number(row.base_price_paise);
          }
        } catch {
          // Room type lookup failed — fall back to listing's nightly rate.
        }
      }
      if (!nightlyBasePaise) return 0;

      // Walk the night range. For overrides we use the existing helper module
      // (lazy-imported to avoid pulling room-upgrade logic into this hot path).
      const startDate = input.scheduledDate;
      const endDate = input.endDate && input.endDate > input.scheduledDate
        ? input.endDate
        : null;
      const nights: string[] = [];
      if (endDate) {
        const cur = new Date(`${startDate}T00:00:00Z`);
        const end = new Date(`${endDate}T00:00:00Z`);
        while (cur < end) {
          nights.push(cur.toISOString().slice(0, 10));
          cur.setUTCDate(cur.getUTCDate() + 1);
        }
      } else {
        nights.push(startDate);
      }

      // Per-night override map (room override > listing override > base). The
      // resolution itself is in resolveNightlyStayPaiseList so the assistant's
      // pricing-preview tool produces an identical list — and any future change
      // to override semantics happens in exactly one place.
      let overrideRows: Array<{ date: string; price_paise: number | null; room_type_id: string | null }> = [];
      try {
        const { availabilityOverridesRepository } = await import('../../listings/repositories/availability-overrides.repository.js');
        const overrides = await availabilityOverridesRepository.listForListing(
          String(listing.id),
          nights[0],
          nights[nights.length - 1],
        );
        overrideRows = overrides.rows.map((o) => ({
          date: typeof o.date === 'string' ? o.date.slice(0, 10) : String(o.date),
          price_paise: o.price_paise == null ? null : Number(o.price_paise),
          room_type_id: o.room_type_id,
        }));
      } catch {
        // Overrides table unavailable — fall through with an empty list and
        // every night will get the base price.
      }
      const nightlyPaiseList = resolveNightlyStayPaiseList({
        nights,
        nightlyBasePaise,
        roomTypeId: input.roomTypeId ?? null,
        overrideRows,
      });

      const hostDiscountPercent = Number(listing.discount_percent ?? listing.discountPercent ?? 0);
      // Multi-room bookings (3 "Non-AC" rooms × 2 nights) are still a
      // single booking row, but the customer is paying for `roomCount`
      // copies of the same per-night rate. Default 1 keeps single-room
      // bookings byte-identical to the previous behaviour.
      const roomCount = Math.max(1, Math.round(Number(input.numberOfRooms) || 1));
      const perRoom = subtotalForStayPaise({ nightlyPaiseList, hostDiscountPercent });
      return perRoom * roomCount;
    }

    if (isTransport && listing) {
      // Transport categories share the `driver-*` prefix. We branch by
      // category on what pricing math owns the subtotal:
      //
      //   driver-quote   — `transport_quotes.provider_quote_paise`, looked
      //                    up via notes.quoteId. NOTE: the transport-quotes
      //                    negotiation feature was removed; nothing stamps a
      //                    quoteId anymore, so this branch is retained (pricing
      //                    wiring + table kept) but is effectively inert.
      //   driver-hourly  — metadata.pricePerHour × notes.durationHours
      //                    (Phase 6A)
      //   driver-day     — metadata.pricePerDay × notes.days (Phase 6A)
      //   driver-package — metadata.packageOptions[].price selected by
      //                    notes.packageId (Phase 6A)
      //   driver-cab / -auto / -van / -bike / -tempo (prebook) —
      //                    metadata.pricePerKm × km.
      //                    Existing flow; falls through `default`.
      let notesParsed: Record<string, unknown> | null = null;
      try {
        notesParsed = input.notes ? JSON.parse(input.notes) : null;
      } catch { /* free-text notes */ }

      const meta = listing.metadata && typeof listing.metadata === 'object' ? listing.metadata as Record<string, unknown> : {};

      // `metadata.transportMode` is the listing's default/primary mode, not
      // the full set of modes it accepts. The UI exposes hourly/day/package
      // tabs whenever their matching price fields exist, so the backend must
      // allow those priced modes too.
      const categoryToMode: Record<string, string> = {
        'driver-hourly': 'hourly',
        'driver-day': 'day',
        'driver-package': 'package',
        // Prebook categories all map to "point" on the listing side — the
        // frontend never advertises "prebook" as a transport mode.
        'driver-cab': 'point',
        'driver-auto': 'point',
        'driver-van': 'point',
        'driver-bike': 'point',
        'driver-tempo': 'point',
        // Quote bookings aren't a "mode" the listing advertises; skip the check.
        'driver-quote': '',
      };
      const requestedMode = categoryToMode[category] ?? '';
      const hasHourlyPrice = Number.isFinite(Number(meta.pricePerHour)) && Number(meta.pricePerHour) > 0;
      const hasDayPrice = Number.isFinite(Number(meta.pricePerDay)) && Number(meta.pricePerDay) > 0;
      const hasPackages = Array.isArray(meta.packageOptions) && meta.packageOptions.length > 0;
      const supportsRequestedMode = requestedMode === 'hourly'
        ? hasHourlyPrice
        : requestedMode === 'day'
          ? hasDayPrice
          : requestedMode === 'package'
            ? hasPackages
            : true;
      if (requestedMode && !supportsRequestedMode) {
        throw new ValidationError(
          `This listing isn't priced for ${requestedMode} bookings yet.`,
        );
      }

      if (category === 'driver-quote') {
        const quoteId = notesParsed && typeof notesParsed.quoteId === 'string'
          ? notesParsed.quoteId
          : null;
        if (!quoteId) {
          // Defensive: the transport-quotes negotiation feature was removed, so
          // no new booking should carry a quoteId. If one somehow does, throw
          // rather than let it fall through to a free (0) price.
          throw new ValidationError('Transport quote booking missing quoteId in notes');
        }
        const { transportQuotesRepository } = await import('../../transport-quotes/repositories/transport-quotes.repository.js');
        const r = await transportQuotesRepository.getById(quoteId);
        const providerQuotePaise = r.rows[0]?.provider_quote_paise;
        return subtotalForTransportQuotePaise({ providerQuotePaise });
      }

      if (category === 'driver-hourly') {
        const pricePerHourRupees = Number(meta.pricePerHour ?? 0);
        if (!Number.isFinite(pricePerHourRupees) || pricePerHourRupees <= 0) {
          throw new ValidationError(
            "This listing isn't priced for hourly bookings yet (missing metadata.pricePerHour).",
          );
        }
        const durationHours = Number(notesParsed?.durationHours);
        if (!Number.isFinite(durationHours) || durationHours <= 0 || durationHours > 24) {
          // Frontend hourly transport bookings use start/end times, so valid
          // same-day windows can be fractional (for example 90 minutes). Keep
          // the backend in lockstep and cap the same-day span at 24 hours.
          throw new ValidationError('durationHours must be greater than 0 and no more than 24.');
        }
        // Working-hours fit: the requested window must sit inside the
        // driver's open hours for that weekday. Closed day → unbookable.
        // Listings without usable workingHours are exempt (legacy rows).
        const hourlyWindow = transportWindowForDate(meta, input.scheduledDate);
        if (hourlyWindow === 'closed') {
          throw new ValidationError("The driver isn't available on this date — pick a working day.");
        }
        if (hourlyWindow) {
          const reqStart = /^(\d{1,2}):(\d{2})/.exec(String(input.startTime ?? '').trim());
          const startMin = reqStart ? Number(reqStart[1]) * 60 + Number(reqStart[2]) : null;
          if (startMin != null
            && (startMin < hourlyWindow.openMin
              || startMin + durationHours * 60 > hourlyWindow.closeMin)) {
            throw new ValidationError(
              "Those hours fall outside the driver's working hours for that day — pick an earlier start or a shorter duration.",
            );
          }
        }
        const subtotal = subtotalForTransportHourlyPaise({
          pricePerHourRupees,
          durationHours,
        });
        if (subtotal <= 0) {
          // Defensive: helper returned 0 even after we validated inputs.
          // Shouldn't happen, but never let a 0-paise hold land.
          throw new ValidationError('Could not price this hourly booking.');
        }
        return subtotal;
      }

      if (category === 'driver-day') {
        const pricePerDayRupees = Number(meta.pricePerDay ?? 0);
        if (!Number.isFinite(pricePerDayRupees) || pricePerDayRupees <= 0) {
          throw new ValidationError(
            "This listing isn't priced for day bookings yet (missing metadata.pricePerDay).",
          );
        }
        // Days defaults to 1 (Phase 6A frontend always sends 1; the helper
        // tolerates a multi-day field for future use). Cap at 30 to bound
        // accidental abuse — matches the RFC's recommended cap.
        const rawDays = notesParsed?.days;
        const days = rawDays == null ? 1 : Number(rawDays);
        if (!Number.isFinite(days) || days <= 0 || days > 30) {
          throw new ValidationError('days must be an integer between 1 and 30.');
        }
        // Closed-day fit — STRICT: every day of the rental must be a working
        // day ("closed means closed", same as blocked dates mid-range). A
        // driver who takes week-long engagements can simply open all seven
        // days. Listings without usable workingHours are exempt. Day rentals
        // have no "window too short" concept — only open vs closed matters.
        const start = new Date(`${input.scheduledDate}T00:00:00`);
        if (!Number.isNaN(start.getTime())) {
          for (let i = 0; i < Math.round(days); i += 1) {
            const d = new Date(start);
            d.setDate(d.getDate() + i);
            const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            if (transportWindowForDate(meta, iso) === 'closed') {
              throw new ValidationError(
                days > 1
                  ? `The driver isn't available on ${iso} — the rental range includes a non-working day.`
                  : "The driver isn't available on this date — pick a working day.",
              );
            }
          }
        }
        const subtotal = subtotalForTransportDayPaise({
          pricePerDayRupees,
          days: Math.round(days),
        });
        if (subtotal <= 0) {
          throw new ValidationError('Could not price this day booking.');
        }
        return subtotal;
      }

      if (category === 'driver-package') {
        if (!Array.isArray(meta.packageOptions) || meta.packageOptions.length === 0) {
          throw new ValidationError(
            "This listing isn't priced for package bookings yet (missing metadata.packageOptions).",
          );
        }
        const packageId = typeof notesParsed?.packageId === 'string' ? notesParsed.packageId : null;
        if (!packageId) {
          throw new ValidationError('Missing packageId in notes for package booking.');
        }
        const subtotal = subtotalForTransportPackagePaise({
          packageOptions: meta.packageOptions,
          packageId,
        });
        if (subtotal <= 0) {
          // Either the id didn't match any entry or the matched entry had
          // an invalid price. Either way, the frontend's package cache is
          // stale and the customer must reselect.
          throw new ValidationError('Selected package not found on this listing.');
        }
        // Packages book the WHOLE day (product decision) — the stated hours
        // are descriptive ("8-hour tour"), not a schedule window, so the only
        // calendar rule is: closed weekday → unbookable. The hold itself is
        // widened to a full-day window in `create` so it blocks (and is
        // blocked by) every other booking that day.
        if (transportWindowForDate(meta, input.scheduledDate) === 'closed') {
          throw new ValidationError("The driver isn't available on this date — pick a working day.");
        }
        return subtotal;
      }

      // Default: legacy prebook driver booking (driver-cab/auto/van/bike/tempo).
      // metadata is host-edited JSON; the helper Number()s whatever is there,
      // exactly as it did when meta was untyped.
      const perKmRupees = (meta.pricePerKm ?? 0) as number | string;
      let estimatedKm = 0;
      const km = Number(notesParsed?.estimatedKm);
      if (Number.isFinite(km) && km > 0) estimatedKm = km;
      return subtotalForTransportPrebookPaise({ perKmRupees, estimatedKm });
    }

    // Default: services. Use the listing's flat price. For listings priced
    // per_hour (metadata.pricingUnit === 'per_hour'), multiply by
    // notes.serviceHours so the hold total matches the agent's price preview.
    if (listing) {
      const svcMeta = listing.metadata && typeof listing.metadata === 'object'
        ? listing.metadata as Record<string, unknown>
        : {};
      const pricingUnit = typeof svcMeta.pricingUnit === 'string' ? svcMeta.pricingUnit.toLowerCase() : '';
      let notesParsed: Record<string, unknown> | null = null;
      try { notesParsed = input.notes ? JSON.parse(input.notes) : null; } catch { /* free text */ }

      let durationHours: number | undefined;
      if (pricingUnit === 'per_hour') {
        const raw = Number(notesParsed?.serviceHours);
        if (Number.isFinite(raw) && raw > 0 && raw <= 24) {
          durationHours = raw;
        } else {
          // No / invalid serviceHours on a per_hour service: fall back to 1
          // so the hold can still be created at a single-hour rate, matching
          // the previous behaviour. The preview tool refuses without hours,
          // so the assistant path never reaches here without a value.
          durationHours = 1;
        }
      }

      // Add-ons are optional sub-services the customer ticked on the booking
      // modal (e.g. "+ Beard trim ₹100" on a haircut). They stack additively
      // onto the base, are NOT multiplied by durationHours, and roll into
      // the same subtotal that platform fee + GST are computed against.
      // Ids may arrive either as a flat string[] (`addOnIds`) from agent
      // bookings or as the snapshot array (`addOns: [{id,label,price}]`)
      // that the booking modal currently posts — we accept both shapes.
      const rawIds: unknown = notesParsed?.addOnIds ?? notesParsed?.addOns;
      const selectedIds: string[] = Array.isArray(rawIds)
        ? rawIds
            .map((entry) => {
              if (typeof entry === 'string') return entry;
              if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') return (entry as { id: string }).id;
              return null;
            })
            .filter((v): v is string => !!v)
        : [];
      // Per-LISTING catalog: when the client picked a specific group from
      // metadata.servicesCatalog, resolve add-ons + base price from that group
      // ONLY. Falls back to the flat svcMeta.addOns + listing.price for legacy
      // listings (pre-catalog) and for pre-catalog bookings still in flight.
      const selectedCatalogId = typeof notesParsed?.selectedServiceCatalogId === 'string'
        ? notesParsed.selectedServiceCatalogId
        : null;
      const group = resolveServiceCatalogGroup(svcMeta, selectedCatalogId);
      const listingAddOns = group ? group.addOns : svcMeta.addOns;
      const basePriceRupees = group ? group.basePrice : listing.price;
      let addOnsRupees = 0;
      try {
        addOnsRupees = resolveServiceAddOns({
          listingAddOns,
          selectedIds,
          catalogVariants: svcMeta.servicesCatalog,
          baseVariantId: group?.id ?? selectedCatalogId ?? null,
        }).sumRupees;
      } catch (err) {
        throw new ValidationError((err as Error).message);
      }

      return subtotalForServicePaise({ priceRupees: basePriceRupees, durationHours, addOnsRupees });
    }
    return 0;
  }

  async createHold(input: CreateBookingInput, userId: string, opts: CreateHoldOptions = {}) {
    // Reject holds for past dates. The Zod schema only validates date *format*;
    // without this a self-service booking could land in the past, which pollutes
    // analytics/RFM rollups and can wrongly satisfy review eligibility (reviews
    // gate on a completed/past stay). Comparison is on the YYYY-MM-DD string,
    // lexicographically equivalent to chronological for ISO dates. The
    // on-behalf/admin path is exempt — a host recording a walk-up may backdate.
    if (!opts.onBehalf) {
      const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      if (input.scheduledDate < todayIST) {
        throw new ValidationError('Pick a future date.');
      }
      // Same-day time-slot bookings (services + hourly transport) can't start
      // in the past or within the lead-time buffer — a slot the customer sees
      // must still be honourable. Exemptions: stays / multi-day rentals (endDate
      // after scheduledDate — a late hotel check-in today is legitimate) and
      // whole-day transport (driver-day / driver-package book the whole day off a
      // nominal 09:00 start, so an afternoon booking is still valid). Mirrors the
      // client pickers' BOOKING_LEAD_MINUTES (src/lib/ist-time.ts, mobile
      // bookings.ts).
      const category = String(input.serviceCategory ?? '').toLowerCase();
      const wholeDayTransport = category === 'driver-day' || category === 'driver-package';
      const isSameDay = !input.endDate || input.endDate === input.scheduledDate;
      if (!wholeDayTransport && isSameDay && input.scheduledDate === todayIST && input.startTime) {
        const [h, m] = input.startTime.split(':').map(Number);
        const slotMin = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
        const istWall = new Date(Date.now() + 330 * 60_000);
        const nowMin = istWall.getUTCHours() * 60 + istWall.getUTCMinutes();
        if (slotMin < nowMin + SAME_DAY_LEAD_MINUTES) {
          throw new ValidationError(
            'That start time has already passed. Please choose a slot at least 30 minutes from now.',
          );
        }
      }
    }

    let providerId = input.providerId;
    // Whenever a listingId is supplied, load the listing once and reuse it
    // for everything downstream: provider fallback, coupon validation, and —
    // most importantly — server-authoritative pricing (computeHoldSubtotalPaise
    // needs listing rows for nightly rate, transport metadata, service price,
    // category, etc.). Previously we only loaded it when providerId was missing
    // OR a coupon was applied, so the common case (frontend sends both
    // providerId AND listingId, no coupon) left `listingResolved=null` and the
    // pricing helper fell through to subtotal=0, producing a wrong/rejected
    // hold.
    let listingResolved: pg.QueryResultRow | null = null;
    if (input.listingId) {
      const listingResult = await listingsRepository.getById(input.listingId);
      listingResolved = listingResult.rows[0] ?? null;
      if (!listingResolved) {
        throw new NotFoundError('Listing', input.listingId);
      }

      // Admin-banned/archived listings are not bookable through ANY path
      // (self-service, on-behalf, agent tools). The DB trigger
      // trg_reject_booking_on_banned_listing backstops this; failing here
      // gives the client a readable error instead of a 500.
      if (listingResolved.banned_at || listingResolved.archived_at) {
        throw new ValidationError('This listing is currently unavailable');
      }

      // Fill in provider id from the listing when the client didn't send one.
      if (!providerId) {
        providerId = listingResolved.provider_profile_id;
        if (!providerId) {
          const providerResult = await providersRepository.getByUserId(listingResolved.user_id);
          providerId = providerResult.rows[0]?.id;
        }
        if (!providerId) {
          throw new ValidationError('This listing is not bookable yet');
        }
      }
    }
    // Coupon validation needs the listing's host_user_id — same row.
    const listingForCoupon = listingResolved;

    if (!providerId) {
      throw new ValidationError('Provider is required');
    }

    // Tour packages + day rentals book the WHOLE day (product decision): the
    // hold spans the driver's working window for that date so it conflicts
    // with — and blocks — every other booking that day (every bookable slot
    // lives inside the window), AND the stored times are real, displayable
    // hours ("9:00 AM – 5:00 PM" on the booking card) instead of a fictional
    // client-sent range. Listings without working hours fall back to a
    // 00:00–23:59 hold for packages (displays as just "Full-day tour") and
    // the client-sent times for day rentals. Mutating `input` here means the
    // conflict check, the hold row, and the dedupe/lock keys below all see
    // the same window.
    if (input.serviceCategory === 'driver-package' || input.serviceCategory === 'driver-day') {
      const listingMeta = listingResolved?.metadata && typeof listingResolved.metadata === 'object'
        ? listingResolved.metadata as Record<string, unknown>
        : {};
      const win = transportWindowForDate(listingMeta, input.scheduledDate);
      const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      if (win && win !== 'closed') {
        input = { ...input, startTime: toHHMM(win.openMin), endTime: toHHMM(win.closeMin) };
      } else if (input.serviceCategory === 'driver-package') {
        input = { ...input, startTime: '00:00', endTime: '23:59' };
      }
    }

    // Coupons require a listing so we can verify the host relationship.
    if (input.couponCode && !input.listingId) {
      throw new ValidationError('Coupon codes can only be applied to listing bookings');
    }
    if (input.couponCode && !listingForCoupon) {
      throw new NotFoundError('Listing', String(input.listingId));
    }

    // Reject the booking if any night in the range is host-blocked. For
    // multi-night stays the range is [scheduledDate, endDate) — every
    // occupied night must be free of blocks. We check the room-level
    // override first (when a roomTypeId is given), falling back to the
    // listing-level override. Pricing override is enforced separately on
    // the client; the server's job here is the hard "is this date even
    // bookable" question.
    //
    // On-behalf holds SKIP this gate: the block belongs to the very partner
    // creating the booking, and the on-behalf calendars explicitly let them
    // book over their own blocks (struck-through but selectable). Real
    // conflicts (existing bookings) are still enforced below.
    if (input.listingId && !opts.onBehalf) {
      // For the override query, the inclusive end is endDate - 1 day (we
      // don't occupy the checkout night). For same-day bookings the range
      // collapses to a single date.
      const rangeStart = input.scheduledDate;
      const isMultiNight = !!input.endDate && input.endDate > input.scheduledDate;
      let rangeEnd = input.scheduledDate;
      if (isMultiNight) {
        const d = new Date(input.endDate + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() - 1);
        rangeEnd = d.toISOString().slice(0, 10);
      }
      const { availabilityOverridesRepository } = await import('../../listings/repositories/availability-overrides.repository.js');
      const overrides = await availabilityOverridesRepository.listForListing(
        input.listingId, rangeStart, rangeEnd,
      );
      const targetRoomId = input.roomTypeId ?? null;
      const blockingRow = overrides.rows.find((r) => {
        if (!r.blocked) return false;
        if (targetRoomId && r.room_type_id === targetRoomId) return true;
        if (!targetRoomId && r.room_type_id === null) return true;
        // A listing-level block applies to every room.
        if (targetRoomId && r.room_type_id === null) return true;
        return false;
      });
      if (blockingRow) {
        throw new ConflictError('This date is no longer available — the host has blocked it.');
      }

      // Host-dialog blocks: the web service/transport Schedule dialogs write
      // whole-day blocks to listings.metadata.blockedDates (the root
      // CLAUDE.md authoritative path), NOT availability_overrides. The
      // customer UIs grey these dates client-side, but until now nothing
      // enforced them at hold time — the assistant or a direct API call
      // could book straight over a driver's day off.
      const metaRaw = listingResolved?.metadata && typeof listingResolved.metadata === 'object'
        ? (listingResolved.metadata as Record<string, unknown>).blockedDates
        : null;
      const metaBlocked = new Set(
        Array.isArray(metaRaw) ? metaRaw.filter((d): d is string => typeof d === 'string') : [],
      );
      if (metaBlocked.size > 0) {
        const cur = new Date(`${rangeStart}T00:00:00Z`);
        for (let iso = rangeStart; iso <= rangeEnd && Number.isFinite(cur.getTime());) {
          if (metaBlocked.has(iso)) {
            throw new ConflictError('This date is no longer available — the host has blocked it.');
          }
          cur.setUTCDate(cur.getUTCDate() + 1);
          iso = cur.toISOString().slice(0, 10);
        }
      }
    }

    const cache = await getCacheProvider();
    const holdCacheKey = `${userId}:${providerId}:${input.scheduledDate}:${input.startTime}:${input.endTime}`;

    if (input.idempotencyKey) {
      const cachedResponse = await cache.getIdempotencyValue<{
        data: {
          booking: Record<string, unknown>;
          hold: { lockId: string; expiresAt: string };
        };
      }>(`booking:create:${userId}:${input.idempotencyKey}`);

      if (cachedResponse && cachedResponse.data?.booking) {
        return cachedResponse;
      }

      const existing = await bookingsRepository.findByIdempotencyKey(userId, input.idempotencyKey);
      if (existing.rows[0]) {
        const response = {
          data: {
            booking: existing.rows[0],
            hold: {
              lockId: existing.rows[0].id,
              expiresAt: existing.rows[0].hold_expires_at,
            },
          },
        };

        await cache.setIdempotencyValue(`booking:create:${userId}:${input.idempotencyKey}`, response, 300);
        return response;
      }
    }

    // The 3-pending cap is a per-guest abuse guard. A host booking for many
    // walk-up guests legitimately holds several slots at once, so skip it on
    // the on-behalf path (countPendingForUser already excludes these rows).
    if (!opts.onBehalf) {
      const pendingCount = await bookingsRepository.countPendingForUser(userId);
      if (parseInt(pendingCount.rows[0].count, 10) >= 3) {
        throw new ConflictError('You already have 3 pending bookings. Complete or cancel one before creating another.');
      }
    }

    // Geocode the job address so the smart-schedule algorithm can compute
    // real travel times between consecutive bookings. Best-effort: if the
    // client already supplied coords (e.g. from a map picker) we use those;
    // otherwise we attempt Nominatim with a 3 s timeout and continue with
    // null coords on failure — geocoding must never block a booking.
    let jobLat = input.lat;
    let jobLng = input.lng;
    if ((!jobLat || !jobLng) && input.address) {
      const geo = await geocodeAddress(input.address).catch(() => null);
      if (geo) {
        jobLat = geo.lat;
        jobLng = geo.lng;
        logger.info('booking: geocoded job address', { address: input.address, lat: geo.lat, lng: geo.lng });
      }
    }

    const lockKey = `booking:${providerId}:${input.scheduledDate}:${input.startTime}`;
    // TTL is bounded below by the pg statement_timeout (10s) plus handshake +
    // coupon consume + insert. Under RDS failover or contention the txn can
    // exceed 10s easily, so 30s gives headroom. The unique index on active
    // slots is still the final authority — the lock just avoids wasted work
    // and misleading 409s from both requests racing into the transaction.
    const lockId = await cache.acquireLock(lockKey, 30000);

    if (!lockId) {
      throw new ConflictError('This time slot is being booked by another user. Please try again.');
    }

    try {
      const bookingData = await dbTransaction(async (client) => {
        // Housekeeping + per-user guard all inside the transaction so the
        // audit trail is consistent: stale row cleanup is visible only if the
        // hold actually gets created, and a concurrent request for the same
        // (user, provider) pair can't observe half the cleanup.
        await bookingsRepository.expireStaleLocksForUser(userId, providerId, client);
        await bookingsRepository.expireStaleBookingsForUser(userId, providerId, client);

        // "One active hold per (user, provider)" is a per-guest guard against a
        // single customer squatting a slot. A host issuing multiple guest
        // payment links against the same listing must be exempt — the real
        // double-book protection is findConflictingBookingsForUpdate below.
        if (!opts.onBehalf) {
          const existingLock = await bookingsRepository.findActiveLockForUserProvider(userId, providerId, client);
          if (existingLock.rows[0]) {
            throw new ConflictError('You already have an active slot hold for this provider.');
          }
        }

        // Serialize all hold-create txns for this (provider, scheduledDate)
        // before doing the conflict read. Without this, two concurrent
        // overlapping windows on the same day (e.g. 09:00–11:00 and
        // 10:00–12:00) can both observe "no conflict" because neither row
        // exists yet, then both insert. See repository for the full
        // rationale on why FOR UPDATE alone doesn't suffice.
        //
        // For multi-night stays lock EVERY date in the window, not just the
        // endpoints. Two overlapping ranges always share at least one night
        // but need not share an endpoint (May 10–13 vs May 11–12), so
        // endpoint-only locking let both txns proceed, both saw "no
        // conflict" (neither row committed yet), and both inserted — a real
        // double-booking the per-(date,time) unique index can't catch
        // across different scheduled_dates. Dates are locked in ascending
        // order in every txn, so range locks can't deadlock each other.
        const lockDates: string[] = [input.scheduledDate];
        if (input.endDate && input.endDate !== input.scheduledDate) {
          const start = new Date(`${input.scheduledDate}T00:00:00Z`);
          const end = new Date(`${input.endDate}T00:00:00Z`);
          if (Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && end > start) {
            const nights = Math.round((end.getTime() - start.getTime()) / 86_400_000);
            // Backstop against absurd ranges turning into thousands of
            // advisory locks — nothing legitimate books a year-long window.
            if (nights > 370) {
              throw new ValidationError('Booking date range is too long.');
            }
            const cur = new Date(start);
            for (let i = 0; i < nights; i += 1) {
              cur.setUTCDate(cur.getUTCDate() + 1);
              lockDates.push(cur.toISOString().slice(0, 10));
            }
          } else {
            // Unparseable/inverted range — keep the legacy endpoint lock so
            // behavior degrades to the previous (still-serialized) shape.
            lockDates.push(input.endDate);
          }
        }
        for (const d of lockDates) {
          await bookingsRepository.acquireProviderDateAdvisoryLock(client, providerId, d);
        }

        const requestedRoomCount = Math.max(
          1,
          Math.round(Number(input.numberOfRooms) || 1),
        );
        const [conflictCheck, lockCheck] = await Promise.all([
          bookingsRepository.findConflictingBookingsForUpdate(
            client,
            providerId,
            input.scheduledDate,
            input.endTime,
            input.startTime,
            input.roomTypeId ?? null,
            input.endDate ?? null,
            // Per-listing scoping so a provider's other listings (a second
            // car, a different stylist) don't false-block the hold.
            input.listingId ?? null,
            requestedRoomCount,
          ),
          bookingsRepository.findActiveSlotLocksForUpdate(client, providerId, input.scheduledDate, input.endTime, input.startTime, userId),
        ]);

        if (conflictCheck.rows.length > 0) {
          // Name the actual overlapping window(s) so the Ista AI agent can
          // tell the customer WHY their pick failed — generic "no longer
          // available" forces a guessing loop. Hourly bookings carry
          // start_time/end_time; day/package bookings carry just the date.
          const fmt12 = (hhmm: string | null | undefined): string => {
            if (!hhmm) return '';
            const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm));
            if (!m) return String(hhmm).slice(0, 5);
            const h = Number(m[1]);
            const min = Number(m[2]);
            const period = h >= 12 ? 'PM' : 'AM';
            const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
            return min === 0 ? `${h12} ${period}` : `${h12}:${String(min).padStart(2, '0')} ${period}`;
          };
          const windows = conflictCheck.rows
            .slice(0, 3)
            .map((row) => {
              const s = fmt12(row.start_time);
              const e = fmt12(row.end_time);
              return s && e ? `${s}–${e}` : s || e || '';
            })
            .filter((w: string) => w.length > 0)
            .join(', ');
          const extras = conflictCheck.rows.length > 3 ? ` +${conflictCheck.rows.length - 3} more` : '';
          const detail = windows
            ? ` — driver is already booked ${windows}${extras} on this date. Pick a different window or another date.`
            : ' — driver is already booked on this date. Pick a different window or another date.';
          throw new ConflictError(`This time slot is no longer available${detail}`);
        }

        if (lockCheck.rows.length > 0) {
          throw new ConflictError('This slot is temporarily held by another user');
        }

        // ───────── Server-authoritative pricing ─────────
        // Compute the host subtotal from the listing/room/notes data we already
        // have, then resolve the coupon discount (which atomically locks the
        // coupon row + increments uses_count), then derive platform fee + GST
        // via the shared `applyFees` helper. The frontend may have sent
        // `input.agreedPrice` as a preview claim — we compare it to the
        // server-computed total below and reject on disagreement, but we never
        // persist anything the client supplied.
        const serverSubtotalPaise = await this.computeHoldSubtotalPaise(input, listingForCoupon);

        // For service bookings: rewrite notes.addOns with server-resolved
        // entries (id + label + canonical price) so the snapshot persisted on
        // the booking always reflects what the provider currently charges,
        // never a stale modal cache. The invoice + email read from this same
        // notes blob, so this is what keeps the receipt the customer sees
        // identical to what they were actually billed.
        if (
          listingForCoupon &&
          String((listingForCoupon as { listing_type?: string }).listing_type ?? '').toLowerCase() === 'service' &&
          typeof input.notes === 'string' &&
          input.notes.trim().startsWith('{')
        ) {
          try {
            const parsed = JSON.parse(input.notes);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              const rawIds = parsed.addOnIds ?? parsed.addOns;
              if (Array.isArray(rawIds) && rawIds.length > 0) {
                const ids: string[] = rawIds
                  .map((e: unknown) => (typeof e === 'string'
                    ? e
                    : (e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string' ? (e as { id: string }).id : null)))
                  .filter((v: string | null): v is string => !!v);
                const svcMeta = listingForCoupon.metadata && typeof listingForCoupon.metadata === 'object'
                  ? listingForCoupon.metadata as Record<string, unknown>
                  : {};
                const selectedCatalogId = typeof parsed.selectedServiceCatalogId === 'string'
                  ? parsed.selectedServiceCatalogId
                  : null;
                const group = resolveServiceCatalogGroup(svcMeta, selectedCatalogId);
                const listingAddOns = group ? group.addOns : svcMeta.addOns;
                const resolved = resolveServiceAddOns({
                  listingAddOns,
                  selectedIds: ids,
                  catalogVariants: svcMeta.servicesCatalog,
                  baseVariantId: group?.id ?? selectedCatalogId ?? null,
                });
                parsed.addOns = resolved.items;
                delete parsed.addOnIds;
                input.notes = JSON.stringify(parsed);
              }
            }
          } catch {
            // Notes weren't valid JSON or didn't carry add-ons — leave as-is.
          }
        }

        let couponId: string | null = null;
        let couponDiscountPaise = 0;
        if (input.couponCode && listingForCoupon) {
          const quote = await couponsService.consume(client, {
            code: input.couponCode,
            listingId: String(listingForCoupon.id),
            // Pass the listing's kind so the coupon's category scope (set
            // when created from the Provider / Transport dashboard) is
            // enforced at consume time — a transport coupon can't be
            // redeemed against a stay or service booking even if the same
            // host owns both kinds of listings.
            listingCategory: (listingForCoupon as { listing_type?: string }).listing_type ?? null,
            hostUserId: String(listingForCoupon.user_id),
            // Coupon discount is computed against the server's subtotal in
            // rupees — not the client's claimed total. This stops a tampered
            // client from over-discounting via a fixed coupon that's bigger
            // than the real subtotal.
            basePrice: serverSubtotalPaise / 100,
            // Enforces coupon_users targeting (platform coupons issued to
            // specific people).
            bookingUserId: userId,
          });
          couponId = quote.couponId;
          couponDiscountPaise = Math.round(quote.discountAmount * 100);
        }

        // GST rate threshold (>₹7,500/night → 18%) needs to see the per-room
        // rate on hotels — those have `listings.price_per_night IS NULL` and
        // store the nightly on `room_types.base_price_paise`. Falling back to
        // the listing rate would put luxury rooms in the 12% bucket while the
        // frontend preview shows 18%, blowing the ±₹2 createHold drift check.
        // Resolve the room once here and reuse it for the receipt snapshot
        // below so we don't double-fetch.
        let roomRowForPricing: { name: string | null; base_price_paise: number | null; quantity: number | null } | null = null;
        if (input.roomTypeId) {
          try {
            const rt = await roomTypesRepository.getById(input.roomTypeId);
            const row = rt.rows[0];
            if (row) {
              const paise = Number(row.base_price_paise);
              const qty = Number(row.quantity);
              roomRowForPricing = {
                name: typeof row.name === 'string' ? row.name : null,
                base_price_paise: Number.isFinite(paise) && paise > 0 ? paise : null,
                quantity: Number.isFinite(qty) && qty > 0 ? Math.round(qty) : null,
              };
            }
          } catch {
            roomRowForPricing = null;
          }
        }

        // Hard cap: a single booking can't claim more rooms than the host
        // configured for this room type. This guards the "I tried to book
        // 6 rooms in a 5-room sathram" case before the conflict check —
        // which only knows about overlapping bookings, not the host cap.
        if (roomRowForPricing?.quantity != null && requestedRoomCount > roomRowForPricing.quantity) {
          throw new ValidationError(
            `Only ${roomRowForPricing.quantity} ${roomRowForPricing.name ?? 'room'}${
              roomRowForPricing.quantity === 1 ? '' : 's'
            } available for this room type. Please reduce the room count.`,
          );
        }
        const nightlyHintPaise = roomRowForPricing?.base_price_paise != null
          ? roomRowForPricing.base_price_paise
          : (listingForCoupon?.price_per_night != null
              ? Math.round(Number(listingForCoupon.price_per_night) * 100)
              : null);
        // Platform fee comes from the admin fee-rules table (listing > city >
        // tier > state > global precedence), resolved against the LISTING's
        // geography. Falls back to the legacy flat fee on any resolution
        // problem, so this lookup can never block a hold.
        const resolvedFee = await feeRulesService.resolveForListingRow(
          listingForCoupon,
          input.serviceCategory ?? listingForCoupon?.category ?? null,
        );
        const breakdown: BookingPriceBreakdown = applyFees({
          subtotalPaise: serverSubtotalPaise,
          discountPaise: couponDiscountPaise,
          category: input.serviceCategory ?? listingForCoupon?.category ?? null,
          nightlyHintPaise,
          fee: resolvedFee.spec,
        });

        // Business commission (partner payout side), resolved from the same
        // rule table with audience='business' and snapshotted alongside the
        // customer fee. Frozen at hold time so a later rule change never
        // rewrites what the host earns on this booking. Computed on the
        // discounted subtotal — the host-side amount — NOT on the customer
        // total (fee + GST + insurance are the platform's, not the host's).
        // Doesn't touch what the customer pays; earnings surfaces render
        // gross − commission = net off it.
        const resolvedCommission = await feeRulesService.resolveForListingRow(
          listingForCoupon,
          input.serviceCategory ?? listingForCoupon?.category ?? null,
          'business',
        );
        const commissionPaise = resolvedCommission.rule
          ? computePlatformFeePaise(breakdown.discountedSubtotalPaise, resolvedCommission.spec)
          : null;

        const receiptSnapshot = receiptSnapshotFromNotes(input.notes);
        const roomTypeNameSnapshot: string | null = roomRowForPricing?.name
          && roomRowForPricing.name.trim() ? roomRowForPricing.name.trim() : null;

        // Transport-only: snapshot the booked vehicle's model / plate / colour
        // and the driver's phone onto the booking so post-booking surfaces (My
        // Bookings, confirmation screen, tax invoice) keep rendering the right
        // vehicle even after the host edits or removes the listing. Mirrors the
        // guest/room snapshot pattern above. Driver NAME isn't snapshotted —
        // it's already surfaced live as provider_name on every booking payload.
        let vehicleModelSnapshot: string | null = null;
        let vehiclePlateSnapshot: string | null = null;
        let vehicleColorSnapshot: string | null = null;
        let driverPhoneSnapshot: string | null = null;
        {
          const cat = String(input.serviceCategory ?? listingForCoupon?.category ?? '').toLowerCase();
          if (cat.startsWith('driver-') && listingForCoupon) {
            const rawMeta = (listingForCoupon as { metadata?: unknown }).metadata;
            const meta = rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta)
              ? rawMeta as Record<string, unknown>
              : {};
            const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
            vehicleModelSnapshot = str((listingForCoupon as { vehicle_name?: unknown }).vehicle_name)
              ?? str(meta.vehicleName);
            vehiclePlateSnapshot = str(meta.licensePlate);
            vehicleColorSnapshot = str(meta.vehicleColor);
            try {
              const contact = (await bookingsRepository.getDriverContact(providerId, client)).rows[0];
              driverPhoneSnapshot = str(contact?.driver_phone);
            } catch {
              // Contact lookup is best-effort — never block the hold on it.
            }
          }
        }

        // Validate the optional client claim. We allow ±₹2 drift to absorb
        // FP/locale differences in the frontend preview, but anything larger
        // means the client and server disagree about what the booking costs —
        // refuse rather than silently picking one side.
        if (typeof input.agreedPrice === 'number' && input.agreedPrice >= 0) {
          const claimedPaise = Math.round(input.agreedPrice * 100);
          if (Math.abs(claimedPaise - breakdown.totalPaise) > 200) {
            logger.warn('Booking hold price mismatch — client total disagrees with server total', {
              listingId: input.listingId,
              userId,
              clientPaise: claimedPaise,
              serverPaise: breakdown.totalPaise,
              drift: claimedPaise - breakdown.totalPaise,
            });
            throw new ValidationError(
              'Booking price has changed. Please refresh and try again.',
            );
          }
        }

        const holdInsert = await bookingsRepository.createPendingBookingHold(client, {
          providerId,
          scheduledDate: input.scheduledDate,
          endDate: input.endDate ?? null,
          startTime: input.startTime,
          endTime: input.endTime,
          userId,
          serviceCategory: input.serviceCategory,
          address: input.address,
          lat: jobLat,
          lng: jobLng,
          notes: input.notes,
          idempotencyKey: input.idempotencyKey,
          agreedPricePaise: breakdown.totalPaise,
          listingId: input.listingId,
          couponId,
          roomTypeId: input.roomTypeId ?? null,
          roomCount: requestedRoomCount,
          guestNameSnapshot: receiptSnapshot.guestName,
          guestCount: receiptSnapshot.guestCount,
          roomTypeNameSnapshot,
          vehicleModelSnapshot,
          vehiclePlateSnapshot,
          vehicleColorSnapshot,
          driverPhoneSnapshot,
          // Persist the forward breakdown so createOrder can copy these
          // values onto the payment row without re-deriving them. This is
          // what makes the invoice + email reconcile exactly to what the
          // booking modal showed and the server actually charged.
          //
          // We store the ORIGINAL (pre-discount) subtotal here, with the
          // discount as a separate column. The invoice/email then show:
          //   base cost (original subtotal)
          //   platform fee
          //   discount (− amount)
          //   GST (computed against subtotal − discount + platform fee)
          //   total = subtotal − discount + platform fee + GST
          // — which is what the customer actually paid, and reconciles to
          // amount_paise exactly without subtracting the discount twice.
          subtotalPaise: breakdown.subtotalPaise,
          platformFeePaise: breakdown.platformFeePaise,
          taxesPaise: breakdown.taxesPaise,
          discountPaise: breakdown.discountPaise,
          feeRuleId: resolvedFee.spec.ruleId ?? null,
          commissionRuleId: resolvedCommission.rule?.id ?? null,
          commissionPaise,
          // Same status='pending' + hold_expires_at as a self-service hold, so
          // the existing sweeper frees the slot when the guest doesn't pay.
          holdMinutes: opts.holdMinutes,
          bookedOnBehalf: opts.onBehalf ?? false,
          createdByUserId: opts.createdByUserId ?? null,
          guestContact: opts.guestContact ?? null,
        });

        // Redemption ledger (admin coupon console): same transaction as the
        // consume + hold insert, so a rolled-back hold leaves no phantom row.
        if (couponId) {
          await couponsService.recordRedemption(client, {
            couponId,
            bookingId: holdInsert.booking?.id ?? null,
            userId,
            discountPaise: couponDiscountPaise,
          });
        }

        return holdInsert;
      }).catch((error: unknown) => {
        if (this.isActiveSlotUniqueViolation(error)) {
          throw new ConflictError('This time slot was just taken. Please choose another slot.');
        }
        throw error;
      });

      await cache.del(`availability:${providerId}:${input.scheduledDate}`);
      // Drop ALL cached schedules for this date — a fresh hold makes any
      // previously-cached "available slots" response stale immediately.
      await cacheDelByPattern(`*schedule:*:${input.scheduledDate}:*`).catch(() => undefined);

      logAuditEvent({
        event: 'booking.hold_created',
        booking_id: bookingData.booking.id,
        user_id: userId,
        from_status: null,
        to_status: bookingData.booking.status,
      });

      const response = {
        data: {
          booking: bookingData.booking,
          hold: {
            lockId: bookingData.lock.id,
            expiresAt: bookingData.lock.expires_at,
          },
        },
      };

      const holdExpirySeconds = Math.max(
        1,
        Math.ceil((new Date(bookingData.lock.expires_at).getTime() - Date.now()) / 1000)
      );

      await cache.setBookingHold(holdCacheKey, response.data, holdExpirySeconds);
      if (input.idempotencyKey) {
        await cache.setIdempotencyValue(`booking:create:${userId}:${input.idempotencyKey}`, response, holdExpirySeconds);
      }

      return response;
    } finally {
      await cache.releaseLock(lockKey, lockId);
    }
  }

  async createBooking(input: CreateBookingInput, userId: string) {
    return this.createHold(input, userId);
  }

  /**
   * Host-books-on-behalf: a host creates a booking for a walk-up guest who has
   * no account, and the guest pays via a Razorpay Payment Link (QR / SMS).
   *
   * Flow: verify the host owns the listing's provider → create an ordinary
   * `pending` hold (long TTL, flagged `booked_on_behalf`, guest contact stored)
   * → mint a payment link for the server-authoritative total → persist the link
   * on the booking. The link's `payment_link.paid` webhook confirms the booking
   * later via the normal confirmation path.
   *
   * The booking's `user_id` is the guest's OWN account when their email/phone
   * matches an existing user (so the confirmed booking shows in their dashboard
   * and the confirmation is addressed to them); otherwise it falls back to the
   * host. `created_by_user_id` always records the host. Insurance/trip-protection
   * is excluded — the guest never opted in, and the link amount must equal the
   * booking's `agreed_price_paise` for pricing parity.
   */
  async createOnBehalf(
    input: CreateBookingInput,
    hostUserId: string,
    guest: OnBehalfGuest,
    opts: { actorRole?: 'host' | 'admin' } = {},
  ) {
    if (!input.listingId) {
      throw new ValidationError('A listing is required to book on behalf of a guest.');
    }

    // Authorization: the host must own the listing's provider profile.
    // Admin actors (behind requireRole('admin') at the route) may book on
    // behalf of a guest against ANY listing — support creating a booking for
    // a caller. Everything downstream (payment link, webhook confirm, guest
    // linking) is identical.
    const listingResult = await listingsRepository.getById(input.listingId);
    const listing = listingResult.rows[0];
    if (!listing) throw new NotFoundError('Listing', input.listingId);

    if (opts.actorRole !== 'admin') {
      const hostProviders = await providersRepository.getByUserId(hostUserId);
      const ownsListing = hostProviders.rows.some(
        (p) => String((p as { id?: string }).id) === String(listing.provider_profile_id),
      ) || String(listing.user_id) === String(hostUserId);
      if (!ownsListing) {
        throw new ForbiddenError('You can only create bookings for your own listings.');
      }
    }

    const paymentProvider = await getPaymentProvider();
    if (!paymentProvider.createPaymentLink) {
      throw new ValidationError('The configured payment gateway does not support payment links.');
    }

    // Link the booking to the guest's own account ONLY when both their email
    // AND phone match the same existing user, so the confirmed booking lands
    // in THEIR dashboard and the confirmation is addressed to them. Requiring
    // both prevents mis-linking on a phone collision or a typo'd email.
    // Best-effort — a lookup miss or failure just leaves the host as owner
    // (unchanged behaviour). Never link to the host's own account.
    let ownerUserId = hostUserId;
    try {
      const match = await usersRepository.findByEmailAndPhone(guest.email ?? null, guest.phone);
      const matchedUserId = match.rows[0]?.user_id ? String(match.rows[0].user_id) : null;
      if (matchedUserId && matchedUserId !== hostUserId) {
        ownerUserId = matchedUserId;
      }
    } catch (err) {
      logger.warn('on-behalf: guest account lookup failed; keeping host as owner', { err: String(err) });
    }

    const held = await this.createHold(input, ownerUserId, {
      onBehalf: true,
      holdMinutes: PAYMENT_LINK_TTL_MINUTES,
      guestContact: guest,
      createdByUserId: hostUserId,
    });

    const booking = held.data.booking as pg.QueryResultRow;
    const amountPaise = Number(booking.agreed_price_paise);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
      throw new ValidationError('Could not determine the booking amount for the payment link.');
    }

    const listingName = typeof listing.name === 'string' && listing.name.trim()
      ? listing.name.trim()
      : 'your stay';
    const callbackBase = config.app.frontendUrl?.replace(/\/+$/, '') || '';

    // The link should die WITH the hold. Razorpay's default link validity is
    // ~6 months while the hold sweeper expires the booking after 5 minutes —
    // an unexpired link would keep collecting money for a dead booking. The
    // adapter clamps expire_by to Razorpay's ≥15-min floor, so a guest CAN
    // still pay a just-expired hold in that window; the payment_link.paid
    // webhook auto-refunds those.
    const holdExpiresAt = booking.hold_expires_at ? new Date(booking.hold_expires_at) : null;
    const expireByEpochSec = holdExpiresAt && Number.isFinite(holdExpiresAt.getTime())
      ? Math.floor(holdExpiresAt.getTime() / 1000)
      : Math.floor(Date.now() / 1000) + PAYMENT_LINK_TTL_MINUTES * 60;

    const link = await paymentProvider.createPaymentLink({
      bookingId: String(booking.id),
      amountPaise,
      currency: 'INR',
      description: `Booking for ${listingName}`,
      customer: { name: guest.name ?? null, contact: guest.phone, email: guest.email ?? null },
      callbackUrl: callbackBase ? `${callbackBase}/booking/${booking.id}` : undefined,
      expireByEpochSec,
    });

    await bookingsRepository.setPaymentLink(String(booking.id), link.id, link.shortUrl);

    // Email the guest the pay link + a scannable QR PNG. Razorpay already
    // SMS-es the short URL (notify.sms), so this is the email channel of the
    // same nudge. Best-effort: a QR render or SES failure must never fail the
    // booking — the host still has the QR on screen.
    if (guest.email?.trim()) {
      const guestEmail = guest.email.trim();
      (async () => {
        const QRCode = (await import('qrcode')).default;
        const qrPng = await QRCode.toBuffer(link.shortUrl, { type: 'png', width: 512, margin: 2 });
        const { sendNotificationEmail } = await import('../../notifications/services/email.service.js');
        const whenStr = input.endDate && input.endDate !== input.scheduledDate
          ? `${input.scheduledDate} → ${input.endDate}`
          : input.scheduledDate;
        await sendNotificationEmail({
          toEmail: guestEmail,
          type: 'payment_link',
          data: {
            title: 'Complete your booking payment',
            message: `${guest.name?.trim() ? `Hi ${guest.name.trim()}, ` : ''}your booking at ${listingName} is reserved. Pay securely to confirm it.`,
            link: link.shortUrl,
            listing: listingName,
            date: whenStr,
            amount: `₹${(amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            bookingId: String(booking.id),
          },
          attachments: [{ filename: 'pay-qr.png', content: qrPng, contentType: 'image/png' }],
        });
      })().catch((err) => {
        logger.warn('on-behalf: payment-link email failed (booking unaffected)', {
          bookingId: String(booking.id),
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }

    logAuditEvent({
      event: 'booking.on_behalf_created',
      booking_id: String(booking.id),
      user_id: hostUserId,
      from_status: null,
      to_status: 'pending',
    });

    return {
      booking: { ...booking, payment_link_id: link.id, payment_link_url: link.shortUrl },
      paymentLink: { shortUrl: link.shortUrl, paymentLinkId: link.id },
    };
  }

  async releaseHold(bookingId: string, userId: string) {
    const bookingResult = await bookingsRepository.getAccessibleBookingById(bookingId, userId);
    const booking = bookingResult.rows[0];
    if (!booking) throw new NotFoundError('Booking', bookingId);
    if (booking.status !== 'pending') {
      return { data: booking };
    }

    const cache = await getCacheProvider();
    const result = await dbTransaction(async (client) => {
      await bookingsRepository.releaseHoldByBookingId(bookingId, userId, client);
      // A released hold is a booking that never reached `confirmed` — payment
      // didn't go through, or the user dismissed the flow. Use 'expired' so
      // host/provider dashboards (which filter expired out) don't surface
      // phantom "cancelled" rows for bookings the host never saw.
      const updated = await bookingsRepository.expireBooking(client, bookingId);
      return updated.rows[0];
    });

    await cache.del(`availability:${booking.provider_id}:${booking.scheduled_date}`);
    await cache.releaseBookingHold(`${userId}:${booking.provider_id}:${booking.scheduled_date}:${booking.start_time}:${booking.end_time}`);

    logAuditEvent({
      event: 'booking.hold_released',
      booking_id: bookingId,
      user_id: userId,
      from_status: booking.status,
      to_status: result.status,
    });

    return { data: result };
  }

  async confirmBooking(bookingId: string, params?: {
    client?: pg.PoolClient;
    paymentId?: string | null;
    userId?: string | null;
    skipCompletedPaymentCheck?: boolean;
  }) {
    const client = params?.client;
    const run = async (txn: pg.PoolClient) => {
      const current = await bookingsRepository.getByIdForUpdate(txn, bookingId);
      if (!current.rows[0]) throw new NotFoundError('Booking', bookingId);

      const booking = current.rows[0];
      if (booking.status === 'confirmed' || booking.status === 'completed') {
        return booking;
      }

      if (booking.status !== 'pending') {
        throw new ValidationError(`Cannot confirm booking from '${booking.status}' state`);
      }

      const paymentResult = await bookingsRepository.getCompletedPaymentSummary(bookingId, txn);
      if (!params?.skipCompletedPaymentCheck && !paymentResult.rows[0]) {
        throw new ValidationError('A completed payment is required before confirming this booking');
      }

      const result = await bookingsRepository.confirmBooking(txn, bookingId);
      const updated = result.rows[0] || booking;

      logAuditEvent({
        event: 'booking.confirmed',
        booking_id: bookingId,
        payment_id: params?.paymentId ?? paymentResult.rows[0]?.id ?? null,
        user_id: params?.userId ?? updated.user_id,
        from_status: booking.status,
        to_status: updated.status,
      });

      // Notify guest — booking confirmed. Deep-links into the guest dashboard
      // with `?booking=<id>` so the dashboard can auto-open the details modal,
      // and carries the listing/provider/amount metadata plus a full pricing
      // breakdown so the receipt email reconciles to the on-demand PDF invoice.
      const ctx = await loadNotificationContext(txn, bookingId);
      const listingLabel = ctx.listingName || updated.service_category?.replace(/-/g, ' ') || 'your booking';
      const dateRange = formatDateRange(updated.scheduled_date, ctx.checkOut);
      // `agreed_price_paise` is the booking's host-facing nightly/base total
      // — it excludes platform fee, GST and insurance. The receipt blocks
      // in both the host and guest emails want the "what the customer
      // actually paid" number, not the host's gross. We pull the proper
      // total below (after `storedBreakdown` is resolved) and overwrite
      // this fallback when a stored breakdown is available.
      const grossPaise = Number(updated.agreed_price_paise || 0);
      let amountPaidLabel = grossPaise > 0 ? formatRupees(grossPaise) : undefined;

      // Best-effort pricing breakdown for the email. Failures degrade the
      // email to the bare confirmation — they never block booking confirm.
      let pricing: ReturnType<typeof computePricingBreakdown> | null = null;
      // Hoisted so the email metadata block at the bottom can surface the
      // vendor's GSTIN even when pricing-breakdown computation throws.
      let gstin: string | null = null;
      try {
        let listingRow: pg.QueryResultRow | undefined;
        if (updated.listing_id) {
          const r = await txn.query(
            'SELECT category, listing_type, price_per_night, property_type, state FROM listings WHERE id = $1 LIMIT 1',
            [String(updated.listing_id)],
          );
          listingRow = r.rows[0];
        }
        if (updated.provider_id) {
          // The metadata column doesn't exist on the current schema — no
          // migration adds it. A plain try/catch around `SELECT metadata`
          // is NOT enough here: when the column is missing, postgres aborts
          // the entire transaction and the JS catch only swallows the JS
          // error, leaving the next query (releaseBookingLock) to crash
          // with "current transaction is aborted". Wrap in a SAVEPOINT so
          // the rollback is contained to this sub-query and the outer
          // verify-payment txn stays alive. Once a migration adds the
          // column, the gstin will just start populating.
          await txn.query('SAVEPOINT sp_metadata_lookup');
          try {
            const r = await txn.query(
              'SELECT metadata FROM provider_profiles WHERE id = $1 LIMIT 1',
              [String(updated.provider_id)],
            );
            gstin = r.rows[0]?.metadata?.gstin ? String(r.rows[0].metadata.gstin) : null;
            await txn.query('RELEASE SAVEPOINT sp_metadata_lookup');
          } catch {
            await txn.query('ROLLBACK TO SAVEPOINT sp_metadata_lookup');
          }
        }
        pricing = computePricingBreakdown(updated, listingRow, gstin);
      } catch (err) {
        logger.debug('pricing breakdown unavailable for email', { bookingId, err: String(err) });
      }

      // Look up the persisted fee breakdown — set at order creation. When
      // present we surface the platform fee + tax as separate lines so the
      // fare summary in the email reconciles to the invoice PDF. Falls back
      // to the inferred subtotal/tax pair from computePricingBreakdown for
      // legacy payments that pre-date the breakdown columns.
      //
      // `amount_paise` here is the GRAND TOTAL the customer was charged —
      // base + platform fee + GST − discount + INSURANCE. The booking's
      // `agreed_price_paise` excludes insurance (insurance is added at
      // createOrder, after the hold). Using payment.amount_paise for the
      // "Total Paid" line keeps the email reconciled to the invoice PDF,
      // which already uses payment.amount_paise via computeInvoiceLines.
      let storedBreakdown: { amount_paise: number; subtotal_paise: number; platform_fee_paise: number; taxes_paise: number; insurance_premium_paise: number; discount_paise: number; payment_method: string | null } | null = null;
      // SAVEPOINT-wrapped: if any of the breakdown columns are missing on a
      // legacy schema, Postgres aborts the WHOLE transaction. A bare JS
      // try/catch swallows the error here but the next query in the verify
      // flow (releaseBookingLock) would then fail with "current transaction
      // is aborted". The savepoint contains the rollback locally.
      await txn.query('SAVEPOINT sp_payment_breakdown');
      try {
        const r = await txn.query<{ amount_paise: string | number; subtotal_paise: string | number | null; platform_fee_paise: string | number | null; taxes_paise: string | number | null; insurance_premium_paise: string | number | null; discount_paise: string | number | null }>(
          `SELECT amount_paise, subtotal_paise, platform_fee_paise, taxes_paise, insurance_premium_paise, discount_paise
             FROM payments
            WHERE booking_id = $1 AND status = 'completed'
            ORDER BY completed_at DESC NULLS LAST, created_at DESC
            LIMIT 1`,
          [bookingId],
        );
        const pr = r.rows[0];
        if (pr && pr.subtotal_paise != null) {
          storedBreakdown = {
            amount_paise: Number(pr.amount_paise),
            subtotal_paise: Number(pr.subtotal_paise),
            platform_fee_paise: Number(pr.platform_fee_paise ?? 0),
            taxes_paise: Number(pr.taxes_paise ?? 0),
            insurance_premium_paise: Number(pr.insurance_premium_paise ?? 0),
            discount_paise: pr.discount_paise != null ? Number(pr.discount_paise) : 0,
            payment_method: null,
          };
        }
        await txn.query('RELEASE SAVEPOINT sp_payment_breakdown');
      } catch {
        await txn.query('ROLLBACK TO SAVEPOINT sp_payment_breakdown');
      }

      // Customer-facing fare lines use the ₹-prefixed Indian-style formatter
      // (₹1,000 / ₹1,234.50). The audit-grade `formatRupees` stays for the
      // pricing-breakdown footer line where reconciliation against the
      // INR-prefixed invoice line matters.
      // Total Paid is recomputed from the displayed line items, the same
      // way the invoice PDF does, instead of trusting `amount_paise` —
      // we hit a real bug where `amount_paise` lagged the insurance line
      // and the customer was shown ₹9.36 with an inline ₹2 insurance row
      // (true total ₹11.36). Recomputing keeps the receipt total and the
      // invoice total in lock-step across stays, services, and transport.
      const emailTotalPaise = (() => {
        if (storedBreakdown) {
          const subtotal = Number(storedBreakdown.subtotal_paise) || 0;
          const platformFee = Number(storedBreakdown.platform_fee_paise) || 0;
          const taxes = Number(storedBreakdown.taxes_paise) || 0;
          const insurance = Number(storedBreakdown.insurance_premium_paise) || 0;
          const discount = Number(storedBreakdown.discount_paise) || 0;
          return Math.max(0, subtotal - discount) + platformFee + taxes + insurance;
        }
        return pricing ? pricing.grossPaise : 0;
      })();

      // Promote the recomputed total into the receipt `Amount:` line used
      // by BOTH the guest and host emails. Previously this used
      // `agreed_price_paise` (gross host portion) and disagreed with the
      // line-by-line Fare Summary — the host saw ₹9.36 while the breakdown
      // summed to ₹11.36. With one canonical number, all three surfaces
      // (host receipt amount, guest receipt amount, invoice total) line up.
      if (emailTotalPaise > 0) {
        amountPaidLabel = formatRupees(emailTotalPaise);
      }

      // For services, extract the snapshotted add-ons from notes so the
      // Fare Summary in the email can list them under the base service
      // charge. Mirrors the invoice PDF treatment in invoice.service.ts.
      const serviceCategoryLower = (updated.service_category ?? '').toLowerCase();
      const looksLikeService =
        (ctx.listingType ?? '') === 'service'
        || (!serviceCategoryLower.startsWith('driver-')
            && !/hotel|homestay|stay/.test(serviceCategoryLower)
            && (ctx.listingType ?? '') !== 'stay'
            && (ctx.listingType ?? '') !== 'transport');
      let emailServiceAddOns: Array<{ label: string; price: number }> | undefined;
      if (looksLikeService) {
        try {
          const parsedNotes = updated.notes ? JSON.parse(String(updated.notes)) : null;
          if (parsedNotes && typeof parsedNotes === 'object' && Array.isArray(parsedNotes.addOns)) {
            const cleaned = parsedNotes.addOns
              .filter((a: unknown): a is Record<string, unknown> => !!a && typeof a === 'object')
              .map((a: Record<string, unknown>) => ({
                label: typeof a.label === 'string' ? a.label : '',
                price: Number(a.price ?? 0),
              }))
              .filter((a: { label: string; price: number }) => a.label.length > 0 && Number.isFinite(a.price) && a.price >= 0);
            if (cleaned.length > 0) emailServiceAddOns = cleaned;
          }
        } catch {
          // Notes wasn't JSON or didn't carry add-ons — no-op.
        }
      }

      const pricingLines = pricing && pricing.grossPaise > 0
        ? {
            subtotal: formatINR(storedBreakdown?.subtotal_paise ?? pricing.taxablePaise),
            gstLabel: pricing.interState
              ? `IGST @ ${(pricing.gst.rate * 100).toFixed(0)}%`
              : `CGST + SGST @ ${(pricing.gst.rate * 100).toFixed(0)}%`,
            gstAmount: formatINR(storedBreakdown?.taxes_paise ?? pricing.taxPaise),
            total: formatINR(emailTotalPaise),
            description: ctx.listingName || (updated.service_category ? String(updated.service_category).replace(/-/g, ' ') : 'Service'),
            // Drives the Fare Summary base-row label. When the customer
            // picked a specific catalog group (e.g. "Women's Haircut") the
            // email shows that instead of generic "Service charge", matching
            // the invoice + booking-confirmation hero. Parsed defensively
            // from notes here so the EmailPricingBreakdown is self-contained.
            serviceName: (() => {
              if (!looksLikeService) return undefined;
              try {
                const parsed = updated.notes ? JSON.parse(String(updated.notes)) : null;
                const name = parsed && typeof parsed === 'object' && typeof parsed.selectedServiceName === 'string'
                  ? parsed.selectedServiceName.trim()
                  : '';
                return name.length > 0 ? name : undefined;
              } catch {
                return undefined;
              }
            })(),
            platformFee: storedBreakdown && storedBreakdown.platform_fee_paise > 0
              ? formatINR(storedBreakdown.platform_fee_paise)
              : undefined,
            insurance: storedBreakdown && storedBreakdown.insurance_premium_paise > 0
              ? formatINR(storedBreakdown.insurance_premium_paise)
              : undefined,
            discount: storedBreakdown && storedBreakdown.discount_paise > 0
              ? formatINR(storedBreakdown.discount_paise)
              : undefined,
            ...(emailServiceAddOns && emailServiceAddOns.length > 0
              ? (() => {
                  const addOnsSumPaise = emailServiceAddOns!.reduce(
                    (sum, a) => sum + Math.round((a.price || 0) * 100),
                    0,
                  );
                  const fullSubPaise = Number(storedBreakdown?.subtotal_paise ?? pricing.taxablePaise) || 0;
                  const baseOnlyPaise = Math.max(0, fullSubPaise - addOnsSumPaise);
                  return {
                    baseChargeOnly: formatINR(baseOnlyPaise),
                    addOnItems: emailServiceAddOns!.map((a) => ({
                      label: a.label,
                      amount: formatINR(Math.round((a.price || 0) * 100)),
                    })),
                  };
                })()
              : {}),
          }
        : undefined;

      // Determine listing type up front — needed for both the guest's
      // "Provider" row decision (omitted for stays — a hotel guest doesn't
      // think in terms of a service provider) and to route the host email
      // to the right dashboard.
      const isStayBooking = (ctx.listingType ?? '') === 'stay'
        || (updated.service_category ?? '').toLowerCase().includes('hotel')
        || (updated.service_category ?? '').toLowerCase().includes('homestay')
        || (updated.service_category ?? '').toLowerCase().startsWith('stay');

      const isTransportBookingEarly = (updated.service_category ?? '').toLowerCase().startsWith('driver-');
      // Booking "kind" carried in notification metadata so the mobile app can
      // deep-link a tapped notification straight to the right booking-detail
      // screen (stay / service / transport).
      const bookingKind: 'stay' | 'service' | 'transport' = isStayBooking ? 'stay' : isTransportBookingEarly ? 'transport' : 'service';
      // Pull pickup/drop/etc. from the booking notes JSON early so both the
      // guest confirmation and the host new-booking email get the route.
      // Also surface the mode-derived booking details (hours / days / package)
      // and the booking's start/end times so the email and invoice both show
      // exactly what was reserved.
      let transportDetailsEarly: {
        pickup?: string;
        drop?: string;
        mode?: string;
        vehicleType?: string;
        estimatedKm?: number;
        passengers?: number;
        selectedSlots?: string[];
        durationHours?: number;
        days?: number;
        packageId?: string;
        packageName?: string;
      } = {};
      if (isTransportBookingEarly) {
        try {
          const parsed = updated.notes ? JSON.parse(updated.notes) : null;
          if (parsed && typeof parsed === 'object') {
            transportDetailsEarly = {
              pickup: typeof parsed.pickup === 'string' ? parsed.pickup : undefined,
              drop: typeof parsed.drop === 'string' ? parsed.drop : undefined,
              mode: typeof parsed.mode === 'string'
                ? parsed.mode
                : (typeof parsed.transportMode === 'string' ? parsed.transportMode : undefined),
              vehicleType: typeof parsed.vehicleType === 'string' ? parsed.vehicleType : undefined,
              estimatedKm: typeof parsed.estimatedKm === 'number' ? parsed.estimatedKm : undefined,
              passengers: typeof parsed.passengers === 'number' && parsed.passengers > 0 ? parsed.passengers : undefined,
              selectedSlots: Array.isArray(parsed.selectedSlots)
                ? parsed.selectedSlots.filter((s: unknown): s is string => typeof s === 'string')
                : undefined,
              durationHours: typeof parsed.durationHours === 'number' && parsed.durationHours > 0
                ? parsed.durationHours
                : undefined,
              days: typeof parsed.days === 'number' && parsed.days > 0 ? Math.round(parsed.days) : undefined,
              packageId: typeof parsed.packageId === 'string' ? parsed.packageId : undefined,
            };
          }
        } catch { /* notes may be free text */ }
        // Resolve the tour-package display name from the listing's
        // metadata.packageOptions so the email + invoice show the human
        // label ("Hyderabad Heritage Tour"), not the opaque package id.
        // Best-effort — failures fall back to the id below.
        if (transportDetailsEarly.packageId && updated.listing_id) {
          try {
            const lr = await txn.query<{ metadata: Record<string, unknown> | null }>(
              'SELECT metadata FROM listings WHERE id = $1 LIMIT 1',
              [String(updated.listing_id)],
            );
            const meta = (lr.rows[0]?.metadata as Record<string, unknown> | null) || null;
            const opts = meta && Array.isArray(meta.packageOptions) ? meta.packageOptions as Array<Record<string, unknown>> : [];
            const match = opts.find((p, i) => {
              const id = typeof p.id === 'string' ? p.id : `pkg-${i}`;
              return id === transportDetailsEarly.packageId;
            });
            const name = match && typeof match.name === 'string' ? match.name.trim() : '';
            if (name) transportDetailsEarly.packageName = name;
          } catch { /* leave packageName undefined — falls back to id */ }
        }
      }


      // Service-specific extras (location + duration) — pulled from notes JSON
      // the same way transport does it. Optional everywhere; rendered only
      // when present.
      const isServiceBookingEarly = !isStayBooking && !isTransportBookingEarly;
      let serviceDetailsEarly: { location?: string; duration?: string; selectedServiceName?: string; visitAddress?: string } = {};
      if (isServiceBookingEarly) {
        try {
          const parsed = updated.notes ? JSON.parse(updated.notes) : null;
          if (parsed && typeof parsed === 'object') {
            const hoursRaw = typeof parsed.hours === 'number' ? parsed.hours
              : (typeof parsed.serviceHours === 'number' ? parsed.serviceHours : undefined);
            const rawServiceName = typeof parsed.selectedServiceName === 'string'
              ? parsed.selectedServiceName.trim()
              : '';
            serviceDetailsEarly = {
              location: typeof parsed.location === 'string'
                ? parsed.location
                : (typeof parsed.address === 'string'
                    ? parsed.address
                    : (typeof parsed.serviceAddress === 'string' ? parsed.serviceAddress : undefined)),
              duration: typeof parsed.duration === 'string'
                ? parsed.duration
                : (typeof hoursRaw === 'number' && hoursRaw > 0
                    ? `${hoursRaw} hour${hoursRaw === 1 ? '' : 's'}`
                    : undefined),
              // Selected services-catalog group name (e.g. "Women's Haircut").
              // Surfaced on the confirmation email so multi-service listings
              // show the specific offering booked, mirroring the invoice and
              // host-dashboard treatment.
              selectedServiceName: rawServiceName.length > 0 ? rawServiceName : undefined,
              // Visit-provider: the shop address the customer travels to,
              // snapshotted server-side into the notes at prepare time (WS6 —
              // the public listing may withhold it, but a confirmed guest is
              // entitled to it, and the email is where it lands).
              visitAddress: parsed.serviceMode === 'visit-provider' && typeof parsed.visitAddress === 'string' && parsed.visitAddress.trim()
                ? parsed.visitAddress.trim()
                : undefined,
            };
          }
        } catch { /* notes may be free text */ }
      }

      // Build the rich Booking Details payload that drives the MMT-style
      // confirmation email layout. Stays get check-in/out + room type;
      // transport gets pickup/drop; services fall back to the date row.
      const checkInDateOnly = updated.scheduled_date ? String(updated.scheduled_date).slice(0, 10) : undefined;
      const checkOutDateOnly = ctx.checkOut ? String(ctx.checkOut).slice(0, 10) : undefined;
      const nights = (() => {
        if (!isStayBooking || !checkInDateOnly || !checkOutDateOnly) return undefined;
        const ms = new Date(`${checkOutDateOnly}T00:00:00`).getTime() - new Date(`${checkInDateOnly}T00:00:00`).getTime();
        const n = Math.round(ms / (1000 * 60 * 60 * 24));
        return n > 0 ? n : undefined;
      })();
      // Default check-in 3 PM / check-out 12 PM for stays — matches the
      // standard hotel convention and what guests see on their receipt.
      const checkInTime = isStayBooking ? '03:00 PM' : (updated.start_time ? String(updated.start_time).slice(0, 5) : undefined);
      const checkOutTime = isStayBooking ? '12:00 PM' : undefined;
      const bookedOn = new Date(ctx.bookedOn ?? updated.created_at ?? Date.now()).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });

      sendNotificationAsync({
        userId: updated.user_id,
        type: 'booking_confirmed',
        title: 'Booking Confirmed ✅',
        message: isStayBooking
          ? `Your reservation at ${listingLabel} (${dateRange}) is confirmed. Below are the details of your confirmed reservation.`
          : `Your booking at ${listingLabel} for ${dateRange} is confirmed. See you soon!`,
        link: `/bookings?booking=${bookingId}`,
        channels: [...PUSH_CHANNELS],
        metadata: {
          bookingId,
          kind: bookingKind,
          // Use the full date range so the summary table matches the body
          // ("Tue, 12 May → Wed, 13 May" for multi-night stays, single day
          // for services / one-night stays).
          date: dateRange,
          listingName: ctx.listingName ?? undefined,
          // Stays: omit the "Provider" field — the listing name already
          // names the property and "Provider: <pp.display_name>" leaks the
          // host's provider-profile label (often a generic / multi-listing
          // name like "Super Cleanings") into a guest hotel receipt.
          providerName: isStayBooking ? undefined : (ctx.providerName ?? undefined),
          amount: amountPaidLabel,
          pricing: pricingLines,
          // MMT-style booking details — the email template renders these
          // when present and falls back gracefully when they aren't.
          guestName: ctx.guestName ?? undefined,
          hotelAddress: isStayBooking ? (ctx.hotelAddress ?? undefined) : undefined,
          // Stays AND services — a visit-provider booking whose host never
          // gave a street address needs the "Getting there" note too (the
          // rule returns true for at-home/online/transport, so those never
          // render it). Was stay-gated, which left the service email silent
          // while the dashboard showed the warning.
          hasExactAddress: (isStayBooking || isServiceBookingEarly) ? ctx.hasExactAddress : undefined,
          checkInDate: isStayBooking ? checkInDateOnly : undefined,
          checkInTime,
          checkOutDate: isStayBooking ? checkOutDateOnly : undefined,
          checkOutTime,
          nights,
          guestCount: ctx.guestCount ?? undefined,
          roomType: isStayBooking ? (ctx.roomType ?? undefined) : undefined,
          roomCount: isStayBooking ? (ctx.roomCount ?? undefined) : undefined,
          cancellationPolicyText: describeCancellationPolicy(ctx.cancellationPolicy, checkInDateOnly),
          bookedOn,
          // Transport routing details — present for driver bookings, undefined otherwise.
          serviceType: isTransportBookingEarly
            ? `Transport · ${(transportDetailsEarly.vehicleType || updated.service_category || 'driver').toString().replace(/^driver-/, '')}`
            : undefined,
          pickup: transportDetailsEarly.pickup,
          drop: transportDetailsEarly.drop,
          estimatedKm: transportDetailsEarly.estimatedKm,
          // Vehicle identity (booking-time snapshot) + driver contact (live
          // host name/phone) so the rider can spot the car and reach the
          // driver straight from the confirmation email.
          vehicleModel: isTransportBookingEarly ? ((updated.vehicle_model_snapshot as string | null) ?? undefined) : undefined,
          vehicleColor: isTransportBookingEarly ? ((updated.vehicle_color_snapshot as string | null) ?? undefined) : undefined,
          licensePlate: isTransportBookingEarly ? ((updated.vehicle_plate_snapshot as string | null) ?? undefined) : undefined,
          driverName: isTransportBookingEarly ? (ctx.driverName ?? undefined) : undefined,
          driverPhone: isTransportBookingEarly ? (ctx.driverPhone ?? undefined) : undefined,
          // Mode-specific transport details — render only when present so
          // hourly/day/package each surface their own row in the email +
          // invoice (and pricing match: hourly shows hours, day shows days,
          // package shows the package name).
          transportMode: isTransportBookingEarly ? transportDetailsEarly.mode : undefined,
          transportHours: isTransportBookingEarly ? transportDetailsEarly.durationHours : undefined,
          transportDays: isTransportBookingEarly ? transportDetailsEarly.days : undefined,
          transportPackage: isTransportBookingEarly
            ? (transportDetailsEarly.packageName || transportDetailsEarly.packageId)
            : undefined,
          // Booking time slot — non-stays only. Stays already surface
          // checkInTime/checkOutTime above; services + transport want the
          // start/end time the customer actually reserved on the slot strip.
          bookingStartTime: !isStayBooking && updated.start_time ? String(updated.start_time).slice(0, 5) : undefined,
          bookingEndTime: !isStayBooking && updated.end_time ? String(updated.end_time).slice(0, 5) : undefined,
          // Service-specific routing details — render only when present.
          serviceLocation: isServiceBookingEarly ? serviceDetailsEarly.location : undefined,
          serviceDuration: isServiceBookingEarly ? serviceDetailsEarly.duration : undefined,
          selectedServiceName: isServiceBookingEarly ? serviceDetailsEarly.selectedServiceName : undefined,
          // Visit-provider only — NEVER set for stays (the template infers
          // isStay from hotelAddress; this field renders a "Where to go" row
          // in the service branch instead).
          visitAddress: isServiceBookingEarly ? serviceDetailsEarly.visitAddress : undefined,
          // Transport: passenger count + the customer-picked slots from
          // the day-strip. Both render only when present so non-transport
          // bookings stay unchanged.
          passengers: isTransportBookingEarly ? transportDetailsEarly.passengers : undefined,
          selectedSlots: isTransportBookingEarly ? transportDetailsEarly.selectedSlots : undefined,
          // Tax-identifier surfacing. Provider GSTIN comes from the SAVEPOINT
          // metadata lookup above; platform GSTIN from app config.
          providerGstin: gstin ?? undefined,
          platformGstin: config.app.platformGstin
            ? String(config.app.platformGstin).trim() || undefined
            : undefined,
          // Payment method — surfaced as a "Paid via X" line below the fare summary.
          paymentMethod: storedBreakdown?.payment_method ?? undefined,
        },
      });

      // Notify the property side — new booking. Stay listings route to the
      // host dashboard, transport to the transport dashboard, services to
      // the partner dashboard.
      const category = String(updated.service_category || '').toLowerCase();
      const isTransportBooking = category.startsWith('driver-');
      const providerDashboardPath = isStayBooking ? 'host' : isTransportBooking ? 'transport' : 'partner';
      const guestLabel = ctx.guestName ? `Guest ${ctx.guestName}` : 'A guest';

      // Pull transport-specific bits out of the notes JSON so the email
      // summary names the trip instead of just saying "Listing: <name>".
      // Notes is JSON-encoded by TransportBooking.tsx with shape
      // { transport:true, mode, pickup, drop, vehicleType, ... }.
      let transportDetails: { pickup?: string; drop?: string; mode?: string; vehicleType?: string; estimatedKm?: number } = {};
      if (isTransportBooking) {
        try {
          const parsed = updated.notes ? JSON.parse(updated.notes) : null;
          if (parsed && typeof parsed === 'object') {
            transportDetails = {
              pickup: typeof parsed.pickup === 'string' ? parsed.pickup : undefined,
              drop: typeof parsed.drop === 'string' ? parsed.drop : undefined,
              mode: typeof parsed.mode === 'string' ? parsed.mode : undefined,
              vehicleType: typeof parsed.vehicleType === 'string' ? parsed.vehicleType : undefined,
              estimatedKm: typeof parsed.estimatedKm === 'number' ? parsed.estimatedKm : undefined,
            };
          }
        } catch { /* notes may be free text */ }
      }

      // Service-type label that gives the email subject line meaning —
      // "Stay booking", "Transport: cab", "Cleaning service", etc.
      const serviceTypeLabel = isStayBooking
        ? 'Stay booking'
        : isTransportBooking
          ? `Transport · ${(transportDetails.vehicleType || updated.service_category || 'driver').toString().replace(/^driver-/, '')}`
          : (updated.service_category ? String(updated.service_category).replace(/-/g, ' ') : 'Service booking');

      sendNotificationAsync({
        // `updated` is a raw bookings row — it has NO provider_user_id column
        // (that alias only exists on the accessible-booking SELECTs). Keying
        // the notification to provider_id (a provider_profiles id) writes the
        // bell row to a nonexistent user and finds no FCM tokens, so the host
        // never saw new-booking notifications. ctx resolves the real user id.
        userId: ctx.providerUserId ?? updated.provider_user_id ?? updated.provider_id,
        type: 'new_booking',
        title: 'New Booking 🎉',
        message: `${guestLabel} booked ${listingLabel} for ${dateRange}.`,
        link: `/dashboard/${providerDashboardPath}?booking=${bookingId}`,
        channels: [...PUSH_CHANNELS],
        // Carry the listing name + date + guest name + service type + price
        // so the email's summary table is meaningful instead of generic.
        metadata: {
          bookingId,
          kind: bookingKind,
          listingName: ctx.listingName ?? listingLabel,
          serviceType: serviceTypeLabel,
          date: dateRange,
          guestName: ctx.guestName ?? undefined,
          amount: amountPaidLabel,
          // Transport bookings carry pickup/drop so the provider sees
          // exactly where they're being asked to go.
          pickup: transportDetails.pickup,
          drop: transportDetails.drop,
          estimatedKm: transportDetails.estimatedKm,
          mode: transportDetails.mode,
        },
      });

      // Seed a provider→guest "booking confirmed" chat message so the thread
      // is discoverable in Messages and the in-chat Call button has a booking
      // to gate on. Best-effort + idempotent + its own DB connection — grouped
      // here with the other post-confirm side effects.
      void seedBookingConfirmationMessage(bookingId);

      // Emit the funnel's tail event server-side (reliable regardless of which
      // client confirmed) so the nightly rollup can compute views→booking.
      trackServerEvent('booking_confirmed', {
        userId: updated.user_id,
        listingId: updated.listing_id ? String(updated.listing_id) : null,
        listingType: bookingKind,
        source: 'server_confirm',
        // GMV + geo + provider identity for the admin dashboard. revenuePaise is
        // the grand total the customer paid (base + fees + tax + insurance −
        // discount). city drives Geographic demand; providerUserId → active
        // providers.
        props: {
          revenuePaise: emailTotalPaise,
          city: ctx.listingCity ?? undefined,
          providerUserId: ctx.providerUserId ?? (updated.provider_user_id as string | undefined) ?? undefined,
        },
      });

      // Invalidate smart schedule and availability caches so the confirmed slot
      // is immediately excluded from future scheduling queries.
      try {
        const cache = await getCacheProvider();
        await cache.del(`availability:${booking.provider_id}:${booking.scheduled_date}`);
        // Drop ALL category caches for the date — booking confirmations on
        // one category change provider availability across categories too.
        await cacheDelByPattern(`*schedule:*:${booking.scheduled_date}:*`);
      } catch {
        // Cache invalidation is best-effort; the 60s TTL is a safety net.
      }

      return updated;
    };

    return client ? run(client) : dbTransaction(run);
  }

  async updateStatus(
    bookingId: string,
    status: BookingStatus,
    userId?: string,
    actorRole?: 'guest' | 'host' | 'provider' | 'admin',
    adminOpts?: { refundMode?: 'policy' | 'full'; cancellationReason?: CancellationReason },
  ) {
    if (!userId) throw new ForbiddenError('Authenticated user required');

    // Ownership check: only the guest or the provider on the booking may
    // touch it. Admin actors (behind requireRole('admin') at the route)
    // bypass ownership — they can cancel any booking, nothing else.
    const accessible = actorRole === 'admin'
      ? await bookingsRepository.getBookingByIdForAdmin(bookingId)
      : await bookingsRepository.getAccessibleBookingById(bookingId, userId);
    if (!accessible.rows[0]) throw new NotFoundError('Booking', bookingId);

    const booking = accessible.rows[0];
    const isGuest = booking.user_id === userId;
    const isProvider = booking.provider_user_id === userId;

    // `expired` is an internal-only transition driven by the sweeper; clients can't request it.
    if (status === 'expired') {
      throw new ForbiddenError('expired is an internal transition');
    }

    // Per-role transition matrix. Guests may only cancel; provider owns the rest of the lifecycle.
    const guestTransitions: Record<string, BookingStatus[]> = {
      pending: ['cancelled'],
      confirmed: ['cancelled'],
      in_progress: [],
      completed: [],
      cancelled: [],
      expired: [],
    };
    const providerTransitions: Record<string, BookingStatus[]> = {
      pending: ['confirmed', 'cancelled'],
      confirmed: ['in_progress', 'cancelled'],
      in_progress: ['completed', 'cancelled'],
      completed: [],
      cancelled: [],
      expired: [],
    };

    // Admins may only CANCEL (any pre-terminal state, including in_progress —
    // support intervenes mid-service when something went badly wrong). All
    // other lifecycle transitions stay with the provider.
    const adminTransitions: Record<string, BookingStatus[]> = {
      pending: ['cancelled'],
      confirmed: ['cancelled'],
      in_progress: ['cancelled'],
      completed: [],
      cancelled: [],
      expired: [],
    };

    const matrix = actorRole === 'admin'
      ? adminTransitions
      : isProvider ? providerTransitions : isGuest ? guestTransitions : null;
    if (!matrix) throw new ForbiddenError('Not authorized to modify this booking');

    const allowed = matrix[booking.status] || [];
    if (!allowed.includes(status)) {
      throw new ValidationError(`Cannot transition from '${booking.status}' to '${status}'`);
    }

    const cache = await getCacheProvider();
    let cancelRefundPaise = 0; // captured for the booking_cancelled analytics event
    const result = await dbTransaction(async (client) => {
      if (status === 'cancelled') {
        const completedPayment = await bookingsRepository.getCompletedPaymentSummary(bookingId, client);
        if (completedPayment.rows[0]) {
          const paymentRow = completedPayment.rows[0];
          const ctx = await bookingsRepository.getCancellationContext(bookingId, client);
          const policy: CancellationPolicy = (ctx.rows[0]?.cancellation_policy as CancellationPolicy) || 'flexible';
          const breakdown = paymentBreakdownFromRow(paymentRow);
          // When a user is both guest and host of a booking (self-test or
          // host-of-own-listing scenario) the cancel is happening through the
          // guest dashboard — treat them as guest so the audit reason matches
          // intent. Refund math is identical for flexible; differs for
          // moderate/strict where guests are subject to the time window.
          const refund = computeCancellationRefund({
            breakdown,
            policy,
            // Admin cancels use host semantics — the guest is never penalized
            // for a platform-initiated cancellation.
            cancelledBy: actorRole === 'admin' ? 'host' : isGuest ? 'guest' : 'host',
            scheduledStartIso: scheduledStartIso(ctx.rows[0]),
            cancelledAtIso: new Date().toISOString(),
          });
          // Support override: refund everything the guest paid (incl. the
          // trip-protection premium), regardless of policy math. Only
          // reachable through the admin cancel endpoint.
          if (actorRole === 'admin' && adminOpts?.refundMode === 'full') {
            refund.refundPaise = breakdown.totalPaise;
            refund.hostKeepsPaise = 0;
            refund.platformKeepsPaise = 0;
            refund.insuranceVoided = true;
            refund.reason = 'Full refund issued by IstaSeva support.';
          }
          cancelRefundPaise = refund.refundPaise;

          const { paymentsService } = await import('../../payments/index.js');
          // Refund failure must NOT block the cancellation. Razorpay can fail
          // for transient reasons (network, test-mode mock payments, mismatch
          // in payment_id) — the guest still gets a clean cancel and admin
          // resolves the refund out-of-band via the audit log below. With
          // proper prod keys the refund normally succeeds; this is the safety
          // net for everything else.
          try {
            await paymentsService.refundCompletedBooking({
              bookingId,
              paymentId: paymentRow.id,
              userId: userId ?? booking.user_id,
              client,
              refundPaise: refund.refundPaise,
              refundReasonDetail: refund.reason,
              voidInsurance: refund.insuranceVoided,
            });
          } catch (err) {
            const reason = err instanceof Error ? err.message : 'Unknown refund error';
            logger.error('Refund failed during cancel — proceeding with cancellation', {
              bookingId,
              paymentId: paymentRow.id,
              error: reason,
            });
            logAuditEvent({
              event: 'booking.cancel_refund_failed',
              booking_id: bookingId,
              user_id: userId ?? booking.user_id,
              payment_id: paymentRow.id,
              metadata: { error: reason, refundPaise: refund.refundPaise, policy },
            });
          }
        }

        await bookingsRepository.releaseHoldByBookingId(bookingId, booking.user_id, client);
      }

      return bookingsRepository.updateStatus(bookingId, status, client, adminOpts?.cancellationReason);
    });

    if (status === 'cancelled') {
      // A cancelled PENDING on-behalf booking still has a live Razorpay
      // payment link — cancel it so the guest can't pay a dead booking.
      // Best-effort: if the guest pays in the race window anyway, the
      // payment_link.paid webhook's dead-booking path auto-refunds.
      if (booking.booked_on_behalf && booking.status === 'pending' && booking.payment_link_id) {
        try {
          const paymentProvider = await getPaymentProvider();
          await paymentProvider.cancelPaymentLink?.(String(booking.payment_link_id));
        } catch (err) {
          logger.warn('cancel: payment-link cancel failed (paid-after-dead webhook path is the backstop)', {
            bookingId,
            paymentLinkId: String(booking.payment_link_id),
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await cache.del(`availability:${booking.provider_id}:${booking.scheduled_date}`);
      await cache.releaseBookingHold(`${booking.user_id}:${booking.provider_id}:${booking.scheduled_date}:${booking.start_time}:${booking.end_time}`);
      // Cancellation frees a slot — invalidate the schedule cache so the
      // freed window appears in subsequent searches.
      await cacheDelByPattern(`*schedule:*:${booking.scheduled_date}:*`).catch(() => undefined);
      // Analytics: cancellation + refund amount (0 when nothing was charged).
      // `reason` is the guest's categorical pick; host/provider/assistant
      // cancels don't collect one and land as 'unspecified'.
      trackServerEvent('booking_cancelled', {
        userId: userId ?? booking.user_id,
        listingId: booking.listing_id ? String(booking.listing_id) : null,
        source: 'server_cancel',
        props: { refundPaise: cancelRefundPaise, reason: adminOpts?.cancellationReason ?? 'unspecified' },
      });
    }

    logAuditEvent({
      event: `booking.${status}`,
      booking_id: bookingId,
      user_id: userId ?? booking.user_id,
      from_status: booking.status,
      to_status: result.rows[0]?.status ?? status,
    });

    // Notify on key status transitions. Use a fresh client (cheap query) since
    // the cancel transaction has already committed; descriptive copy needs
    // listing + actor context that the booking row alone doesn't carry.
    if (status === 'cancelled' || status === 'completed') {
      try {
        const { pool } = await import('../../../common/db/postgres.js');
        const client = await pool.connect();
        try {
          const ctx = await loadNotificationContext(client, bookingId);
          const listingLabel = ctx.listingName || booking.service_category?.replace(/-/g, ' ') || 'your booking';
          const dateRange = formatDateRange(booking.scheduled_date, ctx.checkOut);
          const isStayBooking = (ctx.listingType ?? '') === 'stay'
            || (booking.service_category ?? '').toLowerCase().includes('hotel')
            || (booking.service_category ?? '').toLowerCase().includes('homestay')
            || (booking.service_category ?? '').toLowerCase().startsWith('stay');
          // Carried in notification metadata for mobile deep-linking (see the
          // confirmation-notification path for the same field).
          const bookingKind: 'stay' | 'service' | 'transport' = isStayBooking
            ? 'stay'
            : (booking.service_category ?? '').toLowerCase().startsWith('driver-') ? 'transport' : 'service';
          const providerDashboardPath = isStayBooking ? 'host' : 'partner';
          // Provider-side actor label depends on whether they hold a host or
          // partner role. We default to "Host" for stays, "Partner" for
          // services/transport. The `actorRole` hint from the controller is
          // authoritative when present.
          const providerRoleLabel = actorRole === 'provider'
            ? 'Partner'
            : actorRole === 'host'
              ? 'Host'
              : isStayBooking ? 'Host' : 'Partner';

          if (status === 'cancelled' && actorRole === 'admin') {
            // Platform-initiated cancel: both sides get support-attributed
            // copy — neither party "cancelled on" the other.
            sendNotificationAsync({
              userId: booking.user_id,
              type: 'booking_cancelled',
              title: 'Booking Cancelled',
              message: `IstaSeva support cancelled your booking at ${listingLabel} for ${dateRange}. Any payment will be refunded shortly.`,
              link: `/bookings?booking=${bookingId}`,
              channels: [...PUSH_CHANNELS],
              metadata: { bookingId, kind: bookingKind },
            });
            sendNotificationAsync({
              userId: booking.provider_user_id ?? booking.provider_id,
              type: 'booking_cancelled',
              title: 'Booking Cancelled',
              message: `IstaSeva support cancelled ${listingLabel} for ${dateRange}.`,
              link: `/dashboard/${providerDashboardPath}?booking=${bookingId}`,
              channels: [...PUSH_CHANNELS],
              metadata: { bookingId, kind: bookingKind },
            });
          } else if (status === 'cancelled') {
            // The actor's label leads the message: "Host Jane cancelled …" /
            // "Guest Jane cancelled …". When same user is both host & guest
            // (dev/staging), the explicit `actorRole` resolves the ambiguity.
            const resolvedActor: 'guest' | 'provider' = actorRole === 'guest'
              ? 'guest'
              : actorRole === 'host' || actorRole === 'provider'
                ? 'provider'
                : isProvider ? 'provider' : 'guest';

            const guestLabel = ctx.guestName ? `Guest ${ctx.guestName}` : 'Your guest';
            const providerLabel = ctx.providerName ? `${providerRoleLabel} ${ctx.providerName}` : `Your ${providerRoleLabel.toLowerCase()}`;

            if (resolvedActor === 'guest') {
              // Notify provider side: "Guest <name> cancelled <listing> for <range>."
              sendNotificationAsync({
                userId: booking.provider_user_id ?? booking.provider_id,
                type: 'booking_cancelled',
                title: 'Booking Cancelled',
                message: `${guestLabel} cancelled ${listingLabel} for ${dateRange}.`,
                link: `/dashboard/${providerDashboardPath}?booking=${bookingId}`,
                channels: [...PUSH_CHANNELS],
                metadata: { bookingId, kind: bookingKind },
              });
              // Confirm to the guest themselves: clear, neutral copy.
              sendNotificationAsync({
                userId: booking.user_id,
                type: 'booking_cancelled',
                title: 'Booking Cancelled',
                message: `Your booking at ${listingLabel} for ${dateRange} has been cancelled. Any payment will be refunded shortly.`,
                link: `/bookings?booking=${bookingId}`,
                channels: [...PUSH_CHANNELS],
                metadata: { bookingId, kind: bookingKind },
              });
            } else {
              // Provider cancelled — guest gets the actor-attributed message;
              // provider gets a neutral "you cancelled" confirmation so it
              // lands in their feed too.
              sendNotificationAsync({
                userId: booking.user_id,
                type: 'booking_cancelled',
                title: 'Booking Cancelled',
                message: `${providerLabel} cancelled ${listingLabel} for ${dateRange}. Any payment will be refunded shortly.`,
                link: `/bookings?booking=${bookingId}`,
                channels: [...PUSH_CHANNELS],
                metadata: { bookingId, kind: bookingKind },
              });
              sendNotificationAsync({
                userId: booking.provider_user_id ?? booking.provider_id,
                type: 'booking_cancelled',
                title: 'Booking Cancelled',
                message: `You cancelled ${listingLabel} for ${dateRange}.`,
                link: `/dashboard/${providerDashboardPath}?booking=${bookingId}`,
                channels: [...PUSH_CHANNELS],
                metadata: { bookingId, kind: bookingKind },
              });
            }
          } else if (status === 'completed') {
            sendNotificationAsync({
              userId: booking.user_id,
              type: 'booking_completed',
              title: 'Service Completed ⭐',
              message: `Hope you enjoyed ${listingLabel}! Leave a review to help others.`,
              link: `/bookings?booking=${bookingId}&review=1`,
              channels: [...PUSH_CHANNELS],
              metadata: { bookingId, kind: bookingKind },
            });
          }
        } finally {
          client.release();
        }
      } catch (err) {
        logger.warn('booking status notification context failed', {
          bookingId,
          status,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { data: result.rows[0] };
  }

  async expirePendingBooking(bookingId: string, client?: pg.PoolClient) {
    const current = await bookingsRepository.getById(bookingId, client);
    if (!current.rows[0] || current.rows[0].status !== 'pending') {
      return current.rows[0] ?? null;
    }

    const result = client
      ? await bookingsRepository.expireBooking(client, bookingId)
      : await dbTransaction(async (txn) => bookingsRepository.expireBooking(txn, bookingId));

    logAuditEvent({
      event: 'booking.expired',
      booking_id: bookingId,
      user_id: current.rows[0].user_id,
      from_status: current.rows[0].status,
      to_status: result.rows[0]?.status ?? 'expired',
    });

    if (result.rows[0]) {
      const booking = result.rows[0];
      const cache = await getCacheProvider();
      await cache.releaseBookingHold(`${booking.user_id}:${booking.provider_id}:${booking.scheduled_date}:${booking.start_time}:${booking.end_time}`);
    }

    return result.rows[0] ?? null;
  }

  async runExpiredHoldCleanup() {
    return dbTransaction(async (client) => {
      const result = await bookingsRepository.cleanupExpiredHolds(client);
      return result.rows[0]?.cleaned ?? null;
    });
  }

  async getInternalBooking(bookingId: string, client?: pg.PoolClient) {
    const result = client
      ? await bookingsRepository.getByIdForUpdate(client, bookingId)
      : await bookingsRepository.getById(bookingId);
    if (!result.rows[0]) throw new NotFoundError('Booking', bookingId);
    return result.rows[0];
  }
}

export const bookingsService = new BookingsService();
