import { describe, it, expect } from 'vitest';
import { SUPPORTED_LANGUAGES, filterToSupportedLanguages } from '../supported-languages.js';

describe('filterToSupportedLanguages', () => {
  it('keeps supported languages and drops unsupported ones', () => {
    // The user's example: "English, Hindi, German" → German dropped.
    expect(filterToSupportedLanguages(['English', 'Hindi', 'German'])).toEqual(['English', 'Hindi']);
  });

  it('canonicalizes casing (model emits lowercase; form chips are Title Case)', () => {
    expect(filterToSupportedLanguages(['english', 'HINDI', 'telugu'])).toEqual(['English', 'Hindi', 'Telugu']);
  });

  it('de-dupes case-insensitively', () => {
    expect(filterToSupportedLanguages(['English', 'english', 'ENGLISH'])).toEqual(['English']);
  });

  it('returns [] when nothing is supported (so the required-gate keeps blocking)', () => {
    expect(filterToSupportedLanguages(['German', 'French', 'Spanish'])).toEqual([]);
    expect(filterToSupportedLanguages([])).toEqual([]);
    expect(filterToSupportedLanguages('English')).toEqual([]); // non-array
  });

  it('accepts every language in the canonical set', () => {
    expect(filterToSupportedLanguages([...SUPPORTED_LANGUAGES])).toEqual([...SUPPORTED_LANGUAGES]);
  });
});
