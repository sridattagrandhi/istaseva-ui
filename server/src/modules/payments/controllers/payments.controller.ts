import { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../../../common/errors/app-error.js';
import { logger } from '../../../common/logging/logger.js';
import { createPaymentSchema, verifyPaymentSchema } from '../schemas/payment.schema.js';
import { paymentsService } from '../services/payments.service.js';

export class PaymentsController {
  async createOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = createPaymentSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      const response = await paymentsService.createOrder(parsed.data, req.user!.id);
      res.json(response);
    } catch (err) {
      next(err);
    }
  }

  async verify(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = verifyPaymentSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      const response = await paymentsService.verifyPayment({
        ...parsed.data,
        userId: req.user!.id,
      });
      res.json(response);
    } catch (err) {
      next(err);
    }
  }

  async webhook(req: Request, res: Response, next: NextFunction) {
    try {
      const signature = req.headers['x-razorpay-signature'] as string | undefined;
      // req.body is a Buffer here because express.raw() is mounted on this route.
      // Verify the signature against the raw bytes BEFORE parsing JSON — re-serializing
      // a parsed object will not reproduce the exact bytes Razorpay signed.
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      if (!paymentsService.verifyWebhookSignature(signature, rawBody)) {
        logger.warn('Invalid Razorpay webhook signature');
        return res.status(400).json({ error: 'Invalid signature' });
      }

      let event: unknown;
      try {
        event = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'Invalid JSON' });
      }

      const headerEventId = req.headers['x-razorpay-event-id'];
      const eventIdFromHeader = Array.isArray(headerEventId)
        ? headerEventId[0]
        : (typeof headerEventId === 'string' ? headerEventId : undefined);

      const response = await paymentsService.handleWebhook(event, { eventIdFromHeader });
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
}

export const paymentsController = new PaymentsController();
