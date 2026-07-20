import { z } from 'zod';

// Per-endpoint rate-limit knobs. Defaults match the historical hard-coded
// values in create-app.ts, so unsetting an env var is a no-op. Each
// `*_MAX = 0` disables that limiter entirely (handy for staging load tests).
const limitField = (def: number) => z.coerce.number().int().nonnegative().default(def);
const windowField = (def: number) => z.coerce.number().int().positive().default(def);

export const rateLimitSchema = z.object({
  api: z.object({
    windowMs: windowField(15 * 60 * 1000),
    max: limitField(5000),
  }),
  auth: z.object({
    windowMs: windowField(15 * 60 * 1000),
    max: limitField(20),
  }),
  messages: z.object({ windowMs: windowField(60 * 1000), max: limitField(60) }),
  bookings: z.object({ windowMs: windowField(60 * 1000), max: limitField(30) }),
  reviews: z.object({ windowMs: windowField(60 * 1000), max: limitField(20) }),
  search: z.object({ windowMs: windowField(60 * 1000), max: limitField(120) }),
  // New limiters — narrowed protection for previously-unguarded hot paths.
  payments: z.object({ windowMs: windowField(60 * 1000), max: limitField(10) }),
  llm: z.object({ windowMs: windowField(60 * 1000), max: limitField(20) }),
  uploads: z.object({ windowMs: windowField(60 * 1000), max: limitField(30) }),
  listings: z.object({ windowMs: windowField(60 * 1000), max: limitField(300) }),
  // Coupon apply/validate — throttles code brute-forcing / enumeration.
  coupons: z.object({ windowMs: windowField(60 * 1000), max: limitField(20) }),
});

export type RateLimitConfig = z.infer<typeof rateLimitSchema>;
