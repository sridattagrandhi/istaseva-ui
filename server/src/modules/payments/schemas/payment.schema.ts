import { z } from 'zod';
import { PAYMENT_STATUSES } from './payment-status.js';

export const createPaymentSchema = z.object({
  bookingId: z.string().uuid(),
  // The customer-supplied amount is treated as a CLAIM — the server
  // validates it against the booking's authoritative agreed_price_paise
  // (set at hold-creation time from listing + nights + coupon + insurance).
  // The fee/GST breakdown is always recomputed server-side from booking,
  // listing, category, coupon, and insurance flag — never trusted from the
  // client. This keeps stored values, the invoice PDF, and the email all
  // consistent with what the booking actually represents.
  amount: z.number().positive(),
  currency: z.enum(['INR', 'USD']).default('INR'),
  insuranceOptIn: z.boolean().default(false),
  idempotencyKey: z.string().min(8).max(255).optional(),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const verifyPaymentSchema = z.object({
  bookingId: z.string().uuid(),
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);
