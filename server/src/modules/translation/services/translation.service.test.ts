import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranslationService } from './translation.service.js';

const { mockFindMany, mockUpsertMany, mockTranslateBatch } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockUpsertMany: vi.fn(),
  mockTranslateBatch: vi.fn(),
}));

vi.mock('../repositories/translation.repository.js', () => ({
  translationRepository: {
    findMany: (...args: unknown[]) => mockFindMany(...args),
    upsertMany: (...args: unknown[]) => mockUpsertMany(...args),
  },
  TranslationRepository: {
    hashText: (text: string) => `hash:${text}`,
  },
}));

vi.mock('./bhashini.service.js', () => ({
  createTranslateProvider: () => ({ translateBatch: mockTranslateBatch }),
}));

describe('TranslationService', () => {
  let service: TranslationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TranslationService();
  });

  it('returns source texts unchanged when sourceLang === targetLang', async () => {
    const result = await service.translate('hi', 'hi', ['नमस्ते']);
    expect(result).toEqual(['नमस्ते']);
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockTranslateBatch).not.toHaveBeenCalled();
  });

  it('returns empty array for empty input', async () => {
    const result = await service.translate('en', 'hi', []);
    expect(result).toEqual([]);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('returns cached translations without calling provider on full cache hit', async () => {
    mockFindMany.mockResolvedValue(new Map([['hash:Hello', 'नमस्ते']]));

    const result = await service.translate('en', 'hi', ['Hello']);
    expect(result).toEqual(['नमस्ते']);
    expect(mockTranslateBatch).not.toHaveBeenCalled();
    expect(mockUpsertMany).not.toHaveBeenCalled();
  });

  it('calls provider for cache misses and writes results back', async () => {
    mockFindMany.mockResolvedValue(new Map());
    mockTranslateBatch.mockResolvedValue(['नमस्ते', 'धन्यवाद']);
    mockUpsertMany.mockResolvedValue(undefined);

    const result = await service.translate('en', 'hi', ['Hello', 'Thank you']);
    expect(result).toEqual(['नमस्ते', 'धन्यवाद']);
    expect(mockTranslateBatch).toHaveBeenCalledWith({
      sourceLang: 'en',
      targetLang: 'hi',
      texts: ['Hello', 'Thank you'],
    });
    expect(mockUpsertMany).toHaveBeenCalledWith('en', 'hi', [
      { textHash: 'hash:Hello', originalText: 'Hello', translatedText: 'नमस्ते' },
      { textHash: 'hash:Thank you', originalText: 'Thank you', translatedText: 'धन्यवाद' },
    ]);
  });

  it('only calls provider for misses when cache is partially warm', async () => {
    mockFindMany.mockResolvedValue(new Map([['hash:Hello', 'नमस्ते']]));
    mockTranslateBatch.mockResolvedValue(['धन्यवाद']);
    mockUpsertMany.mockResolvedValue(undefined);

    const result = await service.translate('en', 'hi', ['Hello', 'Thank you']);
    expect(result).toEqual(['नमस्ते', 'धन्यवाद']);
    expect(mockTranslateBatch).toHaveBeenCalledWith({
      sourceLang: 'en',
      targetLang: 'hi',
      texts: ['Thank you'],
    });
  });

  it('deduplicates duplicate input texts before calling provider', async () => {
    mockFindMany.mockResolvedValue(new Map());
    mockTranslateBatch.mockResolvedValue(['नमस्ते']);
    mockUpsertMany.mockResolvedValue(undefined);

    const result = await service.translate('en', 'hi', ['Hello', 'Hello', 'Hello']);
    expect(result).toEqual(['नमस्ते', 'नमस्ते', 'नमस्ते']);
    expect(mockTranslateBatch).toHaveBeenCalledWith({
      sourceLang: 'en',
      targetLang: 'hi',
      texts: ['Hello'],
    });
  });
});
