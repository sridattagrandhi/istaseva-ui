import { z } from 'zod';

export const fraudSignalSchema = z.object({
  eventType: z.string().min(1),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
  metadata: z.record(z.string(), z.unknown()).optional(),
  deviceId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  ipAddress: z.string().min(1).optional(),
});

export type FraudSignalInput = z.infer<typeof fraudSignalSchema>;
