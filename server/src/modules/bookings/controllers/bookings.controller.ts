import { Request, Response, NextFunction } from 'express';
import { bookingsService } from '../services/bookings.service.js';
import { invoiceService } from '../services/invoice.service.js';
import { bookingIntentService } from '../services/booking-intent.service.js';
import { bookingStatusSchema, createBookingSchema, createOnBehalfRequestSchema, prepareBookingRequestSchema } from '../schemas/booking.schema.js';
import { cancellationReasonSchema } from '../schemas/cancellation-reasons.js';
import type { PrepareBookingIntentInput } from '../services/booking-notes.js';
import { ValidationError } from '../../../common/errors/app-error.js';
import { parseLimit, parsePage } from '../../../common/http/pagination.js';
import { requireUuidParam } from '../../../common/http/uuid-param.js';

export class BookingsController {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const { status, page, limit, scope } = req.query;
      // Dashboards (guest, host/stays, provider, transport) all consume this
      // endpoint and render the full list in one scroll — there's no UI
      // pagination yet, and capping at MAX_LIMIT=100 silently dropped older
      // rows so the Completed tab looked empty. Raise the cap here (the only
      // caller that needs it) instead of the global default.
      const response = await bookingsService.listForUser({
        userId: req.user!.id,
        status,
        page: parsePage(page),
        limit: parseLimit(limit, { def: 1000, max: 1000 }),
        scope: scope === 'provider' ? 'provider' : 'user',
      });
      res.json(response);
    } catch (err) {
      next(err);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const response = await bookingsService.getById(requireUuidParam(req.params.id), req.user!.id);
      res.json(response);
    } catch (err) {
      next(err);
    }
  }

  // GET /api/bookings/relationship?peerUserId=X — powers the in-chat Call
  // button + roles subtitle. Returns { hasActiveBooking, phone, roles } for
  // the signed-in user relative to the chat peer.
  async getRelationship(req: Request, res: Response, next: NextFunction) {
    try {
      const peerUserId = String(req.query.peerUserId ?? '').trim();
      if (!peerUserId) {
        throw new ValidationError('peerUserId is required');
      }
      const data = await bookingsService.getPeerCallRelationship(req.user!.id, peerUserId);
      res.json(data);
    } catch (err) {
      next(err);
    }
  }

  async cancelPreview(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await bookingsService.previewCancellation(String(req.params.id), req.user!.id);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = createBookingSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      const response = await bookingsService.createHold(parsed.data, req.user!.id);
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/bookings/on-behalf — a host creates a booking for a walk-up guest
   * who has no account. Returns the booking plus a Razorpay Payment Link
   * (QR / SMS) the guest uses to pay. Ownership is enforced in the service.
   */
  async createOnBehalf(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = createOnBehalfRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      const { guest, ...input } = parsed.data;
      const response = await bookingIntentService.prepareOnBehalf(
        input as PrepareBookingIntentInput & { scheduledDate: string },
        req.user!.id,
        guest,
      );
      res.status(201).json({ data: response });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Unified prepare-booking: hold + Razorpay order + result in one call, the
   * same path the chat assistant uses. The client renders the returned payload
   * in a Confirm & Pay card / launches checkout — no second round trip.
   */
  async prepare(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = prepareBookingRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      const result = await bookingIntentService.prepare(
        parsed.data as PrepareBookingIntentInput & { scheduledDate: string },
        req.user!.id,
      );
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async releaseHold(req: Request, res: Response, next: NextFunction) {
    try {
      const response = await bookingsService.releaseHold(String(req.params.id), req.user!.id);
      res.json(response);
    } catch (err) {
      next(err);
    }
  }

  async updateStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = bookingStatusSchema.safeParse(req.body.status);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      // Optional `as` hint disambiguates whose action this is when the same
      // user wears multiple hats (own host + own guest in dev/staging).
      // Notification copy uses it to attribute the cancel correctly.
      const asRaw = typeof req.body?.as === 'string' ? req.body.as.toLowerCase() : '';
      const actorRole: 'guest' | 'host' | 'provider' | undefined =
        asRaw === 'host' || asRaw === 'provider' || asRaw === 'guest' ? asRaw : undefined;

      // Optional categorical cancellation reason — the guest UI sends one;
      // host/provider dashboards and the assistant cancel path don't, so
      // absence is fine (invalid values are rejected, not coerced).
      let cancellationReason;
      if (req.body?.cancellationReason !== undefined) {
        const parsedReason = cancellationReasonSchema.safeParse(req.body.cancellationReason);
        if (!parsedReason.success) throw new ValidationError(parsedReason.error.message);
        cancellationReason = parsedReason.data;
      }

      const response = await bookingsService.updateStatus(String(req.params.id), parsed.data, req.user!.id, actorRole, { cancellationReason });
      res.json(response);
    } catch (err) {
      next(err);
    }
  }

  async downloadInvoice(req: Request, res: Response, next: NextFunction) {
    try {
      const { pdf, filename } = await invoiceService.render(String(req.params.id), req.user!.id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', String(pdf.length));
      res.end(pdf);
    } catch (err) {
      next(err);
    }
  }
}

export const bookingsController = new BookingsController();
