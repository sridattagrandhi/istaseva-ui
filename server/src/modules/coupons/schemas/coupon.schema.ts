import { z } from 'zod';

export const createCouponSchema = z.object({
  code: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_-]+$/, 'Code must be alphanumeric (dashes/underscores allowed)'),
  listingId: z.string().uuid().optional().nullable(),
  /** Listing-category scope. Stamped when the dashboard "Applies to" picker
   *  is set to "All your stays" / "All your services" / "All your transports"
   *  so the consume-time gate can reject bookings of a different kind.
   *  Omitted = legacy host-wide semantics. */
  category: z.enum(['stay', 'service', 'transport']).optional().nullable(),
  discountType: z.enum(['percent', 'fixed']),
  discountValue: z.number().positive(),
  maxUses: z.number().int().positive().optional().nullable(),
  /** Per-user redemption cap. Omitted → 1 (once per customer). Explicit null →
   *  unlimited per user (for deliberately repeatable promos). */
  maxUsesPerUser: z.number().int().positive().optional().nullable(),
  validFrom: z.string().datetime().optional().nullable(),
  validUntil: z.string().datetime().optional().nullable(),
}).refine(
  (v) => v.discountType !== 'percent' || v.discountValue <= 100,
  { message: 'Percentage discounts must be between 0 and 100', path: ['discountValue'] },
);

export type CreateCouponInput = z.infer<typeof createCouponSchema>;

export const validateCouponQuerySchema = z.object({
  code: z.string().trim().min(1),
  listingId: z.string().uuid(),
  basePrice: z.coerce.number().positive(),
});
