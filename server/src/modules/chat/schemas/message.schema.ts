import { z } from 'zod';

export const sendMessageSchema = z.object({
  receiver_id: z.string().min(1),
  content: z.string().min(1).max(5000),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
