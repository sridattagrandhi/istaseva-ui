import { Request, Response, NextFunction } from 'express';
import { providersService } from '../services/providers.service.js';
import { providerPayoutsService } from '../services/payouts.service.js';

export class ProvidersController {
  async getMyProfile(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await providersService.getMyProfile(req.user!.id));
    } catch (err) {
      next(err);
    }
  }

  async getByUserId(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.params.userId as string;
      res.json(await providersService.getByUserId(userId));
    } catch (err) {
      next(err);
    }
  }

  async createProfile(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(201).json(await providersService.createProfile(req.user!.id, req.body as Record<string, unknown>));
    } catch (err) {
      next(err);
    }
  }

  async upsertProfile(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await providersService.upsertProfile(req.user!.id, req.body as Record<string, unknown>));
    } catch (err) {
      next(err);
    }
  }

  async getMyInsights(req: Request, res: Response, next: NextFunction) {
    try {
      const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
      res.json(await providersService.getMyInsights(req.user!.id, {
        category: str(req.query.category),
        days: str(req.query.days),
        from: str(req.query.from),
        to: str(req.query.to),
      }));
    } catch (err) {
      next(err);
    }
  }

  /** GET /me/payout-account — masked active payout destination (or null). */
  async getMyPayoutAccount(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await providerPayoutsService.getMyAccount(req.user!.id));
    } catch (err) {
      next(err);
    }
  }

  /** PUT /me/payout-account — save/replace the payout destination. */
  async saveMyPayoutAccount(req: Request, res: Response, next: NextFunction) {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' ? v : null);
      res.json(await providerPayoutsService.saveMyAccount(req.user!.id, {
        method: body.method === 'upi' ? 'upi' : 'bank',
        accountHolder: str(body.accountHolder),
        accountNumber: str(body.accountNumber),
        ifsc: str(body.ifsc),
        upiId: str(body.upiId),
      }));
    } catch (err) {
      next(err);
    }
  }

  /** GET /me/payouts — pending payable summary + recorded payout history
   *  (?page=N, 50 per page, most recent first). */
  async getMyPayouts(req: Request, res: Response, next: NextFunction) {
    try {
      const page = Number(req.query.page);
      res.json(await providerPayoutsService.getMyPayouts(req.user!.id, Number.isFinite(page) ? page : 1));
    } catch (err) {
      next(err);
    }
  }

  async getMyEarnings(req: Request, res: Response, next: NextFunction) {
    try {
      const range = typeof req.query.range === 'string' ? req.query.range : '30d';
      const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined;
      const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined;
      const listingId = typeof req.query.listingId === 'string' && req.query.listingId ? req.query.listingId : undefined;
      // Vertical filter — whitelist so only known values ever reach the SQL builder.
      const type = req.query.type === 'stay' || req.query.type === 'service' || req.query.type === 'transport'
        ? req.query.type
        : undefined;
      res.json(await providersService.getMyEarnings(req.user!.id, { range, from, to, listingId, type }));
    } catch (err) {
      next(err);
    }
  }
}

export const providersController = new ProvidersController();
