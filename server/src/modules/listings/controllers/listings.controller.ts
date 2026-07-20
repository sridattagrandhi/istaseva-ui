import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { listingsService } from '../services/listings.service.js';
import { roomTypesService } from '../services/room-types.service.js';
import { availabilityOverridesService } from '../services/availability-overrides.service.js';
import { parseLimit } from '../../../common/http/pagination.js';
import { requireUuidParam } from '../../../common/http/uuid-param.js';
import { NotFoundError, ValidationError } from '../../../common/errors/app-error.js';
import { bookingsRepository } from '../../bookings/repositories/bookings.repository.js';
import { feeRulesService } from '../../payments/services/fee-rules.service.js';
import { listingsRepository } from '../repositories/listings.repository.js';
import { approximateListingGeo, markGeoExact } from '../services/listing-geo-privacy.js';

type TaxonomyType = 'stay' | 'service' | 'transport';

// New-listing payloads always carry a `category` plus a display name (the
// frontend contract in src/domains/listings/listing.service.ts requires
// `{ category, name }`; stays send `title`). Enforce that minimum here so an
// empty/garbage body can't create a null-named, uncategorized row — the rest
// of the payload is passed through untouched for the service to normalize.
// Exported: the admin create-for-user endpoint enforces the same minimum.
export const createListingSchema = z
  .object({
    category: z.string().trim().min(1, 'category is required'),
    name: z.string().trim().optional(),
    title: z.string().trim().optional(),
  })
  .passthrough()
  .refine((d) => Boolean(d.name) || Boolean(d.title), {
    message: 'name or title is required',
  });

/**
 * Normalize a pg `date` column value to a YYYY-MM-DD string.
 *
 * pg's default parser returns DATE values as JS `Date` objects (midnight in
 * the server's local timezone). Doing `String(d).slice(0,10)` on a Date
 * silently produces `"Wed May 27"` (the toString form), not `"2026-05-27"`.
 * The transport/service-bookings endpoints used to do exactly that, which
 * broke the frontend's `bookingsByDate.get(date)` lookup — every booking
 * map key was a weekday header instead of an iso date, so the calendar
 * rendered all-free and the conflict check never fired.
 *
 * Using `toISOString().slice(0,10)` would re-introduce a different bug: if
 * the host server's TZ is anywhere west of UTC, the local-midnight Date
 * shifts to the previous calendar day in UTC. So we read the local
 * year/month/day off the Date directly, matching how pg constructed it.
 */
function toIsoDate(value: unknown): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value ?? '').slice(0, 10);
}

