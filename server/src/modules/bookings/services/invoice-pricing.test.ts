// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { computeInvoiceLines, type InvoicePaymentRow } from './invoice-pricing.js';
import type { PricingBreakdown } from './pricing-breakdown.js';

const fallback = (overrides?: Partial<PricingBreakdown>): PricingBreakdown => ({
  grossPaise: 1232_00,
  taxablePaise: 1100_00,
  taxPaise: 132_00,
  cgstPaise: 66_00,
  sgstPaise: 66_00,
  igstPaise: 0,
  interState: false,
  customerStateCode: null,
  providerStateCode: null,
  gst: { rate: 0.12, hsn: '9963', label: 'Accommodation services' },
  ...overrides,
});

describe('computeInvoiceLines — stored breakdown path (post-migration)', () => {
  it('uses stored values directly so the modal numbers match the invoice', () => {
    const payment: InvoicePaymentRow = {
      amount_paise: 1252_00,
      subtotal_paise: 1000_00,
      platform_fee_paise: 100_00,
      taxes_paise: 132_00,
      insurance_premium_paise: 20_00,
      discount_paise: null,
      method: 'UPI',
    };
    const r = computeInvoiceLines(payment, fallback(), 'stay');
    expect(r.source).toBe('stored');
    expect(r.baseLabel).toBe('Base cost');
    expect(r.subtotalPaise).toBe(1000_00);
    expect(r.platformFeePaise).toBe(100_00);
    expect(r.taxesPaise).toBe(132_00);
    expect(r.insurancePaise).toBe(20_00);
    expect(r.lineTaxablePaise).toBe(1100_00); // subtotal + platform fee
    expect(r.totalPaise).toBe(1252_00);
  });

  it('CGST + SGST sum exactly to taxes_paise (rounding absorbed in SGST)', () => {
    // Pick a value where halving gives a half-paise. With taxes_paise = 13201
    // → cgst = round(13201/2) = 6601, sgst = 13201 - 6601 = 6600. Sum = 13201.
    const payment: InvoicePaymentRow = {
      amount_paise: 1252_01,
      subtotal_paise: 1000_00,
      platform_fee_paise: 100_00,
      taxes_paise: 132_01,
      insurance_premium_paise: 20_00,
      discount_paise: null,
    };
    const r = computeInvoiceLines(payment, fallback(), 'stay');
    expect(r.cgstPaise + r.sgstPaise).toBe(r.taxesPaise);
  });

  it('parts always reconcile to amount_paise — stay scenario', () => {
    const payment: InvoicePaymentRow = {
      amount_paise: 1252_00,
      subtotal_paise: 1000_00,
      platform_fee_paise: 100_00,
      taxes_paise: 132_00,
      insurance_premium_paise: 20_00,
      discount_paise: null,
    };
    const r = computeInvoiceLines(payment, fallback(), 'stay');
    expect(
      r.subtotalPaise + r.platformFeePaise + r.taxesPaise + r.insurancePaise,
    ).toBe(r.totalPaise);
  });

  it('discount: stores ORIGINAL subtotal so the invoice can show base + discount separately', () => {
    // ₹1,000 base − ₹200 coupon → discounted 800 → 10% fee 80 → 12% GST on
    // (800 + 80) = 105.60 → total 985.60. Invoice rows render as:
    //   Base cost     ₹1,000
    //   Platform fee  ₹80
    //   Discount      −₹200
    //   GST (CGST+SGST) ₹105.60
    //   Total paid    ₹985.60
    // Reconciliation: subtotal − discount + fee + GST + insurance == total.
    const payment: InvoicePaymentRow = {
      amount_paise: 985_60,
      subtotal_paise: 1000_00,   // ORIGINAL, not discounted
      platform_fee_paise: 80_00,
      taxes_paise: 105_60,
      insurance_premium_paise: 0,
      discount_paise: 200_00,
    };
    const r = computeInvoiceLines(payment, fallback({ grossPaise: 985_60 }), 'stay');
    expect(r.subtotalPaise).toBe(1000_00);
    expect(r.discountPaise).toBe(200_00);
    // The line-item taxable value is the GST base = (subtotal − discount + fee).
    expect(r.lineTaxablePaise).toBe(880_00);
    // Visual reconciliation: subtotal − discount + fee + taxes + insurance == total.
    expect(
      r.subtotalPaise - r.discountPaise
        + r.platformFeePaise + r.taxesPaise + r.insurancePaise,
    ).toBe(r.totalPaise);
  });

  it('no-discount case still reconciles (subtotal + fee + taxes + insurance == total)', () => {
    const payment: InvoicePaymentRow = {
      amount_paise: 1252_00,
      subtotal_paise: 1000_00,
      platform_fee_paise: 100_00,
      taxes_paise: 132_00,
      insurance_premium_paise: 20_00,
      discount_paise: 0,
    };
    const r = computeInvoiceLines(payment, fallback(), 'stay');
    expect(r.lineTaxablePaise).toBe(1100_00); // subtotal + platformFee
    expect(
      r.subtotalPaise + r.platformFeePaise + r.taxesPaise + r.insurancePaise,
    ).toBe(r.totalPaise);
  });

  it('labels Trip fare for transport bookings', () => {
    const payment: InvoicePaymentRow = {
      amount_paise: 866_25,
      subtotal_paise: 750_00,
      platform_fee_paise: 75_00,
      taxes_paise: 41_25,
      insurance_premium_paise: 0,
      discount_paise: null,
    };
    const r = computeInvoiceLines(payment, fallback({ gst: { rate: 0.05, hsn: '9964', label: 'Passenger transport' } }), 'transport');
    expect(r.baseLabel).toBe('Trip fare');
    expect(r.lineTaxablePaise).toBe(825_00);
  });

  it('labels Service cost for service bookings', () => {
    const payment: InvoicePaymentRow = {
      amount_paise: 2596_00,
      subtotal_paise: 2000_00,
      platform_fee_paise: 200_00,
      taxes_paise: 396_00,
      insurance_premium_paise: 0,
      discount_paise: null,
    };
    const r = computeInvoiceLines(payment, fallback({ gst: { rate: 0.18, hsn: '9985', label: 'Support services' } }), 'service');
    expect(r.baseLabel).toBe('Service cost');
  });

  it('treats string-typed paise (pg may return numerics as strings) as numbers', () => {
    const payment: InvoicePaymentRow = {
      amount_paise: '1252_00'.replace('_', '') as any,
      subtotal_paise: '100000' as any,
      platform_fee_paise: '10000' as any,
      taxes_paise: '13200' as any,
      insurance_premium_paise: '2000' as any,
      discount_paise: null,
    };
    const r = computeInvoiceLines(payment, fallback(), 'stay');
    expect(r.source).toBe('stored');
    expect(r.subtotalPaise).toBe(100000);
    expect(r.platformFeePaise).toBe(10000);
  });
});

