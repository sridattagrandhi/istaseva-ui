export const BOOKING_STATUSES = [
  'pending',
  'confirmed',
  'in_progress',
  'completed',
  'cancelled',
  'expired',
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const ACTIVE_BOOKING_STATUSES: BookingStatus[] = ['pending', 'confirmed', 'in_progress'];