export class ListingsController {
  /** GET /api/listings/taxonomy?type=<stay|service|transport>
   *  Returns the distinct categories + subcategories that show up on
   *  active listings of the requested type. The frontend filter dialog
   *  uses this so the chip list reflects published reality rather than
   *  a hard-coded preset. Defaults to "service" because that's the only
   *  type with truly open-ended subcategories. */
  async taxonomy(req: Request, res: Response, next: NextFunction) {
    try {
      const raw = String(req.query.type || 'service').toLowerCase();
      const type: TaxonomyType =
        raw === 'stay' || raw === 'transport' ? (raw as TaxonomyType) : 'service';
      const data = await listingsRepository.distinctTaxonomy(type);
      res.json({ data: { ...data, type } });
    } catch (err) { next(err); }
  }

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const { type, cursor } = req.query;
      const hoursRaw = req.query.availableWithinHours;
      const hours = typeof hoursRaw === 'string' ? Number(hoursRaw) : NaN;
      // Optional stay date-range filter. Only accept well-formed YYYY-MM-DD and
      // a positive-length range; the repository ignores anything else too.
      const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
      const fromRaw = typeof req.query.from === 'string' && ISO_DATE.test(req.query.from) ? req.query.from : undefined;
      const toRaw = typeof req.query.to === 'string' && ISO_DATE.test(req.query.to) ? req.query.to : undefined;
      const dateRangeValid = fromRaw && toRaw && toRaw > fromRaw;
      res.json(await listingsService.listPublic({
        type: typeof type === 'string' ? type : undefined,
        limit: parseLimit(req.query.limit),
        cursor: typeof cursor === 'string' ? cursor : undefined,
        availableWithinHours: Number.isFinite(hours) && hours > 0 ? hours : undefined,
        from: dateRangeValid ? fromRaw : undefined,
        to: dateRangeValid ? toRaw : undefined,
      }));
    } catch (err) {
      next(err);
    }
  }

  async mine(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await listingsService.listForUser(req.user!.id));
    } catch (err) {
      next(err);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const listingId = requireUuidParam(req.params.id);
      const result = await listingsService.getById(listingId);
      // Admin-banned/archived listings exist only for their owner (dashboard
      // shows the notice) and admins; everyone else gets the same 404 as a
      // deleted row so the enforcement isn't probeable.
      const row = result.data;
      if ((row.banned_at || row.archived_at) && req.user?.id !== row.user_id && req.user?.role !== 'admin') {
        throw new NotFoundError('Listing', String(req.params.id));
      }
      // Geo privacy (B1): exact street address + coordinates go only to the
      // owner, admins, and guests with a real booking. Everyone else gets an
      // approximate location. Homestay addresses are host HOME addresses.
      res.json({ ...result, data: await this.applyGeoPrivacy(row, req) });
    } catch (err) {
      next(err);
    }
  }

  /** Decide exact-vs-approximate geo for a single listing row + viewer. */
  private async applyGeoPrivacy(row: Record<string, unknown>, req: Request) {
    const viewerId = req.user?.id;
    const isOwner = viewerId && viewerId === row.user_id;
    const isAdmin = req.user?.role === 'admin';
    if (isOwner || isAdmin) return markGeoExact(row);
    if (viewerId) {
      const hasBooking = await bookingsRepository.userHasActiveBookingForListing(
        viewerId,
        String(row.id),
      );
      if (hasBooking.rows[0]) return markGeoExact(row);
    }
    return approximateListingGeo(row);
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = createListingSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));
      }
      res.status(201).json(await listingsService.create(req.user!.id, parsed.data as Record<string, unknown>));
    } catch (err) {
      next(err);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await listingsService.update(String(req.params.id), req.user!.id, req.body as Record<string, unknown>));
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/listings/:id/fee-quote?subtotalPaise=NNN
   *
   * Server-resolved platform fee for a hypothetical booking of this listing
   * (admin fee-rules panel: listing > city > tier > state > global). Public
   * like the listing itself — it exposes nothing the checkout screen won't
   * show anyway. `subtotalPaise` is the DISCOUNTED subtotal the fee's
   * percentage component applies to.
   */
  async feeQuote(req: Request, res: Response, next: NextFunction) {
    try {
      const subtotalPaise = Math.max(0, Math.round(Number(req.query.subtotalPaise) || 0));
      const quote = await feeRulesService.quoteForListing(
        requireUuidParam(req.params.id),
        subtotalPaise,
      );
      // Flat body (no {success,data} envelope) — the web api-client wraps
      // the whole body as `data`, so an envelope here would double-nest.
      res.json(quote);
    } catch (err) {
      next(err);
    }
  }

  async bookedDates(req: Request, res: Response, next: NextFunction) {
    try {
      const roomTypeId = typeof req.query.roomTypeId === 'string' ? req.query.roomTypeId : undefined;
      const result = await bookingsRepository.listBookedDatesForListing(String(req.params.id), roomTypeId);
      res.json({ dates: result.rows.map((r: { date: string }) => r.date) });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/listings/:id/room-availability?roomTypeId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
   *
   * Returns the host's configured `quantity` for the room type and the
   * minimum number of rooms still available across the requested night
   * range. Drives the customer modal's "How many rooms?" stepper cap so
   * the picker can't go past what's actually free before submit.
   *
   * Public — same access posture as `bookedDates`. Returns `{ quantity: 0,
   * remaining: 0 }` when the room type doesn't exist so callers degrade to
   * "can't book" rather than crashing.
   */
  async roomAvailability(req: Request, res: Response, next: NextFunction) {
    try {
      const listingId = String(req.params.id);
      const roomTypeId = typeof req.query.roomTypeId === 'string' ? req.query.roomTypeId : '';
      const from = typeof req.query.from === 'string' ? req.query.from : '';
      const to = typeof req.query.to === 'string' ? req.query.to : '';
      if (!roomTypeId || !from || !to) {
        res.json({ quantity: 0, remaining: 0 });
        return;
      }
      const result = await bookingsRepository.getRoomTypeAvailability(listingId, roomTypeId, from, to);
      const row = result.rows[0];
      res.json({
        quantity: row?.quantity ?? 0,
        remaining: row?.remaining ?? 0,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/listings/:id/transport-bookings?from=YYYY-MM-DD&to=YYYY-MM-DD
   *
   * Returns active driver-* bookings (pending hold, confirmed, in-progress)
   * for the listing's provider in the requested window. The customer-facing
   * booking modal uses this to grey out unavailable time ranges before the
   * user submits — turning the backend's createHold-time conflict error
   * into an upfront "you can't book this slot" UI.
   *
   * Scoped by provider (not listing) because a driver/vehicle can only be at
   * one place at a time even if they advertise multiple listings.
   */
  async transportBookings(req: Request, res: Response, next: NextFunction) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const end = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
      const from = typeof req.query.from === 'string' ? req.query.from : today;
      const to = typeof req.query.to === 'string' ? req.query.to : end;

      const listingResult = await listingsRepository.getById(String(req.params.id));
      const listing = listingResult.rows[0] as Record<string, unknown> | undefined;
      if (!listing) {
        res.json({ data: [] });
        return;
      }
      // Match the booking row by EITHER provider_profile_id or the listing
      // itself. The previous version short-circuited to empty when
      // provider_profile_id was null (some legacy listings have no
      // resolved provider link) — which meant the driver's schedule
      // dialog showed every slot as free even when bookings existed
      // against the listing. We now hand both IDs to the repo and let it
      // OR-match.
      const providerId = typeof listing.provider_profile_id === 'string'
        ? listing.provider_profile_id
        : null;
      const listingId = String(listing.id ?? req.params.id);

      const result = await bookingsRepository.listTransportBookingsForProvider(providerId, listingId, from, to);
      res.json({
        data: result.rows.map((r) => ({
          id: r.id,
          // PG DATE columns can arrive as Date objects (pg's default parser
          // for `date`) OR as strings depending on driver config. We MUST
          // normalize to YYYY-MM-DD: the frontend uses this as a Map key
          // when matching the user's selected date to existing bookings.
          // The previous `String(r.scheduled_date).slice(0,10)` returned
          // `"Wed May 27"` for Date objects (because String(Date) is the
          // toString() form), which never matched the iso key the client
          // computes — so the calendar rendered all-free and the conflict
          // notice never fired, even when a real booking existed.
          scheduledDate: toIsoDate(r.scheduled_date),
          startTime: typeof r.start_time === 'string' ? r.start_time.slice(0, 5) : r.start_time,
          endTime: typeof r.end_time === 'string' ? r.end_time.slice(0, 5) : r.end_time,
          serviceCategory: r.service_category,
          status: r.status,
        })),
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/listings/:id/service-bookings?from=YYYY-MM-DD&to=YYYY-MM-DD
   *
   * Same shape and intent as `transport-bookings`, but for service listings.
   * Used by the customer booking modal to grey out already-taken time slots
   * so users can't pick a window the provider has been committed to. The
   * row is identified by provider_id OR listing_id (legacy rows sometimes
   * lack one or the other).
   */
  async serviceBookings(req: Request, res: Response, next: NextFunction) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const end = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
      const from = typeof req.query.from === 'string' ? req.query.from : today;
      const to = typeof req.query.to === 'string' ? req.query.to : end;

      const listingResult = await listingsRepository.getById(String(req.params.id));
      const listing = listingResult.rows[0] as Record<string, unknown> | undefined;
      if (!listing) {
        res.json({ data: [] });
        return;
      }
      const providerId = typeof listing.provider_profile_id === 'string'
        ? listing.provider_profile_id
        : null;
      const listingId = String(listing.id ?? req.params.id);

      const result = await bookingsRepository.listServiceBookingsForProvider(providerId, listingId, from, to);
      res.json({
        data: result.rows.map((r) => ({
          id: r.id,
          // See comment in transportBookings above: pg's `date` parser returns
          // a Date object whose toString() gives "Wed May 27 2026 ...", so
          // String(...).slice(0,10) silently produces "Wed May 27" instead
          // of the iso "2026-05-27" the client uses as a Map key.
          scheduledDate: toIsoDate(r.scheduled_date),
          startTime: typeof r.start_time === 'string' ? r.start_time.slice(0, 5) : r.start_time,
          endTime: typeof r.end_time === 'string' ? r.end_time.slice(0, 5) : r.end_time,
          serviceCategory: r.service_category,
          status: r.status,
        })),
      });
    } catch (err) {
      next(err);
    }
  }

  async readiness(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({
        data: await listingsService.getReadiness(String(req.params.id), req.user!.id),
      });
    } catch (err) { next(err); }
  }

  async listRoomTypes(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await roomTypesService.listForListing(String(req.params.id)));
    } catch (err) { next(err); }
  }

  async createRoomType(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(201).json(await roomTypesService.create(
        String(req.params.id), req.user!.id, req.body as Record<string, unknown>,
      ));
    } catch (err) { next(err); }
  }

  async updateRoomType(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await roomTypesService.update(
        String(req.params.id), String(req.params.roomId), req.user!.id, req.body as Record<string, unknown>,
      ));
    } catch (err) { next(err); }
  }

  async deleteRoomType(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await roomTypesService.delete(
        String(req.params.id), String(req.params.roomId), req.user!.id,
      ));
    } catch (err) { next(err); }
  }

  async listAvailability(req: Request, res: Response, next: NextFunction) {
    try {
      // Default window: today through 90 days out.
      const today = new Date().toISOString().slice(0, 10);
      const end = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
      const from = typeof req.query.from === 'string' ? req.query.from : today;
      const to = typeof req.query.to === 'string' ? req.query.to : end;
      res.json(await availabilityOverridesService.listForListing(String(req.params.id), from, to));
    } catch (err) { next(err); }
  }

  async setAvailability(req: Request, res: Response, next: NextFunction) {
    try {
      const body = (req.body || {}) as { entries?: unknown[] };
      const entries = Array.isArray(body.entries) ? body.entries : [];
      // bulkSet validates each entry (date/blocked/pricePaise) itself; the
      // cast just names the service's own (unexported) input type.
      res.json(await availabilityOverridesService.bulkSet(
        String(req.params.id), req.user!.id,
        entries as Parameters<typeof availabilityOverridesService.bulkSet>[2],
      ));
    } catch (err) { next(err); }
  }
}

export const listingsController = new ListingsController();
