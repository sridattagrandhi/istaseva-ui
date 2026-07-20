// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  computePricingBreakdown,
  classifyGst,
  stateCodeFromGstin,
  gstStateCodeFromText,
  isInterState,
  formatRupees,
  formatINR,
} from './pricing-breakdown.js';

describe('classifyGst', () => {
  it('classifies stays under ₹7,500/night as 12% accommodation', () => {
    const r = classifyGst({}, { listing_type: 'stay', price_per_night: 5000 });
    expect(r.rate).toBe(0.12);
    expect(r.hsn).toBe('9963');
  });

  it('classifies stays over ₹7,500/night as 18% accommodation', () => {
    const r = classifyGst({}, { listing_type: 'stay', price_per_night: 10000 });
    expect(r.rate).toBe(0.18);
    expect(r.hsn).toBe('9963');
  });

  it('classifies transport as 5%', () => {
    const r = classifyGst({ service_category: 'auto' }, undefined);
    expect(r.rate).toBe(0.05);
    expect(r.hsn).toBe('9964');
  });

  it('falls through to support services 18%', () => {
    const r = classifyGst({ service_category: 'cleaning' }, undefined);
    expect(r.rate).toBe(0.18);
    expect(r.hsn).toBe('9985');
  });

  it('infers stay from price_per_night even without listing_type', () => {
    const r = classifyGst({}, { price_per_night: 3000 });
    expect(r.hsn).toBe('9963');
  });
});

describe('stateCodeFromGstin', () => {
  it('extracts the leading two-digit code', () => {
    expect(stateCodeFromGstin('29ABCDE1234F1Z5')).toBe('29');
  });
  it('returns null for missing or malformed input', () => {
    expect(stateCodeFromGstin(null)).toBeNull();
    expect(stateCodeFromGstin('XX0000')).toBeNull();
    expect(stateCodeFromGstin('')).toBeNull();
  });
});

describe('isInterState', () => {
  it('returns true when codes differ and both known', () => {
    expect(isInterState('29', '07')).toBe(true);
  });
  it('collapses to intra-state when either side is unknown', () => {
    expect(isInterState(null, '29')).toBe(false);
    expect(isInterState('29', null)).toBe(false);
  });
});

describe('computePricingBreakdown', () => {
  it('splits CGST + SGST for intra-state stay bookings', () => {
    // 12% on a stay; gross 11,200 paise → taxable 10,000, tax 1,200 split 600/600
    const b = computePricingBreakdown(
      { agreed_price_paise: 11200, metadata: { customer_gstin: '29ABCDE1234F1Z5' } },
      { listing_type: 'stay', price_per_night: 5000 },
      '29ABCDE1234F1Z5',
    );
    expect(b.grossPaise).toBe(11200);
    expect(b.taxablePaise).toBe(10000);
    expect(b.taxPaise).toBe(1200);
    expect(b.cgstPaise).toBe(600);
    expect(b.sgstPaise).toBe(600);
    expect(b.igstPaise).toBe(0);
    expect(b.interState).toBe(false);
  });

  it('uses IGST when provider and customer states differ', () => {
    const b = computePricingBreakdown(
      { agreed_price_paise: 11200, metadata: { customer_gstin: '07ABCDE1234F1Z5' } },
      { listing_type: 'stay', price_per_night: 5000 },
      '29ABCDE1234F1Z5',
    );
    expect(b.interState).toBe(true);
    expect(b.igstPaise).toBe(1200);
    expect(b.cgstPaise).toBe(0);
    expect(b.sgstPaise).toBe(0);
  });

  it('handles gross=0 without crashing (free bookings)', () => {
    const b = computePricingBreakdown({ agreed_price_paise: 0 }, undefined, null);
    expect(b.grossPaise).toBe(0);
    expect(b.taxablePaise).toBe(0);
    expect(b.taxPaise).toBe(0);
  });
});

