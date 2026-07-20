import { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../../../common/errors/app-error.js';
import { bookingIntentService } from '../../bookings/services/booking-intent.service.js';
import { createOnBehalfRequestSchema } from '../../bookings/schemas/booking.schema.js';
import type { PrepareBookingIntentInput } from '../../bookings/services/booking-notes.js';
import { adminActionsService } from '../services/admin-actions.service.js';
import { adminBookingsService } from '../services/admin-bookings.service.js';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Comma-separated multi-select param → trimmed, capped string list. */
export function strList(value: unknown, max = 50): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim().slice(0, 100))
    .filter(Boolean)
    .slice(0, max);
  return items.length ? items : undefined;
}

export class AdminBookingsController {
  async search(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const onBehalf = str(req.query.bookedOnBehalf);
      const { rows, total } = await adminBookingsService.search({
        bookingId: str(req.query.bookingId),
        userQuery: str(req.query.user),
        listingId: str(req.query.listingId),
        status: str(req.query.status),
        bookedOnBehalf: onBehalf === 'true' ? true : onBehalf === 'false' ? false : undefined,
        from: str(req.query.from),
        to: str(req.query.to),
        states: strList(req.query.states),
        cities: strList(req.query.cities),
        types: strList(req.query.types),
        categories: strList(req.query.categories),
        providerIds: strList(req.query.providerIds),
        limit,
        offset,
      });
      res.json({ bookings: rows, total, limit, offset });
    } catch (err) { next(err); }
  }

  async detail(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await adminBookingsService.detail(String(req.params.id)));
    } catch (err) { next(err); }
  }

  /**
   * POST /api/admin/bookings/on-behalf — support books for a guest against
   * ANY listing. Identical to the host flow (Razorpay payment link, webhook
   * confirm) except the ownership check is bypassed and the action is
   * recorded in admin_actions.
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
        { actorRole: 'admin' },
      );

      await adminActionsService.record({
        actorUserId: req.user!.id,
        action: 'admin.booking.create_on_behalf',
        targetType: 'booking',
        targetId: response.bookingId,
        bookingId: response.bookingId,
        metadata: {
          listingId: input.listingId,
          guestPhone: guest.phone,
          amountPaise: response.amountPaise,
        },
      });

      res.status(201).json({ data: response });
    } catch (err) { next(err); }
  }

  async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const refundMode = req.body?.refundMode === 'full' ? 'full' : 'policy';
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
      res.json(await adminBookingsService.cancel(req.user!.id, String(req.params.id), { refundMode, reason }));
    } catch (err) { next(err); }
  }
}

export const adminBookingsController = new AdminBookingsController();
