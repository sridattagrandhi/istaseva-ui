import { z } from 'zod';

export const databaseSchema = z.object({
  provider: z.enum(['postgres']).default('postgres'),
  url: z.string().min(1),
  poolMin: z.coerce.number().int().nonnegative().default(2),
  poolMax: z.coerce.number().int().positive().default(20),
});
