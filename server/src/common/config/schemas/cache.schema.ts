import { z } from 'zod';
import { booleanish } from './booleanish.js';

export const cacheSchema = z.object({
  provider: z.enum(['redis', 'mock']).default('redis'),
  url: z.string().min(1).optional(),
  host: z.string().min(1).default('localhost'),
  port: z.coerce.number().int().positive().default(6379),
  tls: booleanish.default(false),
  /** ElastiCache AUTH token (REDIS_AUTH_TOKEN). Optional — local docker Redis
   *  runs unauthenticated; deployed environments inject it via ECS secrets. */
  authToken: z.string().min(1).optional(),
  keyPrefix: z.string().default('instaserve'),
  defaultTtlSeconds: z.coerce.number().int().positive().default(300),
  bookingHoldTtlSeconds: z.coerce.number().int().positive().default(300),
  idempotencyTtlSeconds: z.coerce.number().int().positive().default(600),
});
