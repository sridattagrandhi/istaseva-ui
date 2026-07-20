import { Request, Response, NextFunction } from 'express';
import { notificationsService } from '../services/notifications.service.js';
import { parseLimit, parsePage } from '../../../common/http/pagination.js';

export class NotificationsController {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const { unread_only, page, limit } = req.query;
      const response = await notificationsService.listForUser({
        userId: req.user!.id,
        unreadOnly: unread_only === 'true',
        page: parsePage(page),
        limit: parseLimit(limit),
      });
      res.json(response);
    } catch (err) {
      next(err);
    }
  }

  async markRead(req: Request, res: Response, next: NextFunction) {
    try {
      const response = await notificationsService.markRead(String(req.params.id), req.user!.id);
      res.json(response);
    } catch (err) {
      next(err);
    }
  }

  async markAllRead(req: Request, res: Response, next: NextFunction) {
    try {
      const response = await notificationsService.markAllRead(req.user!.id);
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
}

export const notificationsController = new NotificationsController();
