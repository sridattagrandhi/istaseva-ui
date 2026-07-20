import { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../../../common/errors/app-error.js';
import { messagesService } from '../services/messages.service.js';
import { sendMessageSchema } from '../schemas/message.schema.js';
import { parseLimit, parseOffset } from '../../../common/http/pagination.js';

export class MessagesController {
  async listConversations(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = parseLimit(req.query.limit, { def: 50 });
      const offset = parseOffset(req.query.offset);
      res.json(await messagesService.listConversations(req.user!.id, { limit, offset }));
    } catch (err) {
      next(err);
    }
  }

  async getConversation(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = parseLimit(req.query.limit, { def: 100, max: 200 });
      const before = req.query.before ? String(req.query.before) : undefined;
      res.json(
        await messagesService.getConversation(req.user!.id, String(req.params.otherUserId), { limit, before })
      );
    } catch (err) {
      next(err);
    }
  }

  async markConversationAsRead(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await messagesService.markConversationAsRead(req.user!.id, String(req.params.otherUserId)));
    } catch (err) {
      next(err);
    }
  }

  async sendMessage(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = sendMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid message payload');
      }

      res.status(201).json(await messagesService.sendMessage(req.user!.id, parsed.data));
    } catch (err) {
      next(err);
    }
  }

  async markAsRead(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await messagesService.markAsRead(req.user!.id, String(req.params.id)));
    } catch (err) {
      next(err);
    }
  }
}

export const messagesController = new MessagesController();
