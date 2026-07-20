import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../../common/errors/app-error.js';
import { wishlistsService } from '../services/wishlists.service.js';

const listingTypeSchema = z.enum(['stay', 'service', 'transport']);
const bodySchema = z.object({
  listingId: z.string().uuid(),
  listingType: listingTypeSchema,
});
const paramSchema = z.object({
  listingType: listingTypeSchema,
  listingId: z.string().uuid(),
});

export class WishlistsController {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await wishlistsService.list(req.user!.id);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  }

  async add(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      await wishlistsService.add(req.user!.id, parsed.data.listingId, parsed.data.listingType);
      res.status(201).json({ success: true });
    } catch (err) { next(err); }
  }

  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = paramSchema.safeParse(req.params);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      await wishlistsService.remove(req.user!.id, parsed.data.listingId, parsed.data.listingType);
      res.json({ success: true });
    } catch (err) { next(err); }
  }
}

export const wishlistsController = new WishlistsController();
