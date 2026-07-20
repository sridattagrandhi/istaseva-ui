import { z } from 'zod';

export const searchSchema = z.object({
  provider: z.enum(['postgres']).default('postgres'),
});
