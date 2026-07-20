import { Request, Response, NextFunction } from 'express';
import { adminFraudService } from '../services/admin-fraud.service.js';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class AdminFraudController {
  async listSignals(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const { rows, total } = await adminFraudService.listSignals({
        userId: str(req.query.userId),
        riskLevel: str(req.query.riskLevel),
        eventType: str(req.query.eventType),
        from: str(req.query.from),
        to: str(req.query.to),
        limit,
        offset,
      });
      res.json({ signals: rows, total, limit, offset });
    } catch (err) { next(err); }
  }

  async listEventTypes(_req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ eventTypes: await adminFraudService.listEventTypes() });
    } catch (err) { next(err); }
  }

  async userDossier(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await adminFraudService.userDossier(String(req.params.userId)));
    } catch (err) { next(err); }
  }
}

export const adminFraudController = new AdminFraudController();
