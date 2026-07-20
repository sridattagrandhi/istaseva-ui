import { Request, Response, NextFunction } from 'express';
import { adminFacetsService } from '../services/admin-facets.service.js';

export class AdminFacetsController {
  /** GET /api/admin/facets — distinct states/cities/types/categories for filter dropdowns. */
  async listingFacets(_req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await adminFacetsService.listingFacets());
    } catch (err) { next(err); }
  }
}

export const adminFacetsController = new AdminFacetsController();
