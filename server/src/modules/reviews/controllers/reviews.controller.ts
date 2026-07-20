import { Request, Response, NextFunction } from 'express';
import { reviewsService } from '../services/reviews.service.js';

export class ReviewsController {
  async listByStay(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await reviewsService.listByStay(String(req.params.stayId)));
    } catch (err) {
      next(err);
    }
  }

  async listByListing(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await reviewsService.listByListing(String(req.params.listingId)));
    } catch (err) {
      next(err);
    }
  }

  async pendingPrompts(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await reviewsService.pendingPrompts(req.user!.id));
    } catch (err) {
      next(err);
    }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(201).json(await reviewsService.create(req.user!.id, req.body as Record<string, unknown>));
    } catch (err) {
      next(err);
    }
  }

  async markHelpful(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await reviewsService.incrementHelpful(String(req.params.id), req.user!.id));
    } catch (err) {
      next(err);
    }
  }
}

export const reviewsController = new ReviewsController();
