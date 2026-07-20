import { translationRepository, TranslationRepository } from '../repositories/translation.repository.js';
import { createTranslateProvider, TranslateProvider } from './bhashini.service.js';

/**
 * Orchestrates cache-first lookup with provider-backed fallback.
 *
 * Flow per request:
 *  1. Hash each input text.
 *  2. Bulk-fetch cached translations for all hashes in one SELECT.
 *  3. Translate the misses via the configured provider (Bhashini or passthrough).
 *  4. Bulk-upsert the new rows.
 *  5. Return translations in the same order as the input array.
 *
 * Same-language translation is a no-op — we short-circuit before touching the
 * DB so the cache doesn't fill with identity mappings.
 */
export class TranslationService {
  private provider: TranslateProvider = createTranslateProvider();

  async translate(sourceLang: string, targetLang: string, texts: string[]): Promise<string[]> {
    if (texts.length === 0) return [];
    if (sourceLang === targetLang) return texts.slice();

    const normalizedHashes = texts.map((t) => TranslationRepository.hashText(t));
    const uniqueHashes = Array.from(new Set(normalizedHashes));

    const cached = await translationRepository.findMany(sourceLang, targetLang, uniqueHashes);

    // Collect unique misses so we don't pay the provider for duplicates.
    const missIndex = new Map<string, string>(); // hash -> original text
    for (let i = 0; i < texts.length; i++) {
      const hash = normalizedHashes[i];
      if (!cached.has(hash) && !missIndex.has(hash)) missIndex.set(hash, texts[i]);
    }

    if (missIndex.size > 0) {
      const missHashes = Array.from(missIndex.keys());
      const missTexts = missHashes.map((h) => missIndex.get(h)!);
      const translated = await this.provider.translateBatch({ sourceLang, targetLang, texts: missTexts });

      const upserts = missHashes.map((hash, i) => ({
        textHash: hash,
        originalText: missTexts[i],
        translatedText: translated[i],
      }));
      await translationRepository.upsertMany(sourceLang, targetLang, upserts);
      for (const u of upserts) cached.set(u.textHash, u.translatedText);
    }

    return normalizedHashes.map((hash, i) => cached.get(hash) ?? texts[i]);
  }
}

export const translationService = new TranslationService();
