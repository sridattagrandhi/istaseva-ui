import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ForbiddenError } from '../../../common/errors/app-error.js';
import { supplyOptimizationService } from '../services/supply-optimization.service.js';

const actionQuery = z.object({
  action: z.enum(['recalculate', 'get_promoted']).default('get_promoted'),
});

export class SupplyOptimizationController {
  async getMetrics(req: Request, res: Response, next: NextFunction) {
    try {
      const { action } = actionQuery.parse(req.query);
      // The recompute is expensive and already runs on a schedule — only admins
      // may trigger it on demand. Reads (get_promoted) are open to any signed-in user.
      if (action === 'recalculate' && (req as any).user?.role !== 'admin') {
        throw new ForbiddenError('Only admins can trigger a supply-metrics recompute.');
      }
      const response = action === 'recalculate'
        ? await supplyOptimizationService.recalculateMetrics()
        : await supplyOptimizationService.getMetrics();

      res.json(response);
    } catch (err) {
      next(err);
    }
  }
}

export const supplyOptimizationController = new SupplyOptimizationController();
