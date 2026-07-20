// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { looksLikeStreetAddress, scanAddressInProse } from './address-in-prose.js';

describe('address-in-prose guardrail (WS6 follow-up)', () => {
  it('flags a complete address: door number + road', () => {
    expect(looksLikeStreetAddress('Stay at 12 Temple Road, close to the river')).toBe(true);
    expect(looksLikeStreetAddress('D.No 4-2-118, Gandhi Street, Vellore')).toBe(true);
    expect(looksLikeStreetAddress('Plot 17, Jubilee Hills')).toBe(true);
    expect(looksLikeStreetAddress('Flat No 3B, #12 cross')).toBe(true);
  });

  it('flags an Indian PIN code', () => {
    expect(looksLikeStreetAddress('Near the bus stand, Tirupati 517501')).toBe(true);
  });

  it('does NOT flag area references or the leaky seed phrasing', () => {
    // The agreed line: a well-known road NAME is fine; a complete address is not.
    expect(looksLikeStreetAddress('Affordable pilgrim stay near Tirumala By-pass Road in Tirupati')).toBe(false);
    expect(looksLikeStreetAddress('5 minutes from the temple, quiet neighbourhood')).toBe(false);
    expect(looksLikeStreetAddress('Cozy homestay in Hampi, Karnataka')).toBe(false);
  });

  it('does NOT mistake prices for PIN codes', () => {
    expect(looksLikeStreetAddress('Weekly rate ₹150000 for the full villa')).toBe(false);
    expect(looksLikeStreetAddress('Rs 250000 per month, all inclusive')).toBe(false);
  });

  it('produces a WARN-severity issue, never blocking', () => {
    const issues = scanAddressInProse('description', 'House 12, MG Road, 560001');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].code).toBe('address_in_prose');
    expect(issues[0].message).toMatch(/only shared|confirmed guests/i);
  });

  it('ignores non-strings and clean text', () => {
    expect(scanAddressInProse('description', undefined)).toEqual([]);
    expect(scanAddressInProse('name', 'Riverside Homestay')).toEqual([]);
  });
});
