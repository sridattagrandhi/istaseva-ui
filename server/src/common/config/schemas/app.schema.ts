import { z } from 'zod';

const DEFAULT_PORT = Number(process.env.PORT) || 3001;

export const appSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  environment: z.enum(['local', 'development', 'staging', 'production', 'test']).default('development'),
  port: z.coerce.number().int().positive().default(DEFAULT_PORT),
  apiUrl: z.string().url().default(`http://localhost:${DEFAULT_PORT}`),
  frontendUrl: z.string().url().default('http://localhost:8080'),
  logLevel: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).default('debug'),
  /** IstaSeva's own GSTIN — printed on invoices alongside the host's GSTIN
   *  so the platform's commission line item is properly attributable. Empty
   *  string means we omit the platform GSTIN line. */
  platformGstin: z.string().optional().default(''),
});
