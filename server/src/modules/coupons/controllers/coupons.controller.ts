import { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../../../common/errors/app-error.js';
import { couponsService } from '../services/coupons.service.js';
import { createCouponSchema, validateCouponQuerySchema } from '../schemas/coupon.schema.js';

export class CouponsController {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      // Dashboards pass ?category=stay|service|transport so they only see
      // their own coupons. Anything else (or no param) returns the legacy
      // unfiltered list — keeps any internal/admin callers working.
      const raw = typeof req.query.category === 'string' ? req.query.category.toLowerCase() : '';
      const category = raw === 'stay' || raw === 'service' || raw === 'transport' ? raw : undefined;
      const data = await couponsService.listForHost(req.user!.id, category);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = createCouponSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      const data = await couponsService.create(req.user!.id, parsed.data);
      res.status(201).json({ success: true, data });
    } catch (err) { next(err); }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await couponsService.delete(String(req.params.id), req.user!.id);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  }

  async toggleActive(req: Request, res: Response, next: NextFunction) {
    try {
      const isActive = Boolean(req.body?.isActive);
      const data = await couponsService.setActive(String(req.params.id), req.user!.id, isActive);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  }

  /** Preview endpoint — guests use this to see their discount before checking out. */
  async validate(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = validateCouponQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      // userId enforces coupon_users targeting (platform coupons issued to
      // specific people) — the preview should reject exactly like consume will.
      const quote = await couponsService.quote({ ...parsed.data, userId: req.user?.id });
      res.json({ success: true, data: quote });
    } catch (err) { next(err); }
  }
}

export const couponsController = new CouponsController();
