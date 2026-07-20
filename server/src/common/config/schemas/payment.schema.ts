import { z } from 'zod';

export const paymentSchema = z.object({
  provider: z.enum(['mock', 'razorpay', 'stripe']).default('mock'),
  defaultCurrency: z.enum(['INR', 'USD']).default('INR'),
  razorpay: z.object({
    keyId: z.string().optional(),
    keySecret: z.string().optional(),
    webhookSecret: z.string().optional(),
  }),
  stripe: z.object({
    secretKey: z.string().optional(),
    webhookSecret: z.string().optional(),
  }),
});
