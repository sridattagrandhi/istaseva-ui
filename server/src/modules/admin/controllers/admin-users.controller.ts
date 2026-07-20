import { Request, Response, NextFunction } from 'express';
import { adminUsersService } from '../services/admin-users.service.js';

export class AdminUsersController {
  async search(req: Request, res: Response, next: NextFunction) {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const limit = Number(req.query.limit) || 20;
      res.json({ users: await adminUsersService.search(q, limit) });
    } catch (err) { next(err); }
  }

  async get(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await adminUsersService.get(String(req.params.userId)));
    } catch (err) { next(err); }
  }

  async suspend(req: Request, res: Response, next: NextFunction) {
    try {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
      res.json(await adminUsersService.suspend(req.user!.id, String(req.params.userId), reason));
    } catch (err) { next(err); }
  }

  async unsuspend(req: Request, res: Response, next: NextFunction) {
    try {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
      res.json(await adminUsersService.unsuspend(req.user!.id, String(req.params.userId), reason));
    } catch (err) { next(err); }
  }

  /** Suspend + schedule erasure (LEG-003 takedown, e.g. a discovered minor). */
  async requestDeletion(req: Request, res: Response, next: NextFunction) {
    try {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
      res.json(await adminUsersService.requestDeletion(req.user!.id, String(req.params.userId), reason));
    } catch (err) { next(err); }
  }
}

export const adminUsersController = new AdminUsersController();
