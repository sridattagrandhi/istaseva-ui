import type { NextFunction, Request, Response } from 'express';
import { ValidationError } from '../../../common/errors/app-error.js';
import { fraudSignalSchema } from '../schemas/fraud-signal.schema.js';
import { fraudSignalsService } from '../services/fraud-signals.service.js';

export class FraudController {
  async createSignal(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = fraudSignalSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid fraud signal payload');
      }

      res.status(201).json(await fraudSignalsService.createSignal(req.user!.id, parsed.data));
    } catch (error) {
      next(error);
    }
  }
}

export const fraudController = new FraudController();