describe('gstStateCodeFromText', () => {
  it('finds a state name inside a free-text address', () => {
    expect(gstStateCodeFromText('Jubilee Hills Check Post Road, Hyderabad, Telangana 500034')).toBe('36');
    expect(gstStateCodeFromText('MG Road, Bengaluru, Karnataka')).toBe('29');
  });

  it('is case- and punctuation-insensitive', () => {
    expect(gstStateCodeFromText('  tamil nadu.  ')).toBe('33');
    expect(gstStateCodeFromText('CHENNAI, TAMIL-NADU')).toBe('33');
  });

  it('prefers the longest state-name match', () => {
    // "daman and diu" is contained in the full UT name — the merged UT must win.
    expect(gstStateCodeFromText('Dadra and Nagar Haveli and Daman and Diu')).toBe('26');
  });

  it('maps common aliases', () => {
    expect(gstStateCodeFromText('Cuttack, Orissa')).toBe('21');
    expect(gstStateCodeFromText('Pondicherry beach road')).toBe('34');
  });

  it('returns null when no state name is present', () => {
    expect(gstStateCodeFromText('Flat 2B, 3rd Cross, near temple')).toBeNull();
    expect(gstStateCodeFromText('')).toBeNull();
    expect(gstStateCodeFromText(null)).toBeNull();
  });
});

describe('computePricingBreakdown — state derived from listing.state + booking.address', () => {
  const base = { agreed_price_paise: 112000, service_category: 'salon' };

  it('splits IGST when the address state differs from the listing state', () => {
    const b = computePricingBreakdown(
      { ...base, address: 'HSR Layout, Bengaluru, Karnataka' },
      { category: 'salon', state: 'Telangana' },
      null,
    );
    expect(b.interState).toBe(true);
    expect(b.igstPaise).toBe(b.taxPaise);
    expect(b.cgstPaise).toBe(0);
    expect(b.sgstPaise).toBe(0);
    expect(b.providerStateCode).toBe('36');
    expect(b.customerStateCode).toBe('29');
  });

  it('splits CGST+SGST when both states match', () => {
    const b = computePricingBreakdown(
      { ...base, address: 'Banjara Hills, Hyderabad, Telangana' },
      { category: 'salon', state: 'Telangana' },
      null,
    );
    expect(b.interState).toBe(false);
    expect(b.cgstPaise + b.sgstPaise).toBe(b.taxPaise);
    expect(b.igstPaise).toBe(0);
  });

  it('falls back to intra-state when the address names no state', () => {
    const b = computePricingBreakdown(
      { ...base, address: 'Flat 2B, 3rd Cross' },
      { category: 'salon', state: 'Telangana' },
      null,
    );
    expect(b.interState).toBe(false);
    expect(b.igstPaise).toBe(0);
  });

  it('GSTIN prefixes still take priority over name-derived states', () => {
    const b = computePricingBreakdown(
      { ...base, address: 'Somewhere, Karnataka', metadata: { customer_gstin: '36ABCDE1234F1Z5' } },
      { category: 'salon', state: 'Karnataka' },
      '36ABCDE1234F1Z5',
    );
    // Both GSTINs say Telangana (36) → intra-state, despite the Karnataka text.
    expect(b.interState).toBe(false);
    expect(b.providerStateCode).toBe('36');
    expect(b.customerStateCode).toBe('36');
  });
});

describe('formatRupees', () => {
  it('formats paise in INR with 2 decimals', () => {
    expect(formatRupees(11200)).toMatch(/^INR/);
    expect(formatRupees(11200)).toContain('.00');
  });
});

describe('formatINR (customer-facing)', () => {
  it('drops the decimals on round rupees', () => {
    expect(formatINR(900000)).toBe('₹9,000');
    expect(formatINR(162000)).toBe('₹1,620');
    expect(formatINR(1062000)).toBe('₹10,620');
  });

  it('uses Indian-style digit grouping (1,00,000 not 100,000)', () => {
    expect(formatINR(12500000)).toBe('₹1,25,000');
    expect(formatINR(999999900)).toBe('₹99,99,999');
  });

  it('keeps two decimals only when paise are non-zero', () => {
    expect(formatINR(123450)).toBe('₹1,234.50');
    expect(formatINR(99)).toBe('₹0.99');
  });

  it('renders zero / null / undefined / NaN as ₹0', () => {
    expect(formatINR(0)).toBe('₹0');
    expect(formatINR(null)).toBe('₹0');
    expect(formatINR(undefined)).toBe('₹0');
    expect(formatINR(Number.NaN)).toBe('₹0');
  });

  it('keeps the ₹ prefix on negatives, with a leading minus', () => {
    expect(formatINR(-50000)).toBe('-₹500');
    expect(formatINR(-123450)).toBe('-₹1,234.50');
  });
});
