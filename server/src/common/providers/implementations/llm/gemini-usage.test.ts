import { describe, it, expect } from 'vitest';
import { summarizeGeminiUsage } from './gemini-usage.js';

describe('summarizeGeminiUsage', () => {
  it('flattens usageMetadata and computes the cached percentage', () => {
    const result = {
      usageMetadata: {
        promptTokenCount: 27000,
        candidatesTokenCount: 180,
        cachedContentTokenCount: 24000,
        thoughtsTokenCount: 0,
        totalTokenCount: 27180,
      },
    };

    expect(summarizeGeminiUsage(result)).toEqual({
      promptTokens: 27000,
      cachedTokens: 24000,
      cachedPct: 89, // round(24000 / 27000 * 100)
      outputTokens: 180,
      thoughtsTokens: 0,
      totalTokens: 27180,
    });
  });

  it('reports cachedPct 0 when nothing is cached (the COST-002 baseline)', () => {
    const summary = summarizeGeminiUsage({
      usageMetadata: { promptTokenCount: 27000, candidatesTokenCount: 200, totalTokenCount: 27200 },
    });
    expect(summary?.cachedTokens).toBe(0);
    expect(summary?.cachedPct).toBe(0);
  });

  it('never divides by zero when there are no prompt tokens', () => {
    const summary = summarizeGeminiUsage({ usageMetadata: {} });
    expect(summary).toEqual({
      promptTokens: 0,
      cachedTokens: 0,
      cachedPct: 0,
      outputTokens: 0,
      thoughtsTokens: 0,
      totalTokens: 0,
    });
  });

  it('returns null when the response carries no usage metadata', () => {
    expect(summarizeGeminiUsage({})).toBeNull();
    expect(summarizeGeminiUsage(null)).toBeNull();
    expect(summarizeGeminiUsage(undefined)).toBeNull();
    expect(summarizeGeminiUsage({ candidates: [] })).toBeNull();
  });
});
