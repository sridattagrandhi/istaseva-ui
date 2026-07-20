import { createHash } from 'node:crypto';
import { redis } from '../../../common/cache/redis.js';

const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function rkey(sourceLang: string, targetLang: string, hash: string): string {
  return `txl:${sourceLang}:${targetLang}:${hash}`;
}

export class TranslationRepository {
  static hashText(text: string): string {
    return createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
  }

  async findMany(
    sourceLang: string,
    targetLang: string,
    textHashes: string[],
  ): Promise<Map<string, string>> {
    if (textHashes.length === 0) return new Map();
    const keys = textHashes.map((h) => rkey(sourceLang, targetLang, h));
    const values = await redis.mget(...keys);
    const map = new Map<string, string>();
    for (let i = 0; i < textHashes.length; i++) {
      if (values[i] !== null) map.set(textHashes[i], values[i] as string);
    }
    return map;
  }

  async upsertMany(
    sourceLang: string,
    targetLang: string,
    entries: Array<{ textHash: string; originalText: string; translatedText: string }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    const pipeline = redis.pipeline();
    for (const { textHash, translatedText } of entries) {
      pipeline.set(rkey(sourceLang, targetLang, textHash), translatedText, 'EX', TTL_SECONDS);
    }
    await pipeline.exec();
  }
}

export const translationRepository = new TranslationRepository();
