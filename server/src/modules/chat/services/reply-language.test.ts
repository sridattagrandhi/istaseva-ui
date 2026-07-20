// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { detectMessageLanguage, perTurnLanguageDirective } from './reply-language.js';

describe('detectMessageLanguage', () => {
  it('detects each native Indian script', () => {
    expect(detectMessageLanguage('హైదరాబాద్‌లో హోటల్స్ ఏవి?')?.name).toBe('Telugu');
    expect(detectMessageLanguage('ஹைதராபாத்தில் ஹோட்டல்கள் உள்ளதா?')?.name).toBe('Tamil');
    expect(detectMessageLanguage('ಹೈದರಾಬಾದ್‌ನಲ್ಲಿ ಹೋಟೆಲ್‌ಗಳಿವೆಯೇ?')?.name).toBe('Kannada');
    expect(detectMessageLanguage('നമസ്കാരം, ഹോട്ടലുകൾ ഉണ്ടോ?')?.name).toBe('Malayalam');
    expect(detectMessageLanguage('হায়দরাবাদে হোটেল আছে?')?.name).toBe('Bengali');
    expect(detectMessageLanguage('હૈદરાબાદમાં હોટેલ છે?')?.name).toBe('Gujarati');
    expect(detectMessageLanguage('हैदराबाद में होटल हैं?')?.name).toBe('Hindi or Marathi');
  });

  it('returns null for English / romanized / Spanish (Latin script)', () => {
    expect(detectMessageLanguage('any hotels in Hyderabad under 3000?')).toBeNull();
    expect(detectMessageLanguage('naaku oka haircut kaavali')).toBeNull();
    expect(detectMessageLanguage('Buenos días, ¿tienen hoteles?')).toBeNull();
  });

  it('ignores a stray glyph in otherwise-English text', () => {
    // A single Devanagari char (e.g. emoji-adjacent) is below the threshold.
    expect(detectMessageLanguage('ok ठ')).toBeNull();
  });
});

describe('perTurnLanguageDirective', () => {
  it('produces a hard directive naming the script for native input', () => {
    const d = perTurnLanguageDirective('హైదరాబాద్‌లో హోటల్స్ ఏవి?');
    expect(d).toContain('Telugu');
    expect(d).toContain('non-negotiable');
  });

  it('names both Hindi and Marathi for Devanagari', () => {
    expect(perTurnLanguageDirective('हैदराबाद में होटल हैं?')).toContain('Hindi or Marathi');
  });

  it('is empty for English so the prompt decides', () => {
    expect(perTurnLanguageDirective('any hotels in Hyderabad?')).toBe('');
  });
});
