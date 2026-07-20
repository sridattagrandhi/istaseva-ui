import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../../common/errors/app-error.js';
import { smartScheduleService } from '../services/smart-schedule.service.js';

// lat/lng are optional — some listings (especially newly onboarded providers
// who haven't set service-radius geocoords yet) ship without coordinates, and
// the service handles missing coords by skipping the distance/zone check.
// Rejecting the request just because the *user* couldn't be geolocated would
// surface a confusing "could not load slots" error in the booking modal.
const scheduleSchema = z.object({
  service_category: z.string().min(1),
  lat: z.number().optional(),
  lng: z.number().optional(),
  preferred_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  duration_minutes: z.number().min(15).max(480).default(60),
});

export class SmartScheduleController {
  async findSlots(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = scheduleSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      res.json(await smartScheduleService.findSlots(parsed.data));
    } catch (err) {
      next(err);
    }
  }
}

export const smartScheduleController = new SmartScheduleController();
