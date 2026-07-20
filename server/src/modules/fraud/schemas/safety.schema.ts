import { z } from 'zod';

// SEC-006: strict allowlists for POST /api/safety/*.
// Server-owned fields are deliberately ABSENT from these schemas and are set
// by the service instead — Zod strips unknown keys, so clients cannot inject:
//   safety_alerts: status (always 'open'), emergency_contacts_notified,
//                  user_id (authenticated caller)
//   safety_checks: initiated_by (authenticated caller)

export const createSafetyAlertSchema = z.object({
  booking_id: z.string().uuid().nullish(),
  alert_type: z.enum(['sos', 'unsafe_feeling', 'harassment']).default('sos'),
  description: z.string().max(2000).nullish(),
  location_lat: z.number().min(-90).max(90).nullish(),
  location_lng: z.number().min(-180).max(180).nullish(),
});

export type CreateSafetyAlertInput = z.infer<typeof createSafetyAlertSchema>;

export const createSafetyCheckSchema = z.object({
  booking_id: z.string().uuid(),
  check_type: z.enum(['companion_present', 'location_share', 'identity_photo', 'otp_verification']),
  response: z.enum(['yes', 'no', 'confirmed', 'skipped']),
  severity: z.enum(['low', 'medium', 'high']),
  is_resolved: z.boolean().optional(),
});

export type CreateSafetyCheckInput = z.infer<typeof createSafetyCheckSchema>;
