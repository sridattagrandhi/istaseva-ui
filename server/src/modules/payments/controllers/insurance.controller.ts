import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../../common/errors/app-error.js';
import { paymentsRepository } from '../repositories/payments.repository.js';

const createInsurancePolicySchema = z.object({
  booking_id: z.string().uuid(),
  coverage_amount: z.coerce.number().positive().optional(),
  coverage_type: z.string().min(1).max(50).optional(),
}).strict();

export class InsuranceController {
  async createPolicy(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = createInsurancePolicySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid insurance policy payload');
      }

      const bookingResult = await paymentsRepository.getPendingBookingWithAuthoritativePrice(parsed.data.booking_id, req.user!.id);
      const booking = bookingResult.rows[0];
      if (!booking) {
        throw new ValidationError('Booking is no longer available for insurance');
      }

      const rawPrice = Number(booking.price_per_night);
      const bookingAmount = Number.isFinite(rawPrice) && rawPrice > 0
        ? rawPrice
        : Number(String(booking.price ?? '').replace(/[^0-9.]/g, ''));

      if (!Number.isFinite(bookingAmount) || bookingAmount <= 0) {
        throw new ValidationError('Unable to calculate insurance premium for this booking');
      }

      const premiumAmount = Math.max(2, Math.min(49, Math.round(bookingAmount * 0.02)));

      await paymentsRepository.insertInsurancePolicy(
        parsed.data.booking_id,
        req.user!.id,
        premiumAmount
      );

      res.status(201).json({
        data: {
          booking_id: parsed.data.booking_id,
          user_id: req.user!.id,
          premium_amount: premiumAmount,
          coverage_amount: parsed.data.coverage_amount || 500,
          coverage_type: parsed.data.coverage_type || 'standard',
          status: 'active',
        },
      });
    } catch (err) {
      next(err);
    }
  }
}

export const insuranceController = new InsuranceController();
