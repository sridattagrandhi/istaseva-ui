export const PAYMENT_STATUSES = [
  'pending',
  'completed',
  'failed',
  'partially_refunded',
  'refunded',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
