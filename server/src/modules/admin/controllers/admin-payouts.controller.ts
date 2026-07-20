import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../../common/errors/app-error.js';
import { adminPayoutsService } from '../services/admin-payouts.service.js';

const recordPayoutSchema = z.object({
  providerUserId: z.string().min(1),
  note: z.string().max(500).nullish(),
});

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class AdminPayoutsController {
  async summary(_req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ owed: await adminPayoutsService.owedSummary() });
    } catch (err) { next(err); }
  }

  /** Drill-down: one partner's businesses (listings) with per-listing owed. */
  async partnerBusinesses(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ businesses: await adminPayoutsService.partnerBusinesses(String(req.params.userId)) });
    } catch (err) { next(err); }
  }

  async ledger(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      res.json({ payouts: await adminPayoutsService.ledger({ providerUserId: str(req.query.providerUserId), limit }) });
    } catch (err) { next(err); }
  }

  async record(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = recordPayoutSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));
      }
      res.status(201).json({ payout: await adminPayoutsService.recordPayout(req.user!.id, parsed.data) });
    } catch (err) { next(err); }
  }
}

export const adminPayoutsController = new AdminPayoutsController();
