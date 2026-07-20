import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TranslationRepository } from './translation.repository.js';

// Requires a real Redis at localhost:6379 (docker compose up -d redis).
// Run with: npx vitest run server/src/modules/translation/repositories/translation.repository.test.ts

const repo = new TranslationRepository();
const SRC = 'en';
const TGT = 'hi';

// Use a fixed test prefix so cleanup is scoped and doesn't touch app data.
const TEXT_A = '__test__repo_hello__';
const TEXT_B = '__test__repo_world__';
const HASH_A = TranslationRepository.hashText(TEXT_A);
const HASH_B = TranslationRepository.hashText(TEXT_B);

beforeAll(async () => {
  // Clean up any leftover keys from a previous run.
  const { redis } = await import('../../../common/cache/redis.js');
  await redis.del(`txl:${SRC}:${TGT}:${HASH_A}`, `txl:${SRC}:${TGT}:${HASH_B}`);
});

afterAll(async () => {
  const { redis } = await import('../../../common/cache/redis.js');
  await redis.del(`txl:${SRC}:${TGT}:${HASH_A}`, `txl:${SRC}:${TGT}:${HASH_B}`);
  redis.disconnect();
});

describe('TranslationRepository (Redis integration)', () => {
  it('returns empty map when no keys are cached', async () => {
    const result = await repo.findMany(SRC, TGT, [HASH_A, HASH_B]);
    expect(result.size).toBe(0);
  });

  it('upsertMany writes translations and findMany retrieves them', async () => {
    await repo.upsertMany(SRC, TGT, [
      { textHash: HASH_A, originalText: TEXT_A, translatedText: 'नमस्ते' },
      { textHash: HASH_B, originalText: TEXT_B, translatedText: 'दुनिया' },
    ]);

    const result = await repo.findMany(SRC, TGT, [HASH_A, HASH_B]);
    expect(result.get(HASH_A)).toBe('नमस्ते');
    expect(result.get(HASH_B)).toBe('दुनिया');
  });

  it('findMany returns only the hashes that exist', async () => {
    const result = await repo.findMany(SRC, TGT, [HASH_A, 'nonexistent_hash']);
    expect(result.size).toBe(1);
    expect(result.get(HASH_A)).toBe('नमस्ते');
  });

  it('upsertMany overwrites existing entries', async () => {
    await repo.upsertMany(SRC, TGT, [
      { textHash: HASH_A, originalText: TEXT_A, translatedText: 'हेलो' },
    ]);
    const result = await repo.findMany(SRC, TGT, [HASH_A]);
    expect(result.get(HASH_A)).toBe('हेलो');
  });

  it('hashText is deterministic and normalises whitespace/case', () => {
    expect(TranslationRepository.hashText('Hello')).toBe(TranslationRepository.hashText('hello'));
    expect(TranslationRepository.hashText('  Hello  ')).toBe(TranslationRepository.hashText('hello'));
  });

  it('findMany handles empty hash list without error', async () => {
    const result = await repo.findMany(SRC, TGT, []);
    expect(result.size).toBe(0);
  });

  it('upsertMany handles empty entries without error', async () => {
    await expect(repo.upsertMany(SRC, TGT, [])).resolves.toBeUndefined();
  });
});