describe('computeInvoiceLines — legacy fallback path (pre-migration row)', () => {
  it('falls back to taxablePaise + tax split when breakdown columns are NULL', () => {
    const payment: InvoicePaymentRow = {
      amount_paise: 1232_00,
      subtotal_paise: null,
      platform_fee_paise: null,
      taxes_paise: null,
      insurance_premium_paise: null,
      discount_paise: null,
    };
    const r = computeInvoiceLines(payment, fallback(), 'stay');
    expect(r.source).toBe('legacy');
    expect(r.subtotalPaise).toBe(1100_00);   // taxablePaise from fallback
    expect(r.platformFeePaise).toBe(0);       // legacy invoices had no fee line
    expect(r.taxesPaise).toBe(132_00);
    expect(r.lineTaxablePaise).toBe(1100_00);
  });

  it('falls back when paymentRow itself is missing', () => {
    const r = computeInvoiceLines(null, fallback(), 'stay');
    expect(r.source).toBe('legacy');
    expect(r.totalPaise).toBe(1232_00);
  });

  it('parts reconcile to grossPaise on the legacy path too', () => {
    const r = computeInvoiceLines(null, fallback(), 'stay');
    expect(r.subtotalPaise + r.taxesPaise).toBe(r.totalPaise);
  });
});

