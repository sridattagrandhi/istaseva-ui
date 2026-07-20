import { z } from 'zod';
import { smartScheduleService } from '../../../providers/services/smart-schedule.service.js';
import { logger } from '../../../../common/logging/logger.js';
import type { ToolDefinition } from '../types.js';

/**
 * Surface real open slots for a service/transport category so the agent
 * can say "Tomorrow you've got 10:00, 13:00 or 16:30 — which one?"
 * instead of asking the user to guess a time.
 *
 * Reads-only — calls smart-schedule which already caches per-date keys
 * (5-min TTL) so back-to-back calls during a conversation are cheap.
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const ArgsSchema = z.object({
  serviceCategory: z
    .string()
    .min(1)
    .max(80)
    .describe('Service category to look up (e.g. "cleaning", "auto", "plumber"). Use the value from a previous search_listings hit, not a free-text rephrase. Ignored when listingId is also supplied.'),
  listingId: z
    .string()
    .min(1)
    .optional()
    .describe('Optional. Restrict the slot search to one specific listing. STRONGLY prefer passing this whenever the user has already named or picked a listing — it avoids the category-text mismatch that returns 0 slots even when the listing has open time.'),
  preferredDate: z
    .string()
    .regex(DATE)
    .describe('YYYY-MM-DD. The day the user wants. Translate "tomorrow" / "Saturday" using the IST date in your system prompt.'),
  durationMinutes: z
    .number()
    .int()
    .min(15)
    .max(720)
    .default(60)
    .describe('How long the booking will take in minutes. Default 60; bump for jobs the user said are bigger.'),
  lat: z.number().optional().describe('Optional user latitude — helps rank by travel time.'),
  lng: z.number().optional().describe('Optional user longitude.'),
});
type Args = z.infer<typeof ArgsSchema>;

interface SlotHit {
  providerId: string;
  providerName: string;
  startTime: string;        // "HH:MM"
  endTime: string;          // "HH:MM"
  travelMinutes: number;
  distanceKm: number;
}

interface FindSlotsResult {
  slots: SlotHit[];
  totalProviders: number;
  /** Best 3 to surface in the reply — keeps the bubble scannable. */
  topSlots: SlotHit[];
}

export const findAvailableSlotsTool: ToolDefinition<Args, FindSlotsResult> = {
  name: 'find_available_slots',
  description:
    'List real open time-slots for a service/transport category on a specific date. Call this BEFORE asking the user "what time?" — surface 2-3 concrete options ("11am, 2pm or 4pm — which works?") and let them pick, rather than making them guess. Stays do NOT use this; nightly bookings have no time-of-day picker.',
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      serviceCategory: { type: 'string' },
      listingId: { type: 'string', description: 'Optional — restrict the search to one listing.' },
      preferredDate: { type: 'string', description: 'YYYY-MM-DD' },
      durationMinutes: { type: 'number', default: 60 },
      lat: { type: 'number' },
      lng: { type: 'number' },
    },
    required: ['serviceCategory', 'preferredDate'],
  },

  async execute(args, _ctx): Promise<FindSlotsResult> {
    try {
      const raw = await smartScheduleService.findSlots({
        service_category: args.serviceCategory,
        listing_id: args.listingId,
        preferred_date: args.preferredDate,
        duration_minutes: args.durationMinutes,
        lat: args.lat,
        lng: args.lng,
      });

      const slots: SlotHit[] = (raw.slots ?? []).map((s: any) => ({
        providerId: String(s.provider_id),
        providerName: String(s.provider_name ?? 'Provider'),
        startTime: String(s.start_time),
        endTime: String(s.end_time),
        travelMinutes: Number(s.estimated_travel_minutes ?? 0),
        distanceKm: Number(s.distance_km ?? 0),
      }));

      return {
        slots,
        totalProviders: Number(raw.totalProviders ?? slots.length),
        topSlots: slots.slice(0, 3),
      };
    } catch (err) {
      logger.warn('find_available_slots: smart-schedule failed', {
        category: args.serviceCategory,
        date: args.preferredDate,
        error: (err as Error).message,
      });
      // Degrade quietly — empty list is a recoverable signal the model can
      // respond to ("nothing showing for that day, want to try another?").
      return { slots: [], totalProviders: 0, topSlots: [] };
    }
  },

  summarize(args, result) {
    if (result.topSlots.length === 0) {
      return `No ${args.serviceCategory} slots on ${args.preferredDate}`;
    }
    return `Found ${result.totalProviders} provider${result.totalProviders === 1 ? '' : 's'} with open slots on ${args.preferredDate}`;
  },
};
