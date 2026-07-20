import { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../../../common/errors/app-error.js';
import { createListingSchema } from '../../listings/controllers/listings.controller.js';
import { adminListingsService } from '../services/admin-listings.service.js';
import { strList } from './admin-bookings.controller.js';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class AdminListingsController {
  async search(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const state = str(req.query.state);
      const { rows, total } = await adminListingsService.search({
        q: str(req.query.q),
        type: str(req.query.type),
        state: state === 'live' || state === 'inactive' || state === 'banned' || state === 'archived' ? state : undefined,
        userId: str(req.query.userId),
        from: str(req.query.from),
        to: str(req.query.to),
        states: strList(req.query.states),
        cities: strList(req.query.cities),
        types: strList(req.query.types),
        categories: strList(req.query.categories),
        limit,
        offset,
      });
      res.json({ listings: rows, total, limit, offset });
    } catch (err) { next(err); }
  }

  /**
   * POST /api/admin/listings/for-user — assisted onboarding. Body:
   * { targetUserId, listing: {...same payload as POST /api/listings} }.
   * Target must exist, be KYC-verified, and not suspended (service-enforced).
   */
  async createForUser(req: Request, res: Response, next: NextFunction) {
    try {
      const targetUserId = typeof req.body?.targetUserId === 'string' ? req.body.targetUserId.trim() : '';
      if (!targetUserId) throw new ValidationError('targetUserId is required');
      const parsed = createListingSchema.safeParse(req.body?.listing);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));
      }
      const rooms = Array.isArray(req.body?.rooms)
        ? (req.body.rooms as Array<Record<string, unknown>>).slice(0, 50)
        : [];
      res.status(201).json(
        await adminListingsService.createForUser(req.user!.id, targetUserId, parsed.data as Record<string, unknown>, rooms)
      );
    } catch (err) { next(err); }
  }

  async detail(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await adminListingsService.detail(String(req.params.id)));
    } catch (err) { next(err); }
  }

  async ban(req: Request, res: Response, next: NextFunction) {
    try {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
      res.json(await adminListingsService.ban(req.user!.id, String(req.params.id), reason));
    } catch (err) { next(err); }
  }

  async unban(req: Request, res: Response, next: NextFunction) {
    try {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
      res.json(await adminListingsService.unban(req.user!.id, String(req.params.id), reason));
    } catch (err) { next(err); }
  }

  /** Admin takedown = soft archive (reason required). The only delete path. */
  async archive(req: Request, res: Response, next: NextFunction) {
    try {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
      res.json(await adminListingsService.archive(req.user!.id, String(req.params.id), reason));
    } catch (err) { next(err); }
  }

  async unarchive(req: Request, res: Response, next: NextFunction) {
    try {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
      res.json(await adminListingsService.unarchive(req.user!.id, String(req.params.id), reason));
    } catch (err) { next(err); }
  }
}

export const adminListingsController = new AdminListingsController();
