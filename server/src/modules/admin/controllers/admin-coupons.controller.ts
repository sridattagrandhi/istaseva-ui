import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../../common/errors/app-error.js';
import { adminCouponsService } from '../services/admin-coupons.service.js';

const createPlatformCouponSchema = z.object({
  code: z.string().min(2).max(40),
  discountType: z.enum(['percent', 'fixed']),
  discountValue: z.number().positive(),
  maxUses: z.number().int().positive().nullish(),
  validFrom: z.string().nullish(),
  validUntil: z.string().nullish(),
  listingId: z.string().uuid().nullish(),
  category: z.enum(['stay', 'service', 'transport']).nullish(),
  userIds: z.array(z.string().min(1)).max(500).optional(),
});

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class AdminCouponsController {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const scope = str(req.query.scope);
      const active = str(req.query.active);
      const { rows, total } = await adminCouponsService.list({
        q: str(req.query.q),
        scope: scope === 'platform' || scope === 'host' ? scope : undefined,
        active: active === 'true' ? true : active === 'false' ? false : undefined,
        limit,
        offset,
      });
      res.json({ coupons: rows, total, limit, offset });
    } catch (err) { next(err); }
  }

  async detail(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await adminCouponsService.detail(String(req.params.id)));
    } catch (err) { next(err); }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = createPlatformCouponSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));
      }
      res.status(201).json(await adminCouponsService.create(req.user!.id, parsed.data));
    } catch (err) { next(err); }
  }

  async setActive(req: Request, res: Response, next: NextFunction) {
    try {
      const isActive = Boolean(req.body?.isActive);
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
      res.json(await adminCouponsService.setActive(req.user!.id, String(req.params.id), isActive, reason));
    } catch (err) { next(err); }
  }
}

export const adminCouponsController = new AdminCouponsController();