describe('computeInvoiceLines — hotel invoice/email parity (regression)', () => {
  // The exact screenshot case reported in the fix: hotel booking with
  // base ₹2,000, platform fee ₹180 (10% of post-discount base), ₹200
  // coupon discount, ₹261.60 GST @ 12%, ₹40 insurance → ₹2,281.60 total.
  // Previously the PDF reverse-derived the taxable subtotal from
  // agreed_price_paise and hid the platform fee + discount inside it.
  it('renders the exact reported breakdown without reverse-deriving', () => {
    const payment: InvoicePaymentRow = {
      amount_paise: 2281_60,
      subtotal_paise: 2000_00,
      platform_fee_paise: 180_00,
      taxes_paise: 261_60,
      insurance_premium_paise: 40_00,
      discount_paise: 200_00,
      method: 'UPI',
    };
    const r = computeInvoiceLines(payment, fallback({ grossPaise: 2241_60 }), 'stay');
    expect(r.source).toBe('stored');
    expect(r.baseLabel).toBe('Base cost');
    expect(r.subtotalPaise).toBe(2000_00);
    expect(r.platformFeePaise).toBe(180_00);
    expect(r.discountPaise).toBe(200_00);
    expect(r.taxesPaise).toBe(261_60);
    expect(r.cgstPaise).toBe(130_80);
    expect(r.sgstPaise).toBe(130_80);
    expect(r.cgstPaise + r.sgstPaise).toBe(r.taxesPaise);
    expect(r.insurancePaise).toBe(40_00);
    expect(r.totalPaise).toBe(2281_60); // uses amount_paise, NOT fallback.grossPaise
    expect(
      r.subtotalPaise - r.discountPaise + r.platformFeePaise + r.taxesPaise + r.insurancePaise,
    ).toBe(r.totalPaise);
  });

  it('hotel invoice without discount/insurance hides those rows', () => {
    // ₹2,000 base + 10% platform fee + 12% GST on (base + fee) = 264 → 2464 total.
    const payment: InvoicePaymentRow = {
      amount_paise: 2464_00,
      subtotal_paise: 2000_00,
      platform_fee_paise: 200_00,
      taxes_paise: 264_00,
      insurance_premium_paise: 0,
      discount_paise: 0,
    };
    const r = computeInvoiceLines(payment, fallback(), 'stay');
    expect(r.source).toBe('stored');
    expect(r.discountPaise).toBe(0);
    expect(r.insurancePaise).toBe(0);
    expect(r.cgstPaise).toBe(132_00);
    expect(r.sgstPaise).toBe(132_00);
    expect(r.totalPaise).toBe(2464_00);
    expect(
      r.subtotalPaise + r.platformFeePaise + r.taxesPaise,
    ).toBe(r.totalPaise);
  });

  it('service invoice exposes explicit service cost + fee + GST + total', () => {
    const payment: InvoicePaymentRow = {
      amount_paise: 1239_00,
      subtotal_paise: 1000_00,
      platform_fee_paise: 100_00,
      taxes_paise: 139_00,
      insurance_premium_paise: 0,
      discount_paise: 0,
    };
    const r = computeInvoiceLines(
      payment,
      fallback({ gst: { rate: 0.18, hsn: '9985', label: 'Support services' } }),
      'service',
    );
    expect(r.source).toBe('stored');
    expect(r.baseLabel).toBe('Service cost');
    expect(r.subtotalPaise).toBe(1000_00);
    expect(r.platformFeePaise).toBe(100_00);
    expect(r.totalPaise).toBe(1239_00);
  });

  it('transport invoice exposes explicit trip fare + fee + GST + total', () => {
    const payment: InvoicePaymentRow = {
      amount_paise: 866_25,
      subtotal_paise: 750_00,
      platform_fee_paise: 75_00,
      taxes_paise: 41_25,
      insurance_premium_paise: 0,
      discount_paise: 0,
    };
    const r = computeInvoiceLines(
      payment,
      fallback({ gst: { rate: 0.05, hsn: '9964', label: 'Passenger transport' } }),
      'transport',
    );
    expect(r.source).toBe('stored');
    expect(r.baseLabel).toBe('Trip fare');
    expect(r.subtotalPaise).toBe(750_00);
    expect(r.platformFeePaise).toBe(75_00);
    expect(r.totalPaise).toBe(866_25);
  });

  it('does NOT reverse-derive subtotal from agreed_price_paise when stored breakdown exists', () => {
    // fallback.grossPaise (= booking.agreed_price_paise, excludes insurance)
    // would reverse-derive a taxable subtotal of round(2241_60/1.12) = 2001_43.
    // With stored fields present, computeInvoiceLines must use the stored
    // subtotal directly (2000_00) and total from amount_paise (2281_60).
    const payment: InvoicePaymentRow = {
      amount_paise: 2281_60,
      subtotal_paise: 2000_00,
      platform_fee_paise: 180_00,
      taxes_paise: 261_60,
      insurance_premium_paise: 40_00,
      discount_paise: 200_00,
    };
    const r = computeInvoiceLines(payment, fallback({ grossPaise: 2241_60 }), 'stay');
    expect(r.subtotalPaise).not.toBe(2001_43);
    expect(r.subtotalPaise).toBe(2000_00);
    expect(r.totalPaise).not.toBe(2241_60);
    expect(r.totalPaise).toBe(2281_60);
  });
});
