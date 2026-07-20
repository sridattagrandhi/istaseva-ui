import { z } from 'zod';

const TIME_24H = /^([01]\d|2[0-3]):[0-5]\d$/;

const dayWindowSchema = z
  .union([
    z.null(),
    z.tuple([z.string().regex(TIME_24H), z.string().regex(TIME_24H)]),
  ])
  .refine(
    (v) => v === null || (v[0] < v[1]),
    { message: 'start time must be earlier than end time' },
  );

/**
 * Per-day working hours JSONB shape: each weekday key maps to either a
 * [start, end] tuple (24h "HH:MM") or null for "weekly off". All seven keys
 * are required so the algorithm can rely on the data being complete.
 */
export const workingHoursSchema = z.object({
  sun: dayWindowSchema,
  mon: dayWindowSchema,
  tue: dayWindowSchema,
  wed: dayWindowSchema,
  thu: dayWindowSchema,
  fri: dayWindowSchema,
  sat: dayWindowSchema,
});

export const providerProfileUpsertSchema = z.object({
  display_name: z.string().min(1).max(120).optional(),
  service_categories: z.array(z.string()).max(20).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  service_radius_km: z.number().positive().max(200).optional(),
  buffer_minutes: z.number().int().min(0).max(240).optional(),
  is_available: z.boolean().optional(),
  bio: z.string().max(2000).optional(),

  // P3 scheduling fields
  vehicle_class: z.enum(['walk', 'scooter', 'car', 'van']).optional(),
  max_jobs_per_day: z.number().int().min(1).max(50).optional(),
  working_hours: workingHoursSchema.optional(),
});

export type ProviderProfileUpsertInput = z.infer<typeof providerProfileUpsertSchema>;
