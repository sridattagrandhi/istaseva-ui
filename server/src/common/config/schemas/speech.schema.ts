import { z } from 'zod';

export const speechSchema = z.object({
  ttsProvider: z.enum(['google', 'none']).default('none'),
  // Cloud TTS auth now piggy-backs on the Vertex SA (see tts.service.ts).
  // No googleApiKey field — one Google credential for the whole app.
  googleVoiceModel: z.string().default('Neural2'),
});
