import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../../common/errors/app-error.js';
import { translationService } from '../services/translation.service.js';

// Supported targets mirror the frontend's i18next locales. Source is
// expected to be English in ~all current callers but we accept any tag to
// future-proof (e.g., host writes a Tamil description, guest reads Hindi).
const langRegex = /^[a-z]{2}$/;

const bodySchema = z.object({
  sourceLang: z.string().regex(langRegex).default('en'),
  targetLang: z.string().regex(langRegex),
  texts: z.array(z.string().min(1).max(5000)).min(1).max(100),
});

export class TranslationController {
  async translate(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      const { sourceLang, targetLang, texts } = parsed.data;
      const translations = await translationService.translate(sourceLang, targetLang, texts);
      res.json({ success: true, data: { translations } });
    } catch (err) {
      next(err);
    }
  }
}

export const translationController = new TranslationController();
