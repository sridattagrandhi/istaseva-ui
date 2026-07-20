import { z } from 'zod';

export const kycSchema = z.object({
  provider: z.enum(['mock', 'digilocker']).default('mock'),
  digilockerClientId: z.string().optional(),
  digilockerClientSecret: z.string().optional(),
  digilockerRedirectUri: z.string().url().optional(),
});
