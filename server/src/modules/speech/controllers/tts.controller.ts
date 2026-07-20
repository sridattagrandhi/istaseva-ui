import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../../common/errors/app-error.js';
import { logger } from '../../../common/logging/logger.js';
import { ttsService } from '../services/tts.service.js';

const ttsSchema = z.object({
  text: z.string().min(1).max(4500),
  lang: z.string().optional(),
  voice: z.string().optional(),
  speakingRate: z.number().min(0.25).max(2).optional(),
  pitch: z.number().min(-20).max(20).optional(),
});

export class TtsController {
  async synthesize(req: Request, res: Response, next: NextFunction) {
    try {
      if (!ttsService.enabled) {
        res.status(503).json({ error: { message: 'TTS provider is not configured' } });
        return;
      }

      const parsed = ttsSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      const result = await ttsService.synthesize({
        text: parsed.data.text,
        lang: parsed.data.lang,
        voiceName: parsed.data.voice,
        speakingRate: parsed.data.speakingRate,
        pitch: parsed.data.pitch,
      });

      res.json(result);
    } catch (err) {
      // Upstream Google TTS failures (API disabled, quota, etc.) shouldn't
      // bubble as 500s — the browser client treats this endpoint as optional
      // and falls back to window.speechSynthesis on any non-OK response.
      // Return 503 so the failure is visibly "service unavailable" rather
      // than an app bug, and so the client stops retrying this session.
      logger.error('TTS synthesis error', { error: (err as Error).message });
      if (err instanceof ValidationError) return next(err);
      res.status(503).json({ error: { message: 'TTS temporarily unavailable' } });
    }
  }
}

export const ttsController = new TtsController();
