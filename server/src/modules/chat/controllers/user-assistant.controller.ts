import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ValidationError, UnauthorizedError } from '../../../common/errors/app-error.js';
import { logger } from '../../../common/logging/logger.js';
import { userAssistantService } from '../services/user-assistant.service.js';
import { assistantBookingService } from '../services/assistant-booking.service.js';

const schema = z.object({
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
  })),
  displayLang: z.string().default('en'),
  // NOTE: zod strips unknown keys — every context field the clients send
  // must be declared here or the service never sees it (surface/listingType
  // were silently dropped for months before being added).
  context: z.object({
    path: z.string().optional(),
    surface: z.enum(['discovery', 'onboarding', 'booking-details', 'dashboard', 'other']).optional(),
    listingType: z.enum(['stay', 'service', 'transport']).nullable().optional(),
    // 'mobile' has no marketplace grid — the prompt disables the on-page
    // tools (filter_marketplace / locate_listing) for it.
    platform: z.enum(['web', 'mobile']).optional(),
    // Real device location — clients only send this when the user granted
    // geolocation (never a default placeholder). Powers "near me" requests.
    location: z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      city: z.string().max(120).optional(),
      state: z.string().max(120).optional(),
    }).optional(),
  }).optional(),
  // Phase 5: client mints a UUID and subscribes to
  // assistant:<requestId>:tools BEFORE firing the request, so chip
  // events fired during the loop reach an active subscriber. Optional
  // for backwards compat — server falls back to a server-side UUID
  // (events still fire on that channel, no client receives them).
  requestId: z.string().uuid().optional(),
});

// Schema for the agent-prepared booking flow. Intentionally permissive on
// times (defaulted server-side) and strict on the date format so the agent
// can't submit "this Saturday" as a string and have it silently fail deep
// in the booking service.
export const prepareBookingSchema = z.object({
  listingId: z.string().uuid(),
  scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Check-out date for multi-night stays. Services/transport ignore this.
  // Defaults to scheduledDate + 1 day for stays when not provided.
  checkOutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  notes: z.string().max(500).optional(),
  insuranceOptIn: z.boolean().optional(),
  roomTypeId: z.string().min(1).optional(),
  guestCount: z.number().int().min(1).max(40).optional(),
  // Multi-room stays — units of the chosen room type. MUST be accepted here so
  // the sathram confirm-card retry (which echoes the original bookingArgs)
  // keeps the room count; without it the retry collapses to 1 room and fails
  // guest-capacity ("Single sleeps up to 1") for a valid multi-room booking.
  numberOfRooms: z.number().int().min(1).max(20).optional(),
  serviceMode: z.enum(['at-home', 'visit-provider', 'online']).optional(),
  serviceAddress: z.string().min(3).max(1000).optional(),
  serviceHours: z.number().positive().max(24).optional(),
  serviceCatalogId: z.string().min(1).max(64).optional(),
  serviceAddOnIds: z.array(z.string().min(1).max(64)).max(20).optional(),
  transportMode: z.enum(['hourly', 'day', 'package']).optional(),
  transportHours: z.number().positive().max(24).optional(),
  transportDays: z.number().int().min(1).max(30).optional(),
  transportPackageId: z.string().min(1).optional(),
  pickupLocation: z.string().min(3).max(1000).optional(),
  passengerCount: z.number().int().min(1).max(20).optional(),
});

export class UserAssistantController {
  async chat(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw new UnauthorizedError();
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      const response = await userAssistantService.respond({
        messages: parsed.data.messages,
        displayLang: parsed.data.displayLang,
        context: parsed.data.context,
        requestId: parsed.data.requestId,
        user: { id: req.user.id, name: (req.user as any).name, role: req.user.role },
      });
      res.json(response);
    } catch (err) {
      logger.error('User assistant error', { error: (err as Error).message });
      next(err);
    }
  }

  async prepareBooking(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw new UnauthorizedError();
      const parsed = prepareBookingSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      const result = await assistantBookingService.prepare(parsed.data, req.user.id);
      res.json({ success: true, data: result });
    } catch (err) {
      logger.warn('prepare_booking failed', { error: (err as Error).message });
      next(err);
    }
  }
}

export const userAssistantController = new UserAssistantController();
