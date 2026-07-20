import { describe, it, expect } from 'vitest';
import { scanProhibitedContent } from '../prohibited-content.js';

describe('scanProhibitedContent', () => {
  it('accepts ordinary, legitimate values', () => {
    expect(scanProhibitedContent('name', 'Sunrise Homestay')).toEqual([]);
    expect(scanProhibitedContent('vehicleName', 'Toyota Innova')).toEqual([]);
    expect(scanProhibitedContent('description', 'Cozy 2-bedroom place near the lake.')).toEqual([]);
    expect(scanProhibitedContent('subcategories', ['Haircut', 'Beard trim'])).toEqual([]);
  });

  it('rejects clearly-prohibited content with a stable code', () => {
    const weapons = scanProhibitedContent('vehicleName', 'Toyota with a gun');
    expect(weapons).toHaveLength(1);
    expect(weapons[0].code).toBe('prohibited_weapons');
    expect(weapons[0].field).toBe('vehicleName');

    expect(scanProhibitedContent('category', 'cocaine delivery')[0]?.code).toBe('prohibited_drugs');
    expect(scanProhibitedContent('subcategories', ['haircut', 'escort'])[0]?.code)
      .toBe('prohibited_sexual_services');
  });

  it('uses word boundaries — no false positives on legitimate substrings', () => {
    // "bomb" in "Bombay", "arms" in "Armstrong", "meth" in "method".
    expect(scanProhibitedContent('location', 'Bombay, Maharashtra')).toEqual([]);
    expect(scanProhibitedContent('name', 'Armstrong Cleaners')).toEqual([]);
    expect(scanProhibitedContent('description', 'A methodical, careful plumber.')).toEqual([]);
  });

  it('ignores non-string / structured values (their shape is gated elsewhere)', () => {
    expect(scanProhibitedContent('price', 500)).toEqual([]);
    expect(scanProhibitedContent('servicesCatalog', [{ name: 'Haircut', basePrice: 500 }])).toEqual([]);
    expect(scanProhibitedContent('flexibleHours', true)).toEqual([]);
  });
});
