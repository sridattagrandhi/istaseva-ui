import { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../../../common/errors/app-error.js';
import { createSafetyAlertSchema, createSafetyCheckSchema } from '../schemas/safety.schema.js';
import { safetyService } from '../services/safety.service.js';

export class SafetyController {
  async listAlerts(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await safetyService.listAlerts(req.user!.id));
    } catch (err) {
      next(err);
    }
  }

  async createAlert(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = createSafetyAlertSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid safety alert payload');
      }
      res.status(201).json(await safetyService.createAlert(req.user!.id, parsed.data));
    } catch (err) {
      next(err);
    }
  }

  async createCheck(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = createSafetyCheckSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid safety check payload');
      }
      res.status(201).json(await safetyService.createCheck(req.user!.id, parsed.data));
    } catch (err) {
      next(err);
    }
  }
}

export const safetyController = new SafetyController();
