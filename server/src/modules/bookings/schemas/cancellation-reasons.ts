import { z } from 'zod';

// Categorical cancellation reasons the GUEST picks when cancelling. Written to
// bookings.cancellation_reason and echoed into the booking_cancelled analytics
// event so the admin dashboard can split normal churn from platform problems.
// `host_asked_offline` doubles as a disintermediation/fraud signal.
//
// Mirrored (no shared code, same convention as BOOKING_STATUSES) in:
//   web    src/domains/bookings/booking.service.ts (CANCELLATION_REASONS)
//   mobile mobile/src/design/api/bookings.ts       (CANCELLATION_REASONS)
export const CANCELLATION_REASONS = [
  'plans_changed',
  'found_alternative',
  'price_too_high',
  'booked_by_mistake',
  'host_asked_offline',
  'property_issue',
  'other',
] as const;

export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

export const cancellationReasonSchema = z.enum(CANCELLATION_REASONS);
